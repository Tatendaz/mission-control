"use strict";
/* Engine unit tests: the staleness fixes. Real git fixtures in a temp dir for
   the repo-scanning halves, stubbed lookups for the gh-dependent halves.
   Zero dependencies beyond node (node:test) + git, like the project. Run:
   node --test test/ */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { scanRepo, remoteMovedAhead, parseNextRefs, ghFullFor, stepRepoFor,
  makeRefResolver, pruneDoneNext } = require("../sweep.js");

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/* a bare origin plus a clone with one pushed commit on main */
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-engine-"));
  const bare = path.join(tmp, "origin.git");
  const work = path.join(tmp, "work");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
  execFileSync("git", ["clone", bare, work], { stdio: "ignore" });
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "T");
  fs.writeFileSync(path.join(work, "a.txt"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "init");
  git(work, "push", "-u", "origin", "main");
  return { tmp, bare, work };
}
function commit(work, file, msg) {
  fs.writeFileSync(path.join(work, file), msg + "\n");
  git(work, "add", ".");
  git(work, "commit", "-m", msg);
}

test("scanRepo: a merged branch that lost its upstream is not unpushed", t => {
  const { tmp, work } = fixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /* banked: the full post-merge state — branch pushed, PR merged into main,
     remote branch deleted, tracking ref pruned, upstream config dropped. The
     only remote ref containing its commits is origin/main. */
  git(work, "checkout", "-b", "banked");
  commit(work, "b.txt", "banked work");
  git(work, "push", "-u", "origin", "banked");
  git(work, "checkout", "main");
  git(work, "merge", "--no-ff", "banked", "-m", "merge banked (PR)");
  git(work, "push", "origin", "main");
  git(work, "push", "origin", "--delete", "banked");
  git(work, "fetch", "--prune", "origin");
  git(work, "branch", "--unset-upstream", "banked");

  /* loc: never pushed anywhere — genuinely at risk */
  git(work, "checkout", "-b", "loc", "main");
  commit(work, "c.txt", "local-only work");
  git(work, "checkout", "main");
  /* third shape: the default branch itself with no upstream but fully pushed —
     containment must clear it too, not just topic branches */
  git(work, "branch", "--unset-upstream", "main");

  const r = scanRepo(work);
  assert.deepStrictEqual(r.localOnly, ["loc"],
    "only the never-pushed branch counts; the merged and the pushed ones are filtered");
  assert.strictEqual(r.aheadTotal, 0);
  assert.strictEqual(r.dirty, 0);
});

test("remoteMovedAhead: never-fetched, fetched-not-merged, caught-up, garbage oid", t => {
  const { tmp, bare, work } = fixture();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /* someone else pushes to origin/main */
  const other = path.join(tmp, "other");
  execFileSync("git", ["clone", bare, other], { stdio: "ignore" });
  git(other, "config", "user.email", "o@example.com");
  git(other, "config", "user.name", "O");
  commit(other, "d.txt", "remote-side work");
  git(other, "push", "origin", "main");
  const oid = git(other, "rev-parse", "HEAD");

  assert.strictEqual(remoteMovedAhead(work, "main", oid), true, "never fetched");
  git(work, "fetch", "origin");
  assert.strictEqual(remoteMovedAhead(work, "main", oid), true, "fetched but local main still behind");
  git(work, "merge", "--ff-only", "origin/main");
  assert.strictEqual(remoteMovedAhead(work, "main", oid), false, "caught up");
  assert.strictEqual(remoteMovedAhead(work, "main", "not-a-sha"), false, "garbage oid never flags");
});

test("parseNextRefs: the shapes that appear in real next steps", () => {
  const cases = [
    ["Merge PR #8, the draggable and collapsible widget", [{ type: "pr", n: 8 }]],
    ["Land PRs #6 and #7, then tag v1.1.1", [{ type: "pr", n: 6 }, { type: "pr", n: 7 }]],
    ["Feel-test PR #219 on both phones, then merge", [{ type: "pr", n: 219 }]],
    ["Offline-signal follow-up, issue #182", [{ type: "issue", n: 182 }]],
    ["PR #1 has two fix commits blocked by the pre-push gate", [{ type: "pr", n: 1 }]],
    ["Post the v0.2.0 announcement, still unposted", []],
    ["Batch 4, the OHLC and session family, is the declared next", []],
    ["Review https://github.com/Tatendaz/yapui/pull/6 carefully", []],
    ["Close the remaining issues 2 weeks after launch", []],
    ["Ship PRs 6 and 7 properly", []],
  ];
  for (const [step, want] of cases)
    assert.deepStrictEqual(parseNextRefs(step), want, step);
});

