# BE Ticket Team — design

Date: 2026-11-10 · Status: draft for product-owner approval

## Intent

The product owner gets Jira tickets (stories and bugs) for two backend repos, ReviewCook API and GiftLips API. They want to paste a ticket into AI Team and get back a pushed branch plus a Jira comment they can copy straight into the ticket. Merging stays manual.

A separate team handles these tickets so that ticket work never waits for, or takes agents from, the existing project team (Mira, Bolt, Pixel, Bugsy, Iris).

## Goals

- A new **BE ticket team** with three agents of its own:
  - **ReviewCook dev** (Claude): works only in `reviewcook-api`.
  - **GiftLips dev** (Claude): works only in `giftlips-api`.
  - **Ticket QA** (Codex): one agent that tests tickets for both repos, one at a time.
- Flow for each ticket: **plan alone, implement, QA, fix up to 2 times, commit, push, write the Jira comment**. There is no PM/BA run and no plan approval.
- The team has its own capacity. A ticket never waits behind project work, and project work never waits behind a ticket. Work hours, the tea break, per-agent breaks, usage-limit pauses and login pauses still apply to both teams, because they share the same Claude and Codex accounts.
- A Jira comment ready to copy, shown on the ticket card with a Copy button.
- The office shows the new team in a sofa corner (no desks), with every existing animation and sound.

## Non-goals

- No merging, no PRs, no Jira API calls. The product owner merges, opens PRs and pastes comments by hand.
- No frontend work by this team. FE needs are only described in the comment.
- No other repos for now. Adding one later means adding one entry to the repo list (see below).
- No change to the existing project flow or the existing "Jira tickets" (PM/BA-planned) flow.

## Anti-goals (a failure even if it "works")

- Touching the product owner's own checkout of either repo (switching branches, stashing, committing there). All work happens in a worktree under `data/worktrees/`.
- Force-pushing, or pushing to `main` or to any branch other than the ticket's own new branch.
- Overwriting or reusing an existing branch with the same name (for example the existing `RECK-116`).
- Claiming a push succeeded, or giving a branch link, when the push failed.
- A ticket agent blocking or delaying a project-team agent, or the other way round.

## Repos (decided)

| Repo key | Folder | GitHub | Jira key prefix | Dev agent |
|---|---|---|---|---|
| reviewcook-api | `~/Development/QRTiger/ReviewCook/reviewcook-api` | `QRTiger/reviewcook-api` | `RECK-` | ReviewCook dev |
| giftlips-api | `~/Development/QRTiger/GiftLips/giftlips-api` | `QRTiger/giftlips-api` | `GIF-` | GiftLips dev |

- Both repos use `main` as the base branch and `jest` for tests (`npm test`).
- Push auth works from this Mac today: `git push --dry-run` succeeded for both, using the keychain credential and the `gh` login as `kasun-gx`.
- The list is one constant in `app/server.js`. Builder's call: the GitHub web URL comes from parsing `git remote get-url origin`, so it is not hard-coded.

## Ticket intake (decided, with some details as my call)

- A new **BE tickets** tab in `app/index.html` with two fields: Jira key, and ticket text (summary, description, acceptance criteria, pasted from Jira). The repo is shown, read-only, once the key is typed.
- The repo comes from the key prefix (decided): `RECK-` is reviewcook-api, `GIF-` is giftlips-api. A key with any other prefix is rejected.
- The key is validated with the existing `^[A-Z][A-Z0-9]*-\d+$`. A key that is already open for the same repo is rejected.
- The ticket starts right away, as soon as its repo's dev is free. There is no approval step.

## Flow for each ticket (decided)

