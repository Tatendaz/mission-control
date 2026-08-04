#!/usr/bin/env node
/* Mission Control sweeper.
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
/* tolerate a missing config at load time: the module is require()d by tests,
   which exercise the pure helpers and never touch CFG. main() still refuses.
   A config that parses but lacks the required shape gets the same clean
   refusal as a missing one, not a TypeError halfway through assemble(). */
const CFG = (() => {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
    return c && ["roots", "satelliteRoots", "projects", "ignoreDirs"].every(k => Array.isArray(c[k])) ? c : null;
  } catch { return null; }
})();
const HOME = process.env.HOME || "/Users/" + (process.env.USER || "");
const untilde = p => p && p.startsWith("~") ? HOME + p.slice(1) : p;
/* the scribe resolves symlinks before matching; do the same here so a
   transcript recorded under a symlinked root still finds its project */
const REAL = new Map();
const norm = p => {
  if (!p) return p;
  if (REAL.has(p)) return REAL.get(p);
  let s = untilde(p);
  try { s = fs.realpathSync(s); } catch {}
  s = s.length > 1 ? s.replace(/\/+$/, "") : s;
  REAL.set(p, s);
  return s;
};
const tilde = p => p && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
const HOME_DIR = () => path.resolve(HERE, untilde(CFG.home || "."));
const DRY = process.argv.includes("--dry");
const GIT = () => bin(CFG && CFG.git, "git");
const GH = () => bin(CFG && CFG.gh, "gh");
const AS_JSON = process.argv.includes("--json");
const NOW = Date.now();
const DAY = 86400000;

/* a configured binary path that does not exist falls back to the bare name, so
   PATH resolution still finds it (Homebrew lives in different prefixes) */
function bin(configured, name) {
  if (configured && fs.existsSync(configured)) return configured;
  if (configured) warn(`${name} not found at ${configured}; falling back to PATH`);
  return name;
}
const WARNED = [];
function warn(msg) { if (!WARNED.includes(msg)) { WARNED.push(msg); console.error("warning: " + msg); } }

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
  let u = sh(GIT(), ["-C", p, "config", "--get", "remote.origin.url"]);
  if (!u) return null;
  u = u.replace(/^[a-z+]+:\/\//, "").replace(/^ssh:\/\//, "");
  u = u.replace(/^[^@/]*@/, "");   /* git@host and https://user:token@host both drop out */
  u = u.replace(/:(\d+)(?=\/)/, "");   /* an explicit ssh port is not part of the identity */
  return u.replace(":", "/").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
}

/* one repo checkout scan */
function scanRepo(p, opts = {}) {
  const r = { path: p, dirty: 0, newestTs: 0, newestSubject: "", newestBranch: "",
    aheadTotal: 0, localOnly: [], branch: null, hasRemote: false };
  const st = sh(GIT(), ["-C", p, "status", "--porcelain"]);
  if (st != null) {
    let lines = st ? st.split("\n") : [];
    if (opts.excludeNested && opts.excludeNested.length)
      lines = lines.filter(l => !opts.excludeNested.some(n => l.slice(3).startsWith(n + "/") || l.slice(3) === n + "/"));
    r.dirty = lines.length;
  }
  /* \x01 separator: a branch name may legally contain "|", which used to shift
     every field after it and make unpushed work look clean */
  const refs = sh(GIT(), ["-C", p, "for-each-ref", "refs/heads",
    "--format=%(committerdate:unix)%01%(refname:short)%01%(upstream:track)%01%(upstream)%01%(subject)"]);
  if (refs) {
    const local = [];
    for (const line of refs.split("\n")) {
      const [ts, name, track, upstream, ...subj] = line.split("\x01");
      const t = (+ts) * 1000;
      if (t > r.newestTs) { r.newestTs = t; r.newestBranch = name; r.newestSubject = subj.join("\x01"); }
      const ahead = /\[ahead (\d+)/.exec(track || "");
      if (ahead) r.aheadTotal += +ahead[1];
      if (!upstream) local.push({ name, t });
    }
    /* newest first: the branch worth naming is the one you last touched.
       A branch with no upstream only counts as unpushed while its tip holds
       commits no remote ref contains — a leftover local branch whose PR merged
       (remote side deleted) is banked work, not work at risk. Containment is
       judged against the remote refs on disk, so it is only as fresh as the
       last fetch; the behind-origin flag covers the never-fetched case. */
    const MAX_CONTAIN_CHECKS = 16;
    r.localOnly = local.sort((a, b) => b.t - a.t).filter((x, i) => {
      if (i >= MAX_CONTAIN_CHECKS) return true;
      const out = sh(GIT(), ["-C", p, "rev-list", "--max-count=1", "refs/heads/" + x.name, "--not", "--remotes"]);
      return out !== "";   /* "" = fully contained; null (git error) stays flagged */
    }).map(x => x.name);
  }
  r.branch = sh(GIT(), ["-C", p, "rev-parse", "--abbrev-ref", "HEAD"]);
  r.hasRemote = !!originOf(p);
  if (!r.hasRemote) { r.aheadTotal = 0; r.localOnly = []; }
  return r;
}

/* ── Claude session logs: newest activity per project ── */
function sessionMap() {
  const dirs = [];
  const root = untilde(CFG.sessionsDir);   /* "~/.claude/projects" is the common config value */
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = path.join(root, e.name);
      let newest = 0, newestFile = null;
      const mtimes = [];
      try {
        for (const f of fs.readdirSync(d)) {
          if (!f.endsWith(".jsonl")) continue;
          const m = fs.statSync(path.join(d, f)).mtimeMs;
          mtimes.push(m);
          if (m > newest) { newest = m; newestFile = path.join(d, f); }
        }
      } catch {}
      if (newest) dirs.push({ enc: e.name, newest, cwd: cwdOf(newestFile), mtimes });
    }
  } catch {}
  return dirs;
}
/* The directory name encodes a path lossily (every non-alnum becomes "-"), so
   "~/code/acme-app" and "~/code/acme/app" collide. The transcript's own cwd is
   authoritative; fall back to the encoded name only when it is unreadable. */
