#!/usr/bin/env node
/* Mission Control server.
   Serves the radar board on 127.0.0.1 and gives it hands:
     GET  /            the board (no-cache, always the latest sweep)
     GET  /api/live    { sweptAt, agents: {label: status} }  herdr-backed, 10s cache
     POST /api/sweep   run sweep.js now (single-flight)
     POST /api/launch  { id } -> herdr workspace (create if missing) + new tab
                       + claude started with a prompt built from the card
   Sweeps also run on a schedule (config sweepHour:sweepMinute daily), when the
   scribe drops a fresh status file (debounced), and at boot when data is stale.
   Loopback only: /api/launch executes commands, so nothing may reach it off-box. */

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const HERE = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
const HOME = process.env.HOME || "";
const BOARD = path.resolve(HERE, CFG.home.startsWith("~") ? HOME + CFG.home.slice(1) : CFG.home, CFG.boardHtml);
const DATA = path.join(HERE, "data.json");
const LOGDIR = path.join(HERE, "logs");
fs.mkdirSync(LOGDIR, { recursive: true });
fs.mkdirSync(path.join(HERE, "status"), { recursive: true });
const LOG = path.join(LOGDIR, "server.log");
function log(...a) {
  const line = new Date().toISOString() + " " + a.join(" ") + "\n";
  try { if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) fs.renameSync(LOG, LOG + ".1"); } catch {}
  try { fs.appendFileSync(LOG, line); } catch {}
}

function herdr(args, timeout = 20000) {
  return new Promise(res => {
    execFile(CFG.herdr, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return res(null);
        try {
          const j = JSON.parse(stdout.trim().split("\n").pop());
          res(j.result !== undefined ? j.result : j);
        } catch { res(stdout ? { raw: stdout.trim() } : null); }
      });
  });
}

/* ── sweep management ── */
let sweeping = null;
function runSweep(reason) {
  if (sweeping) return sweeping;
  log("sweep start:", reason);
  sweeping = new Promise(res => {
    execFile(process.execPath, [path.join(HERE, "sweep.js")],
      { encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        log("sweep done:", err ? "FAILED " + (stderr || err.message).slice(0, 300) : stdout.trim());
        sweeping = null;
        res(!err);
      });
  });
  return sweeping;
}
function sweptAt() {
  try { return JSON.parse(fs.readFileSync(DATA, "utf8")).sweptAt || 0; } catch { return 0; }
}

/* boot: sweep if stale (>12h) */
if (Date.now() - sweptAt() > 12 * 3600 * 1000) runSweep("boot, data stale");

/* daily at sweepHour:sweepMinute */
setInterval(() => {
  const n = new Date();
  if (n.getHours() === (CFG.sweepHour ?? 7) && n.getMinutes() === (CFG.sweepMinute ?? 30)) runSweep("daily schedule");
}, 60 * 1000);

/* scribe wrote a status file -> a session just ended somewhere -> sweep soon */
let scribeT = null;
try {
  fs.watch(path.join(HERE, "status"), () => {
    clearTimeout(scribeT);
    scribeT = setTimeout(() => runSweep("session ended (scribe)"), 45 * 1000);
  });
} catch (e) { log("status watch failed:", e.message); }

/* ── live herdr agent map, cached ── */
let liveCache = { t: 0, agents: {} };
async function liveAgents() {
  if (Date.now() - liveCache.t < 10000) return liveCache.agents;
  const agents = {};
  const r = await herdr(["agent", "list"], 6000);
  const ws = await herdr(["workspace", "list"], 6000);
  const wsLabel = {};
  for (const w of (ws && ws.workspaces) || []) wsLabel[w.workspace_id] = w.label;
  const rank = { working: 4, blocked: 3, done: 2, idle: 1, unknown: 0 };
  for (const a of (r && r.agents) || []) {
    const label = wsLabel[a.workspace_id] || (a.cwd ? path.basename(a.cwd) : null);
    if (!label) continue;
    const cur = agents[label];
    if (!cur || (rank[a.agent_status] || 0) > (rank[cur] || 0)) agents[label] = a.agent_status;
    const cwdBase = a.cwd ? path.basename(a.cwd) : null;
    if (cwdBase && cwdBase !== label && (!agents[cwdBase] || (rank[a.agent_status] || 0) > (rank[agents[cwdBase]] || 0)))
      agents[cwdBase] = a.agent_status;
  }
  liveCache = { t: Date.now(), agents };
  return agents;
}

