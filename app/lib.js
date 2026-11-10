import path from 'node:path';

// Pure helpers, kept separate so they can be unit tested.

// Last "VERDICT: X" line wins; a missing verdict counts as BLOCKED, never PASS.
export function parseVerdict(text) {
  const all = [...String(text).matchAll(/VERDICT\W*(PASS|FAIL|BLOCKED)\b/gi)];
  return all.length ? all.at(-1)[1].toUpperCase() : 'BLOCKED';
}

// READY tasks whose dependencies are all DONE, in plan order.
export function readyTasks(tasks) {
  const done = new Set(tasks.filter((t) => t.status === 'DONE').map((t) => t.id));
  return tasks.filter((t) => t.status === 'READY' && t.dependsOn.every((d) => done.has(d)));
}
export const nextTask = (tasks) => readyTasks(tasks)[0];

// Normalise the PM/BA agent's tasks.json into the orchestrator's task shape.
// Task ids become branch and folder names, so they must be plain and unique.
export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function normaliseTasks(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('tasks.json must be a non-empty array');
  const seen = new Set();
  return raw.map((t) => {
    if (!t || !t.id || !t.title) throw new Error('each task needs id and title');
    const id = String(t.id);
    if (!TASK_ID.test(id)) throw new Error(`invalid task id "${id.slice(0, 40)}" (letters, digits, - and _ only, starting with a letter or digit)`);
    if (seen.has(id)) throw new Error(`duplicate task id ${id}`);
    seen.add(id);
    return {
      id,
      title: String(t.title),
      phase: Number(t.phase) || 1,
      owner: t.owner === 'frontend-dev' ? 'frontend-dev' : 'backend-dev',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
      status: 'BACKLOG',
      cycles: 0,
      runs: [],
    };
  });
}

// PM/BA open questions: [{question, options:[...]}] -> at most 8 valid ones.
export function normaliseQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length)
    .slice(0, 8)
    .map((q) => ({ question: q.question.trim(), options: q.options.slice(0, 6).map(String) }));
}

const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*)$/;
export const secretFiles = (paths) => paths.filter((p) => SECRET_FILE.test(p) && !p.endsWith('.env.example'));

// ---------- agent event logs ----------
export const clip = (s, n = 400) => {
  s = String(s ?? '').trim();
  return s.length > n ? `${s.slice(0, n)} …(+${s.length - n} chars)` : s;
};
const toText = (c) => (Array.isArray(c) ? c.map((x) => x.text ?? '').join('\n') : String(c ?? ''));
const brief = (input = {}) => input.command ?? input.file_path ?? input.pattern ?? input.url ?? JSON.stringify(input);
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

// Claude Code `--output-format stream-json` event -> readable log line (or null). Fills acc.
export function formatClaudeEvent(e, acc) {
  switch (e.type) {
    case 'rate_limit_event': {
      acc.rate = e.rate_limit_info ?? null;
      const st = acc.rate?.status ?? '';
      return st && st !== 'allowed' ? `⚠ usage limit status: ${st}${acc.rate.resetsAt ? ` (resets ${new Date(acc.rate.resetsAt * 1000).toLocaleTimeString()})` : ''}` : null;
    }
    case 'system':
      if (e.subtype === 'init') acc.model = e.model;
      return e.subtype === 'init' ? `▶ Claude Code · model ${e.model}` : null;
    case 'assistant': {
      // Context in use = everything sent to the model on this turn.
      const u = e.message?.usage;
      if (u) acc.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const said = (e.message?.content ?? []).filter((c) => c.type === 'text' && c.text.trim()).map((c) => c.text.trim());
      if (said.length) acc.notes = [...(acc.notes ?? []), ...said].slice(-12); // memory for a fresh session
      return (e.message?.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? `→ ${c.name}: ${clip(brief(c.input), 300)}` : null))
        .filter(Boolean).join('\n') || null;
    }
    case 'user':
      return (e.message?.content ?? [])
        .filter((c) => c.type === 'tool_result')
        .map((c) => `   ${c.is_error ? '✗' : '←'} ${clip(toText(c.content))}`).join('\n') || null;
    case 'result': {
      const u = e.usage ?? {};
      acc.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, costUsd: e.total_cost_usd ?? 0 };
      acc.text = e.result ?? '';
      acc.denials = e.permission_denials ?? [];
      acc.isError = !!e.is_error;
      acc.apiStatus = e.api_error_status ?? null;
      acc.window = Object.values(e.modelUsage ?? {}).find((m) => m.contextWindow)?.contextWindow ?? null;
      return `■ ${e.subtype} · ${e.num_turns ?? '?'} turns · ${Math.round((e.duration_ms ?? 0) / 1000)}s`;
    }
    default:
      return null;
  }
}

