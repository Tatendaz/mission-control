#!/usr/bin/env node
/* Project Radar sweeper.
   Reads ground truth (git checkouts, gh PRs, the ideas inbox, Claude session
   logs, scribe status files) and regenerates the marker-delimited regions of
   the board HTML, plus data.json (for the server), BOARD.md (for terminals),
   and .cache.json (gh fallback when offline).
   Zero dependencies. Personal data lives in config.json, not here. */

"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
const HOME = process.env.HOME || "/Users/" + (process.env.USER || "");
const untilde = p => p && p.startsWith("~") ? HOME + p.slice(1) : p;
const tilde = p => p && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
const HOME_DIR = () => path.resolve(HERE, untilde(CFG.home || "."));
const DRY = process.argv.includes("--dry");
const AS_JSON = process.argv.includes("--json");
const NOW = Date.now();
const DAY = 86400000;

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8", timeout: opts.timeout || 15000,
      maxBuffer: 8 * 1024 * 1024, cwd: opts.cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return null; }
}
const fmtDay = ts => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric" });
const fmtStamp = ts => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric" }) + ", " +
  new Date(ts).toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const WORDS = ["zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"];
const numWord = n => n >= 0 && n <= 20 ? WORDS[n] : String(n);
const capWord = n => { const w = numWord(n); return w[0].toUpperCase() + w.slice(1); };
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const clamp = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
const firstSentence = s => {
  const m = String(s || "").match(/^.*?[.!?](\s|$)/);
  return clamp((m ? m[0] : s || "").trim().replace(/[.!?]\s*$/, ""), 96);
};

/* ── discovery: every git checkout under the roots ── */
function isGitDir(p) { try { return fs.existsSync(path.join(p, ".git")); } catch { return false; } }
function walk(root, depth, out) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith(".") || CFG.ignoreDirs.includes(e.name)) continue;
    const p = path.join(root, e.name);
    if (isGitDir(p)) out.push(p);
    else if (depth > 1) walk(p, depth - 1, out);
  }
}
function originOf(p) {
  const u = sh(CFG.git, ["-C", p, "config", "--get", "remote.origin.url"]);
  if (!u) return null;
  return u.replace(/^[a-z+]+:\/\//, "").replace(/^git@/, "").replace(/^ssh:\/\//, "")
    .replace(":", "/").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
}

/* one repo checkout scan */
function scanRepo(p, opts = {}) {
  const r = { path: p, dirty: 0, newestTs: 0, newestSubject: "", newestBranch: "",
    aheadTotal: 0, localOnly: [], branch: null, hasRemote: false };
  const st = sh(CFG.git, ["-C", p, "status", "--porcelain"]);
  if (st != null) {
    let lines = st ? st.split("\n") : [];
    if (opts.excludeNested && opts.excludeNested.length)
      lines = lines.filter(l => !opts.excludeNested.some(n => l.slice(3).startsWith(n + "/") || l.slice(3) === n + "/"));
    r.dirty = lines.length;
  }
  const refs = sh(CFG.git, ["-C", p, "for-each-ref", "refs/heads",
    "--format=%(committerdate:unix)|%(refname:short)|%(upstream:track)|%(upstream)|%(subject)"]);
  if (refs) {
    for (const line of refs.split("\n")) {
      const [ts, name, track, upstream, ...subj] = line.split("|");
      const t = (+ts) * 1000;
      if (t > r.newestTs) { r.newestTs = t; r.newestBranch = name; r.newestSubject = subj.join("|"); }
      const ahead = /\[ahead (\d+)/.exec(track || "");
      if (ahead) r.aheadTotal += +ahead[1];
      if (!upstream) r.localOnly.push(name);
    }
  }
  r.branch = sh(CFG.git, ["-C", p, "rev-parse", "--abbrev-ref", "HEAD"]);
  r.hasRemote = !!originOf(p);
  if (!r.hasRemote) { r.aheadTotal = 0; r.localOnly = []; }
  return r;
}

/* ── Claude session logs: newest activity per project ── */
function sessionMap() {
  const dirs = [];
  try {
    for (const e of fs.readdirSync(CFG.sessionsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = path.join(CFG.sessionsDir, e.name);
      let newest = 0;
      try {
        for (const f of fs.readdirSync(d)) {
          if (!f.endsWith(".jsonl")) continue;
          const m = fs.statSync(path.join(d, f)).mtimeMs;
          if (m > newest) newest = m;
        }
      } catch {}
      if (newest) dirs.push({ enc: e.name, newest });
    }
  } catch {}
  return dirs;
}
const encode = p => p.replace(/[^A-Za-z0-9]/g, "-");

/* ── gh: open PRs + inbox issues, cached for offline runs ── */
function ghData() {
  const cacheFile = path.join(HERE, ".cache.json");
  let prs = null, inbox = null;
  const q = `query{viewer{pullRequests(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url createdAt isDraft headRefName repository{nameWithOwner}}}}}`;
  const out = sh(CFG.gh, ["api", "graphql", "-f", "query=" + q], { timeout: 25000 });
  if (out) { try { prs = JSON.parse(out).data.viewer.pullRequests.nodes; } catch {} }
  const iss = sh(CFG.gh, ["issue", "list", "--repo", CFG.inboxRepo, "--state", "open",
    "--json", "number,title,createdAt,url", "--limit", "100"], { timeout: 25000 });
  if (iss) { try { inbox = JSON.parse(iss); } catch {} }
  let stale = false;
  if (!prs || !inbox) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (!prs) { prs = c.prs; stale = true; }
      if (!inbox) { inbox = c.inbox; stale = true; }
    } catch {}
  }
  prs = prs || []; inbox = inbox || [];
  if (!DRY) try { fs.writeFileSync(cacheFile, JSON.stringify({ prs, inbox, at: NOW })); } catch {}
  return { prs, inbox, stale };
}

/* ── scribe status files ── */
function statusFor(id) {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, "status", id + ".json"), "utf8")); }
  catch { return null; }
}