test("stepRepoFor: cross-project mention wins, else the card's own repo", () => {
  const projects = [
    { id: "cicd", path: "~/Projects/cicd" },
    { id: "pups", path: "~/Projects/promptups" },
    { id: "yapui", path: "~/Projects/yapui" },
  ];
  const [cicd, , yapui] = projects;
  assert.strictEqual(stepRepoFor("Merge promptups PR #8, then run promptups init", cicd, projects, "Tatendaz"),
    "tatendaz/promptups");
  assert.strictEqual(stepRepoFor("Merge PR #8, the draggable widget", yapui, projects, "Tatendaz"),
    "tatendaz/yapui");
  assert.strictEqual(stepRepoFor("Merge the social-preview PRs #2 on promptups and yapui", cicd, projects, "Tatendaz"),
    null, "two repos named: no right pairing exists, refuse to guess");
  assert.strictEqual(ghFullFor({ ghRepo: "claude-usage", path: "~/x/claude_usage_plugin" }, "Tatendaz"),
    "tatendaz/claude-usage");
  assert.strictEqual(ghFullFor({ path: "~/x/thing" }, ""), null, "no owner, no slash: unresolvable");
});

test("pruneDoneNext: drops only steps whose every ref is provably finished", t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-prstate-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "prstate.json");
  const projects = [{ id: "yapui", path: "~/Projects/yapui" }];
  const reg = projects[0];
  const states = { "pr:tatendaz/yapui#8": '{"state":"MERGED"}', "issue:tatendaz/yapui#3": '{"state":"CLOSED"}' };
  let calls = 0;
  const rr = makeRefResolver([], { file, lookup: (type, repo, n) => { calls++; return states[type + ":" + repo + "#" + n] || null; } });

  const next = [
    "Merge PR #8, the draggable and collapsible widget",   /* merged → dropped */
    "Close issue #3 after verifying",                      /* closed → dropped */
    "Merge PR #99, the mystery branch",                    /* unknown → kept */
    "Post the v0.2.0 announcement, still unposted",        /* no refs → kept */
  ];
  const out = pruneDoneNext(next, reg, projects, "Tatendaz", rr);
  assert.deepStrictEqual(out, [
    "Merge PR #99, the mystery branch",
    "Post the v0.2.0 announcement, still unposted",
  ]);
  rr.save();

  /* terminal answers persist: a fresh resolver re-prunes from the cache alone */
  const rr2 = makeRefResolver([], { file, lookup: () => { throw new Error("must not be called"); } });
  assert.strictEqual(rr2.resolve("pr", "tatendaz/yapui", 8), "MERGED");
  assert.strictEqual(rr2.resolve("issue", "tatendaz/yapui", 3), "CLOSED");

  /* the open-PR list answers without any lookup */
  const rr3 = makeRefResolver([{ number: 219, repository: { nameWithOwner: "Tatendaz/familytreeapp" } }],
    { file, lookup: () => { throw new Error("must not be called"); } });
  assert.strictEqual(rr3.resolve("pr", "tatendaz/familytreeapp", 219), "OPEN");
});

test("makeRefResolver: CLOSED expires and a reopened item keeps its step", t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-reopen-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "prstate.json");
  const projects = [{ id: "yapui", path: "~/Projects/yapui" }];
  const reg = projects[0];
  const DAY = 24 * 3600000;

  /* a CLOSED answer from 8 days ago must go back to the network — and the
     item has been reopened since */
  fs.writeFileSync(file, JSON.stringify({
    "issue:tatendaz/yapui#3": { s: "CLOSED", at: Date.now() - 8 * DAY },
    "issue:tatendaz/yapui#4": { s: "CLOSED", at: Date.now() - 1 * DAY },
    "pr:tatendaz/yapui#8": { s: "MERGED", at: Date.now() - 300 * DAY },
  }));
  let calls = 0;
  const rr = makeRefResolver([], { file, lookup: () => { calls++; return '{"state":"OPEN"}'; } });
  assert.strictEqual(rr.resolve("issue", "tatendaz/yapui", 3), "OPEN", "stale CLOSED re-checked");
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(
    pruneDoneNext(["Close issue #3 after verifying"], reg, projects, "Tatendaz", rr),
    ["Close issue #3 after verifying"], "reopened item keeps its step");

  /* fresh CLOSED and any-age MERGED still answer from the cache alone */
  assert.strictEqual(rr.resolve("issue", "tatendaz/yapui", 4), "CLOSED");
  assert.strictEqual(rr.resolve("pr", "tatendaz/yapui", 8), "MERGED");
  assert.strictEqual(calls, 1, "no further lookups");

  /* the refreshed OPEN answer persists */
  rr.save();
  const rr2 = makeRefResolver([], { file, lookup: () => { throw new Error("must not be called"); } });
  assert.strictEqual(rr2.resolve("issue", "tatendaz/yapui", 3), "OPEN");
});
