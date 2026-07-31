#!/usr/bin/env node
/* SessionEnd scribe.
   Runs as a Claude Code SessionEnd hook. Reads the hook payload on stdin,
   maps the session's cwd to a radar project, extracts what happened (user
   prompts + files touched) from the transcript, and writes
   radar/status/<id>.json. The mission control server watches that directory
   and re-sweeps, so finishing a session anywhere updates the board.
   Must never block or fail a session: every path exits 0, hard 15s guard. */

"use strict";
const fs = require("fs");
const path = require("path");
const readline = require("readline");

setTimeout(() => process.exit(0), 15000).unref();
process.on("uncaughtException", () => process.exit(0));

const HERE = __dirname;
let CFG;
try { CFG = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8")); }
catch { process.exit(0); }
const HOME = process.env.HOME || require("os").homedir() || "";
const untilde = p => p && p.startsWith("~") ? HOME + p.slice(1) : p;
const norm = p => {
  if (!p) return p;
  let s = untilde(p);
  try { s = fs.realpathSync(s); } catch {}   /* symlinks, /tmp vs /private/tmp */
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
};

let raw = "";
process.stdin.on("data", c => raw += c);
process.stdin.on("end", () => { main(JSON.parse(raw || "{}")).catch(() => {}).then(() => process.exit(0)); });

function projectFor(rawCwd) {
  const cwd = norm(rawCwd);
  if (!cwd) return null;
  let best = null, bestLen = -1;
  for (const p of CFG.projects || []) {
    if (p.aggregate) continue;
    for (const c of [norm(p.path), p.repoPath && norm(p.repoPath)]) {
      if (!c) continue;
      if ((cwd === c || cwd.startsWith(c + "/")) && c.length > bestLen) { best = p; bestLen = c.length; }
    }
  }
  if (best) return best;
  /* a checkout under a satellite root belongs to the project of the same name */
  for (const rawRoot of CFG.satelliteRoots || []) {
    const root = norm(rawRoot);
    if (root && cwd.startsWith(root + "/")) {
      const base = cwd.slice(root.length + 1).split("/")[0];
      const hit = (CFG.projects || []).find(p =>
        path.basename(norm(p.repoPath || p.path) || "") === base ||
        (p.ghRepo && p.ghRepo.split("/").pop() === base) || p.label === base);
      if (hit) return hit;
    }
  }
  return null;
}

async function main(hook) {
  const cwd = hook.cwd || process.cwd();
  const proj = projectFor(cwd);
  if (!proj) return;
  const tp = hook.transcript_path;
  const prompts = [], files = new Set();
  if (tp && fs.existsSync(tp)) {
    const rl = readline.createInterface({ input: fs.createReadStream(tp, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "user" && e.message && !e.isMeta) {
        let text = "";
        const c = e.message.content;
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) text = c
          .filter(x => x && typeof x === "object" && x.type === "text" && typeof x.text === "string")
          .map(x => x.text).join(" ");
        text = (text || "").trim();
        if (!text || text.startsWith("<") || text.startsWith("Caveat:") || text.includes("tool_result")) continue;
        prompts.push(text.replace(/\s+/g, " ").slice(0, 220));
      } else if (e.type === "assistant" && e.message && Array.isArray(e.message.content)) {
        for (const b of e.message.content) {
          if (b.type === "tool_use" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(b.name)) {
            const f = b.input && (b.input.file_path || b.input.notebook_path);
            if (f) files.add(f.startsWith(HOME) ? "~" + f.slice(HOME.length) : f);
          }
        }
      }
    }
  }
  if (!prompts.length && !files.size) return;

  const day = new Date().toLocaleString("en-US", { month: "short", day: "numeric" });
  const first = prompts[0] ? `"${prompts[0].slice(0, 130)}"` : "no prompts recorded";
  let summary = `Session ${day}: ${first}`;
  if (prompts.length > 1) summary += ` and ${prompts.length - 1} more prompt${prompts.length > 2 ? "s" : ""}`;
  if (files.size) summary += `; touched ${files.size} file${files.size > 1 ? "s" : ""}`;
  summary += ".";

  const dir = path.join(HERE, "status");
  fs.mkdirSync(dir, { recursive: true });
  /* the id comes from config and is used as a filename: keep it inside status/ */
  const safeId = String(proj.id).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  if (!safeId) return;
  const out = path.join(dir, safeId + ".json");
  /* Two sessions in one project can end at the same moment; without a lock the
     later writer's read-modify-write drops the earlier one's recent[] entry.
     The lock is advisory and self-healing: a stale one (crashed hook) is broken
     after 10s, and failing to get it never blocks the session. */
  const lock = out + ".lock";
  let held = false;
  for (let i = 0; i < 25 && !held; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); held = true; }
    catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock);
      } catch {}
      if (!held) await new Promise(r => setTimeout(r, 120));
    }
  }
  try {
    let prev = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prev = parsed;
    } catch {
      /* keep a corrupt file rather than silently dropping the session history */
      if (fs.existsSync(out)) {
        try { fs.renameSync(out, `${out}.${Date.now()}.bad`); } catch {}
      }
    }
    const recent = [{ at: Date.now(), summary, prompts: prompts.slice(0, 8), files: [...files].slice(0, 12) }]
      .concat((Array.isArray(prev.recent) ? prev.recent : []).slice(0, 2));
    /* write-then-rename: the server watches this directory and re-sweeps on
       change, so it must never observe a half-written file */
    const tmp = out + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      id: proj.id, updated: Date.now(), cwd, summary, recent,
    }, null, 2));
    fs.renameSync(tmp, out);
  } finally {
    if (held) { try { fs.unlinkSync(lock); } catch {} }
  }
}