function cwdOf(file) {
  if (!file) return null;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const line = buf.slice(0, n).toString("utf8").split("\n")[0];
    const cwd = JSON.parse(line).cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch { return null; }
}
const encode = p => p.replace(/[^A-Za-z0-9]/g, "-");

/* ── gh: open PRs + inbox issues + default-branch heads, cached for offline runs ── */
function ghData() {
  const cacheFile = path.join(HERE, ".cache.json");
  let prs = null, inbox = null, heads = null;
  const q = `query{viewer{pullRequests(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url createdAt isDraft headRefName repository{nameWithOwner}}}}}`;
  const out = sh(GH(), ["api", "graphql", "-f", "query=" + q], { timeout: 25000 });
  if (out) { try { prs = JSON.parse(out).data.viewer.pullRequests.nodes; } catch {} }
  /* where each repo's default branch actually is on GitHub, so a card whose
     local checkout was never pulled can say so instead of reporting old truth.
     One viewer-wide call: per-repo lookups would turn one 404 into a lost sweep. */
  const hq = `query{viewer{repositories(first:100,ownerAffiliations:[OWNER],orderBy:{field:PUSHED_AT,direction:DESC}){nodes{nameWithOwner defaultBranchRef{name target{oid}}}}}}`;
  const hout = sh(GH(), ["api", "graphql", "-f", "query=" + hq], { timeout: 25000 });
  if (hout) {
    try {
      heads = {};
      for (const n of JSON.parse(hout).data.viewer.repositories.nodes)
        if (n && n.defaultBranchRef && n.defaultBranchRef.target)
          heads[n.nameWithOwner.toLowerCase()] = { branch: n.defaultBranchRef.name, oid: n.defaultBranchRef.target.oid };
    } catch { heads = null; }
  }
  const iss = sh(GH(), ["issue", "list", "--repo", CFG.inboxRepo, "--state", "open",
    "--json", "number,title,createdAt,url", "--limit", "100"], { timeout: 25000 });
  if (iss) { try { inbox = JSON.parse(iss); } catch {} }
  let stale = false;
  if (!prs || !inbox || !heads) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (!prs) { prs = c.prs; stale = true; }
      if (!inbox) { inbox = c.inbox; stale = true; }
      if (!heads) { heads = c.heads; stale = true; }
    } catch {}
  }
  prs = prs || []; inbox = inbox || []; heads = heads || {};
  /* read-only modes stay read-only: --dry and --json must not touch the disk */
  if (!DRY && !AS_JSON) try { fs.writeFileSync(cacheFile, JSON.stringify({ prs, inbox, heads, at: NOW })); } catch {}
  return { prs, inbox, heads, stale };
}

/* true when the remote default branch has moved past everything this checkout
   knows: its head is either absent locally (never fetched) or absent from the
   local branch of the same name (fetched, not merged). Both mean the card is
   describing an old world. */
function remoteMovedAhead(p, branch, oid) {
  if (!/^[0-9a-f]{40}$/i.test(oid || "")) return false;
  if (sh(GIT(), ["-C", p, "cat-file", "-e", oid]) == null) return true;
  if (sh(GIT(), ["-C", p, "rev-parse", "--verify", "-q", "refs/heads/" + branch]) == null) return false;
  return sh(GIT(), ["-C", p, "merge-base", "--is-ancestor", oid, "refs/heads/" + branch]) == null;
}

/* ── next-step hygiene: a step anchored to a PR or issue that has since been
   merged or closed is done, and repeating it teaches you to ignore the card ── */
