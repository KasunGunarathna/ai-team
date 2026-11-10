# BE Ticket Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate backend ticket team (Rocco and Gigi as Claude devs, Quinn as Codex QA) that takes a pasted Jira ticket for reviewcook-api or giftlips-api. The team plans it, implements it, QAs it on a fresh branch from `origin/main`, pushes, and produces a Jira comment ready to copy.

**Architecture:** A BE ticket is stored as a `state.projects` record with `kind: 'be-ticket'` and exactly one task whose id is the Jira key. Runs, logs, decisions, tokens, sounds and the existing `/api/state` all work for it unchanged. A new `runBeTicket` flow in `app/server.js` replaces PM/BA planning and merging with five steps: baseline, then dev, then QA, then commit+push, then comment. The scheduler gets a second capacity pool (`team: 'be'`), so neither team waits for the other. Pure logic (repo-from-key, GitHub URL, SUMMARY parsing, comment building, baseline parsing) goes in `app/lib.js` with unit tests.

**Tech Stack:** Node.js (ESM, no framework), `node --test`, plain HTML/SVG/JS front end, `claude` CLI (devs), `codex` CLI (QA).

**Spec:** `docs/superpowers/specs/2026-11-10-be-ticket-team-design.md`

## Global Constraints

- Repos: `reviewcook-api` = `~/Development/QRTiger/ReviewCook/reviewcook-api`, prefix `RECK-`, env file `.env`. `giftlips-api` = `~/Development/QRTiger/GiftLips/giftlips-api`, prefix `GIF-`, env file `.env.test`. Base branch is `main` for both. Paths can be overridden by `RECK_API_DIR` / `GIF_API_DIR`, which are used only for the smoke test.
- Roles and names: `rc-dev` = Rocco (Claude), `gl-dev` = Gigi (Claude), `be-qa` = Quinn (Codex).
- Branch = the Jira key (or the override the product owner sets), created from `origin/main` in `data/worktrees/<projectId>/<KEY>`. Never reuse, overwrite or force-push an existing branch. Never touch the product owner's checkout.
- Push: `git push -u origin <branch>`, never with `--force`, with env `GIT_TERMINAL_PROMPT=0` and a 120 s timeout.
- Never copy, read or touch `.env.staging` or `.env.production`. Never start, stop or reset Docker or databases.
- Max 2 fix cycles (the existing `MAX_FIX_CYCLES`). Ticket-team capacity is 3 jobs, separate from `MAX_AGENTS`.
- Commit message: `feat(<KEY>): <title>`, or `fix(<KEY>): <title>` for a Bug, with the body `QA: PASS (Codex), fix cycles: N`. These commits made by the app get no attribution line, like the existing `feat(TASK)` commits.
- The Jira comment is plain text, in exactly the formats in the spec ("Jira comment format").
- Memory: `data/be-tickets.json`, written atomically (tmp file + rename).
- Never cut: the secret-file check and the agent-config check before commit.

## Review Focus

1. **Branch already exists** (local, or only on origin, for example `RECK-116`): the ticket is BLOCKED with a clear message, nothing is reused, and the "Use branch name" input lets the product owner retry with a new name.
2. **Push rejected or auth failure**: the ticket ends DONE with `outcome: 'push_failed'`. The decision shows git's exact stderr, and the comment says `Branch: <b> (not pushed yet)` with no link.
3. **Dev makes no file changes**: QA, commit and push are skipped, the branch is deleted (it has no commits), and the comment uses the no-code format.
4. **Baseline cannot run** (DB down, missing deps): the ticket is BLOCKED before any dev run, with QA's error text.
5. **Removing a ticket or restarting it never deletes a branch that has commits** beyond its base (pushed work or committed work).

Each line has a test or a smoke check in the task that owns that code (Tasks 1, 4 and 6).

---

## File map

- Modify `app/lib.js`: pure BE helpers.
- Modify `app/lib.test.js`: tests for them.
- Create `.claude/agents/rc-dev.md`, `.claude/agents/gl-dev.md`, `.claude/agents/be-qa.md`.
- Modify `app/server.js`: roles, pools, intake, flow, push, comment, memory, decisions, remove/retry.
- Modify `app/index.html`: BE tickets tab, form, card.
- Modify `app/office.html`: three new agents, the BE ticket lounge, laptops, holds, labels.
- Modify `README.md`: a "BE ticket team" section.
- Create `app/be-smoke.sh`: a smoke test against throwaway git repos (no agent runs).