// Codex `exec --json` event -> readable log line (or null). Fills acc.usage.
export function formatCodexEvent(e, acc) {
  const it = e.item ?? {};
  if (e.type === 'turn.completed') {
    const u = e.usage ?? {};
    const cached = u.cached_input_tokens ?? 0;
    acc.usage = sumUsage([acc.usage, { input: (u.input_tokens ?? 0) - cached, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), cacheRead: cached, cacheWrite: u.cache_write_input_tokens ?? 0, costUsd: 0 }]);
    return '■ turn completed';
  }
  if (e.type === 'turn.failed' || e.type === 'error') {
    acc.errorText = `${acc.errorText ?? ''} ${e.error?.message ?? e.message ?? ''}`.trim();
    return `✗ ${clip(e.error?.message ?? e.message)}`;
  }
  if (e.type === 'item.started' && it.type === 'command_execution') return `→ $ ${clip(it.command, 300)}`;
  if (e.type !== 'item.completed') return null;
  if (it.type === 'agent_message') return it.text;
  if (it.type === 'command_execution') return `   ${it.exit_code === 0 ? '←' : '✗'} exit ${it.exit_code}: ${clip(it.aggregated_output)}`;
  if (it.type === 'file_change') return `→ file change: ${clip(JSON.stringify(it.changes ?? it), 300)}`;
  if (it.type === 'error') return `! ${clip(it.message, 200)}`;
  return null;
}

export function sumUsage(list) {
  const total = { ...ZERO };
  for (const u of list) if (u) for (const k of Object.keys(ZERO)) total[k] += u[k] ?? 0;
  return total;
}