function parseNextRefs(step) {
  const out = [];
  const re = /\b(PRs?|pull requests?|issues?)\s+(#?\d+(?:\s*(?:,|and|&)\s*#\d+)*)/gi;
  let m;
  while ((m = re.exec(String(step || "")))) {
    const type = m[1].toLowerCase().startsWith("i") ? "issue" : "pr";
    for (const n of m[2].match(/\d+/g) || []) out.push({ type, n: +n });
  }
  return out;
}
/* a step may talk about another project's PR ("Merge promptups PR #8" on the
   cicd card); the first other-project name found in the text wins, else the
   card's own repo */
function ghFullFor(reg, owner) {
  const raw = (reg.ghRepo || reg.label || path.basename(untilde(reg.repoPath || reg.path) || "")).toLowerCase();
  if (raw.includes("/")) return raw;
  return owner ? owner.toLowerCase() + "/" + raw : null;
}
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function stepRepoFor(step, reg, projects, owner) {
  const named = new Set();
  for (const other of projects) {
    if (other === reg || other.aggregate) continue;
    const toks = [other.ghRepo && other.ghRepo.split("/").pop(), other.label,
      path.basename(untilde(other.repoPath || other.path) || "")].filter(t => t && t.length >= 3);
    if (toks.some(t => new RegExp("\\b" + escRe(t) + "\\b", "i").test(step)))
      named.add(ghFullFor(other, owner));
  }
  named.delete(null);
  /* two repos named in one step: there is no right pairing of refs to repos,
     so refuse to guess — pruneDoneNext keeps the step */
  if (named.size > 1) return null;
  if (named.size === 1) return [...named][0];
  return ghFullFor(reg, owner);
}
/* PR/issue states, resolved from the open-PR list first, then a small budget
   of gh lookups whose terminal answers (merged/closed never un-happen) persist
   in .prstate.json so steady state costs zero calls */
function makeRefResolver(openPrs, opts = {}) {
  const file = opts.file || path.join(HERE, ".prstate.json");
  const lookup = opts.lookup || ((type, repo, n) =>
    sh(GH(), [type === "pr" ? "pr" : "issue", "view", String(n), "--repo", repo, "--json", "state"], { timeout: 8000 }));
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
  const open = new Set((openPrs || []).map(pr => "pr:" + pr.repository.nameWithOwner.toLowerCase() + "#" + pr.number));
  let checks = 0, fails = 0, dirty = false;
  const resolve = (type, repo, n) => {
    if (!repo) return null;
    const k = type + ":" + repo + "#" + n;
    /* the live open list outranks every cached answer, so a reopened PR
       surfaces immediately even over a stale CLOSED entry */
    if (open.has(k)) return "OPEN";
    const c = cache[k];
    /* MERGED never un-happens; CLOSED does (issues and PRs reopen), so it
       only short-circuits for a week before being re-checked */
    if (c && c.s === "MERGED") return c.s;
    if (c && c.s === "CLOSED" && NOW - c.at < 7 * 24 * 3600000) return c.s;
    /* OPEN answers age out fast, failed lookups slower: a PR closes tomorrow,
       a nonexistent ref stays nonexistent and must not re-burn the budget */
    if (c && NOW - c.at < (c.s === "OPEN" ? 6 : 24) * 3600000) return c.s === "UNKNOWN" ? null : c.s;
    if (DRY || AS_JSON || fails >= 2 || checks >= 8) return null;
    checks++;
    const out = lookup(type, repo, n);
    if (out == null) { fails++; cache[k] = { s: "UNKNOWN", at: NOW }; dirty = true; return null; }
    fails = 0;
    let s = null; try { s = JSON.parse(out).state; } catch {}
    if (!s) return null;
    cache[k] = { s, at: NOW }; dirty = true;
    return s;
  };
  const save = () => { if (dirty && !DRY && !AS_JSON) try { fs.writeFileSync(file, JSON.stringify(cache)); } catch {} };
  return { resolve, save };
}
function pruneDoneNext(next, reg, projects, owner, rr) {
  return (next || []).filter(step => {
    const refs = parseNextRefs(step);
    if (!refs.length) return true;
    const repo = stepRepoFor(step, reg, projects, owner);
    if (!repo) return true;
    /* drop only on positive evidence that every referenced item is finished;
       an unknown state keeps the step — stale beats silently wrong */
    return !refs.map(r => rr.resolve(r.type, repo, r.n)).every(s => s === "MERGED" || s === "CLOSED");
  });
}

/* ── scribe status files ── */
function statusFor(id) {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, "status", id + ".json"), "utf8")); }
  catch { return null; }
}

/* ── progress history: one JSONL line per sweep ──
   The board renders state; motivation needs the delta. Each sweep appends a
   compact snapshot of per-project metrics so the next sweep can say what
   improved. Also feeds the per-day stats and, later, weekly recaps. */