---

### Task 1: Pure BE helpers in lib.js

**Files:**
- Modify: `app/lib.js` (append)
- Test: `app/lib.test.js` (append)

**Interfaces:**
- Produces:
  - `BE_PREFIXES = { 'RECK-': 'reviewcook-api', 'GIF-': 'giftlips-api' }`
  - `repoForKey(key: string) => 'reviewcook-api' | 'giftlips-api' | null`
  - `githubTreeUrl(remote: string, branch: string) => string | null`: accepts `https://[user@]github.com/O/R(.git)` and `git@github.com:O/R(.git)`, and URL-encodes each branch path segment.
  - `summarySections(md: string) => Record<string, string>`: keys are `##` headings lowercased and trimmed, values are trimmed bodies.
  - `parseBaseline(text: string) => { ran: boolean, command: string, failing: string[], error: string | null }`: from JSON. Invalid JSON gives `{ ran: false, command: '', failing: [], error: 'baseline.json missing or invalid' }`.
  - `commitType(ticketText: string) => 'fix' | 'feat'`: `fix` when a line matches `/^\s*(#+\s*)?(type\s*:?\s*)?bug\b/im`.
  - `ticketTitle(ticketText: string) => string`: first non-empty line, without leading `#`, the key and `:`, clipped to 72 chars.
  - `jiraComment({ key, outcome, sections, cycles, baselineFailing, branch, branchUrl }) => string`: `outcome` is `'pushed' | 'push_failed' | 'no_code'`.

- [ ] **Step 1: Write the failing tests**

```js
test('repoForKey maps Jira prefixes', () => {
  assert.equal(repoForKey('RECK-12'), 'reviewcook-api');
  assert.equal(repoForKey('GIF-1824'), 'giftlips-api');
  assert.equal(repoForKey('MINT-1'), null);
  assert.equal(repoForKey('RECKX-1'), null);
});

test('githubTreeUrl handles https, user@ and ssh remotes', () => {
  assert.equal(githubTreeUrl('https://kasun-gx@github.com/QRTiger/giftlips-api.git', 'GIF-1'), 'https://github.com/QRTiger/giftlips-api/tree/GIF-1');
  assert.equal(githubTreeUrl('https://github.com/QRTiger/reviewcook-api.git', 'RECK-9'), 'https://github.com/QRTiger/reviewcook-api/tree/RECK-9');
  assert.equal(githubTreeUrl('git@github.com:QRTiger/reviewcook-api.git', 'a/b'), 'https://github.com/QRTiger/reviewcook-api/tree/a/b');
  assert.equal(githubTreeUrl('https://gitlab.com/x/y.git', 'b'), null);
});

test('summarySections splits on ## headings', () => {
  const s = summarySections('# Title\n## Backend changes\n- a\n\n## FE dev notes\nNone\n');
  assert.equal(s['backend changes'], '- a');
  assert.equal(s['fe dev notes'], 'None');
});

test('parseBaseline validates', () => {
  assert.deepEqual(parseBaseline('{"ran":true,"command":"npm test","failing":["x > y"]}'), { ran: true, command: 'npm test', failing: ['x > y'], error: null });
  assert.equal(parseBaseline('nope').ran, false);
  assert.equal(parseBaseline('{"ran":false,"error":"ECONNREFUSED 5432"}').error, 'ECONNREFUSED 5432');
});

test('commitType and ticketTitle', () => {
  assert.equal(commitType('## Type\nBug\n'), 'fix');
  assert.equal(commitType('Type: Story'), 'feat');
  assert.equal(ticketTitle('\n# RECK-12: Fix login timeout\nmore'), 'Fix login timeout');
});

test('jiraComment pushed / push_failed / no_code', () => {
  const sections = { 'backend changes': '- added X', 'files changed': '- src/a.ts', tests: '- npm test', 'fe dev notes': 'None', 'open questions / assumptions': '- none' };
  const ok = jiraComment({ key: 'RECK-1', outcome: 'pushed', sections, cycles: 1, baselineFailing: [], branch: 'RECK-1', branchUrl: 'https://github.com/QRTiger/reviewcook-api/tree/RECK-1' });
  assert.match(ok, /^AI Team — RECK-1 done \(QA passed\)/);
  assert.match(ok, /Fix cycles: 1/);
  assert.match(ok, /Already failing on main \(not caused by this change\):\n- None/);
  assert.match(ok, /Branch: https:\/\/github\.com\/QRTiger\/reviewcook-api\/tree\/RECK-1\nMerge: manual$/);
  const bad = jiraComment({ key: 'RECK-1', outcome: 'push_failed', sections, cycles: 0, baselineFailing: ['a > b'], branch: 'RECK-1', branchUrl: null });
  assert.match(bad, /Branch: RECK-1 \(not pushed yet\)/);
  assert.match(bad, /- a > b/);
  const nc = jiraComment({ key: 'GIF-2', outcome: 'no_code', sections: { findings: '- data issue', steps: '1. run X' }, cycles: 0, baselineFailing: [], branch: null, branchUrl: null });
  assert.match(nc, /^AI Team — GIF-2: no code change needed\n\nFindings:\n- data issue\n\nSteps:\n1\. run X/);
  assert.doesNotMatch(nc, /Branch:/);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm test`
