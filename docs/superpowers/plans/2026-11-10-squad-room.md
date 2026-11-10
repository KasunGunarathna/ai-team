# Squad Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the product owner chose native execution) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the BE ticket team into the "Superpowers & Ponytail Squad". It gets its own office room, a TODO queue dispatched by Captain Plan, a "Create PR" link taken from `git push` output, and per-agent controls (Break, Stop now, Change task, Give a different ticket).

**Architecture:**
- **Server:** builds on the merged BE flow in `app/server.js`. New tickets start as `TODO`, and `startNext('be')` dispatches READY (resumable) tickets first. TODO tickets are taken by `priority` (descending), then `queuedAt` (ascending). Captain Plan is a role with no engine (`squad-pm`): its break pauses dispatch.
- **Agent controls:** one endpoint, `POST /api/squad/agent`.
- **Office:** `app/office.html` gets a room switcher. The squad is drawn in a second SVG scene.
- **Pure logic:** goes in `app/lib.js`, with unit tests.

**Tech Stack:** Node.js ESM, `node --test`, plain HTML/SVG/JS, git CLI only. No `gh`, no GitHub API.

**Spec:** `docs/superpowers/specs/2026-11-10-squad-room-design.md` (builds on `2026-11-10-be-ticket-team-design.md`)

## Global Constraints

- **Team name:** `Superpowers & Ponytail Squad`. Names: `Captain Plan` (role `squad-pm`, no engine), `Rocket Rocco` (`rc-dev`, Claude), `Giggly Gigi` (`gl-dev`, Claude), `Detective Quinn` (`be-qa`, Codex).
- **Git only:** fetch, branch, pull, push, commit. Never `gh`, never the GitHub API, never read credentials, never force-push.
- **PR link:** taken from the `git push` stderr line `https://github.com/<o>/<r>/pull/new/<branch>`. The fallback is `https://github.com/<o>/<r>/compare/main...<branch>?expand=1`. The comment line is `Create PR: <url>`.
- **Dispatch:** READY tickets first. Then TODO tickets by `priority` descending and `queuedAt` ascending. Each dev handles one ticket at a time. Captain Plan on a break means no new dispatch.
- **Controls:** one agent at a time. Stopping never deletes work; the existing branch-safety rules still apply.
- **No change** to the project team or the PM/BA ticket flow.

## Review Focus

1. **Stop or Change task while the app runs tests:** the test child is killed (`job.child`), the ticket ends BLOCKED, and its worktree is kept.
2. **Give a different ticket when that ticket is for the other repo:** reject with 400 `Ticket is for another dev`.
3. **Captain Plan on a break:** TODO tickets stay TODO; READY (resumed) tickets also wait.
4. **Push output with no "pull/new" line** (the branch already exists on origin): use the compare-URL fallback.
5. **Old state:** BE tickets created before this change (`READY` without `queuedAt`) still run, because READY sorts first.

---

## File map

- Modify `app/lib.js` and `app/lib.test.js`: `prLinkFromPush`, `squadNext`, and a `jiraComment` `prUrl` line.
- Modify `app/server.js`: TODO status, dispatch, the `squad-pm` role, PR link, retry keeps the note, the `/api/squad/agent` endpoint.
- Modify `app/sounds.js` and `app/sounds.test.js`: `handoff` and `pushed` sounds.
- Modify `app/office.html`: room tabs, the squad scene, Captain Plan's dispatch walk, the agent panel controls; remove the lounge strip from the main office.
- Modify `app/index.html`: the tab is renamed `Squad tickets`, plus a TODO label, queue order and a Create PR link.
- Modify `app/be-smoke.sh`: the TODO status and the control endpoint.
- Modify `README.md`.

---

### Task 1: Pure helpers

**Interfaces (produces):**
- `prLinkFromPush(stderr: string, remote: string, branch: string) => string | null`: the first `https://github.com/…/pull/new/…` URL in `stderr`; otherwise, for a GitHub remote, `https://github.com/<o>/<r>/compare/main...<encoded branch>?expand=1`; otherwise `null`.
- `squadNext(tickets: { id, status, priority?, queuedAt?, owner }[], isFree: (owner) => boolean) => ticket | undefined`: READY first, in array order, then TODO sorted by `(priority ?? 0)` descending and `queuedAt` ascending. Only tickets whose owner is free count, where READY with `skipDev` counts as owner `be-qa`.
- `jiraComment({ …, prUrl })`: when `prUrl` is set, `Create PR: <prUrl>` comes after the `Branch:` line and before `Merge: manual`.

