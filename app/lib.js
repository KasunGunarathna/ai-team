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
      return e.subtype === 'init' ? `▶ Claude Code · model ${e.model}` : null;
    case 'assistant':
      return (e.message?.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? `→ ${c.name}: ${clip(brief(c.input), 300)}` : null))
        .filter(Boolean).join('\n') || null;
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

// A denied tool call -> a narrow allow rule for similar calls, or null when no safe rule exists.
// Built from the real leading words only; shell operators, flags or odd characters mean "no suggestion".
const SUBCOMMAND_TOOLS = ['git', 'npm', 'npx', 'pnpm', 'yarn', 'docker'];
export function permissionRule(d) {
  if (d.tool_name !== 'Bash') return /^[A-Za-z][\w-]*$/.test(d.tool_name ?? '') ? d.tool_name : null;
  const cmd = String(d.tool_input?.command ?? '').trim();
  if (!cmd || /[;&|`$<>(){}\\\n]/.test(cmd)) return null;
  const [first, second] = cmd.split(/\s+/);
  if (!/^[a-z][\w.-]*$/i.test(first)) return null;
  if (!SUBCOMMAND_TOOLS.includes(first)) return `Bash(${first}:*)`;
  return second && /^[a-z][\w:.-]*$/i.test(second) ? `Bash(${first} ${second}:*)` : null;
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