const HFILE = path.join(HERE, "history.jsonl");
const dayKey = ts => new Date(ts).toLocaleDateString("en-CA");   /* 2026-08-01, local */
const dayStartMs = (() => { const t = new Date(NOW); t.setHours(0, 0, 0, 0); return t.getTime(); })();
function readHistory() {
  let lines = [];
  try {
    lines = fs.readFileSync(HFILE, "utf8").split("\n").filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {}
  return lines;
}
function appendHistory(entry) {
  try {
    fs.appendFileSync(HFILE, JSON.stringify(entry) + "\n");
    /* a sweep can fire many times a day; keep the file bounded. Truncate via
       tmp + rename so a concurrent manual sweep never sees a half-written file */
    const raw = fs.readFileSync(HFILE, "utf8").split("\n").filter(Boolean);
    if (raw.length > 4000) {
      const tmp = HFILE + ".tmp";
      fs.writeFileSync(tmp, raw.slice(-2000).join("\n") + "\n");
      fs.renameSync(tmp, HFILE);
    }
  } catch (e) { warn("history.jsonl not written: " + e.message); }
}
/* commit timestamps (ms) over the trailing 12 weeks, one git call.
   Filtered to the repo's own author so fetched branches from other people
   never count as your activity. */
const AUTHOR_CACHE = new Map();
function repoAuthor(p) {
  if (!AUTHOR_CACHE.has(p)) AUTHOR_CACHE.set(p, sh(GIT(), ["-C", p, "config", "user.email"]) || null);
  return AUTHOR_CACHE.get(p);
}
function commitTimes(p, remotesOnly) {
  const since = new Date(NOW - 84 * DAY).toISOString();
  const args = ["-C", p, "log", remotesOnly ? "--remotes" : "--all", "--since=" + since, "--format=%ct"];
  const author = repoAuthor(p);
  if (author) args.push("--fixed-strings", "--author=" + author);   /* literal match: emails can hold regex chars */
  const out = sh(GIT(), args);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map(t => (+t) * 1000);
}
const weekBuckets = tss => {
  const wk = new Array(12).fill(0);
  for (const t of tss) {
    const i = 11 - Math.floor((NOW - t) / (7 * DAY));
    if (i >= 0 && i <= 11) wk[i]++;
  }
  return wk;
};

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
    const full = pr.repository.nameWithOwner.toLowerCase();
    (byRepo[full] = byRepo[full] || []).push(pr);
  }
  /* a project claims PRs from <ghOwner>/<repo>; ghRepo may be given either way.
     Keying on the full name stops someoneelse/cli landing on your cli card. */
  const owner = (CFG.ghOwner || "").toLowerCase();
  const prsFor = reg => {
    const full = ghFullFor(reg, owner);
    if (full) return byRepo[full] || [];
    /* no ghOwner configured: fall back to a repo-name match across owners */
    const raw = (reg.ghRepo || reg.label || path.basename(untilde(reg.repoPath || reg.path) || "")).toLowerCase();
    const hit = Object.keys(byRepo).filter(k => k.endsWith("/" + raw));
    return hit.length === 1 ? byRepo[hit[0]] : [];
  };
  const refState = makeRefResolver(gh.prs);

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
      /* a workspace repo can hold nested clones; keep them out of its dirty
         count. walk() stops at the outer .git, so look for them directly. */
      let nestedWithin = [];
      if (reg.nestedClones) {
        try {
          nestedWithin = fs.readdirSync(abs, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith(".") && isGitDir(path.join(abs, e.name)))
            .map(e => e.name);
        } catch {}
      }
      scan = scanRepo(abs, { excludeNested: nestedWithin });
      const o = originOf(abs);
      const sats = (o && origins.get(o) || []).filter(sp => sp !== abs)
        .concat(uniq.filter(sp => sp !== abs && !originOf(sp) && path.basename(sp) === path.basename(abs)))
        .filter(sp => !registryPaths.includes(sp));
      for (const sp of [...new Set(sats)]) {
        const s = scanRepo(sp);
        const rootName = tilde(path.dirname(sp));
        if (s.newestTs > scan.newestTs + 60000) {
          satNote = { path: sp, rootName, scan: s };
          /* hazard keys are the stable identity for cleared-hazard detection:
             titles embed live counts and day tallies, so they churn every sweep */
          satHaz = { sev: "crit", key: `sat-ahead:${reg.id}`, pid: reg.id,
            title: `Newest ${reg.label || reg.id} work lives in a satellite clone`,
            body: `The most recent commit (${fmtDay(s.newestTs)}, <code>${esc(s.newestBranch)}</code>) is in <code>${esc(tilde(sp))}</code>, not the primary checkout, which last moved ${fmtDay(scan.newestTs)}. Anyone opening the primary sees stale state.` };
        } else if (s.dirty >= 5 || s.aheadTotal > 0) {
          hazards.push({ sev: "warn", key: `sat-unrescued:${reg.id}:${tilde(sp)}`, pid: reg.id,
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
    /* longest real-path prefix across the whole registry wins, so a session in
       ~/code/acme-app never counts toward a project at ~/code/acme */
    const claimLen = p2 => {
      let best = -1;
      for (const other of CFG.projects) {
        if (other.aggregate) continue;
        for (const c of [norm(other.path), other.repoPath && norm(other.repoPath)]) {
          if (!c) continue;
          if ((p2 === c || p2.startsWith(c + "/")) && c.length > best) best = c.length;
        }
      }
      return best;
    };
    const realCands = cands.map(norm);
    const sessMts = [];   /* every matched session file's mtime, for today/weekly counts */
    for (const sd of sess) {
      let mine;
      if (sd.cwd) {
        const cwd = norm(sd.cwd);
        const owner = claimLen(cwd);
        mine = realCands.some(c => (cwd === c || cwd.startsWith(c + "/")) && c.length >= owner)
          && (!reg.sessionExact || realCands.includes(cwd));
      } else {
        /* no transcript cwd: fall back to the lossy encoded directory name */
        mine = prefixes.some(pre => reg.sessionExact ? sd.enc === pre : (sd.enc === pre || sd.enc.startsWith(pre + "-")));
        if (mine && reg.sessionExact !== true) {
          const mineLen = Math.max(...prefixes.filter(pre => sd.enc === pre || sd.enc.startsWith(pre + "-")).map(x => x.length));
          const better = CFG.projects.some(other => other !== reg &&
            [untilde(other.repoPath || other.path)].map(encode)
              .some(op => op.length > mineLen && (sd.enc === op || sd.enc.startsWith(op + "-"))));
          if (better) mine = false;
        }
      }
      if (mine) sessMts.push(...(sd.mtimes || []));
      if (mine && sd.newest > ts) ts = sd.newest;
    }
    if (status && status.updated && status.updated > ts) ts = status.updated;

    if (!reg.aggregate && ts) {
      p.days = Math.max(0, Math.floor((NOW - ts) / DAY));
      p.last = fmtDay(ts);
    }

    /* flags */
    for (const f of reg.okFlags || []) p.flags.push(f);
    const prList = prsFor(reg);
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
        hazards.push({ sev: "warn", key: `unpushed:${reg.id}`, pid: reg.id, title: `${reg.label || reg.id}: ${bits.join(" and ")}`,
          body: `On <code>${esc(scan.branch || "")}</code> in <code>${esc(tilde(abs))}</code>. That work exists on this disk only until it is pushed.` });
      /* the inverse of unpushed: GitHub moved (remote merges, other machines)
         and this checkout never pulled, so the card is narrating an old world.
         Neutral, not a warning — nothing is at risk, the view is just stale.
         No ghOwner configured: fall back to a unique repo-name match, the
         same rule prsFor applies. */
      let ghHead = null;
      if (scan.branch && scan.hasRemote) {
        const full = ghFullFor(reg, owner);
        if (full) ghHead = gh.heads[full];
        else {
          const raw = (reg.ghRepo || reg.label || path.basename(untilde(reg.repoPath || reg.path) || "")).toLowerCase();
          const hit = Object.keys(gh.heads).filter(k => k.endsWith("/" + raw));
          if (hit.length === 1) ghHead = gh.heads[hit[0]];
        }
      }
      if (ghHead && remoteMovedAhead(abs, ghHead.branch, ghHead.oid))
        p.flags.push([`behind origin/${ghHead.branch} — pull to refresh`, ""]);
    }
    if (satHaz) hazards.push(satHaz);
    /* parked is a choice the board respects, not a warning it repeats */
    if (reg.parked && p.days != null) p.flags.push([`paused ${p.days}d`, ""]);

    /* aggregate cards: count dirty members */
    if (reg.aggregate && reg.members) {
      let dirtyMembers = 0;
      for (const m of reg.members) {
        const mp = path.join(untilde(reg.path), m);
        if (isGitDir(mp)) { const s = sh(GIT(), ["-C", mp, "status", "--porcelain"]); if (s) dirtyMembers++; }
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
    p.next = pruneDoneNext(p.next, reg, CFG.projects, owner, refState);

    p._label = reg.label || path.basename(untilde(reg.path));
    p._abs = untilde(reg.path);
    p._noLaunch = !!reg.noLaunch;
    p._prs = prList.map(x => ({ number: x.number, title: x.title, url: x.url, createdAt: x.createdAt, repo: x.repository.nameWithOwner }));

    /* progress metrics: what the delta engine diffs between sweeps.
       cm/cp are day-cumulative (commits today, pushed-today via remote refs),
       wk is trailing 12-week intensity (commits + sessions), recomputed fresh. */
    let commitTss = [], pushedToday = 0;
    if (reg.git && scan && !reg.aggregate) {
      commitTss = commitTimes(abs, false);
      pushedToday = commitTimes(abs, true).filter(t => t >= dayStartMs).length;
    }
    /* aggregate shelves catch orphan sessions from unregistered dirs; an
       activity strip on a "nothing happens here" card reads as a bug */
    const wk = reg.aggregate ? [] : weekBuckets(commitTss.concat(sessMts));
    p._metrics = {
      d: scan ? scan.dirty : null,
      a: scan ? scan.aheadTotal : null,
      lo: scan ? scan.localOnly.length : 0,
      days: p.days,
      sess: reg.aggregate ? 0 : sessMts.filter(m => m >= dayStartMs).length,
      cm: commitTss.filter(t => t >= dayStartMs).length,
      cp: pushedToday,
      prs: p._prs.map(x => ({ u: x.url, t: x.title, n: x.number, r: x.repo })),
    };
    p._wk = wk.some(n => n > 0) ? wk : null;
    /* all-clear ring, git cards only, one side per signal:
       top = tree clean, right = everything pushed, bottom = no PR waiting past
       30 days, left = no satellite clone holding newer work */
    p._ring = reg.git && scan && !reg.aggregate ? [
      scan.dirty === 0,
      scan.aheadTotal === 0 && scan.localOnly.length === 0,
      !p._prs.some(x => (NOW - new Date(x.createdAt).getTime()) / DAY > 30),
      !satNote,
    ] : null;
    projects.push(p);
  }
  refState.save();

  /* PR table rows: registry order, then external repos */
  const seen = new Set();
  const prRows = [];
  for (const p of projects) for (const pr of p._prs) {
    if (seen.has(pr.url)) continue;   /* two cards can resolve to the same repo */
    seen.add(pr.url);
    prRows.push({ ...pr, proj: p.id });
  }
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
    /* keyed by project, not PR url: when the oldest stale PR merges and the
       next-oldest takes over, the hazard identity holds instead of "clearing" */
    hazards.push({ sev: "warn", key: `stale-pr:${oldest.proj}`, pid: oldest.proj, title: `A pull request has been waiting ${Math.floor((NOW - new Date(oldest.createdAt).getTime()) / DAY)} days`,
      body: `${esc(oldest.repo)} — "${esc(oldest.title)}", open since ${oldest.since}. It is blocked on a decision, not code.` });

  hazards.sort((a, b) => (a.sev === "crit" ? 0 : 1) - (b.sev === "crit" ? 0 : 1));
  const topHaz = hazards.slice(0, 6);
  /* the empty state is the reward state: this line is what clearing the last
     hazard earns, so it reads like a win, not an absence */
  if (!topHaz.length) topHaz.push({ sev: "ok", title: "All clear — nothing is at risk",
    body: "No unpushed work, no dirty trees, no satellite clone ahead of its primary. Every checkout is in sync. Go outside." });

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

  /* topHaz is the display slice; allHazards feeds the delta diff, so a hazard
     falling off the top six never fakes a cleared-hazard win */
  return { projects, hazards: topHaz, allHazards: hazards, prRows, inbox, rec, figures,
    ghStale: gh.stale, scannedDirs: uniq.length, sessionDirs: sess.length };
}

/* ═══ progress: diff this sweep against the previous one ═══
   A win is a state change outside the tool, hard to fake without doing the
   work: PR merged, hazard cleared, unpushed work banked, a cold project
   touched again. Never activity counts alone, never a score. */
function progress(d, hist) {
  const prev = hist.length ? hist[hist.length - 1] : null;
  const todayLines = hist.filter(l => l.day === dayKey(NOW));
  const label = p => p._label || p.id;
  /* stable key + display title: cleared-hazard detection diffs keys, so a
     count ticking inside a title never fakes a win */
  const curHazK = (d.allHazards || d.hazards).filter(h => h.sev !== "ok").map(h => ({ k: h.key || h.title, t: h.title, p: h.pid || null }));
  const live = d.projects.filter(p => p._metrics);
  const wins = [];
  let prChecks = 0;      /* gh pr view budget, sweep-wide */
  let ghDown = false;    /* first failed probe stops the rest: no 8x timeout hang */

  for (const p of live) {
    const m = p._metrics, pm = prev && prev.projects && prev.projects[p.id];
    if (!pm) continue;
    if (pm.days >= 21 && m.days === 0)
      /* the comeback is the exact moment a streak counter would punish */
      wins.push({ id: p.id, tier: 1, kind: "comeback", n: pm.days,
        text: `${label(p)}: first activity in ${pm.days} days — welcome back` });
    else if (pm.days > 0 && m.days === 0)
      wins.push({ id: p.id, tier: 2, kind: "fresh",
        text: `${label(p)}: touched again after ${pm.days}d quiet` });
    if (pm.a > 0 && m.a === 0)
      wins.push({ id: p.id, tier: 2, kind: "banked", n: pm.a,
        text: `${label(p)}: ${pm.a} unpushed commit${pm.a > 1 ? "s" : ""} banked to the remote` });
    if (pm.d > 0 && m.d === 0)
      wins.push({ id: p.id, tier: 2, kind: "cleaned", n: pm.d,
        text: `${label(p)}: working tree clean, was ${pm.d} dirty` });
    /* PR set difference against the previous sweep; a metrics entry without a
       prs array (older format) yields no diff rather than a wall of false opens */
    if (!Array.isArray(pm.prs)) continue;
    const prevUrls = new Set(pm.prs.map(x => x.u));
    const curUrls = new Set(m.prs.map(x => x.u));
    for (const x of m.prs) if (!prevUrls.has(x.u))
      wins.push({ id: p.id, tier: 2, kind: "pr-open", n: x.n, text: `Opened ${x.r}#${x.n}: ${x.t}` });
    for (const x of pm.prs || []) {
      /* read-only modes stay offline: no gh state checks in --dry / --json */
      if (DRY || AS_JSON || ghDown || curUrls.has(x.u) || prChecks >= 8) continue;
      prChecks++;
      const out = sh(GH(), ["pr", "view", x.u, "--json", "state"], { timeout: 6000 });
      if (out == null) { ghDown = true; continue; }
      let state = null; try { state = JSON.parse(out).state; } catch {}
      if (state === "MERGED")
        wins.push({ id: p.id, tier: 1, kind: "pr-merged", n: x.n, text: `Merged ${x.r}#${x.n}: ${x.t}` });
      else if (state === "CLOSED")
        wins.push({ id: p.id, tier: 2, kind: "pr-closed", n: x.n, text: `Closed ${x.r}#${x.n}: ${x.t}` });
    }
  }
  /* old history lines carry title-only `haz`; diff only against key-aware
     lines so the format transition cannot fabricate cleared-hazard wins.
     A project that GAINED a hazard this sweep gets no cleared-win either:
     unpushed work migrating into a satellite clone is a move, not a win. */
  const prevHazK = prev && Array.isArray(prev.hazK) ? prev.hazK.filter(ph => ph && ph.k) : [];
  const curKeys = new Set(curHazK.map(c => c.k));
  const gainedPids = new Set(curHazK.filter(c => c.p && !prevHazK.some(ph => ph.k === c.k)).map(c => c.p));
  for (const ph of prevHazK)
    if (!curKeys.has(ph.k) && !(ph.p && gainedPids.has(ph.p)))
      wins.push({ id: null, tier: 1, kind: "hazard-cleared", text: `Hazard cleared: ${ph.t || ph.k}` });

  /* fold the day: a sweep fires many times daily (scribe-triggered); the
     emotional unit is the day, so the strip accumulates rather than resets */
  const priorWins = todayLines.flatMap(l => l.wins || []);
  const seenW = new Set(priorWins.map(w => w.kind + "|" + w.text));
  const freshWins = wins.filter(w => !seenW.has(w.kind + "|" + w.text));
  const todayWins = priorWins.concat(freshWins);

  const sum = f => live.reduce((n, p) => n + f(p._metrics), 0);
  const stats = {
    pushed: sum(m => m.cp), commits: sum(m => m.cm), sessions: sum(m => m.sess),
    cleaned: todayWins.filter(w => w.kind === "cleaned").length,
    merged: todayWins.filter(w => w.kind === "pr-merged").length,
    cleared: todayWins.filter(w => w.kind === "hazard-cleared").length,
  };

  const ringed = live.filter(p => p._ring);
  const closedN = ringed.filter(p => p._ring.every(Boolean)).length;
  /* board all-clear holds itself to the ring standard (clean, pushed, no stale
     PR on every repo), not just "no hazard crossed a threshold" */
  const boardClear = ringed.length > 0 && closedN === ringed.length && !curHazK.length;
  /* "first ever" survives history truncation via a sticky marker file */
  const seenFile = path.join(HERE, ".allclear-seen");
  const seenBefore = fs.existsSync(seenFile) || hist.some(l => l.allClear);
  const allClear = {
    n: closedN, total: ringed.length, board: boardClear,
    first: boardClear && hist.length > 0 && !seenBefore,
  };
  if (boardClear && !DRY && !AS_JSON) try { fs.writeFileSync(seenFile, String(NOW)); } catch {}

  /* one delight fact at most; none on the first sweep ever, none if one fired
     in the last 3 days: predictable rewards decay into entitlements */
  let fact = null;
  if (prev && !hist.some(l => l.fact && NOW - l.at < 3 * DAY)) {
    const comeback = freshWins.find(w => w.kind === "comeback" && w.n >= 42);
    if (comeback) fact = { kind: "comeback", text: comeback.text };
    else if (allClear.first && ringed.length > 1)
      fact = { kind: "all-clear", text: "Every project is clear at once — first time on record" };
  }

  /* per-card chips: today's accumulated change, at most two, gone at midnight */
  const chips = {};
  for (const p of live) {
    const m = p._metrics, w4 = todayWins.filter(w => w.id === p.id);
    const c = [];
    const mg = w4.find(w => w.kind === "pr-merged");
    if (mg) c.push(`#${mg.n} merged ✓`);
    const cb = w4.find(w => w.kind === "comeback");
    if (cb) c.push(`back after ${cb.n}d`);
    if (m.cp > 0) c.push(`▲ ${m.cp} pushed today`);
    else if (w4.some(w => w.kind === "banked")) c.push(`unpushed work banked ✓`);
    if (w4.some(w => w.kind === "cleaned")) c.push(`tree clean ✓`);
    else if (m.cm > 0 && !m.cp) c.push(`${m.cm} commit${m.cm > 1 ? "s" : ""} today`);
    if (c.length) chips[p.id] = c.slice(0, 2);
  }

  const delta = {
    at: NOW, prevAt: prev ? prev.at : 0, prevHuman: prev ? fmtStamp(prev.at) : "",
    date: dayKey(NOW), stats,
    /* strongest first before capping, so a tier-1 win never falls off the end */
    wins: todayWins.slice().sort((a, b) => (a.tier || 9) - (b.tier || 9)).slice(0, 12),
    changed: [...new Set(freshWins.map(w => w.id).filter(Boolean))],
    chips, allClear, fact,
    rings: Object.fromEntries(ringed.map(p => [p.id, p._ring])),
    weeks: Object.fromEntries(live.filter(p => p._wk).map(p => [p.id, p._wk])),
  };
  const entry = {
    at: NOW, day: dayKey(NOW),
    projects: Object.fromEntries(live.map(p => [p.id, p._metrics])),
    hazK: curHazK, wins: freshWins, fact, allClear: allClear.board,
  };
  return { delta, entry };
}

/* ═══ render ═══ */
function region(html, name, body, comment) {
  const [a, b] = comment
    ? [`<!-- SWEEP:${name} -->`, `<!-- /SWEEP:${name} -->`]
    : [`/* SWEEP:${name} */`, `/* /SWEEP:${name} */`];
  const i = html.indexOf(a);
  const j = i < 0 ? -1 : html.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`marker ${name} missing or malformed`);
  /* a body carrying its own end marker would swallow the rest of the file on
     the NEXT sweep; refuse rather than write a board that cannot be reswept */
  if (body.includes(b) || body.includes(a)) throw new Error(`generated ${name} body contains a sweep marker; refusing to write`);
  return html.slice(0, i + a.length) + "\n" + body + "\n" + html.slice(j);
}
/* JSON embedded in an inline script: a closing script tag inside a string ends
   the element, and a block-comment terminator ends the sweep marker. Escaping
   "<" and the star-slash pair keeps both inert and still-valid JSON. */
const jsonInline = v => JSON.stringify(v, null, 2)
  .replace(/</g, "\\u003C")
  .replace(/\*\//g, "*\\/");

function render(d, prog) {
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
          <b>${esc(h.title)}</b>
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

  const pj = d.projects.map(({ _label, _abs, _noLaunch, _prs, _metrics, _wk, _ring, ...rest }) =>
    /* absPath feeds the copied shell command; the tilde path is display-only
       (a tilde inside the copy's single quotes would never expand) */
    ({ ...rest, label: _label, absPath: _abs, launch: !_noLaunch }));
  html = region(html, "DATA",
    `const SWEPT = ${jsonInline({ at: NOW, human: stampH })};\n` +
    `const PROJECTS = ${jsonInline(pj)};\n` +
    `const INBOX = ${jsonInline(d.inbox)};\n` +
    `const REC = ${jsonInline(d.rec)};\n` +
    `const DELTA = ${jsonInline(prog ? prog.delta : null)};`, false);

  return { file, html };
}

function boardMd(d, prog) {
  const L = [];
  L.push(`# Mission Control — swept ${fmtStamp(NOW)}`);
  L.push("");
  L.push(`${d.figures.workstreams} workstreams · ${d.figures.prs} open PRs · ${d.figures.unrescued} repos with un-rescued work · inbox ${d.inbox.length}`);
  L.push("");
  if (prog && prog.delta) {
    const s = prog.delta.stats;
    const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    L.push("## Today");
    L.push(`${pl(s.pushed, "commit")} pushed · ${pl(s.commits, "commit")} · ${pl(s.sessions, "session")} · ${pl(s.merged, "PR")} merged · ${pl(s.cleared, "hazard")} cleared`);
    if (prog.delta.wins.length) L.push("");
    for (const w of prog.delta.wins) L.push(`- ${w.text}`);
    if (prog.delta.fact) L.push(`- ${prog.delta.fact.text}`);
    L.push("");
  }
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
/* wrapped in a function: a bare top-level return is only legal because CommonJS
   wraps the file, and it breaks the moment anything parses this as a module.
   Never process.exit() right after writing to stdout either — a piped stdout is
   async and the write is truncated at the pipe buffer (~64KB). */
function main() {
  if (!CFG) { console.error("config.json missing or unreadable next to sweep.js"); process.exitCode = 1; return; }
  const hist = readHistory();
  const d = assemble();
  const prog = progress(d, hist);
  if (AS_JSON) { process.stdout.write(JSON.stringify({ ...d, delta: prog.delta }, null, 2) + "\n"); return; }
  const { file, html } = render(d, prog);
  if (DRY) { process.stdout.write("dry run ok — all markers found, no files written\n"); return; }

  /* backup, then write */
  const bdir = path.join(HERE, "backups");
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date(NOW).toISOString().slice(0, 19).replace(/[:T]/g, "-");
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
  fs.writeFileSync(path.join(HOME_DIR(), "BOARD.md"), boardMd(d, prog));
  appendHistory(prog.entry);
  process.stdout.write(`swept ${d.scannedDirs} checkouts · ${d.figures.prs} PRs · inbox ${d.inbox.length} · ${d.hazards.filter(h => h.sev === "crit").length} critical hazards · ${prog.delta.wins.length} wins today · board + BOARD.md + data.json written${d.ghStale ? " (gh offline, cached)" : ""}\n`);
}
/* the pure pieces, for test/engine.test.js; running as a script still sweeps */
module.exports = { scanRepo, remoteMovedAhead, parseNextRefs, ghFullFor, stepRepoFor, makeRefResolver, pruneDoneNext };
if (require.main === module) main();
