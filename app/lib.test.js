import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, nextTask, normaliseTasks, normaliseQuestions, secretFiles, formatClaudeEvent, formatCodexEvent, sumUsage, permissionRule } from './lib.js';

test('parseVerdict takes the last verdict and defaults to BLOCKED', () => {
  assert.equal(parseVerdict('blah\nVERDICT: PASS'), 'PASS');
  assert.equal(parseVerdict('**Verdict:** fail'), 'FAIL');
  assert.equal(parseVerdict('VERDICT: FAIL\n...fixed...\nVERDICT: PASS'), 'PASS');
  assert.equal(parseVerdict('tests look fine'), 'BLOCKED');
});

test('nextTask respects dependencies and order', () => {
  const t = (id, status, dependsOn = []) => ({ id, status, dependsOn });
  assert.equal(nextTask([t('A', 'READY', ['B']), t('B', 'READY')]).id, 'B');
  assert.equal(nextTask([t('A', 'DONE'), t('B', 'READY', ['A'])]).id, 'B');
  assert.equal(nextTask([t('A', 'BLOCKED'), t('B', 'READY', ['A'])]), undefined);
});

test('normaliseTasks validates and defaults', () => {
  const [x] = normaliseTasks([{ id: 'TASK-001/../x', title: 'Login', owner: 'devops' }]);
  assert.deepEqual(x, { id: 'TASK-001x', title: 'Login', phase: 1, owner: 'backend-dev', dependsOn: [], status: 'BACKLOG', cycles: 0, runs: [] });
  assert.throws(() => normaliseTasks([]));
  assert.throws(() => normaliseTasks([{ id: 'A' }]));
});

test('normaliseQuestions drops invalid entries', () => {
  assert.deepEqual(normaliseQuestions([{ question: ' Country? ', options: ['LK', 'US'] }, { question: 'x', options: [] }, null]), [{ question: 'Country?', options: ['LK', 'US'] }]);
  assert.deepEqual(normaliseQuestions('nope'), []);
});

test('secretFiles flags env and key files only', () => {
  assert.deepEqual(secretFiles(['.env', 'api/.env.local', '.env.example', 'src/env.ts', 'certs/a.pem']), ['.env', 'api/.env.local', 'certs/a.pem']);
});

test('formatClaudeEvent renders tools and captures usage + denials', () => {
  const acc = {};
  assert.equal(formatClaudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }, acc), '→ Bash: npm test');
  assert.equal(formatClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } }, acc), '   ✗ boom');
  assert.equal(formatClaudeEvent({ type: 'system', subtype: 'hook_started' }, acc), null);
  formatClaudeEvent({ type: 'result', subtype: 'success', num_turns: 3, duration_ms: 4000, result: 'ok', total_cost_usd: 0.5, permission_denials: [{ tool_name: 'Bash' }], usage: { input_tokens: 4, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } }, acc);
  assert.deepEqual(acc.usage, { input: 4, output: 10, cacheRead: 100, cacheWrite: 50, costUsd: 0.5 });
  assert.equal(acc.denials.length, 1);
});

test('formatCodexEvent renders commands and sums usage across turns', () => {
  const acc = {};
  assert.equal(formatCodexEvent({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }, acc), '→ $ npm test');
  assert.equal(formatCodexEvent({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: 'fail' } }, acc), '   ✗ exit 1: fail');
  formatCodexEvent({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 } }, acc);
  formatCodexEvent({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }, acc);
  assert.deepEqual(acc.usage, { input: 30, output: 6, cacheRead: 80, cacheWrite: 0, costUsd: 0 });
});

test('sumUsage ignores missing entries', () => {
  assert.deepEqual(sumUsage([null, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.1 }, undefined]), { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.1 });
});

test('permissionRule builds narrow allow rules', () => {
  assert.equal(permissionRule({ tool_name: 'Bash', tool_input: { command: 'docker compose up -d' } }), 'Bash(docker compose:*)');
  assert.equal(permissionRule({ tool_name: 'Bash', tool_input: { command: 'curl -s http://x' } }), 'Bash(curl:*)');
  assert.equal(permissionRule({ tool_name: 'Bash', tool_input: { command: '$(evil)' } }), 'Bash');
  assert.equal(permissionRule({ tool_name: 'WebFetch', tool_input: {} }), 'WebFetch');
});

test('limitUntil detects usage limits only on failed runs', async () => {
  const { limitUntil } = await import('./lib.js');
  const now = 1_000_000_000_000;
  assert.equal(limitUntil({ rate: { status: 'allowed', resetsAt: 2e9 }, text: 'added rate limiting' }, 0, now), null);
  assert.equal(limitUntil({ text: 'rate limit middleware done' }, 0, now), null);
  assert.equal(limitUntil({ rate: { status: 'rejected', resetsAt: now / 1000 + 600 } }, 1, now), now + 600_000 + 60_000);
  assert.equal(limitUntil({ isError: true, text: 'Claude AI usage limit reached|1000003600' }, 1, now), 1000003600 * 1000 + 60_000);
  assert.equal(limitUntil({ errorText: "You've hit your usage limit. Try again in 2 hours." }, 1, now), now + 2 * 3_600_000 + 60_000);
  assert.equal(limitUntil({ apiStatus: 429, isError: true, text: '' }, 1, now), now + 30 * 60_000);
  assert.equal(limitUntil({ isError: true, text: 'syntax error' }, 1, now), null);
});

test('isOpen handles always-open, day hours, overnight and weekdays', async () => {
  const { isOpen } = await import('./lib.js');
  const at = (day, h, m = 0) => new Date(2026, 10, 8 + day, h, m); // 2026-11-08 is a Sunday
  assert.equal(isOpen(null, at(0, 3)), true);
  const day = { start: '09:00', end: '18:00' };
  assert.equal(isOpen(day, at(1, 9)), true);
  assert.equal(isOpen(day, at(1, 18)), false);
  assert.equal(isOpen(day, at(1, 8, 59)), false);
  assert.equal(isOpen({ start: '22:00', end: '06:00' }, at(1, 23)), true);
  assert.equal(isOpen({ start: '22:00', end: '06:00' }, at(1, 12)), false);
  assert.equal(isOpen({ ...day, weekdaysOnly: true }, at(0, 10)), false);
  assert.equal(isOpen({ ...day, weekdaysOnly: true }, at(1, 10)), true);
});

test('readyTasks returns every startable task in order', async () => {
  const { readyTasks } = await import('./lib.js');
  const t = (id, status, dependsOn = []) => ({ id, status, dependsOn });
  assert.deepEqual(readyTasks([t('A', 'DONE'), t('B', 'READY', ['A']), t('C', 'READY'), t('D', 'READY', ['C']), t('E', 'IN_PROGRESS')]).map((x) => x.id), ['B', 'C']);
});