// A denied tool call -> an allow rule for exactly that call (never a wildcard), or null when none is safe to offer.
// The user sees the exact command and approves it; similar commands with other arguments stay blocked.
// Commands that can run arbitrary code, change privileges or persist: never offered, even as an exact command.
const NEVER = /^(sh|bash|zsh|fish|dash|ksh|csh|tcsh|python[\d.]*|perl|ruby|php|lua|node|deno|bun|osascript|env|xargs|sudo|su|doas|eval|exec|command|builtin|source|find|awk|gawk|sed|nohup|timeout|nice|time|watch|parallel|ssh|scp|rsync|nc|ncat|socat|dd|rm|chmod|chown|crontab|launchctl|open|npx)$/i;
export function permissionRule(d) {
  if (d.tool_name === 'WebFetch') {
    try { const host = new URL(d.tool_input?.url).hostname; return /^[a-z0-9.-]+$/i.test(host) ? `WebFetch(domain:${host})` : null; } catch { return null; }
  }
  if (d.tool_name !== 'Bash') return null;
  const cmd = String(d.tool_input?.command ?? '').trim().replace(/\s+/g, ' ');
  if (!cmd || cmd.length > 200 || /[;&|`$<>(){}\\'"*?\n]/.test(cmd)) return null;
  const first = cmd.split(' ')[0];
  if (!/^[a-z][\w.-]*$/i.test(first) || NEVER.test(first)) return null;
  return `Bash(${cmd})`;
}

// ---------- usage limits ----------
const LIMIT_TEXT = /usage limit|rate.?limit|hit your limit|limit reached|quota|too many requests|usage_limit/i;

// When an agent run stopped because the subscription usage limit was hit, return the time (ms)
// to resume; otherwise null. Only failed runs are checked, so a task *about* rate limiting is not a false alarm.
export function limitUntil(r, code, now = Date.now()) {
  const info = r.rate;
  const resets = info?.resetsAt ? info.resetsAt * 1000 : 0;
  if (/reject/i.test(info?.status ?? '')) return resets > now ? resets + 60_000 : now + 30 * 60_000;
  const text = `${r.errorText ?? ''} ${r.isError ? r.text ?? '' : ''}`;
  const failed = code !== 0 || r.isError || r.errorText;
  if (!failed || !(r.apiStatus === 429 || LIMIT_TEXT.test(text))) return null;
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000 + 60_000;
  if (resets > now) return resets + 60_000;
  const m = text.match(/(\d+)\s*(hours?|hrs?|minutes?|mins?)/i);
  if (m) return now + Number(m[1]) * (/^h/i.test(m[2]) ? 3_600_000 : 60_000) + 60_000;
  return now + 30 * 60_000;
}

// ---------- office hours ----------
// hours: null = always open, or { start: 'HH:MM', end: 'HH:MM', weekdaysOnly: bool }. end < start means overnight.
export function isOpen(hours, d = new Date()) {
  if (!hours) return true;
  if (hours.weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) return false;
  const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const m = d.getHours() * 60 + d.getMinutes(), s = mins(hours.start), e = mins(hours.end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

// ---------- login / subscription failures ----------
const AUTH_TEXT = /invalid api key|please run \/login|not logged in|log ?in (is )?required|authentication[_ ]error|unauthori[sz]ed|oauth token (has )?expired|token (has )?expired|credit balance is too low|subscription (has )?(expired|inactive|required)|not included in your plan|plan does not include|payment required|billing/i;

// When a failed agent run looks like a login or subscription problem, return a short reason; otherwise null.
// Only failed runs are checked, so a task *about* authentication is not a false alarm.
export function authFailure(r, code) {
  const failed = code !== 0 || r.isError || r.errorText;
  if (!failed) return null;
  if (r.apiStatus === 401 || r.apiStatus === 403 || r.apiStatus === 402) return `HTTP ${r.apiStatus} from the service`;
  const text = `${r.errorText ?? ''} ${r.isError ? r.text ?? '' : ''} ${r.stderr ?? ''}`;
  const m = text.match(AUTH_TEXT);
  return m ? clip(text.slice(Math.max(0, m.index - 60), m.index + 140), 200) : null;
}

// ---------- weekly usage ----------
// Tokens AI Team used per engine since a time (ms): total processed (incl. cache) and output.
export function tokensSince(runs, since) {
  const out = { claude: { total: 0, out: 0, runs: 0 }, codex: { total: 0, out: 0, runs: 0 } };
  for (const r of runs) {
    const e = out[r.engine];
    if (!e || !r.usage || !(Date.parse(r.startedAt) >= since)) continue;
    e.total += r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
    e.out += r.usage.output;
    e.runs++;
  }
  return out;
}

// Codex session log (JSON lines) -> its latest rate limits: { fiveHour, week } each { pct, resetsAt (ms) }.
export function codexRateLimits(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('rate_limits')) continue;
    let rl;
    try { rl = JSON.parse(lines[i]).payload?.rate_limits; } catch { continue; }
    if (!rl) continue;
    const pick = (w) => w && { pct: Number(w.used_percent) || 0, resetsAt: w.resets_at ? w.resets_at * 1000 : null };
    const windows = [rl.primary, rl.secondary].filter(Boolean);
    return { fiveHour: pick(windows.find((w) => w.window_minutes <= 300)), week: pick(windows.find((w) => w.window_minutes >= 10080)) };
  }
  return null;
}

// ---------- design references (inputs for the UI/UX agent) ----------
export const REF_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8' };
export const isImageRef = (name) => /\.(png|jpe?g|gif|webp)$/i.test(name);

// Uploaded file name -> safe stored name (no folders, plain characters, allowed type), or null.
export function refFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[^\w.-]/g, '_').replace(/^[._-]+/, '').slice(-80);
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return REF_TYPES[ext] && base.length > ext.length + 1 ? base : null;
}

// Figma link -> { key, nodeId, url } (nodeId "12:34" when the link points at a frame), or null if not a Figma file link.
export function parseFigmaUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)figma\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:design|file|proto|board)\/([A-Za-z0-9]{10,64})(?:\/|$)/);
  if (!m) return null;
  const node = u.searchParams.get('node-id');
  return { key: m[1], nodeId: node && /^\d+[-:]\d+$/.test(node) ? node.replace('-', ':') : null, url: u.toString() };
}

// --- Backend ticket team ---
export const BE_PREFIXES = { 'RECK-': 'reviewcook-api', 'GIF-': 'giftlips-api' };
export const repoForKey = (key) => BE_PREFIXES[Object.keys(BE_PREFIXES).find((p) => String(key).startsWith(p))] ?? null;

// Git remote + branch -> GitHub web link, or null if the remote is not GitHub.
export function githubTreeUrl(remote, branch) {
  const m = String(remote).trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/tree/${String(branch).split('/').map(encodeURIComponent).join('/')}` : null;
}

// Markdown -> { "heading lowercased": "trimmed body" } for each "## heading".
export function summarySections(md) {
  const out = {};
  for (const part of String(md).split(/^##[ \t]+/m).slice(1)) {
    const nl = part.indexOf('\n');
    out[(nl < 0 ? part : part.slice(0, nl)).trim().toLowerCase()] = nl < 0 ? '' : part.slice(nl + 1).trim();
  }
  return out;
}

export function parseBaseline(text) {
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== 'object') throw new Error('shape');
    return {
      ran: o.ran === true,
      command: typeof o.command === 'string' ? o.command : '',
      failing: Array.isArray(o.failing) ? o.failing.filter((f) => typeof f === 'string') : [],
      error: typeof o.error === 'string' ? o.error : null,
    };
  } catch {
    return { ran: false, command: '', failing: [], error: 'baseline.json missing or invalid' };
  }
}

// Failing test names from a Jest --json result: "<file> > <describe> > <test>", or the file alone when the suite failed to run.
export function jestFailures(json, rootDir) {
  const out = [];
  for (const r of json?.testResults ?? []) {
    const file = path.relative(rootDir, r.name ?? '');
    const failed = (r.assertionResults ?? []).filter((a) => a.status === 'failed');
    for (const a of failed) out.push([file, ...(a.ancestorTitles ?? []), a.title].join(' > '));
    if (r.status === 'failed' && !failed.length) out.push(file);
  }
  return [...new Set(out)].sort();
}

export const commitType = (ticketText) => (/^\s*(#+\s*)?(type\s*:?\s*)?bug\b/im.test(ticketText) ? 'fix' : 'feat');

export const ticketTitle = (ticketText) => {
  const line = String(ticketText).split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/^\s*#+\s*/, '').replace(/^[A-Z][A-Z0-9]*-\d+\s*:?\s*/, '').trim().slice(0, 72);
};

// Plain-text Jira comment; layout is fixed by the design spec ("Jira comment format").
export function jiraComment({ key, outcome, sections, cycles, baselineFailing, branch, branchUrl }) {
  const body = (name) => sections[name] || '- None';
  const block = (title, text) => `${title}:\n${text}`;
  const open = block('Open questions / assumptions', body('open questions / assumptions'));
  if (outcome === 'no_code') {
    return [`AI Team — ${key}: no code change needed`, block('Findings', body('findings')), block('Steps', body('steps')), open].join('\n\n');
  }
  const tests = [sections.tests, '- App test run (npm test): passed, no new failures', `- QA (Codex): PASS. Fix cycles: ${cycles}`].filter(Boolean).join('\n');
  const failing = baselineFailing.length ? baselineFailing.map((f) => `- ${f}`).join('\n') : '- None';
  return [
    `AI Team — ${key} done (QA passed)`,
    block('Backend changes', body('backend changes')),
    block('Files changed', body('files changed')),
    block('Tests', tests),
    block('FE dev notes', body('fe dev notes')),
    open,
    block('Already failing on main (not caused by this change)', failing),
    `Branch: ${outcome === 'pushed' ? branchUrl : `${branch} (not pushed yet)`}\nMerge: manual`,
  ].join('\n\n');
}

// Which scheduler pool a project's jobs count against: BE tickets have their own capacity.
export const poolOf = (p) => (p.kind === 'be-ticket' ? 'be' : 'main');

// Version folder names -> the newest one ("10.1.0" beats "9.9.9"), or null when there are none.
export const newestVersion = (names) => [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() ?? null;