/* ── launch: card -> herdr workspace -> new tab -> claude with a prompt ── */
function projById(id) {
  try { return (JSON.parse(fs.readFileSync(DATA, "utf8")).projects || []).find(p => p.id === id); }
  catch { return null; }
}
function buildPrompt(p) {
  const parts = [];
  parts.push(`Resume work on ${p.name} (${p.tildePath || p.path}).`);
  if (p.lastWork) parts.push(`Where it stands: ${p.lastWork}`);
  if (p.flags && p.flags.length) parts.push(`Board flags: ${p.flags.map(f => f[0]).join("; ")}.`);
  if (p.next && p.next.length) parts.push(`Next steps from the radar board: ${p.next.map((n, i) => `${i + 1}) ${n}`).join(" ")}`);
  parts.push("Start with the first next step (or the most urgent flag), confirm the plan in one line, then get to work.");
  return parts.join(" ");
}
async function ensureHerdr() {
  let st = null;
  try { st = execFileSync(CFG.herdr, ["status", "server"], { encoding: "utf8", timeout: 4000 }); } catch {}
  if (st && st.includes("running")) return true;
  try { execFileSync("/usr/bin/open", ["-a", "Herdr"], { timeout: 8000 }); } catch { return false; }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      st = execFileSync(CFG.herdr, ["status", "server"], { encoding: "utf8", timeout: 4000 });
      if (st.includes("running")) return true;
    } catch {}
  }
  return false;
}
async function launch(id) {
  const p = projById(id);
  if (!p) return { ok: false, error: "unknown project (sweep first?)" };
  if (p.launch === false) return { ok: false, error: "this card is not launchable" };
  if (!(await ensureHerdr())) return { ok: false, error: "herdr server is not running and could not be started" };

  const ws = await herdr(["workspace", "list"]);
  let wsId = null;
  for (const w of (ws && ws.workspaces) || []) if (w.label === p.label) { wsId = w.workspace_id; break; }
  if (!wsId) {
    const made = await herdr(["workspace", "create", "--cwd", p.path, "--label", p.label, "--focus"]);
    wsId = made && (made.workspace_id || (made.workspace && made.workspace.workspace_id));
    if (!wsId) {
      const again = await herdr(["workspace", "list"]);
      for (const w of (again && again.workspaces) || []) if (w.label === p.label) { wsId = w.workspace_id; break; }
    }
    if (!wsId) return { ok: false, error: "could not create a herdr workspace" };
  } else {
    await herdr(["workspace", "focus", wsId]);
  }

  const tab = await herdr(["tab", "create", "--workspace", wsId, "--cwd", p.path, "--label", "radar", "--focus"]);
  let paneId = tab && (tab.pane_id || (tab.tab && tab.tab.pane_id) || (tab.pane && tab.pane.pane_id));
  const tabId = tab && (tab.tab_id || (tab.tab && tab.tab.tab_id));
  if (!paneId) {
    const panes = await herdr(["pane", "list"]);
    const mine = ((panes && panes.panes) || []).filter(x => !tabId || x.tab_id === tabId);
    if (mine.length) paneId = mine[mine.length - 1].pane_id;
  }
  if (!paneId) return { ok: false, error: "herdr tab opened but no pane id came back" };

  const name = `radar-${p.id}-${Date.now() % 100000}`;
  const started = await herdr(["agent", "start", name, "--kind", "claude", "--pane", paneId, "--timeout", "60000"], 70000);
  if (!started || started.error) return { ok: false, error: "claude did not start in the pane: " + JSON.stringify((started && started.error) || "timeout") };
  const prompted = await herdr(["agent", "prompt", name, buildPrompt(p)], 20000);
  if (!prompted || prompted.error) return { ok: false, error: "claude started but the prompt was not accepted" };

  if (CFG.terminalApp) {
    try { execFileSync("/usr/bin/osascript", ["-e", `tell application "${CFG.terminalApp}" to activate`], { timeout: 4000 }); } catch {}
  }
  log("launched", p.id, "ws", wsId, "pane", paneId);
  return { ok: true, workspace: wsId, pane: paneId };
}

/* ── http ── */
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(BOARD));
    } else if (req.method === "GET" && u.pathname === "/api/live") {
      json(res, 200, { sweptAt: sweptAt(), sweeping: !!sweeping, agents: await liveAgents() });
    } else if (req.method === "GET" && u.pathname === "/health") {
      json(res, 200, { ok: true, sweptAt: sweptAt() });
    } else if (req.method === "POST" && u.pathname === "/api/sweep") {
      runSweep("manual (board button)");
      json(res, 202, { started: true });
    } else if (req.method === "POST" && u.pathname === "/api/launch") {
      let body = "";
      req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on("end", async () => {
        try {
          const { id } = JSON.parse(body || "{}");
          json(res, 200, await launch(String(id || "")));
        } catch (e) { json(res, 200, { ok: false, error: e.message }); }
      });
    } else { json(res, 404, { error: "not found" }); }
  } catch (e) { log("http error:", e.message); try { json(res, 500, { error: e.message }); } catch {} }
});
server.listen(CFG.port, "127.0.0.1", () => log(`mission control on http://localhost:${CFG.port} (pid ${process.pid})`));
