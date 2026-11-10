// AI Team orchestrator: PM/BA (Claude Code) -> DEV (Claude Code) -> QA (Codex).
// Local only. Up to MAX_AGENTS agents work at once (default 2), each task in its own git worktree.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { isOpen, limitUntil, parseVerdict, nextTask, readyTasks, normaliseTasks, normaliseQuestions, secretFiles, formatClaudeEvent, formatCodexEvent, sumUsage, permissionRule, clip } from './lib.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.AI_TEAM_DATA || path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const PORT = Number(process.env.PORT || 4317);
const DAILY_AT = process.env.DAILY_AT ?? '09:00'; // "" disables the daily run
const DAILY_TASKS = Number(process.env.DAILY_TASKS || 2);
const MAX_FIX_CYCLES = 2;
const RUN_TIMEOUT_MS = 45 * 60_000;
const MAX_AGENTS = Math.max(1, Number(process.env.MAX_AGENTS || 2)); // agents working at the same time
const WT = path.join(DATA, 'worktrees'); // one git worktree per running task
const NICK = { 'pm-ba': 'Mira', 'backend-dev': 'Bolt', 'frontend-dev': 'Pixel', qa: 'Bugsy' };

const PM_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
const DEV_TOOLS = [
  ...PM_TOOLS,
  ...['npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'ls', 'mkdir', 'git status', 'git diff', 'git log'].map((c) => `Bash(${c}:*)`),
];

// ---------- state ----------
fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { projects: [] };
state.breaks ??= {}; // role -> true while that agent is on a break
// Migrate older state and put work interrupted by a crash back where it can be retried.
for (const p of state.projects) {
  p.decisions ??= [];
  p.kind ??= 'idea';
  p.planDir ??= '.aiteam';
  p.taskDir ??= 'tasks';
  p.allowTools ??= [];
  p.runBudget ??= 0;
  for (const o of [p, ...p.tasks]) {
    o.runs ??= (o.logs ?? []).map((f) => ({ label: f, log: f, status: 'ok' }));
    delete o.logs;
    for (const r of o.runs) if (r.status === 'running') r.status = 'interrupted';
  }
  if (p.status === 'PLANNING') p.status = 'NEW';
  for (const t of p.tasks) if (['IN_PROGRESS', 'QA', 'CHANGES_REQUESTED'].includes(t.status)) t.status = 'READY'; // its worktree is kept and reused
  if (p.status === 'AWAITING_APPROVAL' && !pending(p).some((d) => d.kind === 'plan')) addPlanDecision(p);
}
function save() {
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}
// Running jobs (a planning run or one task's DEV -> QA loop). Each agent (role) works on one job at a time.
const jobs = new Map(); // id -> { id, kind, projectId, project, taskId, label, role, needs, child, stopped, agentLabel, agentStartedAt }
const roleBusy = {}; // role -> job id currently using that agent
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const projectJobs = (p) => [...jobs.values()].filter((j) => j.projectId === p.id);
const busyText = () => [...jobs.values()].map((j) => j.label).join(' · ') || null;
const roleFree = (role) => !roleBusy[role] && !state.breaks[role] && ![...jobs.values()].some((j) => j.needs === role);

// ---------- helpers ----------
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const agentBody = (name) => fs.readFileSync(path.join(ROOT, '.claude', 'agents', `${name}.md`), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
function now() { return new Date().toISOString(); }

// Terminal log. LOG_AGENT=0 hides the agents' own output lines and keeps workflow events.
const SHOW_AGENT = process.env.LOG_AGENT !== '0';
function say(msg) { console.log(`${new Date().toTimeString().slice(0, 8)}  ${msg}`); }
const tok = (u) => !u ? 'no token data' : `tokens in ${u.input} · cache ${u.cacheRead + u.cacheWrite} · out ${u.output}${u.costUsd ? ` · ≈$${u.costUsd.toFixed(2)}` : ''}`;

// Stop an agent and everything it started: SIGTERM to its process group, SIGKILL 5 s later if anything is left.
function killTree(child) {
  if (!child?.pid) return;
  const sig = (s) => { try { process.kill(-child.pid, s); } catch { /* group already gone */ } };
  sig('SIGTERM');
  setTimeout(() => sig('SIGKILL'), 5000).unref();
}

// Spawn an agent CLI that prints JSON lines; write a readable log as events arrive.
function run(cmd, args, cwd, logFile, format, tag, job) {
  return new Promise((resolve) => {
    const acc = { usage: null, text: '', denials: [] };
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const writeLine = (line) => {
      if (!line.trim()) return;
      let out;
      try { out = format(JSON.parse(line), acc); } catch { out = line; }
      if (!out) return;
      log.write(out + '\n');
      if (SHOW_AGENT) for (const l of out.split('\n')) if (l.trim()) console.log(`          ${tag} ${clip(l, 220)}`);
    };
    // Own process group, so stopping the agent also stops what it started (test runners, dev servers).
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    job.child = child;
    const timer = setTimeout(() => { log.write('\n[timeout: killed]\n'); killTree(child); }, RUN_TIMEOUT_MS);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) writeLine(buf.slice(0, i));
    });
    child.stderr.on('data', (d) => { log.write(d); if (SHOW_AGENT) process.stderr.write(`          ${tag} [stderr] ${clip(String(d), 220)}\n`); });
    child.on('error', (e) => log.write(`\n[spawn error] ${e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      job.child = null;
      writeLine(buf);
      if (job.stopped) log.write('\n[stopped by you]\n');
      if (job.paused) log.write('\n[paused: team tea break]\n');
      log.end(`\n[exit ${code}]\n`, () => resolve({ code, ...acc }));
    });
  });
}

// Records each agent run (log file, duration, tokens) on the project or task that owns it.
// Waits until that agent is free (another job may be using it). Returns null if the job was stopped while waiting.
async function agentRun(p, owner, label, engine, args, job, cwd = p.path) {
  const role = engine === 'codex' ? 'qa' : owner === p ? 'pm-ba' : owner.owner;
  job.needs = role;
  while (roleBusy[role] && roleBusy[role] !== job.id) { if (job.stopped || job.paused) { job.needs = null; return null; } await sleep(1500); }
  roleBusy[role] = job.id;
  const dir = path.join(DATA, 'logs', p.id);
  fs.mkdirSync(dir, { recursive: true });
  const log = `${now().replace(/[:.]/g, '-')}-${label}.log`;
  const rec = { label, engine, log, status: 'running', startedAt: now() };
  say(`▶ [${p.name}] ${label} started (${NICK[role]}, ${engine})`);
  Object.assign(job, { role, agentLabel: label, agentStartedAt: now() });
  owner.runs.push(rec);
  save();
  const t0 = Date.now();
  const r = await run(engine, args, cwd, path.join(dir, log), engine === 'claude' ? formatClaudeEvent : formatCodexEvent, `│ ${label}`, job);
  Object.assign(job, { role: null, needs: null, agentLabel: null });
  delete roleBusy[role];
  const limited = job.stopped || job.paused ? null : limitUntil(r, r.code);
  if (r.rate?.unifiedWindows) state.claudeUsage = { fiveHour: r.rate.unifiedWindows.five_hour, sevenDay: r.rate.unifiedWindows.seven_day, at: now() };
  Object.assign(rec, { status: job.stopped ? 'stopped' : job.paused ? 'paused' : limited ? 'limited' : r.code === 0 ? 'ok' : 'error', exit: r.code, durationMs: Date.now() - t0, usage: r.usage });
  say(`■ [${p.name}] ${label} ${rec.status} (exit ${r.code}) in ${Math.round(rec.durationMs / 1000)}s · ${tok(r.usage)}`);
  save();
  return { ...r, limited, logPath: path.join(dir, log) };
}

// User-level settings are skipped so only this app's allow list applies (and no user plugins/hooks burn tokens).
const claudeArgs = (agent, prompt, tools) =>
  ['-p', prompt, '--append-system-prompt', agentBody(agent), '--setting-sources', 'project,local', '--allowedTools', tools.join(','),
    '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose'];

function startJob(spec, fn) {
  const job = { id: crypto.randomUUID().slice(0, 8), stopped: false, child: null, role: null, needs: null, startedAt: now(), ...spec };
  jobs.set(job.id, job);
  say(`● ${job.label}`);
  fn(job).catch((e) => say(`✗ ${job.label} failed: ${e.stack || e.message}`)).finally(() => {
    jobs.delete(job.id);
    for (const [r, id] of Object.entries(roleBusy)) if (id === job.id) delete roleBusy[r];
    save();
    if (!job.stopped) kick();
  });
  return job;
}

// ---------- decisions (approvals shown as option boxes in the UI) ----------
function pending(p) { return p.decisions.filter((d) => !d.answer); }

function addDecision(p, d) {
  p.decisions.push({ id: crypto.randomUUID().slice(0, 8), createdAt: now(), ...d, options: d.options.map(([value, label]) => ({ value, label })) });
  say(`⚑ [${p.name}] waiting for you (${d.kind}): ${clip(d.question, 160)}`);
}

function addPlanDecision(p) {
  const phases = new Set(p.tasks.map((t) => t.phase)).size;
  addDecision(p, {
    kind: 'plan',
    question: `Approve the PM/BA plan: ${p.tasks.length} tasks in ${phases} phase(s)?`,
    detail: `Review docs/PRD.md and tasks/ in the project first.\n\n${p.tasks.map((t) => `P${t.phase} ${t.id} [${t.owner}] ${t.title}${t.dependsOn.length ? ` (needs ${t.dependsOn.join(', ')})` : ''}`).join('\n')}`,
    options: [
      ['approve_auto', 'Approve and auto-run: start now and pick the next task automatically until all are DONE'],
      ['approve', 'Approve only: mark tasks READY, I will press Run next myself'],
      ['replan', 'Re-plan: PM/BA plans again using my notes below'],
    ],
  });
}

function raiseDenials(p, denials, who) {
  for (const d of denials ?? []) {
    const rule = permissionRule(d);
    if (p.allowTools.includes(rule) || p.decisions.some((x) => x.kind === 'permission' && x.rule === rule)) continue;
    addDecision(p, {
      kind: 'permission', rule,
      question: `${who} tried to use a tool that is not allowed. Allow ${rule} in this project?`,
      detail: `Requested: ${clip(d.tool_input?.command ?? JSON.stringify(d.tool_input), 600)}`,
      options: [['allow', `Allow ${rule} for future runs in this project`], ['deny', 'Keep it blocked']],
    });
  }
}

function block(p, t, why) {
  t.status = 'BLOCKED'; t.note = why;
  say(`✗ [${p.name}] ${t.id} BLOCKED: ${why.split('\n')[0]}`);
  p.decisions = p.decisions.filter((d) => !(d.kind === 'blocked' && d.taskId === t.id && !d.answer));
  addDecision(p, {
    kind: 'blocked', taskId: t.id,
    question: `${t.id} "${t.title}" is blocked. What next?`,
    detail: why,
    options: [
      ['continue', "Retry, keeping this task's work so far (DEV continues from it)"],
      ['restart', "Discard this task's work and start it again from the latest work branch"],
    ],
  });
  save();
  return false;
}

function productDecisions(p) {
  const lines = p.decisions.filter((d) => d.kind === 'question' && d.answer)
    .map((d) => `- ${d.question} → ${d.answer === 'other' ? d.note : d.answer}${d.note && d.answer !== 'other' ? ` (note: ${d.note})` : ''}`);
  return lines.length ? `\n\nProduct owner decisions (binding):\n${lines.join('\n')}` : '';
}

function answer(p, d, value, note) {
  say(`✔ [${p.name}] you answered (${d.kind}) "${clip(d.question, 80)}" → ${value}${note ? ` · note: ${clip(note, 80)}` : ''}`);
  d.answer = value; d.note = note || null; d.answeredAt = now();
  try { applyAnswer(p, d, value, note); } catch (e) { d.answer = null; throw e; }
}

function applyAnswer(p, d, value, note) {
  if (d.kind === 'permission' && value === 'allow') p.allowTools.push(d.rule);
  if (d.kind === 'plan') {
    if (value === 'approve' || value === 'approve_auto') { approve(p); p.auto = value === 'approve_auto'; return kick(); }
    p.planNotes = note || null;
    return startPlan(p);
  }
  if (d.kind === 'blocked') { retryTask(p, p.tasks.find((x) => x.id === d.taskId), value, note); kick(); }
}

// mode: 'continue' keeps the task's worktree, 'restart' throws it away (user chose it explicitly; only this task's work).
function retryTask(p, t, mode, note) {
  say(`↻ [${p.name}] ${t.id} set to retry (${mode === 'restart' ? "discarding this task's work" : 'keeping its work'})`);
  if (mode === 'restart') removeWorktree(p, t);
  p.decisions = p.decisions.filter((d) => !(d.kind === 'blocked' && d.taskId === t.id && !d.answer));
  Object.assign(t, { status: 'READY', cycles: 0, note: null, skipDev: false, feedback: null, instructions: note || null });
  if (!p.auto) p.runBudget = Math.max(p.runBudget, 1);
}

// ---------- git worktrees: every task gets its own copy of the repo ----------
const taskBranch = (p, t) => `${p.branch}--${t.id}`;
const branchExists = (p, b) => { try { git(p.path, 'rev-parse', '--verify', '-q', `refs/heads/${b}`); return true; } catch { return false; } };

// Where finished tasks are merged: the project folder itself if it has the work branch checked out, else a worktree.
function integrationDir(p) {
  if (git(p.path, 'rev-parse', '--abbrev-ref', 'HEAD') === p.branch) return p.path;
  const dir = path.join(WT, p.id, '_integration');
  if (!fs.existsSync(path.join(dir, '.git'))) { fs.mkdirSync(path.dirname(dir), { recursive: true }); git(p.path, 'worktree', 'prune'); git(p.path, 'worktree', 'add', '-q', dir, p.branch); }
  return dir;
}

function ensureWorktree(p, t) {
  const dir = path.join(WT, p.id, t.id);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(p.path, 'worktree', 'prune');
  const b = taskBranch(p, t);
  git(p.path, 'worktree', 'add', '-q', ...(branchExists(p, b) ? [dir, b] : ['-b', b, dir, p.branch]));
  // Ticket plans are git-excluded, so give the task workspace its own copy of the task files.
  if (p.kind === 'ticket') fs.cpSync(path.join(p.path, p.planDir), path.join(dir, p.planDir), { recursive: true });
  say(`⎇ [${p.name}] ${t.id} workspace ready: ${dir}`);
  return dir;
}

function removeWorktree(p, t) {
  const dir = path.join(WT, p.id, t.id);
  try { git(p.path, 'worktree', 'remove', '--force', dir); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
  try { git(p.path, 'worktree', 'prune'); } catch { /* nothing to prune */ }
  if (branchExists(p, taskBranch(p, t))) git(p.path, 'branch', '-D', taskBranch(p, t));
}

// Merge a QA-passed task into the work branch. Returns true, or feedback for DEV when there is a conflict.
function mergeTask(p, t, wt) {
  const dir = integrationDir(p);
  if (git(dir, 'status', '--porcelain')) throw new Error(`The work branch folder ${dir} has uncommitted changes. Commit or stash them, then retry.`);
  const merge = () => git(dir, 'merge', '--no-ff', '-q', '-m', `Merge ${t.id}: ${t.title}`, taskBranch(p, t));
  try { merge(); return true; } catch { try { git(dir, 'merge', '--abort'); } catch { /* no merge in progress */ } }
  // Another task changed the same files meanwhile: bring the latest work branch into this task's workspace.
  try { git(wt, 'merge', '--no-edit', '-q', p.branch); merge(); return true; } catch { /* conflict markers left in wt for DEV */ }
  const files = git(wt, 'diff', '--name-only', '--diff-filter=U');
  return `MERGE CONFLICT: other tasks merged into ${p.branch} while you worked. The latest ${p.branch} is now merged into your workspace with conflict markers in:\n${files || '(see git status)'}\nResolve every conflict keeping both changes where they make sense, then run the tests again.`;
}

// ---------- workflow ----------
// Planning is queued; the scheduler starts it when the project has no running tasks and Mira is free.
function startPlan(p) {
  p.decisions = p.decisions.filter((d) => d.answer || !['plan', 'question', 'blocked'].includes(d.kind));
  p.resumePlan = true; p.error = null;
  save(); kick();
}

async function plan(p, job) {
  const before = { status: p.status, tasks: p.tasks };
  const done = p.tasks.filter((t) => t.status === 'DONE');
  p.status = 'PLANNING'; p.error = null; save();
  const aiDir = path.join(p.path, p.planDir);
  fs.mkdirSync(aiDir, { recursive: true });
  for (const f of ['questions.json', 'tasks.json']) fs.rmSync(path.join(aiDir, f), { force: true }); // never reuse a stale plan
  const tpl = path.join(p.path, p.taskDir, 'TEMPLATE.md');
  if (!fs.existsSync(tpl)) { fs.mkdirSync(path.dirname(tpl), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'tasks', 'TEMPLATE.md'), tpl); }

  const context = productDecisions(p) +
    (p.planNotes ? `\n\nProduct owner feedback on the previous plan (apply it):\n${p.planNotes}` : '') +
    (done.length ? `\n\nThese tasks are already DONE and committed. Keep them in tasks.json with the same id, and plan the remaining work on top of them:\n${done.map((t) => `- ${t.id}: ${t.title}`).join('\n')}` : '');
  const outputs = `Write ${p.planDir}/tasks.json: a JSON array in execution order of {"id":"${p.kind === 'ticket' ? `${p.ticketKey}-01` : 'TASK-001'}","title":"...","phase":1,"owner":"backend-dev","dependsOn":[]}. ` +
    'Every task owner must be backend-dev or frontend-dev. ' +
    `If business decisions are missing, pick a reversible default, and also write ${p.planDir}/questions.json: a JSON array (max 8) of {"question":"...","options":["recommended choice first","alternative"]}. ` +
    'Do not repeat questions already answered above. Do not write or change application code.';
  const prompt = p.kind === 'ticket'
    ? `You are planning work on an EXISTING codebase for Jira ticket ${p.ticketKey}:\n\n${p.idea}${context}\n\n` +
      'First study the repository: README, CLAUDE.md or AGENTS.md, package.json scripts, folder structure, and the existing tests, so the plan fits its stack and conventions. ' +
      `Write ${p.planDir}/ANALYSIS.md: ticket summary, affected areas and files, refined testable acceptance criteria, test approach using the repo's existing test commands, risks, and open questions. ` +
      `Write one ${p.taskDir}/${p.ticketKey}-NN.md per task using ${p.taskDir}/TEMPLATE.md. Keep tasks small and focused on this ticket (usually 1 to 5 tasks). Name the real test commands of this repo in each task. ` +
      outputs
    : `Product idea from the product owner:\n\n${p.idea}${context}\n\n` +
      'Plan this project. Write docs/PRD.md, docs/ARCHITECTURE.md, docs/BACKLOG.md and one tasks/TASK-NNN.md per task using tasks/TEMPLATE.md. ' +
      'Group tasks into phases (phase 1 = project setup and foundations). Keep each task small enough for one developer session, with observable acceptance criteria and real test commands. ' +
      'If the project has no code yet, TASK-001 sets up the stack and test tooling. ' +
      outputs;
  const r = await agentRun(p, p, 'pm-ba-plan', 'claude', claudeArgs('pm-ba', prompt, [...PM_TOOLS, ...p.allowTools]), job);
  if (job.paused) {
    say(`☕ [${p.name}] planning paused for the tea break; it restarts afterwards`);
    Object.assign(p, before, { resumePlan: true });
    if (p.status === 'AWAITING_APPROVAL') addPlanDecision(p);
    return;
  }
  if (!r) { Object.assign(p, before); if (p.status === 'AWAITING_APPROVAL') addPlanDecision(p); return; }
  raiseDenials(p, r.denials, 'PM/BA');
  if (r.limited) {
    Object.assign(p, before, { resumePlan: true, error: `Planning paused: usage limit reached. It restarts automatically after ${new Date(r.limited).toLocaleTimeString()}.` });
    if (p.status === 'AWAITING_APPROVAL') addPlanDecision(p);
    pauseForLimit(r.limited, `${p.name} PM/BA`);
    return;
  }
  if (job.stopped) {
    say(`■ [${p.name}] planning stopped by you`);
    Object.assign(p, before, { error: 'Planning stopped by you. PM/BA may have left changed files in the project.' });
    if (p.status === 'AWAITING_APPROVAL') addPlanDecision(p);
    return;
  }
  try {
    const old = new Map(p.tasks.map((t) => [t.id, t]));
    p.tasks = normaliseTasks(JSON.parse(fs.readFileSync(path.join(aiDir, 'tasks.json'), 'utf8')))
      .map((t) => ({ ...t, runs: old.get(t.id)?.runs ?? [], status: old.get(t.id)?.status === 'DONE' ? 'DONE' : t.status }));
  } catch (e) {
    Object.assign(p, before);
    if (p.status === 'AWAITING_APPROVAL') addPlanDecision(p);
    p.status = p.tasks.length ? p.status : 'NEW';
    p.error = `Planning produced no valid .aiteam/tasks.json (${e.message}). Check the PM/BA log.`;
    say(`✗ [${p.name}] ${p.error}`);
    return;
  }
  let questions = [];
  try { questions = normaliseQuestions(JSON.parse(fs.readFileSync(path.join(aiDir, 'questions.json'), 'utf8'))); } catch { /* questions are optional */ }
  for (const q of questions) {
    addDecision(p, { kind: 'question', question: q.question, options: [...q.options.map((o) => [o, o]), ['other', 'Other (write it in the note)']] });
  }
  p.status = 'AWAITING_APPROVAL';
  say(`✓ [${p.name}] plan ready: ${p.tasks.length} tasks, ${questions.length} question(s)`);
  addPlanDecision(p);
}

function approve(p) {
  if (p.kind === 'ticket') { if (!branchExists(p, p.branch)) git(p.path, 'branch', p.branch); } // your checkout stays as it is
  else { try { git(p.path, 'switch', '-c', p.branch); } catch { git(p.path, 'switch', p.branch); } }
  // Ticket plans live in git-excluded .aiteam/, so there is nothing to commit; never sweep other changes into a "plan" commit.
  if (p.kind !== 'ticket') {
    git(p.path, 'add', '-A');
    if (git(p.path, 'status', '--porcelain')) git(p.path, 'commit', '-q', '-m', 'docs: AI Team project plan (PM/BA)');
  }
  for (const t of p.tasks) if (t.status === 'BACKLOG') t.status = 'READY';
  p.status = 'APPROVED';
  say(`✓ [${p.name}] plan approved on branch ${p.branch}`);
}

// Ticket task files live in the (git-excluded) project folder; project task files are tracked, so write them in the task's worktree.
function appendToTask(p, t, wt, heading, text) {
  const file = path.join(p.kind === 'ticket' ? p.path : wt, p.taskDir, `${t.id}.md`);
  if (fs.existsSync(file)) fs.appendFileSync(file, `\n\n## ${heading} (${now().slice(0, 16)})\n\n${text.trim()}\n`);
}

// Usage limit hit: pause all agent work until the reset time, then the scheduler continues by itself.
function pauseForLimit(until, who) {
  state.pausedUntil = Math.max(state.pausedUntil || 0, until);
  say(`⏸ usage limit reached (${who}). Pausing until ${new Date(state.pausedUntil).toLocaleString()}, then continuing automatically.`);
  save();
}

async function runTask(p, t, job) {
  let wt;
  try { wt = ensureWorktree(p, t); } catch (e) { return block(p, t, `Could not prepare this task's workspace: ${e.message}`); }
  let feedback = t.feedback || '';
  // Hand the task back to the queue without counting a failure (break, tea break or usage limit); work is kept in its worktree.
  const park = (stage, note) => {
    Object.assign(t, { status: 'READY', skipDev: stage === 'QA', feedback, note });
    if (!p.auto) p.runBudget++;
    save();
    return 'parked';
  };
  const holdFor = (role) => state.teaBreak ? 'Paused for the team tea break'
    : state.breaks[role] ? `Waiting: ${NICK[role]} is on a break`
    : state.pausedUntil > Date.now() ? `Waiting for usage limit reset (${new Date(state.pausedUntil).toLocaleTimeString()})` : null;
  const limitedAt = (stage, until) => { pauseForLimit(until, `${t.id} ${stage}`); return park(stage, `Waiting for usage limit reset (${new Date(until).toLocaleTimeString()})`); };

  for (let cycle = t.cycles || 0; cycle <= MAX_FIX_CYCLES; cycle++) {
    t.cycles = cycle; t.note = null;
    if (!t.skipDev) {
      const hold = holdFor(t.owner);
      if (hold) return park('DEV', hold);
      t.status = 'IN_PROGRESS'; save();
      const devPrompt = `Implement ${t.id}: ${t.title}.\nRead ${p.taskDir}/${t.id}.md for scope, acceptance criteria and test plan.${p.kind === 'ticket' ? ` This is an existing codebase: follow its conventions, keep the change focused on ${p.ticketKey}, and do not break existing tests.` : ''} ` +
        'Install dependencies you need, write the code and tests, run the tests, and fill in the Implementation evidence section of the task file. Do not commit.' +
        productDecisions(p) +
        (t.instructions ? `\n\nInstructions from the product owner for this task:\n${t.instructions}` : '') +
        (feedback ? `\n\nYour previous attempt was not accepted. Fix every point:\n\n${feedback}` : '') +
        (t.interrupted ? '\n\nYour previous session was interrupted by a break. Continue from the current state of the workspace.' : '');
      t.interrupted = false;
      const dev = await agentRun(p, t, `${t.id}-dev-${cycle}`, 'claude', claudeArgs(t.owner, devPrompt, [...DEV_TOOLS, ...p.allowTools]), job, wt);
      if (job.paused) { t.interrupted = true; return park('DEV', 'Paused for the team tea break'); }
      if (!dev || job.stopped) return block(p, t, 'Stopped by you during development.');
      raiseDenials(p, dev.denials, `${t.id} (${t.owner})`);
      if (dev.limited) return limitedAt('DEV', dev.limited);
    }
    t.skipDev = false;
    const hold = holdFor('qa');
    if (hold) return park('QA', hold);

    t.status = 'QA'; save();
    const reportFile = path.join(DATA, 'logs', p.id, `${t.id}-qa-${cycle}-${Date.now()}.report.md`);
    const qaPrompt = `${agentBody('qa-engineer')}\n\n---\nTask under test: ${p.taskDir}/${t.id}.md (${t.title}).${p.kind === 'ticket' ? ` Existing codebase: also run the existing test suite to catch regressions.` : ''}\n` +
      'The implementation is the uncommitted change set: inspect it with git status and git diff. Run the real lint, typecheck and test commands. ' +
      'Do not edit application code or tests. End your reply with exactly one line: VERDICT: PASS, VERDICT: FAIL or VERDICT: BLOCKED.';
    const qa = await agentRun(p, t, `${t.id}-qa-${cycle}`, 'codex', ['exec', '--json', '-C', wt, '-s', 'workspace-write', '-o', reportFile, qaPrompt], job, wt);
    if (job.paused) return park('QA', 'Paused for the team tea break (QA restarts)');
    if (!qa || job.stopped) return block(p, t, 'Stopped by you during QA.');
    if (qa.limited) return limitedAt('QA', qa.limited);
    const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : '';
    fs.appendFileSync(qa.logPath, `\n===== QA report =====\n${report || '(none)'}\n`);
    const verdict = parseVerdict(report);
    say(`${verdict === 'PASS' ? '✓' : '✗'} [${p.name}] ${t.id} QA verdict: ${verdict} (attempt ${cycle + 1}/${MAX_FIX_CYCLES + 1})`);
    appendToTask(p, t, wt, `QA run ${cycle + 1} (Codex): ${verdict}`, report || 'No QA report produced.');

    if (verdict === 'PASS') {
      git(wt, 'add', '-A');
      const secrets = secretFiles(git(wt, 'diff', '--cached', '--name-only').split('\n'));
      if (secrets.length) { git(wt, 'reset', '-q'); return block(p, t, `QA passed but secret-like files were created: ${secrets.join(', ')}. Add them to .gitignore, then choose "Retry, keeping this task's work".`); }
      git(wt, 'commit', '-q', '--allow-empty', '-m', `feat(${t.id}): ${t.title}\n\nQA: PASS (Codex), fix cycles: ${cycle}`);
      let merged;
      try { merged = mergeTask(p, t, wt); } catch (e) { return block(p, t, e.message); }
      if (merged !== true) { feedback = merged; t.status = 'CHANGES_REQUESTED'; say(`⚔ [${p.name}] ${t.id} merge conflict, back to ${NICK[t.owner]}`); save(); continue; }
      if (p.kind === 'ticket') fs.copyFileSync(path.join(wt, p.taskDir, `${t.id}.md`), path.join(p.path, p.taskDir, `${t.id}.md`));
      removeWorktree(p, t);
      Object.assign(t, { status: 'DONE', instructions: null, feedback: null, cycles: 0 });
      save();
      say(`✓ [${p.name}] ${t.id} DONE · merged into ${p.branch}`);
      return true;
    }
    if (verdict === 'BLOCKED') return block(p, t, `QA reported BLOCKED (missing tooling, environment or unclear criteria):\n\n${clip(report, 1500)}`);
    feedback = `QA (an independent reviewer) FAILED it:\n\n${report}`;
    t.status = 'CHANGES_REQUESTED'; save();
  }
  return block(p, t, `QA failed ${MAX_FIX_CYCLES + 1} times. Last report:\n\n${clip(feedback, 1500)}`);
}

async function runTaskJob(p, t, job) {
  const r = await runTask(p, t, job);
  if (r !== true && r !== 'parked') p.runBudget = 0; // blocked or stopped: a human decides
  if (p.tasks.length && p.tasks.every((x) => x.status === 'DONE')) { p.runBudget = 0; say(`🏁 [${p.name}] all ${p.tasks.length} tasks DONE`); }
}

const inFocus = (p) => !state.focus || state.focus === p.id;

// Start one piece of work if an agent is free: queued planning first, then ready tasks of auto-run/queued projects.
function startNext() {
  for (const p of state.projects.filter(inFocus)) {
    if (p.resumePlan && !projectJobs(p).length && roleFree('pm-ba')) {
      p.resumePlan = false;
      startJob({ kind: 'plan', projectId: p.id, project: p.name, label: `${p.name}: PM/BA planning` }, (job) => plan(p, job).catch((e) => { p.status = 'NEW'; p.error = e.message; }));
      return true;
    }
  }
  for (const p of state.projects.filter(inFocus)) {
    if (p.status !== 'APPROVED' || p.resumePlan || !(p.auto || p.runBudget > 0) || p.tasks.some((t) => t.status === 'BLOCKED')) continue;
    if (projectJobs(p).some((j) => j.kind === 'plan')) continue;
    const t = readyTasks(p.tasks).find((x) => roleFree(x.skipDev ? 'qa' : x.owner));
    if (!t) continue;
    if (!p.auto) p.runBudget--;
    t.status = t.skipDev ? 'QA' : 'IN_PROGRESS'; // claimed, so no other job picks it
    startJob({ kind: 'task', projectId: p.id, project: p.name, taskId: t.id, label: `${p.name}: ${t.id}` }, (job) => runTaskJob(p, t, job));
    return true;
  }
  return false;
}

let wasOpen = true;
function tick() {
  const open = isOpen(state.workHours);
  if (open !== wasOpen) { wasOpen = open; say(open ? '🏢 office open, the team is back at work' : `🌙 office closed, queued work waits until ${state.workHours.start}`); }
  if (!open || state.teaBreak) return;
  if (state.pausedUntil) {
    if (Date.now() < state.pausedUntil) return;
    state.pausedUntil = null; save();
    say('▶ usage limit window reset, continuing');
  }
  while (jobs.size < MAX_AGENTS && startNext());
}
setInterval(tick, 15_000);
const kick = () => setImmediate(tick);

// ---------- daily scheduler (only while this server runs) ----------
setInterval(() => {
  const d = new Date();
  const today = d.toDateString();
  if (!DAILY_AT || d.toTimeString().slice(0, 5) !== DAILY_AT || state.lastDaily === today) return;
  state.lastDaily = today; save();
  say(`⏰ daily run (${DAILY_TASKS} task(s) per approved project)`);
  for (const p of state.projects) if (p.status === 'APPROVED' && !p.auto) p.runBudget += DAILY_TASKS;
  save(); kick();
}, 30_000);

// ---------- HTTP ----------
const send = (res, code, body, type = 'application/json') =>
  res.writeHead(code, { 'Content-Type': type }).end(type === 'application/json' ? JSON.stringify(body) : body);

async function readJson(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 100_000) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}

function view(p) {
  const tasks = p.tasks.map((t) => ({ ...t, usage: sumUsage(t.runs.map((r) => r.usage)) }));
  return { ...p, tasks, usage: sumUsage([...p.runs, ...p.tasks.flatMap((t) => t.runs)].map((r) => r.usage)) };
}

const server = http.createServer(async (req, res) => {
  try {
    // Block other websites / DNS rebinding from driving local agents.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'bad host' });
    if (req.method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'json only' });

    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(import.meta.dirname, 'office.html')), 'text/html');
    if (req.method === 'GET' && url.pathname === '/board') return send(res, 200, fs.readFileSync(path.join(import.meta.dirname, 'index.html')), 'text/html');
    if (req.method === 'GET' && url.pathname === '/sounds.js') return send(res, 200, fs.readFileSync(path.join(import.meta.dirname, 'sounds.js')), 'text/javascript');
    if (req.method === 'GET' && url.pathname === '/template') {
      const file = url.searchParams.get('type') === 'ticket' ? 'JIRA_TICKET.md' : 'PROJECT_IDEA.md';
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"` });
      return res.end(fs.readFileSync(path.join(ROOT, 'templates', file)));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { busy: busyText(), busyProjects: [...new Set([...jobs.values()].map((j) => j.projectId))], maxAgents: MAX_AGENTS, focus: state.focus || null, breaks: state.breaks,
      jobs: [...jobs.values()].map(({ id, kind, projectId, project, taskId, label, role, agentLabel, agentStartedAt, needs }) => ({ id, kind, projectId, project, taskId, label, role, agentLabel, agentStartedAt, needs })),
      teaBreak: !!state.teaBreak, workHours: state.workHours || null, open: isOpen(state.workHours), pausedUntil: state.pausedUntil || null, claudeUsage: state.claudeUsage || null, dailyAt: DAILY_AT, dailyTasks: DAILY_TASKS, projects: state.projects.map(view) });

    if (req.method === 'GET' && parts[1] === 'log') {
      const [pid, file] = [url.searchParams.get('project'), url.searchParams.get('file')];
      if (!/^[\w-]+$/.test(pid || '') || !/^[\w.-]+$/.test(file || '')) return send(res, 400, { error: 'bad log name' });
      const f = path.join(DATA, 'logs', pid, file);
      return send(res, 200, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(no output yet)', 'text/plain; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
      // Native macOS folder dialog; Cancel returns null.
      const script = 'tell application "System Events" to activate\nPOSIX path of (choose folder with prompt "Select project folder")';
      const picked = await new Promise((resolve) => execFile('osascript', ['-e', script], (err, out) => resolve(err ? null : out.trim().replace(/(.)\/$/, '$1'))));
      return send(res, 200, { path: picked });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const { workHours } = await readJson(req);
      const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (workHours !== null && !(hhmm.test(workHours?.start) && hhmm.test(workHours?.end) && workHours.start !== workHours.end)) return send(res, 400, { error: 'Office hours need a start and end time (HH:MM) that differ' });
      state.workHours = workHours && { start: workHours.start, end: workHours.end, weekdaysOnly: !!workHours.weekdaysOnly };
      say(state.workHours ? `🏢 office hours set: ${state.workHours.start}–${state.workHours.end}${state.workHours.weekdaysOnly ? ', Mon–Fri' : ''}` : '🏢 office hours: always open');
      save(); kick();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/teabreak') {
      state.teaBreak = !!(await readJson(req)).on;
      say(state.teaBreak ? `☕ team tea break: all agents stop now${jobs.size ? ` (pausing ${busyText()})` : ''}` : '▶ tea break over, back to work');
      if (state.teaBreak) for (const j of jobs.values()) { j.paused = true; killTree(j.child); }
      save(); kick();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/resume') {
      state.pausedUntil = null; save();
      say('▶ resumed by you');
      kick();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const { jobId } = await readJson(req);
      const targets = [...jobs.values()].filter((j) => !jobId || j.id === jobId);
      if (!targets.length) return send(res, 400, { error: 'Nothing is running' });
      for (const j of targets) { j.stopped = true; say(`■ stop requested: ${j.label}`); killTree(j.child); }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/focus') {
      const { projectId } = await readJson(req);
      if (projectId && !state.projects.some((x) => x.id === projectId)) return send(res, 400, { error: 'Unknown project' });
      state.focus = projectId || null;
      say(state.focus ? `🎯 team focus: ${state.projects.find((x) => x.id === projectId).name} only` : '🎯 team focus cleared: all projects');
      save(); kick();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/break') {
      const { role, on } = await readJson(req);
      if (!NICK[role]) return send(res, 400, { error: 'Unknown agent' });
      if (on) state.breaks[role] = true; else delete state.breaks[role];
      say(on ? `☕ ${NICK[role]} is on a break (finishes the current step first)` : `▶ ${NICK[role]} is back at work`);
      save(); kick();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const body = await readJson(req);
      const { name, path: dir, idea } = body;
      const kind = body.kind === 'ticket' ? 'ticket' : 'idea';
      const ticketKey = kind === 'ticket' ? String(body.ticketKey ?? '').trim().toUpperCase() : null;
      if (kind === 'ticket' && !/^[A-Z][A-Z0-9]*-\d+$/.test(ticketKey)) return send(res, 400, { error: 'Jira key must look like MINT-123' });
      if (!name?.trim() || !dir?.trim() || !idea?.trim()) return send(res, 400, { error: kind === 'ticket' ? 'Folder, Jira key and ticket details are required' : 'name, path and idea are required' });
      const abs = path.resolve(dir.trim().replace(/^~(?=\/)/, process.env.HOME));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return send(res, 400, { error: `Folder not found: ${abs}` });
      try { git(abs, 'rev-parse', '--is-inside-work-tree'); } catch { return send(res, 400, { error: 'Folder is not a git repository. Run "git init" in it first.' }); }
      const id = crypto.randomUUID().slice(0, 8);
      say(`+ project added: ${name.trim()} (${abs})`);
      if (state.projects.some((x) => x.kind === 'ticket' && x.ticketKey === ticketKey && x.path === abs)) return send(res, 400, { error: `${ticketKey} is already added for this repo` });
      if (kind === 'ticket') {
        // Keep AI planning files out of git so they never land in the ticket's PR.
        const exclude = path.resolve(abs, git(abs, 'rev-parse', '--git-path', 'info/exclude'));
        const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
        if (!cur.split('\n').includes('.aiteam/')) { fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.aiteam/\n`); }
      }
      state.projects.push({
        id, kind, ticketKey, name: name.trim(), path: abs, idea: idea.trim(), status: 'NEW', tasks: [], runs: [], decisions: [], allowTools: [],
        branch: kind === 'ticket' ? `ai-team/${ticketKey}` : `ai-team/${id}`,
        planDir: kind === 'ticket' ? `.aiteam/${ticketKey}` : '.aiteam',
        taskDir: kind === 'ticket' ? `.aiteam/${ticketKey}/tasks` : 'tasks',
      });
      save();
      return send(res, 201, { id });
    }

    const p = parts[0] === 'api' && parts[1] === 'projects' && state.projects.find((x) => x.id === parts[2]);
    if (req.method === 'POST' && p) {
      const body = await readJson(req);
      const action = parts[3];

      if (action === 'decisions') {
        const d = p.decisions.find((x) => x.id === parts[4] && !x.answer);
        if (!d) return send(res, 404, { error: 'Decision not found or already answered' });
        if (!d.options.some((o) => o.value === body.answer)) return send(res, 400, { error: 'Choose one of the options' });
        const note = String(body.note ?? '').trim().slice(0, 4000);
        if (body.answer === 'other' && !note) return send(res, 400, { error: 'Write your answer in the note' });
        if (d.kind === 'plan' && projectJobs(p).length) return send(res, 409, { error: `Busy: ${busyText()}. Try again when the agent finishes.` });
        answer(p, d, body.answer, note);
        save();
        return send(res, 200, { ok: true });
      }

      if (action === 'edit') {
        const name = String(body.name ?? '').trim(), idea = String(body.idea ?? '').trim();
        if (!name || !idea) return send(res, 400, { error: 'Name and idea are required' });
        Object.assign(p, { name, idea }); save();
        say(`✎ [${p.name}] project edited`);
        return send(res, 200, { ok: true });
      }
      // run/auto only queue work, so they are always allowed; the rest must not touch a project an agent is working in.
      const queues = action === 'run' || action === 'auto';
      if (!queues && action !== 'plan' && projectJobs(p).length) return send(res, 409, { error: `Busy: ${busyText()}. Stop it or wait until it finishes.` });
      if (action === 'remove') {
        say(`- project removed: ${p.name}`);
        for (const t of p.tasks) if (fs.existsSync(path.join(WT, p.id, t.id))) removeWorktree(p, t);
        try { git(p.path, 'worktree', 'remove', '--force', path.join(WT, p.id, '_integration')); } catch { /* none */ }
        fs.rmSync(path.join(WT, p.id), { recursive: true, force: true });
        if (state.focus === p.id) state.focus = null;
        state.projects = state.projects.filter((x) => x !== p);
        fs.rmSync(path.join(DATA, 'logs', p.id), { recursive: true, force: true });
        save();
        return send(res, 200, { ok: true });
      }
      if (action === 'plan' && p.status !== 'PLANNING') {
        // Before the first plan and after approval, uncommitted files are not PM/BA's and would be committed with the plan.
        const mustBeClean = p.status === 'APPROVED' || (p.status === 'NEW' && !p.runs.length);
        if (mustBeClean && git(p.path, 'status', '--porcelain')) return send(res, 400, { error: 'Project has uncommitted changes (for example from a blocked task). Resolve them, or commit or stash them, before planning.' });
        p.planNotes = String(body.note ?? '').trim() || null;
        startPlan(p);
        say(`▷ [${p.name}] planning queued`);
        return send(res, 202, { queued: true });
      }
      if (action === 'retry') {
        const t = p.tasks.find((x) => x.id === parts[4]);
        if (!t || !['BLOCKED', 'DONE', 'READY'].includes(t.status)) return send(res, 400, { error: 'Only BLOCKED, DONE or READY tasks can be retried' });
        if (projectJobs(p).some((j) => j.taskId === t.id)) return send(res, 409, { error: `${t.id} is being worked on` });
        if (!['continue', 'restart'].includes(body.mode)) return send(res, 400, { error: 'mode must be continue or restart' });
        retryTask(p, t, body.mode, String(body.note ?? '').trim().slice(0, 4000));
        save();
        return send(res, 200, { ok: true });
      }
      if (action === 'auto') {
        p.auto = !!body.on;
        if (!p.auto) p.runBudget = 0;
        say(`${p.auto ? '⟳' : '⏹'} [${p.name}] auto-run ${p.auto ? 'on' : 'off'}`);
        save(); kick();
        return send(res, 200, { ok: true });
      }
      if (action === 'run' && p.status === 'APPROVED') {
        p.runBudget = Math.min(Math.max(Number(body.max) || 1, 1), 50);
        say(`▷ [${p.name}] ${p.runBudget} task(s) queued`);
        save(); kick();
        return send(res, 202, { ok: true });
      }
      return send(res, 400, { error: `Cannot ${action} while project is ${p.status}` });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// Ctrl+C or kill: stop the agents too, so none keep running without the app. Their tasks resume on the next start.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (jobs.size) say(`■ shutting down: stopping ${busyText()}`);
  for (const j of jobs.values()) { j.paused = true; killTree(j.child); } // paused, not failed: they resume on the next start
  setTimeout(() => { for (const j of jobs.values()) try { process.kill(-j.child.pid, 'SIGKILL'); } catch { /* gone */ } process.exit(0); }, jobs.size ? 1500 : 0);
});

server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is AI Team already running? Stop it or use PORT=<other>.` : e); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI Team running at http://localhost:${PORT}  (up to ${MAX_AGENTS} agents at once, daily run: ${DAILY_AT || 'off'}, ${DAILY_TASKS} tasks/project)`);
  console.log(`Logging workflow events${SHOW_AGENT ? ' and agent output (LOG_AGENT=0 to hide agent output)' : ''}. Press Ctrl+C to stop.`);
  for (const p of state.projects) say(`  ${p.name}: ${p.status} · ${p.tasks.filter((t) => t.status === 'DONE').length}/${p.tasks.length} done · ${pending(p).length} waiting for you`);
});