1. **Branch.** In the repo folder, run `git fetch origin main`. Then create a worktree under `data/worktrees/<ticket id>/` on a new branch named **the Jira key** (for example `RECK-123`), starting from `origin/main`.
   - If a branch with that name already exists, locally or on `origin`, the ticket goes to BLOCKED with a clear message, and the app never reuses or overwrites the branch. *My call:* the product owner can then retry with a branch-name override (for example `RECK-123-v2`) entered on the card.
   - `.aiteam/` is added to the repo's `.git/info/exclude` (the existing pattern), so planning files never get committed.
   - **Test setup (decided):** the app symlinks `node_modules` from the product owner's checkout into the worktree. It copies only the test env file: `.env.test` for giftlips-api, `.env` for reviewcook-api. Both are added to the worktree's `.git/info/exclude`, and the secret-file check still refuses to commit any env file. `.env.staging` and `.env.production` are never copied, read or touched. If the ticket changes `package.json`, the dev replaces the symlink with a real install: `npm ci` for reviewcook (package-lock), `yarn install --frozen-lockfile` for giftlips (yarn.lock). Any DB or Redis the tests need must already be running on the Mac. The team never starts, stops or resets Docker or databases.
   - **Baseline (decided; product-owner decision 2026-11-10):** before the dev starts, **the app itself** runs `npm test -- --json --outputFile=…` once on the clean branch (which equals `origin/main`), outside any sandbox so the tests reach the local DB, and saves the failing tests as the baseline. Later runs fail the ticket only for **new** failures. Baseline failures are listed in the Jira comment under "Already failing on main". If the baseline cannot run at all (for example the DB is down), the ticket goes to BLOCKED with the error before any dev run.
2. **Plan and implement (dev agent, Claude, one session per attempt).** The dev runs with the **superpowers** and **ponytail** plugins loaded, and reads the ticket. Then it:
   - works out the approach on its own: it cannot ask the product owner anything, so it decides, and lists every unclear point as an open question;
   - writes `.aiteam/<KEY>/PLAN.md` (approach, files, tests, open questions);
   - implements with tests, following the repo's conventions and the ponytail rules (smallest complete change);
   - runs the tests;
   - writes `.aiteam/<KEY>/SUMMARY.md` with these sections: **Backend changes**, **Files changed**, **Tests**, **FE dev notes** ("None" if no frontend work is needed), **Open questions / assumptions**.
   - It does not commit. Context hand-off works as it does today.
   - **No code change needed (decided):** some tickets need only feedback, an investigation or steps (for example "data issue, run this", "works as designed", "config change in the admin panel"). The dev then writes SUMMARY.md with **Findings** and **Steps** sections and changes no files. If the worktree diff is empty, the app skips QA, commit and push, deletes the empty branch, and builds a "no code change" Jira comment (format below). The ticket ends as **DONE, no code**.
3. **Tests, then QA (decided 2026-11-10).** After each dev run the app runs the suite again in the same worktree. A new failure (or a suite that cannot run) goes straight back to the dev as feedback and counts as a fix cycle; Quinn is not run. With no new failures, Ticket QA (Codex, **no network**) reviews the uncommitted diff against the acceptance criteria with the app's test results in its prompt, never runs the suite itself, and ends with `VERDICT: PASS|FAIL|BLOCKED`. QA does not edit code.
   - FAIL (bugs found): the report goes back to the same dev, who fixes it in the same worktree and branch. QA then re-tests there. This happens up to **2 fix cycles**. After that the ticket is BLOCKED, using the existing blocked decision (retry with a note, or keep blocked).
   - BLOCKED: the ticket is BLOCKED with the report.
4. **Commit.** On PASS, the existing secret-file and agent-config checks run. Then the app commits with the message `feat(<KEY>): <ticket summary line>` and a body containing `QA: PASS (Codex), fix cycles: N`. *My call:* the prefix is `fix(<KEY>)` when the ticket text says it is a Bug.
5. **Push.** Run `git push -u origin <branch>`, with no force and `GIT_TERMINAL_PROMPT=0` so it can never hang on a password prompt.
   - Success: the link is `https://github.com/<owner>/<repo>/tree/<branch>`.
   - Failure: the ticket ends as **DONE, push failed**. A "Waiting for you" message shows the exact git error and says the branch is committed locally. It offers **Retry push** and **I'll push myself**. The Jira comment is still written, with the line `Branch: <branch> (not pushed yet)` and no link.
6. **Jira comment.** The app (not an agent) builds the comment from SUMMARY.md, the QA verdict and the push result, then stores and shows it.
7. **Clean up.** After a successful push, remove the worktree. The local branch stays.

## Jira comment format (my call, plain text so it pastes cleanly)