/* ═══ assemble ═══ */
function assemble() {
  const found = [];
  for (const r of CFG.roots.map(untilde)) walk(r, 3, found);
  for (const r of CFG.satelliteRoots.map(untilde)) walk(r, 1, found);
  const uniq = [...new Set(found)];
  const origins = new Map();
  for (const p of uniq) {
    const o = originOf(p);
    if (!o) continue;
    if (!origins.has(o)) origins.set(o, []);
    origins.get(o).push(p);
  }

  const sess = sessionMap();
  const gh = ghData();
  const registryPaths = CFG.projects.map(pr => untilde(pr.repoPath || pr.path));

  /* map every authored PR to a registry project by repo basename */
  const byRepo = {};
  for (const pr of gh.prs) {
    const short = pr.repository.nameWithOwner.split("/")[1].toLowerCase();
    (byRepo[short] = byRepo[short] || []).push(pr);
  }

  const projects = [];
  const hazards = [];
  let unrescued = 0;

  for (const reg of CFG.projects) {
    const p = {
      id: reg.id, name: reg.name, path: reg.path, cat: reg.cat,
      last: reg.last || "", days: null, desc: reg.desc,
      flags: [], lastWork: reg.lastWork || "", next: reg.next || [],
    };
    const status = statusFor(reg.id);
    const abs = untilde(reg.repoPath || reg.path);
    let scan = null, satNote = null, satHaz = null;

    if (reg.git) {
      /* a workspace repo can hold nested clones; keep them out of its dirty count */
      const nestedWithin = uniq.filter(p2 => p2 !== abs && p2.startsWith(abs + "/"))
        .map(p2 => p2.slice(abs.length + 1));
      scan = scanRepo(abs, { excludeNested: reg.nestedClones ? nestedWithin : [] });
      const o = originOf(abs);
      const sats = (o && origins.get(o) || []).filter(sp => sp !== abs)
        .concat(uniq.filter(sp => sp !== abs && !originOf(sp) && path.basename(sp) === path.basename(abs)))
        .filter(sp => !registryPaths.includes(sp));
      for (const sp of [...new Set(sats)]) {
        const s = scanRepo(sp);
        const rootName = tilde(path.dirname(sp));
        if (s.newestTs > scan.newestTs + 60000) {
          satNote = { path: sp, rootName, scan: s };
          satHaz = { sev: "crit",
            title: `Newest ${reg.label || reg.id} work lives in a satellite clone`,
            body: `The most recent commit (${fmtDay(s.newestTs)}, <code>${esc(s.newestBranch)}</code>) is in <code>${esc(tilde(sp))}</code>, not the primary checkout, which last moved ${fmtDay(scan.newestTs)}. Anyone opening the primary sees stale state.` };
        } else if (s.dirty >= 5 || s.aheadTotal > 0) {
          hazards.push({ sev: "warn",
            title: `Satellite clone of ${reg.label || reg.id} holds un-rescued work`,
            body: `<code>${esc(tilde(sp))}</code> has ${s.dirty ? s.dirty + " dirty files" : ""}${s.dirty && s.aheadTotal ? " and " : ""}${s.aheadTotal ? s.aheadTotal + " unpushed commits" : ""}. Reconcile it with the primary, then prune.` });
        }
      }
    }

    /* freshness: newest of commits, sessions, scribe */
    let ts = 0;
    if (scan && scan.newestTs) ts = scan.newestTs;
    if (satNote && satNote.scan.newestTs > ts) ts = satNote.scan.newestTs;
    const cands = [untilde(reg.path)];
    if (reg.repoPath) cands.push(abs);
    if (satNote) cands.push(satNote.path);
    if (reg.git) {
      const o = originOf(abs);
      for (const sp of (o && origins.get(o) || [])) cands.push(sp);
    }
    const prefixes = cands.map(encode);
    for (const sd of sess) {
      const mine = prefixes.some(pre => reg.sessionExact ? sd.enc === pre : (sd.enc === pre || sd.enc.startsWith(pre + "-")));
      if (!mine) continue;
      if (reg.sessionExact !== true) {
        /* longest-prefix wins across the whole registry, so a sibling project
           whose directory name extends another's never leaks sessions into it */
        const better = CFG.projects.some(other => other !== reg &&
          [untilde(other.repoPath || other.path)].map(encode)
            .some(op => op.length > Math.max(...prefixes.filter(pre => sd.enc === pre || sd.enc.startsWith(pre + "-")).map(x => x.length)) &&
              (sd.enc === op || sd.enc.startsWith(op + "-"))));
        if (better) continue;
      }
      if (sd.newest > ts) ts = sd.newest;
    }
    if (status && status.updated && status.updated > ts) ts = status.updated;

    if (!reg.aggregate && ts) {
      p.days = Math.max(0, Math.floor((NOW - ts) / DAY));
      p.last = fmtDay(ts);
    }

    /* flags */
    for (const f of reg.okFlags || []) p.flags.push(f);
    const prShort = ((reg.ghRepo || reg.label || path.basename(abs || "")) + "").toLowerCase();
    const prList = byRepo[prShort] || [];
    if (prList.length) p.flags.push([`${prList.length} open PR${prList.length > 1 ? "s" : ""}`, ""]);
    if (satNote) p.flags.push([`newest work in ${satNote.rootName.replace(tilde(untilde(CFG.roots[0])) + "/", "")} clone`, "crit"]);
    if (scan) {
      const bits = [];
      if (scan.dirty) bits.push(`${scan.dirty} dirty file${scan.dirty > 1 ? "s" : ""}`);
      if (scan.aheadTotal) bits.push(`${scan.aheadTotal} unpushed commit${scan.aheadTotal > 1 ? "s" : ""}`);
      else if (scan.localOnly.length && scan.localOnly.length < 8) bits.push(`unpushed branch ${scan.localOnly[0]}`);
      if (bits.length) p.flags.push([bits.join(", "), "warn"]);
      if (bits.length || satNote) unrescued++;
      if (!satHaz && (scan.aheadTotal >= 3 || (scan.dirty >= 5 && (scan.aheadTotal || scan.localOnly.length))))
        hazards.push({ sev: "warn", title: `${reg.label || reg.id}: ${bits.join(" and ")}`,
          body: `On <code>${esc(scan.branch || "")}</code> in <code>${esc(tilde(abs))}</code>. That work exists on this disk only until it is pushed.` });
    }
    if (satHaz) hazards.push(satHaz);
    if (reg.parked && p.days != null) p.flags.push([`paused ${p.days}d`, "warn"]);

    /* aggregate cards: count dirty members */
    if (reg.aggregate && reg.members) {
      let dirtyMembers = 0;
      for (const m of reg.members) {
        const mp = path.join(untilde(reg.path), m);
        if (isGitDir(mp)) { const s = sh(CFG.git, ["-C", mp, "status", "--porcelain"]); if (s) dirtyMembers++; }
      }
      if (dirtyMembers) p.flags.push([`${dirtyMembers} hold uncommitted files`, "warn"]);
    }

    /* narrative */
    if (status && status.summary) p.lastWork = status.summary;
    else if (scan && scan.newestTs) {
      p.lastWork = `Last commit ${fmtDay(scan.newestTs)} on ${scan.newestBranch}: "${scan.newestSubject}".`;
      if (satNote) p.lastWork += ` Newer work (${fmtDay(satNote.scan.newestTs)}) sits in the ${satNote.rootName} clone.`;
    } else if (!reg.aggregate && ts && !p.lastWork) p.lastWork = `Last session ${fmtDay(ts)}.`;
    if (status && status.next && status.next.length) p.next = status.next;

    p._label = reg.label || path.basename(untilde(reg.path));
    p._abs = untilde(reg.path);
    p._noLaunch = !!reg.noLaunch;
    p._prs = prList.map(x => ({ number: x.number, title: x.title, url: x.url, createdAt: x.createdAt, repo: x.repository.nameWithOwner }));
    projects.push(p);
  }

  /* PR table rows: registry order, then external repos */
  const seen = new Set();
  const prRows = [];
  for (const p of projects) for (const pr of p._prs) { seen.add(pr.url); prRows.push({ ...pr, proj: p.id }); }
  for (const pr of gh.prs) if (!seen.has(pr.url))
    prRows.push({ number: pr.number, title: pr.title, url: pr.url, createdAt: pr.createdAt, repo: pr.repository.nameWithOwner, proj: null });
  for (const r of prRows) {
    const note = (CFG.prNotes || [])
      .filter(n => r.title.toLowerCase().includes(n.match.toLowerCase()))
      .sort((a, b) => b.match.length - a.match.length)[0];
    r.note = note ? note.note : "Review and merge";
    r.since = fmtDay(new Date(r.createdAt).getTime());
  }
  /* oldest PR hazard */
  const oldest = prRows.filter(r => r.proj && !CFG.projects.find(x => x.id === r.proj)?.parked)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
  if (oldest && (NOW - new Date(oldest.createdAt).getTime()) / DAY > 30)
    hazards.push({ sev: "warn", title: `A pull request has been waiting ${Math.floor((NOW - new Date(oldest.createdAt).getTime()) / DAY)} days`,
      body: `${esc(oldest.repo)} — "${esc(oldest.title)}", open since ${oldest.since}. It is blocked on a decision, not code.` });

  hazards.sort((a, b) => (a.sev === "crit" ? 0 : 1) - (b.sev === "crit" ? 0 : 1));
  const topHaz = hazards.slice(0, 6);
  if (!topHaz.length) topHaz.push({ sev: "ok", title: "Nothing is at risk right now",
    body: "No unpushed work, no dirty trees, no satellite clone ahead of its primary. The sweep found every checkout in sync." });

  /* inbox */
  const inbox = gh.inbox.map(i => ({
    n: i.number, title: i.title, url: i.url,
    created: fmtDay(new Date(i.createdAt).getTime()),
    days: Math.floor((NOW - new Date(i.createdAt).getTime()) / DAY),
  })).sort((a, b) => b.n - a.n);

  /* recency rows */
  const rec = projects.filter(p => p.days != null)
    .sort((a, b) => a.days - b.days)
    .map(p => [p._label === "cv" ? p.name : p._label, p.days, p.last, firstSentence(p.lastWork) || (p.next[0] || "")]);

  /* figures */
  const live = projects.filter(p => !CFG.projects.find(r => r.id === p.id).aggregate);
  const gitN = live.filter(p => CFG.projects.find(r => r.id === p.id).git).length;
  const staleJunk = CFG.projects.filter(r => r.aggregate).reduce((n, r) => n + (r.members || []).length, 0);
  const prRepos = new Set(prRows.map(r => r.repo)).size;
  const figures = {
    workstreams: live.length, gitN, folderN: live.length - gitN,
    prs: prRows.length, prRepos, unrescued, staleJunk,
  };

  return { projects, hazards: topHaz, prRows, inbox, rec, figures, ghStale: gh.stale,
    scannedDirs: uniq.length, sessionDirs: sess.length };
}