- [ ] Write the failing tests:
  - push stderr with `remote:      https://github.com/QRTiger/reviewcook-api/pull/new/RECK-9` gives that URL;
  - empty stderr with remote `https://kasun-gx@github.com/QRTiger/giftlips-api.git` and branch `GIF-1` gives `https://github.com/QRTiger/giftlips-api/compare/main...GIF-1?expand=1`;
  - a GitLab remote gives `null`;
  - `squadNext`: READY beats an older TODO, priority 5 beats an older TODO, the owner-busy one is skipped, and READY+skipDev needs `be-qa` free;
  - `jiraComment` with `prUrl` ends `Branch: …\nCreate PR: …\nMerge: manual`.
- [ ] Run `npm test` and see them fail (missing exports).
- [ ] Implement the helpers in `app/lib.js` (reuse `githubTreeUrl`'s remote parsing; extract the owner/repo part if needed).
- [ ] Run `npm test` and see everything pass. Commit `feat(squad): queue order, PR link and comment helpers`.

### Task 2: Server: queue, Captain Plan, PR link, agent controls

**Interfaces:**
- Consumes `squadNext`, `prLinkFromPush` and `jiraComment({prUrl})` from Task 1.
- Produces:
  - `NICK['squad-pm'] = 'Captain Plan'`, plus the renamed `NICK` values for the others, as in Global Constraints;
  - `engineOf('squad-pm')` returns `'none'`, and `engineHold('none')` returns `null`;
  - intake creates the task with `status: 'TODO', queuedAt: Date.now(), priority: 0`;
  - `startNext('be')`: if `state.breaks['squad-pm']` is set, return false. Otherwise flatten the be-ticket tasks (with their project) and call `squadNext(..., (role) => roleFree(role) && !teamBusyFor(role))`, where `teamBusyFor(role)` is true when a be job's ticket has that owner and is not finished. This keeps each dev to one ticket. On dispatch, set `t.dispatchedAt = now()`.
  - `pushBranch` resolves `{ ok, url, prUrl }`, with `prUrl = prLinkFromPush(stderr, remote, branch)`. `settlePush`/`finishBe` store `t.prUrl` and pass it to `jiraComment`.
  - `retryTask`: `instructions: note || t.instructions || null`. A pending Change-task note survives a Retry with an empty note.
  - `POST /api/squad/agent { role, action, note?, ticketId? }`:
    - `role` must be one of `rc-dev`, `gl-dev`, `be-qa`, `squad-pm`, else 400 `Unknown squad agent`.
    - `action` is `stop` | `change` | `swap`. Break stays on `/api/break`.
    - `stop` (any role except `squad-pm`): find the be job whose ticket owner is the role (for `be-qa`: the job whose `role === 'be-qa'`), set `j.stopped = true` and kill its child. If there is no job, 400 `<Name> is not working on a ticket`.
    - `change` (devs only): requires a `note` (400 `Write what to change`), stores `t.instructions = note`, then stops as above.
    - `swap` (devs only): `ticketId` must be a TODO ticket with `owner === role` (400 `Ticket is for another dev`, or `Ticket not in the to-do list`). It sets `priority = Date.now()` on it, then stops the current ticket if there is one (if not, it just bumps the priority).
    - All actions `say()` a log line, `save()`, `kick()`, and return 200 `{ ok: true }`.
  - The startup migration leaves `TODO` alone (it is not in the reset list).
- [ ] Implement the changes above.
- [ ] Extend `app/be-smoke.sh`:
  - after intake, the ticket status is `TODO`;
  - `POST /api/squad/agent {role:'rc-dev',action:'stop'}` gives 400 `not working`;
  - `{role:'rc-dev',action:'swap',ticketId:'RECK-5'}` gives 200, and the state shows `priority > 0`;
  - `{role:'gl-dev',action:'swap',ticketId:'RECK-5'}` gives 400 `another dev`;
  - `{role:'x',action:'stop'}` gives 400.
- [ ] Run `node --check app/server.js && npm test && bash app/be-smoke.sh` and see it end with `BE smoke OK`. Commit `feat(squad): to-do queue, Captain Plan dispatch, PR link, agent controls`.

### Task 3: Sounds

- [ ] In `app/sounds.js`, add `handoff` (two quick taps: 660 Hz then 880 Hz, triangle, 0.08 s each) and `pushed` (the done arpeggio followed by a 1320 Hz ding at 0.4 s).
- [ ] Add the keys:
  - `dispatched` = set of `${p.id}/${t.id}` for be tickets whose `dispatchedAt` is set and that are not TODO, mapped to `handoff`;
  - `pushed` = set of be tickets with `outcome === 'pushed'`, mapped to `pushed`.

  Order the events so `pushed` plays before `done`.
- [ ] Add one test in `app/sounds.test.js` following the existing test style: a state change that dispatches a ticket plays `handoff`.
- [ ] Run `npm test` and see it pass. Commit `feat(squad): hand-off and pushed sounds`.

### Task 4: Office: Squad room

- [ ] Remove the main office's BE lounge strip (the planks, rug, sign, plant and sofa in y 720–880) and restore `viewBox="0 0 1400 720"` and the night-veil height 720.
- [ ] Add a room switcher above the scene: two buttons, `🏢 Main office` and `🦸 Squad room`. It remembers the choice in `localStorage` (inside try/catch), and only one SVG is shown at a time.
- [ ] Add a second `<svg id="squadRoom" viewBox="0 0 1400 720">` with:
  - wall and floor;
  - a sign `🦸 Superpowers & Ponytail Squad`;
  - a **to-do board** (`#todoBoard`, up to 6 TODO ticket cards: key and clipped title; empty: "Inbox zero 🎉");
  - two sofas with laptops for Rocco, Gigi and Quinn (reuse the laptop markup and its `.desk` classes);
  - a beanbag, a snack table and a door.
- [ ] Each TEAM member gets a `room` field (`'main'` or `'squad'`); squad members get `sofaX` / `sofaY`.
- [ ] Agents, laptops and fronts are appended to the groups of their own room (`#agents`/`#squadAgents`, `#front`/`#squadFront`).
- [ ] Idle, tea, charge and door spots: `SPOTS_SQUAD`, `TEA_SQUAD`, `CHARGE_SQUAD` and `DOOR_SQUAD`, picked by `t.room`. `freeSpot` only considers spots in the member's room.
- [ ] Add Captain Plan: `{ role: 'squad-pm', name: 'Captain Plan', title: 'Squad PM', engine: 'App', shirt: '#e03131', hair: '#f59f00', skin: '#ffd8a8', style: 'bun', room: 'squad' }`, with a cape (a red path behind the body).
  - Idle, he stands by the to-do board saying `📋 N in the queue`, or `🎉 Queue empty`.
  - When `update()` sees a be ticket whose status went from TODO to anything else since the last refresh (keep the previous statuses in a Map), he walks to the board, then to that dev's sofa seat, saying `🦸 ${key} → ${devName}`, then returns after 6 s.
  - He never charges or goes to the door (engine `App`, so `holdOf` returns `null`).
  - When squad decisions are waiting (be-ticket projects with unanswered decisions), he stands by the to-do board saying `⚑ N need you!`. Clicking him opens the decisions panel (`showDecisions()`).
- [ ] Agent panel (`drawCard`), for squad devs:
  - `⏹ Stop now` (confirm dialog text: `Stop ${name}? The ticket goes to BLOCKED; its work is kept.`);
  - `✏️ Change task` (a textarea plus Send; posts `change` with `note`);
  - `↪ Give a different ticket` (a `<select>` of TODO tickets with this dev's owner, plus Go; posts `swap`).

  Quinn gets `⏹ Stop now` only. Captain Plan gets only Break. Errors show in the card.
- [ ] Update the "who" strings to the new names. The main office's sprint board still filters out be tickets.
- [ ] **Browser check** (Playwright against a throwaway server, as before):
  - the room tabs switch;
  - the squad room shows 4 members and the to-do board with 1 TODO ticket;
  - injecting a job for `rc-dev` seats Rocco with a glowing laptop;
  - flipping a ticket from TODO to IN_PROGRESS in injected state makes Captain Plan walk;
  - the agent panel shows the 4 buttons for Rocco and 2 for Quinn;
  - the main office has no lounge strip.

  Remove `.playwright-mcp/` afterwards.
- [ ] Commit `feat(squad): Squad room with Captain Plan and agent controls`.

### Task 5: Board and README

- [ ] `app/index.html`:
  - the tab label becomes `Squad tickets`;
  - the list order is TODO (by queue order), then active, blocked, done;
  - `beStatus` shows `TODO · #N in queue`;
  - the card shows a `🔀 Create PR` link when `t.prUrl` is set.
- [ ] README: rename the section to "Superpowers & Ponytail Squad". Cover the room, the queue, Captain Plan, the agent controls, the Create PR link from `git push`, and git only.
- [ ] Run `npm test && bash app/be-smoke.sh` and see both pass. Commit `docs/feat(squad): board tab and README`.
