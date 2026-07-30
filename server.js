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

   Loopback bind is NOT a security boundary: any page in the user's browser can
   reach 127.0.0.1. Since /api/launch starts an agent with tool access, every
   request is gated on being same-site (see guard()): loopback Host, our own
   Origin if one is sent, and Sec-Fetch-Site same-origin for browser requests.
   Non-browser clients (curl, the /standup skill) send none of those and pass. */

"use strict";
const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

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
/* last-resort nets: a local dashboard should never die silently on one bad request */
process.on("unhandledRejection", e => log("unhandledRejection:", (e && e.stack || e)));
process.on("uncaughtException", e => { log("uncaughtException:", (e && e.stack || e)); process.exit(1); });

/* every subprocess is async: a sync call here freezes the whole server */
function run(cmd, args, timeout = 20000) {
  return new Promise(res => {
    execFile(cmd, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => res({ ok: !err, out: (stdout || "").trim(), err: err && (stderr || err.message) }));
  });
}
async function herdr(args, timeout = 20000) {
  const r = await run(CFG.herdr, args, timeout);
  if (!r.ok && !r.out) return null;
  try {
    const j = JSON.parse(r.out.split("\n").pop());
    return j.result !== undefined ? j.result : j;
  } catch { return r.out ? { raw: r.out } : null; }
}

/* ── sweep management ── */
let sweeping = null;
function runSweep(reason) {
  if (sweeping) return sweeping;
  log("sweep start:", reason);
  sweeping = run(process.execPath, [path.join(HERE, "sweep.js")], 180000).then(r => {
    log("sweep done:", r.ok ? r.out : "FAILED " + String(r.err).slice(0, 300));
    sweeping = null;
    return r.ok;
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
function watchStatus() {
  try {
    const w = fs.watch(path.join(HERE, "status"), () => {
      clearTimeout(scribeT);
      scribeT = setTimeout(() => runSweep("session ended (scribe)"), 45 * 1000);
    });
    w.on("error", e => {   /* directory replaced or removed: re-arm, never throw */
      log("status watch error:", e.message);
      try { w.close(); } catch {}
      setTimeout(watchStatus, 5000);
    });
  } catch (e) { log("status watch failed:", e.message); setTimeout(watchStatus, 5000); }
}
watchStatus();

/* ── live herdr agent map: cached, and single-flight so a burst of requests
   cannot fan out into 2 subprocesses each ── */
let liveCache = { t: 0, agents: {} };
let livePending = null;
function liveAgents() {
  if (Date.now() - liveCache.t < 10000) return Promise.resolve(liveCache.agents);
  if (livePending) return livePending;
  livePending = (async () => {
    const agents = {};
    const r = await herdr(["agent", "list"], 6000);
    const ws = await herdr(["workspace", "list"], 6000);
    const wsLabel = {};
    for (const w of (ws && ws.workspaces) || []) wsLabel[w.workspace_id] = w.label;
    const rank = { working: 4, blocked: 3, done: 2, idle: 1, unknown: 0 };
    const best = (k, st) => {
      if (!k) return;
      if (!agents[k] || (rank[st] || 0) > (rank[agents[k]] || 0)) agents[k] = st;
    };
    for (const a of (r && r.agents) || []) {
      const label = wsLabel[a.workspace_id] || (a.cwd ? path.basename(a.cwd) : null);
      if (!label) continue;
      best(label, a.agent_status);
      const cwdBase = a.cwd ? path.basename(a.cwd) : null;
      if (cwdBase && cwdBase !== label) best(cwdBase, a.agent_status);
    }
    liveCache = { t: Date.now(), agents };
    return agents;
  })().catch(e => { log("liveAgents failed:", e.message); return liveCache.agents; })
     .finally(() => { livePending = null; });
  return livePending;
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
async function herdrUp() {
  const r = await run(CFG.herdr, ["status", "server"], 4000);
  return r.ok && r.out.includes("running");
}
async function ensureHerdr() {
  if (await herdrUp()) return true;
  const opened = await run("/usr/bin/open", ["-a", "Herdr"], 8000);
  if (!opened.ok) return false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await herdrUp()) return true;
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

  if (CFG.terminalApp) await run("/usr/bin/osascript", ["-e", `tell application "${CFG.terminalApp}" to activate`], 4000);
  log("launched", p.id, "ws", wsId, "pane", paneId);
  return { ok: true, workspace: wsId, pane: paneId };
}

/* ── http ── */
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/* Two separate defenses.

   hostGuard, on every request: the Host header must be loopback. This is what
   stops DNS rebinding, where a hostile page re-resolves its own domain to
   127.0.0.1 and becomes same-origin with us in the browser's eyes.

   siteGuard, on /api/* only: the request must not be cross-site. That blocks a
   hostile page's fetch/form/img from reaching endpoints with side effects,
   while the board's own fetches (same-origin) and non-browser clients like
   curl or the /standup skill (no Sec-Fetch-Site, no Origin) pass. It is
   deliberately NOT applied to loading the board itself: a top-level navigation
   from a link, a bookmark, or the Dock app is legitimately not same-origin. */
function hostGuard(req) {
  const host = String(req.headers.host || "").toLowerCase();
  return LOOPBACK.has(host.replace(/:\d+$/, "")) ? null : "bad host";
}
function siteGuard(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return "cross-site request";
  const origin = req.headers.origin;
  if (origin) {
    let o; try { o = new URL(origin); } catch { return "bad origin"; }
    if (!LOOPBACK.has(o.hostname) || o.port !== String(CFG.port)) return "foreign origin";
  }
  return null;
}
const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, "http://localhost"); }
  catch { return json(res, 400, { error: "bad request target" }); }
  req.on("error", e => log("request error:", e.message));

  const blocked = hostGuard(req) || (u.pathname.startsWith("/api/") ? siteGuard(req) : null);
  if (blocked) { log("blocked:", req.method, req.url, "-", blocked, "from", req.headers.origin || req.headers.host); return json(res, 403, { error: blocked }); }

  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      const html = await fsp.readFile(BOARD);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    } else if (req.method === "GET" && u.pathname === "/api/live") {
      json(res, 200, { sweptAt: sweptAt(), sweeping: !!sweeping, agents: await liveAgents() });
    } else if (req.method === "GET" && u.pathname === "/health") {
      json(res, 200, { ok: true, sweptAt: sweptAt() });
    } else if (req.method === "POST" && u.pathname === "/api/sweep") {
      runSweep("manual (board button)");
      json(res, 202, { started: true });
    } else if (req.method === "POST" && u.pathname === "/api/launch") {
      let body = "", over = false;
      req.setEncoding("utf8");   /* decode across chunk boundaries, not per chunk */
      req.on("data", c => {
        if (over) return;
        body += c;
        if (body.length > 4096) { over = true; json(res, 413, { ok: false, error: "body too large" }); req.destroy(); }
      });
      req.on("end", async () => {
        if (over) return;
        let id;
        try { id = JSON.parse(body || "{}").id; }
        catch { return json(res, 400, { ok: false, error: "body is not JSON" }); }
        try { json(res, 200, await launch(String(id || ""))); }
        catch (e) { log("launch failed:", e.stack || e.message); json(res, 200, { ok: false, error: e.message }); }
      });
    } else { json(res, 404, { error: "not found" }); }
  } catch (e) {
    log("http error:", e.stack || e.message);
    try { json(res, 500, { error: e.message }); } catch {}
  }
});
server.on("clientError", (e, socket) => { try { socket.destroy(); } catch {} });
server.listen(CFG.port, "127.0.0.1", () => log(`mission control on http://localhost:${CFG.port} (pid ${process.pid})`));