Expected: FAIL with `SyntaxError: The requested module './lib.js' does not provide an export named 'repoForKey'` (add the new names to the test file's import line).

- [ ] **Step 3: Implement the helpers in `app/lib.js`**

The comment layout follows the spec exactly:
- A missing section prints `- None`.
- The pushed and push_failed variants have a `Tests:` section: the dev's `tests` section, then the line `- QA (Codex): PASS. Fix cycles: N`.
- The sections are separated by blank lines.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test`
Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add app/lib.js app/lib.test.js
git commit -m "feat(be-team): pure helpers for BE tickets"
```

---

### Task 2: Agent definitions

**Files:**
- Create: `.claude/agents/rc-dev.md`, `.claude/agents/gl-dev.md`, `.claude/agents/be-qa.md`

**Interfaces:**
- Produces: `agentBody('rc-dev' | 'gl-dev' | 'be-qa')` returns their bodies (the existing reader strips the frontmatter).

- [ ] **Step 1: Write the three files**

Frontmatter: `name`, `description`, `tools: Read, Glob, Grep, Edit, Write, Bash, Skill` (devs) or `Read, Glob, Grep, Bash` (QA). Body rules for the devs (rc-dev names reviewcook-api, gl-dev names giftlips-api):
- No human is in the loop. Never wait for answers: decide, and record each decision under "Open questions / assumptions".
- Use `superpowers:writing-plans` thinking to write `.aiteam/<KEY>/PLAN.md` first, then `superpowers:test-driven-development`. Follow ponytail: the smallest complete change.
- Backend only. Describe FE impact in "FE dev notes".
- Do not commit, push, switch branches or edit `.env*`. Do not start, stop or reset Docker or databases.
- Write `.aiteam/<KEY>/SUMMARY.md` with exactly these `##` headings:
  - code change: `Backend changes`, `Files changed`, `Tests`, `FE dev notes`, `Open questions / assumptions`;
  - no code needed: `Findings`, `Steps`, `Open questions / assumptions`, with no source files changed.
- If `package.json` changes: `rm node_modules` (it is a symlink) and run `npm ci` (reviewcook) or `yarn install --frozen-lockfile` (giftlips).

`be-qa.md` is a copy of `qa-engineer.md`'s rules, plus this: compare test failures against the baseline list given in the prompt, and fail only for new failures or unmet acceptance criteria.

- [ ] **Step 2: Verify they load**

Run: `node -e "import('fs').then(f=>['rc-dev','gl-dev','be-qa'].forEach(n=>console.log(n, f.readFileSync('.claude/agents/'+n+'.md','utf8').startsWith('---'))))"`
Expected: three lines ending in `true`.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/rc-dev.md .claude/agents/gl-dev.md .claude/agents/be-qa.md
git commit -m "feat(be-team): agent definitions for Rocco, Gigi and Quinn"
```

---

### Task 3: Roles, separate scheduler pool, intake API, memory

**Files:**
- Modify: `app/server.js`
- Modify: `app/lib.js` + `app/lib.test.js` (for `poolOf`)

**Interfaces:**
- Consumes: `repoForKey`, `ticketTitle` (Task 1).
- Produces:
  - `BE_REPOS = { 'reviewcook-api': { dir, envFile: '.env', dev: 'rc-dev' }, 'giftlips-api': { dir, envFile: '.env.test', dev: 'gl-dev' } }` (with `dir` overridable by `RECK_API_DIR` / `GIF_API_DIR`).
  - `NICK` gains `'rc-dev': 'Rocco', 'gl-dev': 'Gigi', 'be-qa': 'Quinn'`.
  - `engineOf(role)` returns `'codex'` for `qa`, `ui-ux` and `be-qa`.
  - lib: `poolOf(p) => p.kind === 'be-ticket' ? 'be' : 'main'`.
  - `BE_MAX = 3`.
  - Each job spec carries `team: poolOf(p)`.
  - The BE ticket record is `{ id, kind: 'be-ticket', ticketKey, repo, name: KEY, path: repo.dir, idea, status: 'APPROVED', auto: true, branch: KEY, planDir: '.aiteam/KEY', taskDir: '.aiteam/KEY', tasks: [{ id: KEY, title, owner: repo.dev, status: 'READY', dependsOn: [], phase: 1, cycles: 0, runs: [] }], runs: [], decisions: [], allowTools: [], runBudget: 0 }`.
  - `remember(p, t)` writes `data/be-tickets.json[`${p.repo}/${p.ticketKey}`]`.
  - `pastTickets(repo) => string`: the last 10 DONE entries for that repo, as lines like `- KEY: summary line (files: a, b)`.

- [ ] **Step 1: Failing test for `poolOf`**

```js
test('poolOf separates BE tickets from the project team', () => {
  assert.equal(poolOf({ kind: 'be-ticket' }), 'be');
  assert.equal(poolOf({ kind: 'ticket' }), 'main');
  assert.equal(poolOf({ kind: 'idea' }), 'main');
});
```

Run: `npm test`. Expected: FAIL (no export `poolOf`).

- [ ] **Step 2: Implement `poolOf` and the scheduler split**
  - `startNext(team)` considers only `state.projects.filter((p) => poolOf(p) === team)`.
  - `inFocus` applies only when `team === 'main'`.
  - For the `be` team, a project is eligible when `p.kind === 'be-ticket'` and its task is READY (ignore `runBudget`). The task's agent comes from `roleFree(t.skipDev ? 'be-qa' : t.owner)`. The job runs `runBeTicket` (Task 4).
  - `tick()` runs `while (teamJobs('main') < MAX_AGENTS && startNext('main'));` then `while (teamJobs('be') < BE_MAX && startNext('be'));`, where `teamJobs(team) = [...jobs.values()].filter((j) => j.team === team).length`.
  - The daily run skips `be-ticket` projects.

- [ ] **Step 3: Intake branch in `POST /api/projects`**

When `body.kind === 'be-ticket'`:
- Validate the key with `/^[A-Z][A-Z0-9]*-\d+$/`, then `repoForKey`. Errors:
  - `'Jira key must start with RECK- (ReviewCook) or GIF- (GiftLips)'`
  - `'Ticket text is required'`
  - `'<KEY> is already added. Remove the old one first.'`
  - `'Repo folder not found: <dir>'`
- Append `.aiteam/` to the repo's `info/exclude`, using the existing code moved into a helper `excludeIn(repoDir, entry)`.
- Push the record, call `remember`, `save()`, `kick()`, and return 201 `{ id }`.
- Ignore `name` and `path` from the body.

- [ ] **Step 4: Memory**

Write `remember(p, t)` and `pastTickets(repo)`. The record fields are listed in the spec under "JSON memory". The plan, summary and comment text are read from the worktree files when they exist. Write with tmp file + `renameSync`.

- [ ] **Step 5: Run the tests and commit**

Run: `npm test`. Expected: all pass. Also run `node --check app/server.js`, which should exit 0.

```bash
git add app/server.js app/lib.js app/lib.test.js
git commit -m "feat(be-team): roles, separate scheduler pool, ticket intake and memory"
```

---

### Task 4: runBeTicket flow (workspace, baseline, dev, QA, commit, push, comment)

**Files:**
- Modify: `app/server.js`

**Interfaces:**
- Consumes: Task 1 helpers; Task 3's `BE_REPOS`, `remember`, `pastTickets`; the existing `agentRun`, `claudeArgs`, `block`, `configChanges`, `secretFiles`, `parseVerdict`, `appendToTask`-style logging, and `HANDOFF_AT`/`MAX_HANDOFFS`.
- Produces:
  - `beWorktree(p, t)`: returns the worktree dir, or throws `Error('Branch <b> already exists (local or on origin). Choose another branch name on the ticket card.')`.
  - `removeBeWorktree(p, t)`: removes the worktree, and deletes the local branch only if `git rev-list --count origin/main..<b>` is `0`.
  - `pushBranch(p) => { ok: true, url } | { ok: false, error }`.
  - `finishBe(p, t, outcome, extra)`: sets `t.status = 'DONE'`, `t.outcome`, `t.comment`, `t.branchUrl`, calls `remember`, and saves.
  - `claudeArgs(agent, prompt, tools, extra = [])`: the 4th param is appended (for `--plugin-dir`).
  - `PLUGIN_DIRS`: the newest version dir under `~/.claude/plugins/cache/claude-plugins-official/superpowers/` and under `~/.claude/plugins/cache/ponytail/ponytail/` (by `localeCompare` with `{numeric: true}`). A missing dir is skipped, and `say()` notes it once at startup.

- [ ] **Step 1: Workspace**

In `beWorktree`:
1. `git fetch -q origin main` in `p.path`.
2. Check whether the branch exists: `refs/heads/<b>` locally, or `git ls-remote --exit-code --heads origin <b>` (exit 2 means absent).
3. Run `git worktree add -q --no-track -b <b> <dir> origin/main`, then set `t.baseSha = git rev-parse origin/main`.
4. If `<repo>/node_modules` exists, `symlinkSync` it to `<dir>/node_modules`.
5. Copy `envFile` from the repo into the worktree only when it exists in the repo and `git ls-files --error-unmatch <envFile>` fails (that is, it is untracked).
6. Add `node_modules` and the env file to the shared `info/exclude` with `excludeIn`.

On reuse (the dir exists with `.git`), return it as is.

- [ ] **Step 2: Baseline**

Skip this when `t.baseline` is set. Otherwise:
1. Set `t.status = 'QA'` and `t.note = 'Baseline test run on clean main'`.
2. Run Codex as role `be-qa` with label `<KEY>-baseline`. The prompt asks it to run the repo's real test command and write `.aiteam/<KEY>/baseline.json` as `{"ran":true|false,"command":"...","failing":["<suite> > <test>"],"error":null|"..."}`, and to edit nothing else.
3. Parse the result with `parseBaseline`. If `!ran`, return `block(p, t, 'Baseline tests could not run on clean main: <error>. Start what the tests need (DB, Redis), then retry.')`.
4. Store `t.baseline`.

Limit and auth pauses park the ticket exactly as `runTask` does. Copy its `park` and `holdFor` closures, using roles `t.owner` and `be-qa`.

- [ ] **Step 3: Dev cycle**

This follows the `runTask` dev branch, with these differences:
- Role `t.owner`.
- Prompt = ticket text + the paths `.aiteam/<KEY>/PLAN.md` and `SUMMARY.md` + `Past tickets in this repo:\n${pastTickets(p.repo)}` + feedback, interrupt and handoff text as in `runTask`.
- Tools = `[...DEV_TOOLS, 'Skill', ...p.allowTools]`.
- Extra args = `PLUGIN_DIRS.flatMap((d) => ['--plugin-dir', d])`.
- Afterwards, if `SUMMARY.md` is missing, `block(p, t, 'Dev finished without writing .aiteam/<KEY>/SUMMARY.md')`.
- **No-code path:** if `git status --porcelain` in the worktree is empty:
  1. `removeBeWorktree` (this deletes the branch, because it has 0 commits);
  2. `finishBe(p, t, 'no_code', …)`, with the comment from `jiraComment({ outcome: 'no_code', … })`;
  3. return `true`.

- [ ] **Step 4: QA cycle**

This follows the `runTask` QA branch:
- Role `be-qa`, label `<KEY>-qa-<cycle>`.
- Prompt = `agentBody('be-qa')` + ticket text + `Baseline failures on clean main (ignore these): <list or none>` + the uncommitted-diff instructions + the verdict line. FAIL and BLOCKED behave as in `runTask`.

- [ ] **Step 5: Commit and push on PASS**

1. Run the same secret and config checks as `runTask`.
2. Commit with `` `${commitType(p.idea)}(${KEY}): ${t.title}` `` and the body `QA: PASS (Codex), fix cycles: N`.
3. Remove the worktree (the local branch is kept, because it now has a commit).
4. Run `pushBranch(p)`:
   - Command: `execFile('git', ['push', '-u', 'origin', p.branch], { cwd: p.path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 })`.
   - On success, the URL is `githubTreeUrl(git(p.path, 'remote', 'get-url', 'origin'), p.branch)`.
5. If the push succeeds: `finishBe(p, t, 'pushed', { branchUrl })`.
6. If it fails: `finishBe(p, t, 'push_failed')`, then `addDecision(p, { kind: 'push', taskId: KEY, question: 'Push of <b> failed. The branch is committed locally in <repo dir>.', detail: <stderr>, options: [['retry', 'Retry push'], ['manual', "I'll push myself"]] })`.

Build the comment with `summarySections(SUMMARY.md)`. Read SUMMARY.md before removing the worktree, and keep the text in `t.summary`.

- [ ] **Step 6: Crash recovery**

The startup migration already resets IN_PROGRESS, QA and CHANGES_REQUESTED tasks to READY. Confirm that `runBeTicket` reuses the worktree and skips the baseline when `t.baseline` is set.

- [ ] **Step 7: Syntax check and commit**

Run: `node --check app/server.js && npm test`. Expected: exit 0, all tests pass.

```bash
git add app/server.js
git commit -m "feat(be-team): ticket flow: baseline, dev, QA, commit, push, Jira comment"
```

---

### Task 5: Decisions, retry, branch override, remove

**Files:**
- Modify: `app/server.js`

**Interfaces:**
- Consumes: `removeBeWorktree`, `pushBranch`, `finishBe`, `jiraComment` (Task 4).
- Produces:
  - `POST /api/projects/:id/branch { branch }` → 200, or 400 `'Invalid branch name'`. It validates with `git check-ref-format --branch <b>`, and only works when the task is BLOCKED.

- [ ] **Step 1:** In `applyAnswer`, handle `kind === 'push'`.
  - `retry`: run `pushBranch`. On success set `outcome: 'pushed'`, rebuild the comment with the link, and call `remember`. On failure, add a new push decision with the new stderr.
  - `manual`: keep `push_failed`, and note "You chose to push yourself".
- [ ] **Step 2:** In `retryTask`, for `be-ticket`, `restart` calls `removeBeWorktree` (never `removeWorktree`) and clears `t.baseline`. `continue` keeps both.
- [ ] **Step 3:** In the `remove` action, for `be-ticket`, call `removeBeWorktree` when the worktree exists. Do not call the `_integration` cleanup. Drop the memory entry only if the ticket is not DONE; finished tickets stay in memory.
- [ ] **Step 4:** Add the branch endpoint. It sets `p.branch`, `t.status = 'READY'`, `t.note = null` and clears the blocked decision.
- [ ] **Step 5:** Run `node --check app/server.js && npm test`, then commit:

```bash
git add app/server.js
git commit -m "feat(be-team): push retry, branch override, safe remove and restart"
```

---

### Task 6: Smoke test without agents

**Files:**
- Create: `app/be-smoke.sh`

- [ ] **Step 1: Write the script.** It must:
  1. Make temp dirs: a bare `origin.git`, plus clones `reck` and `gif` with one commit on `main`, pushed. Also push an extra branch `RECK-116` to origin.
  2. Start the server with `AI_TEAM_DATA=$tmp/data PORT=4399 RECK_API_DIR=$tmp/reck GIF_API_DIR=$tmp/gif node app/server.js &`.
  3. Put Rocco and Gigi on a break first (`POST /api/break {role:'rc-dev',on:true}`, and the same for `gl-dev`), so no agent ever runs.
  4. Check:
     - `POST /api/projects {kind:'be-ticket',ticketKey:'MINT-1',idea:'x'}` → 400 with `RECK-`.
     - `{kind:'be-ticket',ticketKey:'RECK-5',idea:'Fix X'}` → 201. `/api/state` then shows a project with `kind:'be-ticket'`, `repo:'reviewcook-api'`, and a task with `owner:'rc-dev'` and `status:'READY'`.
     - Posting the same key again → 400 `already added`.
     - `$tmp/reck/.git/info/exclude` contains `.aiteam/`.
     - `data/be-tickets.json` has key `reviewcook-api/RECK-5`.
     - The git status of `reck` is unchanged, and its branch is still `main`.
  5. Kill the server and remove the temp dir.

  It exits non-zero on the first failed check (`set -euo pipefail`, plus `curl -sf` / `grep -q`).
- [ ] **Step 2: Run it.** Run: `bash app/be-smoke.sh`. Expected: it ends with `BE smoke OK`.
- [ ] **Step 3: Commit**

```bash
git add app/be-smoke.sh
git commit -m "test(be-team): smoke test for ticket intake"
```

---

### Task 7: Board UI: BE tickets tab

**Files:**
- Modify: `app/index.html`

- [ ] **Step 1:** Add a tab button `data-tab="be-ticket"` labelled `BE tickets`. Add a form `#newBeTicket` (`data-kind="be-ticket"`, hidden) with:
  - input `ticketKey` (placeholder `RECK-123 or GIF-123`);
  - a read-only line under it showing `→ ReviewCook API (Rocco)` / `→ GiftLips API (Gigi)` / `Key must start with RECK- or GIF-`, updated on `input`;
  - a textarea `idea` (`Paste the Jira ticket: summary, type, description, acceptance criteria`);
  - a submit button `Add BE ticket`.

  It posts `{ kind: 'be-ticket', ticketKey, idea }`. Reuse the existing form submit and tab-switch code paths. The existing code finds forms by `data-kind`.
- [ ] **Step 2:** In `render()`, for `kindOf(p) === 'be-ticket'`:
  - Show the pills `BE ticket`, the repo, and the outcome label: `DONE · pushed`, `DONE · push failed`, `DONE · no code`, or the task status otherwise.
  - Hide the PM/BA, plan, run, auto, edit and design-reference controls.
  - Show the task's run list (the existing `runList`) and the decisions (the existing `decisionNode`; add `push: 'Optional note'` to `NOTE_HINT`).
  - When BLOCKED and `t.note` starts with `Branch `, show a "Use branch name" input that posts to `/api/projects/:id/branch`.
  - When `t.comment` exists, show a read-only `<textarea>` with the comment, a `Copy comment` button (`navigator.clipboard.writeText`, with the button text set to `Copied ✓` for 2 s), and, if `t.branchUrl` is set, the link opening in a new tab.
- [ ] **Step 3: Manual check.** Run `npm start`, open `http://localhost:4317/board`, and confirm:
  - the BE tickets tab shows;
  - typing `GIF-1` shows `→ GiftLips API (Gigi)`;
  - adding a ticket while Gigi is on a break (office card) shows a READY card with no PM/BA buttons.

  Remove the ticket afterwards.
- [ ] **Step 4: Commit**

```bash
git add app/index.html
git commit -m "feat(be-team): BE tickets tab with copyable Jira comment"
```

---

### Task 8: Office: BE ticket lounge with sofa and laptops

**Files:**
- Modify: `app/office.html`

**Interfaces:**
- Consumes: the roles `rc-dev`, `gl-dev`, `be-qa`, and job labels `<KEY>-dev-N[-sK]`, `<KEY>-qa-N`, `<KEY>-baseline`.

- [ ] **Step 1:** Change the viewBox to `0 0 1400 880`, and the `#nightveil` height to `880`. Draw a "🛋️ BE ticket lounge" strip in y 720–880 (floor, a sign, a rug, a long sofa back at about x 420–980 and y 780), below the existing scene and above `#desks`.
- [ ] **Step 2:** Add to `TEAM`, each with a new field `sofaX`:
  - `{ role: 'rc-dev', name: 'Rocco', title: 'ReviewCook dev', engine: 'Claude', shirt: '#f08c00', hair: '#343a40', skin: '#c68642', style: 'phones', sofaX: 540 }`
  - `{ role: 'gl-dev', name: 'Gigi', title: 'GiftLips dev', engine: 'Claude', shirt: '#d6336c', hair: '#5f3dc4', skin: '#ffdbac', style: 'long', sofaX: 700 }`
  - `{ role: 'be-qa', name: 'Quinn', title: 'Ticket QA', engine: 'Codex', shirt: '#2f9e44', hair: '#a0522d', skin: '#e0ac69', style: 'glasses', sofaX: 860 }`

  Leave `DESK_X` unchanged. The desk-building loop runs only for members without `sofaX`. For sofa members, build a laptop group with `class="desk" id="desk-<role>"`, containing the same `.glow`, `.scr`, `.code` and `.lowbat` children scaled to a laptop (about 70×44), drawn in `#front` at `(sofaX, 800)`, so `.on` and `.lowbat` keep working. Draw the sofa front and arms in `#front`.
- [ ] **Step 3:** Change `engineOf` to `['qa', 'ui-ux', 'be-qa'].includes(role) ? 'codex' : 'claude'`. In `update()`:
  - An active member with `sofaX` sits at `(sofaX, 772)` with spot `'sofa-<role>'`. Do not set the `back` class for them (they face the viewer, laptop on lap). The verb is `🔍 Testing` for `be-qa` and `⌨️ Coding` otherwise.
  - Change the label regex in `update` and `taskTitle` to `/-(dev|qa|baseline)(-\d+)?(-s\d+)?$/`.
  - Idle, tea, limit and door behaviour stays as is (they wander to shared spots).
- [ ] **Step 4:** Update the engine "who" strings:
  - `'Mira, Bolt and Pixel'` becomes `'Mira, Bolt, Pixel, Rocco and Gigi'`;
  - `'Bugsy and Iris'` becomes `'Bugsy, Iris and Quinn'`;
  - the usage-card strings change to match.

  In `drawBoard`, filter out `be-ticket` projects.
- [ ] **Step 5: Manual check.** Run `npm start` and open `http://localhost:4317/`. Confirm:
  - the lounge strip shows three people with laptops;
  - nobody overlaps the pong table or the café;
  - Quinn's laptop shows `🔋 LOW` when the Codex limit is active (temporarily set `state.limits.codex` in `data/state.json` to a future ms while the server is stopped, then restore it).
- [ ] **Step 6: Commit**

```bash
git add app/office.html
git commit -m "feat(be-team): BE ticket lounge with Rocco, Gigi and Quinn"
```

---

### Task 9: README and the first real ticket

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Add a "BE ticket team" section after "Jira tickets on an existing project". It covers:
  - who is on the team;
  - the key prefixes;
  - the flow;
  - which env file is copied, and that `.env.staging` and `.env.production` are never used;
  - that the DB and Redis must be running;
  - the comment and Copy button;
  - the push failure options;
  - `data/be-tickets.json`;
  - that merging is manual.
- [ ] **Step 2:** Run `npm test && bash app/be-smoke.sh`. Expected: everything passes, ending with `BE smoke OK`.
- [ ] **Step 3:** Commit.

```bash
git add README.md
git commit -m "docs: BE ticket team"
```

- [ ] **Step 4 (product owner, manual):** Add one small real `RECK-` or `GIF-` ticket and watch it reach DONE. Check the branch on GitHub and the comment. This is the only end-to-end check with real agents. The plan does not automate it, because it spends Claude and Codex quota and pushes to the real remotes.