```
AI Team — RECK-123 done (QA passed)

Backend changes:
- …

Files changed:
- …

Tests:
- npm test: passed (QA, Codex). Fix cycles: 0

FE dev notes:
- None   (or what the FE dev needs to do: new/changed endpoints, fields, errors)

Open questions / assumptions:
- …

Already failing on main (not caused by this change):
- None   (or the baseline failures)

Branch: https://github.com/QRTiger/reviewcook-api/tree/RECK-123
Merge: manual
```

No-code-change variant:

```
AI Team — RECK-124: no code change needed

Findings:
- …

Steps:
1. …

Open questions / assumptions:
- …
```

## JSON memory (decided: one record per ticket, everything kept)

- `data/be-tickets.json` holds one entry per ticket, keyed by `<repo>/<KEY>`. Each entry has: key, repo, ticket text, status, branch, push result and link, base commit (`origin/main` SHA), baseline failures, every dev and QA attempt (time, verdict, QA report path, log path, tokens), PLAN.md and SUMMARY.md contents, files changed, the final Jira comment, and timestamps.
- It is written atomically, the same way as `state.json` (tmp file + rename), after every step, so a restart loses nothing.
- *My call:* each dev prompt includes a short "past tickets in this repo" list from this memory (key, one-line summary, files changed, for up to the last 10 DONE tickets), so the dev can see related past work. Full comments stay in the file and are not put in the prompt.
- *My call:* the board can re-open the stored comment of any past ticket and copy it again.

## Team separation (decided)

- New roles: `rc-dev`, `gl-dev` and `be-qa`, each with its own `.claude/agents/*.md` file (the `be-qa` body can reuse `qa-engineer.md`'s rules).
- Ticket-team jobs are counted separately from the project team's `MAX_AGENTS`. The ticket team allows up to 3 jobs at once, but because QA is shared, at most 2 tickets are active in practice (one per repo).
- Project "focus" mode does not pause ticket work. *My call:* focus is for the project team only.
- Usage-limit and login pauses apply per engine to both teams (same accounts). The two ticket devs pause with Claude, and Ticket QA pauses with Codex.
- The weekly usage cards include ticket-team tokens (they share the accounts).

## Plugins for the dev agents (decided: superpowers + ponytail)

- Agents run with `--setting-sources project`, so user-level plugins do not load. Ticket devs get them with `--plugin-dir <superpowers cache dir> --plugin-dir <ponytail cache dir>`. The directories are found at startup from `~/.claude/plugins/cache/...`, using the newest version.
- `Skill` is added to the ticket devs' allowed tools.
- If a plugin dir is missing, the dev still runs, and the log notes it.
- The superpowers brainstorming skill expects a human partner. The dev prompt says there is no human in the loop: decide yourself, and write the questions down.

## Office (decided: sofa corner, no desks, all animations and sounds)

- *My call:* the office SVG grows downward with a **"BE ticket lounge"** strip under the current lounge. It has a long sofa, and each of the three agents sits on it with a laptop on their lap.
- Names and looks are *my call*, changeable: **Rocco** (ReviewCook dev), **Gigi** (GiftLips dev), **Quinn** (Ticket QA).
- Every existing animation works for them: laptop screen glow and scrolling code while working, wandering to lounge spots when idle, tea break, office closed, the battery recharge on a usage limit, waiting at the door on a login problem, and speech bubbles showing the current ticket.
- Every existing sound fires for ticket events too: agent start, ticket done, blocked, decision needed, reminder, outage.
- The weekly usage cards' agent lists include the new names.

## Board UI

- The BE tickets tab lists ticket cards with: key, repo, status (IN_PROGRESS / QA / CHANGES_REQUESTED / BLOCKED / DONE / DONE, push failed), agent run logs (existing log viewer), tokens, and once finished, the comment box with a Copy button and the branch link.
- Stop and retry work as they do for tasks.

## Left to the builder

- How to model a BE ticket in `state.json`. Suggestion: reuse the project record with `kind: 'be-ticket'` and a single task whose id is the key, so runs, logs, decisions and tokens keep working.
- Exact office coordinates, colours and the new viewBox height.
- Refactoring needed to give the scheduler two capacity pools.
- Tests: unit tests for the pure parts (repo from key prefix, comment builder, GitHub URL from remote, branch-exists check), plus a self-check that the project team's scheduler is unaffected.

## Open questions

- None blocking. The calls marked *my call* above can be changed when you review this doc.
