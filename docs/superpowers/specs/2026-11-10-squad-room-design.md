# Superpowers & Ponytail Squad: its own room, a ticket queue, draft PRs, agent controls

Date: 2026-11-10 · Status: draft for product-owner approval · Builds on `2026-11-10-be-ticket-team-design.md` (merged)

## Intent

The BE ticket team already works on its own (Rocco, Gigi, Quinn). The product owner wants it to feel like a separate squad with its own room. Tickets wait in a to-do list and are handed out one at a time. Each passed ticket ends with a pushed branch and a one-click "Create PR" link. The product owner also wants to control any single agent directly: give it a break, stop it, change its task, or hand it a different ticket.

## Goals

- **Name and identity (decided; the names are my call and can be changed).** The team is the **Superpowers & Ponytail Squad**, because its devs work with those plugins. The kid-style names are:
  - 🦸 **Captain Plan**: PM / dispatcher (new).
  - 🧢 **Rocket Rocco**: ReviewCook dev (role `rc-dev`, Claude).
  - 🎀 **Giggly Gigi**: GiftLips dev (role `gl-dev`, Claude).
  - 🔍 **Detective Quinn**: QA (role `be-qa`, Codex).
- **Separate room (decided).** The office page gets two rooms, switched with tabs at the top: **Main office** and **Squad room**. The Squad room is its own scene. The squad sits on sofas with laptops (no desks), with a **to-do board** on the wall showing the queue and Captain Plan's spot. The squad leaves the main office lounge strip.
- **To-do queue (decided).**
  - A new ticket is saved as **TODO**.
  - **Captain Plan is a simple dispatcher (decided)**: in the order tickets were added (first in, first out), it hands the next TODO ticket to its dev (`RECK-` to Rocco, `GIF-` to Gigi) when that dev is free.
  - *My call:* Captain Plan is **not an AI run**. The app dispatches, and Captain Plan is the animated character: walks to the board, takes the card, walks to the dev, hand-off sound. It costs no quota. It can become a real agent later.
  - Each dev works on one ticket at a time. Both devs can work in parallel. Quinn tests one ticket at a time.
- **Flow per ticket.** Unchanged from the merged design (fresh branch from `origin/main`, the app runs the baseline tests, the dev brainstorms, plans and builds, the app runs the tests, Quinn reviews, at most 2 fix cycles). The one change is at the end:
  - On a pass: commit and push, using **only git commands (decided)**: fetch, branch, pull, push, commit. There is no `gh` and no GitHub API, and the app never handles GitHub tokens.
  - **PR link (decided):** take the "Create a pull request … by visiting: <url>" line GitHub prints on `git push`. If it is missing, for example when the branch existed already, fall back to `https://github.com/<owner>/<repo>/compare/main...<branch>?expand=1`.
  - The Jira comment and the card show `Create PR: <url>` plus the branch link. The product owner clicks it, chooses **Create draft pull request** against `main`, and merges by hand.
  - If the push fails, the decision works as it does today: **Retry push** / **I'll push myself**.
  - Why not `gh`: the `gh` token on this Mac cannot see the QRTiger repos (HTTP 404). Only the keychain credential, which `git push` uses, works.
- **Agent controls: one agent at a time (decided).** Clicking a squad member (in the room or on the team list) opens its panel:
  1. **☕ Break**: finish the current step, then rest. **▶ Back to work** ends it. (This already exists, via `/api/break`.)
  2. **⏹ Stop now**: kill the running step. The ticket goes to **BLOCKED** and its work stays in the worktree. The dev then takes the next TODO ticket.
  3. **✏️ Change task**: Stop now plus a note. The ticket goes to BLOCKED with the note stored as the retry instructions. **Retry** continues from the saved work with the note.
  4. **↪ Give a different ticket**: choose a TODO ticket for that dev's repo. The current ticket goes to BLOCKED, and the chosen ticket starts next for this dev, ahead of the queue.
  - Captain Plan's panel has only Break. Quinn's panel has Break and Stop now, because it is not a dev with tickets to swap.
- **Animations and sounds.** The Squad room uses the existing set: typing glow, walking, speech bubbles, break and tea, battery recharge on a usage limit, the door on a login problem, and office closed. New: Captain Plan's dispatch walk with a short "hand-off" sound, and a "branch pushed" sound (the existing done arpeggio plus a ding). The existing sounds still fire for start, done, blocked and decisions.

## Non-goals

- No AI PM (only a dispatcher), no reordering or priorities in the queue (first in, first out), no multi-select agent controls, no PR creation by the app (only the link), no auto-merge, no GitHub or Jira API.
- No change to the project team or the PM/BA ticket flow.

## Anti-goals

- Stopping or swapping must never delete work. The ticket's worktree and branch stay, and the branch-safety rules from the merged design still apply.
- Nothing is ever force-pushed, and the PR link always compares against `main`.
- A control action on one agent must not affect the others.

## Board (task board page)

- The tab is renamed **Squad tickets**. The list shows TODO tickets in queue order, then active, blocked and done.
- The ticket card shows the **Create PR** link next to the Jira comment and the Copy button.

## Left to the builder

- How TODO is modelled. Suggestion: a task status `TODO` plus `queuedAt`; dispatch = first TODO by `queuedAt`, or a `t.priority` bump from "Give a different ticket".
- How the room is drawn: one SVG scene per room with a view toggle, or a second SVG.
- Tests: unit tests for the dispatch order, a test that parses the PR link out of `git push` stderr (with the compare-URL fallback), and a smoke-test extension for the TODO status and the agent-control endpoints (no agent runs).

## Open questions

- None blocking. The names, the non-AI Captain Plan, and FIFO dispatch are my calls and can be changed.