/* ═══ render ═══ */
function region(html, name, body, comment) {
  const [a, b] = comment
    ? [`<!-- SWEEP:${name} -->`, `<!-- /SWEEP:${name} -->`]
    : [`/* SWEEP:${name} */`, `/* /SWEEP:${name} */`];
  const i = html.indexOf(a), j = html.indexOf(b);
  if (i < 0 || j < 0 || j < i) throw new Error(`marker ${name} missing or malformed`);
  return html.slice(0, i + a.length) + "\n" + body + "\n" + html.slice(j);
}

function render(d) {
  const file = path.join(HOME_DIR(), CFG.boardHtml);
  let html = fs.readFileSync(file, "utf8");
  const stampH = fmtStamp(NOW);

  html = region(html, "STAMP", `Swept ${stampH}`, true);

  const ledeTail = CFG.ledeEstimate
    ? `You estimated ${CFG.ledeEstimate} projects; <strong>the measured truth is ${numWord(d.figures.workstreams)}.</strong>`
    : `<strong>${capWord(d.figures.workstreams)} workstreams, measured.</strong>`;
  html = region(html, "OVERVIEW", `
    <p class="lede">Assembled from a live sweep of your repos, open pull requests, Claude Code session history and the watch inbox. No manual input. ${ledeTail}</p>
    <div class="figures">
      <div class="fig"><div class="v">${d.figures.workstreams}</div><div class="l">active workstreams</div><div class="s">${d.figures.gitN} git repos, ${d.figures.folderN} working folders</div></div>
      <div class="fig"><div class="v">${d.figures.prs}</div><div class="l">open pull requests</div><div class="s">across ${d.figures.prRepos} repositories</div></div>
      <div class="fig"><div class="v">${d.figures.unrescued}</div><div class="l">repos holding un-rescued work</div><div class="s">uncommitted or unpushed changes</div></div>
      <div class="fig"><div class="v">${d.figures.staleJunk}</div><div class="l">stale or junk directories</div><div class="s">2019 to 2024, plus empties and duplicates</div></div>
    </div>`, true);

  html = region(html, "HAZARDS", `
    <div class="hazards">${d.hazards.map((h, i) => `
      <div class="hz">
        <div class="hz-no">${String(i + 1).padStart(2, "0")}</div>
        <div>
          <b>${h.title}</b>
          <p>${h.body}</p>
        </div>
        <span class="sev ${h.sev}"><i>${h.sev === "crit" ? "▲" : h.sev === "warn" ? "◆" : "●"}</i>${h.sev === "crit" ? "critical" : h.sev === "warn" ? "warning" : "all clear"}</span>
      </div>`).join("")}
    </div>`, true);

  html = region(html, "PRS", `
    <h2>${capWord(d.figures.prs)} ${d.figures.prs === 1 ? "is" : "are"} waiting on you</h2>
    <p class="sub">Across ${numWord(d.figures.prRepos)} repositories. The oldest ones are blocked on decisions, not code.</p>
    <div class="twrap">
      <table>
        <thead><tr><th>Repo</th><th>Pull request</th><th>Since</th><th>Waiting on</th></tr></thead>
        <tbody>${d.prRows.map(r => `
          <tr><td class="num">${esc(CFG.ghOwner ? r.repo.replace(new RegExp("^" + CFG.ghOwner + "/"), "") : r.repo)}</td><td><a href="${r.url}">${esc(r.title)} (#${r.number})</a></td><td class="num">${r.since}</td><td>${esc(r.note)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>`, true);

  html = region(html, "FOOTER",
    `  <p>Swept ${stampH} from ${d.scannedDirs} git checkouts, an open-PR search, the ideas inbox, and ${d.sessionDirs} Claude Code session folders.${d.ghStale ? " GitHub data is from the last successful sweep; the network was unreachable this run." : ""}</p>`, true);

  const pj = d.projects.map(({ _label, _abs, _noLaunch, _prs, ...rest }) =>
    ({ ...rest, label: _label, launch: !_noLaunch }));
  html = region(html, "DATA",
    `const SWEPT = ${JSON.stringify({ at: NOW, human: stampH })};\n` +
    `const PROJECTS = ${JSON.stringify(pj, null, 2)};\n` +
    `const INBOX = ${JSON.stringify(d.inbox, null, 2)};\n` +
    `const REC = ${JSON.stringify(d.rec)};`, false);

  return { file, html };
}

function boardMd(d) {
  const L = [];
  L.push(`# Project Radar — swept ${fmtStamp(NOW)}`);
  L.push("");
  L.push(`${d.figures.workstreams} workstreams · ${d.figures.prs} open PRs · ${d.figures.unrescued} repos with un-rescued work · inbox ${d.inbox.length}`);
  L.push("");
  L.push("## Hazards");
  for (const h of d.hazards) L.push(`- [${h.sev}] ${h.title} — ${h.body.replace(/<[^>]+>/g, "")}`);
  L.push("");
  L.push("## Board");
  for (const p of d.projects) {
    const fl = p.flags.map(f => f[0]).join("; ");
    L.push(`- **${p.name}** (${p.last || "—"}${p.days != null ? `, ${p.days}d` : ""})${fl ? ` [${fl}]` : ""}`);
    if (p.next[0]) L.push(`  next: ${p.next[0]}`);
  }
  L.push("");
  L.push("## Inbox");
  if (!d.inbox.length) L.push("- empty");
  for (const i of d.inbox) L.push(`- #${i.n} ${i.title} (${i.created})`);
  L.push("");
  L.push("## Pull requests");
  for (const r of d.prRows) L.push(`- ${r.repo} — ${r.title} (#${r.number}, ${r.since}): ${r.note}`);
  return L.join("\n") + "\n";
}

/* ═══ main ═══ */
const d = assemble();
if (AS_JSON) { console.log(JSON.stringify(d, null, 2)); process.exit(0); }
const { file, html } = render(d);
if (DRY) { console.log("dry run ok — all markers found, no files written"); process.exit(0); }

/* backup, then write */
const bdir = path.join(HERE, "backups");
fs.mkdirSync(bdir, { recursive: true });
const stamp = new Date(NOW).toISOString().slice(0, 16).replace(/[:T]/g, "-");
fs.copyFileSync(file, path.join(bdir, `radar-${stamp}.html`));
const old = fs.readdirSync(bdir).filter(f => f.startsWith("radar-")).sort();
while (old.length > 10) fs.unlinkSync(path.join(bdir, old.shift()));

fs.writeFileSync(file, html);
fs.writeFileSync(path.join(HERE, "data.json"), JSON.stringify({
  sweptAt: NOW, projects: d.projects.map(p => ({
    id: p.id, name: p.name, label: p._label, path: p._abs, tildePath: p.path,
    launch: !p._noLaunch, lastWork: p.lastWork, next: p.next, flags: p.flags,
  })), inbox: d.inbox, figures: d.figures,
}, null, 2));
fs.writeFileSync(path.join(HOME_DIR(), "BOARD.md"), boardMd(d));
console.log(`swept ${d.scannedDirs} checkouts · ${d.figures.prs} PRs · inbox ${d.inbox.length} · ${d.hazards.filter(h => h.sev === "crit").length} critical hazards · board + BOARD.md + data.json written${d.ghStale ? " (gh offline, cached)" : ""}`);
