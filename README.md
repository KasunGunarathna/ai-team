# AI Team: local PM/BA → DEV → QA

A local web app that runs an AI engineering team on any project folder:

- **PM/BA:** Claude Code with `.claude/agents/pm-ba.md`. Turns your idea into `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/BACKLOG.md`, `tasks/TASK-*.md` and `.aiteam/tasks.json`, grouped into phases.
- **DEV:** Claude Code with `backend-dev.md` or `frontend-dev.md`, depending on the task owner.
- **QA:** Codex (`codex exec`) with `qa-engineer.md`. It runs the real tests and ends its reply with `VERDICT: PASS | FAIL | BLOCKED`.

The app runs on your existing Claude Code and Codex subscriptions. It needs no API keys and no extra dependencies, only Node 22+.

## Run

```bash
cd ~/"Development/AI Team"
npm start            # http://localhost:4317
npm test             # orchestrator logic tests
```

Options (environment variables): `PORT=4317`, `DAILY_AT=09:00` (set it to an empty value to turn the daily run off), `DAILY_TASKS=2`, `LOG_AGENT=0` (hide the agents' own output in the terminal and keep only workflow events).

The terminal shows what the app is doing: projects added, planning, every agent run starting and ending with its duration and tokens, QA verdicts, commits, blocked tasks, and decisions waiting for you or answered by you. Keep the terminal open: closing it, or pressing Ctrl+C, stops the app and the daily run.

## Flow

1. **Add a project:** a name, a folder path (it must be a git repo with no uncommitted changes) and your idea.
2. **Plan with PM/BA:** the tasks appear in the Backlog column. Read the generated docs and tasks in the project. Use **Re-plan** if you need another attempt.
3. **Approve plan:** the app creates branch `ai-team/<id>`, commits the plan and marks the tasks READY.
4. **Run next N:** for each READY task whose dependencies are DONE:
   - DEV implements the task and adds tests.
   - QA (Codex) runs the tests independently.
   - If QA passes, the app commits `feat(TASK-xxx): ...` and marks the task DONE.
   - If QA fails, the QA report goes back to DEV. This repeats up to 2 fix cycles, then the task becomes BLOCKED.
   - BLOCKED stops the run. Its changes stay uncommitted so you can inspect them. Fix the problem, then press **Retry**.
5. **Daily run:** while the app is running, at `DAILY_AT` it runs `DAILY_TASKS` tasks for every approved project.

## The office (home page)

<http://localhost:4317> opens a cartoon office of the team. The task board moved to <http://localhost:4317/board>, and each page links to the other.

| Nickname | Role | Engine |
| --- | --- | --- |
| Mira | PM / BA | Claude Code |
| Bolt | Backend dev | Claude Code |
| Pixel | Frontend dev | Claude Code |
| Bugsy | QA engineer | Codex |
| Iris | UI/UX designer | Codex |

- **Working:** the agent sits at their desk with the monitor lit, typing, and a speech bubble shows the task.
- **Idle:** agents wander between the water cooler, sofa, plant, ping-pong table, café and fridge.
- **Decisions waiting:** Mira stands at the whiteboard with "⚑ N decisions need you!".
- **Usage limit, shown as a tea break:** the team takes a tea break at the café, fridge and water cooler, with cups in hand. The top bar shows "back at 00:21 (in 1h 30m)" and a **Resume now** button.
- **Decisions from the office:** the "⚑ Waiting for you" panel (and the ⚑ button at the top) shows the same option boxes as the board: approve plans, answer questions, allow tools, or choose how to retry a blocked task. Write suggestions in the note; the agents receive it. Clicking an agent while decisions are waiting jumps to the panel.
- **Office hours:** set them in the Office hours card (always open, or a start and end time, optionally Monday to Friday only). Outside those hours the office is dark, the team has gone home, and no new work starts; a task that is already running is finished first. Queued and auto-run work continues when the office opens.
- **Day and night:** the windows follow your local time.

## Teamwork: parallel agents, focus and breaks

- **Two agents at once (default):** up to `MAX_AGENTS=2` agents work at the same time. For example, Bolt codes a backend task while Pixel codes a frontend task, or Bugsy tests one task while Bolt codes the next. Each agent works on one task at a time.
- **Own workspace per task:** every task runs in its own git worktree under `data/worktrees/<project>/<task>`, created from the work branch, so parallel agents never edit the same files. After QA passes, the task is merged into the work branch (`ai-team/...`) and its worktree is removed. If two tasks changed the same lines, the merge conflict goes back to that task's developer, then QA runs again.
- **Focus:** click a project on the office whiteboard (🎯) and the whole team works only on that project. Click it again, or the 🎯 chip, to work on all projects.
- **One agent on a break:** click an agent in the office and choose "Send on a break". They finish their current step, then wait; their tasks wait too, and the rest of the team keeps working. "Back to work" brings them back.
- **Whole team:** "☕ Team tea break" stops every agent immediately. Each interrupted task keeps its work in its worktree and goes back to READY (not counted as a failure). "▶ Back to work" starts them again: a developer continues from the partial work, an interrupted QA run starts over, and interrupted planning runs again. **Stop** (on the board) stops all running agents immediately.
- **New dependencies:** each task's worktree starts without `node_modules`, so DEV installs dependencies in it. This takes longer and uses more disk.

## Weekly usage

At the bottom of the office page, one card per engine shows:

- **% of the weekly limit left**, with a bar (green, then orange below 30%, red below 10%), when it resets, and the 5-hour window. These numbers come from Claude and Codex themselves, so they include your own use outside AI Team. Claude reports them on each AI Team run; for Codex, the app reads the newest session log in `~/.codex/sessions` (read-only). They are as fresh as the last run ("as of …").
- **Tokens AI Team used in the last 7 days**: total processed (including cache) and output, from AI Team's own run records.

The board sidebar shows the "% left" for both.

## Context and fresh sessions

- **Every task starts fresh:** each step (planning, every developer attempt, every QA run) is a new Claude Code or Codex session, so one task's conversation never fills up the next one.
- **Context meter:** while a Claude agent works, "Team right now" and the agent card show how full its context is, e.g. "🧠 20% context used · 160k left". The board's banner shows it too. Codex does not report this while it works, so QA shows no meter.
- **Fresh session at 80%:** when a developer's session reaches `CONTEXT_HANDOFF_AT` percent (default 80), the app ends it and starts a fresh session for the same attempt. The new session gets a memory note: what the last session said most recently, and which files it had changed (`git status`). The run list shows the old run as "handoff" and the new one as `-s2`, `-s3` and so on. After 3 hand-offs in one attempt, the task is blocked: it is probably too big and should be split.
- **Window size:** the app learns each model's context window from finished runs, and assumes 200k until then.

## Sounds

Press **🔕 Sounds off** in the office header or the board sidebar to turn sounds on (you hear a ding-dong to confirm). The setting is remembered in that browser. Browsers only play sound after you click the page once, so after a reload, click anywhere.

| Event | Sound |
| --- | --- |
| An agent starts a step (coding, testing or planning) | quick rising pop |
| A task is DONE | happy four-note arpeggio |
| A task is BLOCKED | low "uh-oh" |
| A new approval or decision is waiting | ding-dong |
| Decisions still waiting | soft triple beep every 2 minutes until you answer |

If several events happen at once, their sounds play one after another. Keep only one AI Team tab open, or you will hear each sound twice.

## Auto-run and usage limits

- **Auto-run:** choose "Approve and auto-run" in the plan box, or tick **Auto-run** on an approved project. When a task finishes, the next ready task starts automatically, until every task is DONE. When a project is finished, the app moves on to the next auto-run project or ticket.
- **Queue:** "Run next N", planning and the daily run never fail because another agent is busy. They wait their turn; at most `MAX_AGENTS` agents (default 2) run at once.
- **Blocked:** if a task is blocked, that project waits for your decision. Other projects keep going, and once you answer, the project continues.
- **Usage limit (per engine):** if Claude reports its usage limit, only the Claude agents (Mira, Bolt, Pixel) pause until the reset time it reports (plus 1 minute), then continue automatically; Bugsy (Codex) keeps testing. A Codex limit pauses only Bugsy. If no reset time is given, the app tries again after 30 minutes. The interrupted task goes back to READY with its work kept and is not counted as a failed attempt; a task stopped during QA resumes at QA. In the office, the whiteboard turns into a charging battery with the reset time, the affected agents recharge in the lounge with a blinking battery, and their monitors show 🔋 LOW.
- **Login or subscription problem:** if Claude or Codex fails because you are logged out, a token expired or the plan is not active, that engine's agents pause (the others keep working) and the task waits, without counting as a failure. The office shows a red lock on the whiteboard with the fix (`claude`, then `/login`; or `codex login`), a blinking red key-card reader on the door, and the affected agents waiting at the door. The app tries again every 15 minutes; after logging in, press **🔑 Retry now** to continue at once.
- **Usage meter:** the sidebar shows your current Claude 5-hour and 7-day usage, taken from the latest run.

## UI/UX design approval (frontend tasks)

Iris, the UI/UX agent (runs on Codex, `.claude/agents/ui-ux.md`), designs every frontend task before Pixel builds it:

1. **Design:** Iris reads the task and product docs, follows the repo's existing UI if there is one, and writes `<plan dir>/design/<TASK>/mockup.html` (one self-contained static HTML page showing the screens and states, including mobile) and `NOTES.md` (layout, accessibility, states, open questions). The board shows the task in the **Design** column.
2. **Your review:** a "🎨 design" decision appears in "Waiting for you" (board and office) with **🎨 Open UI mockup**. Choose **Approve**, or **Request changes** and write what to change; Iris then makes a new round with your note.
3. **Build:** after approval, Pixel builds the real UI to match the mockup, and Bugsy (QA) also checks the UI against it.

**Design references (inputs for Iris):** on the board, open **🎨 Design references for all screens** under a project (used for every frontend task) or **🎨 Design refs** on a frontend task card (that task only), and add:

- **Images** (PNG, JPG, GIF, WebP; max 10 MB): attached to Iris's Codex prompt as images (`codex exec -i`).
- **HTML pages**: Iris reads them as reference (their scripts are not used).
- **Figma links**: paste a link to a frame (it contains `node-id=`). If `FIGMA_TOKEN` is set when you start the app (a Figma personal access token with read access), the app downloads that frame as a PNG and attaches it. Without a token the link is only listed, because Codex cannot open Figma from its sandbox; export the frame as PNG and upload it instead.

Add or change references before the design runs, or add them and choose **Request changes** to get a new round that uses them. Files are stored in `data/refs/` and shown sandboxed.

Backend tasks skip this step. Mockups are kept in `data/designs/` and (for projects) committed with the task. They are shown in a locked-down sandbox: no scripts, no outside requests, and no access to the app.

## Jira tickets on an existing project

Open the **Jira tickets** tab, choose the existing repo folder, enter the Jira key (for example `MINT-123`) and paste the ticket. `templates/JIRA_TICKET.md` shows a useful format, and the tab has a download link for it.

1. **Analyse ticket with PM/BA:** PM/BA studies the existing code and writes `.aiteam/MINT-123/ANALYSIS.md` plus small tasks `MINT-123-01`, `MINT-123-02`, … in `.aiteam/MINT-123/tasks/`.
2. **Approve** in the "Waiting for you" box. The app creates branch `ai-team/MINT-123` from the branch the repo is currently on.
3. **Run next:** DEV and QA work as for projects. QA also runs the repo's existing tests to catch regressions. Each passed task is committed as `feat(MINT-123-01): …`, so Jira can link the commits to the ticket.

`.aiteam/` is added to the repo's `.git/info/exclude`, so AI planning files never appear in your commits or PR. Several tickets can share one repo: before each task the app switches to that ticket's branch, as long as there are no uncommitted changes. Push the branch and open the PR yourself.

## Logs, tokens and approvals

- **Live logs:** every agent run is listed on its task card, and PM/BA runs are listed under PM/BA runs. Click a run to see its log, which updates while the agent works: assistant text, `→` tool calls and commands, `←`/`✗` results, and the QA report.
- **Tokens:** shown for each run, each task (Σ) and the whole project, split into input, cache and output. Claude runs also show a "≈$" figure. That is an API-equivalent estimate; your subscription is not charged per token. Codex reports tokens only.
- **Waiting for you:** anything that needs your approval appears as an option box. Pick an option, add an optional note, and submit.
  - **plan:** approve the PM/BA plan, or re-plan using your notes.
  - **question:** a business decision PM/BA could not make. Your answers are passed to PM/BA and the developer agents.
  - **permission:** an agent tried to use a tool that is not allowed (for example `docker compose`). Allow it for this project or keep it blocked.
  - **blocked:** a task failed QA 3 times or could not start. Retry with the current changes, or discard all uncommitted changes and start the task again. An optional note is passed to the developer.

## Changing course

- **Stop:** the button in the orange "Agent working" bar kills the running agent. Its task becomes BLOCKED with a "Stopped by you" decision. If planning was running, the previous plan is restored.
- **Edit project:** change the name or idea. Saving does not re-plan.
- **Re-plan with PM/BA:** available at any time, including after approval, with optional notes. DONE tasks stay DONE and keep their history. You approve the new plan before any work continues.
- **Retry / Redo on a task card:** for BLOCKED tasks, retry keeping the current changes or discard them. For DONE tasks, redo with a note saying what should change. Then press **Run next**.
- **Remove project:** takes it off the board and deletes its logs. Files and git history in the project folder are not touched.
- **Switching projects:** click another project in the sidebar at any time. Work on a second project starts when an agent is free (up to `MAX_AGENTS` at once), unless the team is focused on another project.

Agent runs use `--setting-sources project,local`, so your personal `~/.claude` settings, allow rules and plugins do not apply to them. App state is stored in `data/state.json`, and logs are in `data/logs/`.

## Safety rules built into the app

- At most `MAX_AGENTS` agents (default 2) run at once, to stay within subscription usage limits. Each task works in its own git worktree.
- The app works only on the `ai-team/<id>` branch. It never pushes, merges or deploys: you review and merge the branch yourself.
- DEV can edit files and run only `npm`, `npx`, `pnpm`, `yarn`, `node`, `tsc`, `ls`, `mkdir` and read-only git commands. QA runs in Codex's `workspace-write` sandbox, which has no network access.
- A commit is refused if it contains `.env`, `*.pem` or `*.key` files.
- The server listens on 127.0.0.1 only and rejects requests from other sites.
