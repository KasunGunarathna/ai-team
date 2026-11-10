import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, nextTask, normaliseTasks, normaliseQuestions, secretFiles, formatClaudeEvent, formatCodexEvent, sumUsage, permissionRule, repoForKey, githubTreeUrl, summarySections, parseBaseline, commitType, ticketTitle, jiraComment, poolOf, newestVersion, jestFailures, isTestHarness } from './lib.js';

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
  const [x] = normaliseTasks([{ id: 'TASK-001', title: 'Login', owner: 'devops' }]);
  assert.deepEqual(x, { id: 'TASK-001', title: 'Login', phase: 1, owner: 'backend-dev', dependsOn: [], status: 'BACKLOG', cycles: 0, runs: [] });
  assert.throws(() => normaliseTasks([]));
  assert.throws(() => normaliseTasks([{ id: 'A' }]));
  assert.throws(() => normaliseTasks([{ id: 'TASK-001/../x', title: 't' }]), /invalid task id/);
  assert.throws(() => normaliseTasks([{ id: '_integration', title: 't' }]), /invalid task id/);
  assert.throws(() => normaliseTasks([{ id: '!!', title: 't' }]), /invalid task id/);
  assert.throws(() => normaliseTasks([{ id: 'A', title: 't' }, { id: 'A', title: 'u' }]), /duplicate/);
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

test('formatClaudeEvent tracks context size, recent notes and the context window', () => {
  const acc = {};
  formatClaudeEvent({ type: 'system', subtype: 'init', model: 'm' }, acc);
  formatClaudeEvent({ type: 'assistant', message: { usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }, content: [{ type: 'text', text: ' Done step 1 ' }] } }, acc);
  assert.deepEqual([acc.model, acc.context, acc.notes], ['m', 1502, ['Done step 1']]);
  formatClaudeEvent({ type: 'result', subtype: 'success', modelUsage: { m: { contextWindow: 200000 } } }, acc);
  assert.equal(acc.window, 200000);
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

test('permissionRule offers only the exact command, never a wildcard, and refuses unsafe ones', () => {
  const rule = (command) => permissionRule({ tool_name: 'Bash', tool_input: { command } });
  assert.equal(rule('docker compose up -d'), 'Bash(docker compose up -d)'); // exact: other compose commands stay blocked
  assert.equal(rule('git  show   HEAD'), 'Bash(git show HEAD)');
  assert.equal(rule('git push origin main'), 'Bash(git push origin main)');
  for (const c of ['python -c print', 'bash -c id', 'env FOO=1 make', 'xargs rm', 'sudo ls', 'find . -delete', 'sed -i s/a/b/ f', 'npx some-pkg', 'node -e x', 'rm -rf build']) assert.equal(rule(c), null, c);
  for (const c of ["echo 'hi'", '$(evil)', 'ls && rm -rf ~', 'echo `id`', '/bin/sh -c id', 'ls *', 'cat a > b', 'x'.repeat(201)]) assert.equal(rule(c), null, c);
  assert.ok(!String(rule('git -c core.sshCommand=evil push')).includes('*'));
  assert.equal(permissionRule({ tool_name: 'WebFetch', tool_input: { url: 'https://docs.example.com/a?b=1' } }), 'WebFetch(domain:docs.example.com)');
  assert.equal(permissionRule({ tool_name: 'WebFetch', tool_input: {} }), null);
  assert.equal(permissionRule({ tool_name: 'Write', tool_input: { file_path: '.claude/x' } }), null);
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

test('authFailure spots login and subscription problems only on failed runs', async () => {
  const { authFailure } = await import('./lib.js');
  assert.equal(authFailure({ text: 'Added OAuth token expired handling' }, 0), null);
  assert.ok(authFailure({ isError: true, text: 'Invalid API key · Please run /login' }, 1));
  assert.ok(authFailure({ errorText: 'unexpected status 401 Unauthorized' }, 1));
  assert.ok(authFailure({ stderr: 'Error: Not logged in. Run codex login.' }, 1));
  assert.ok(authFailure({ isError: true, text: 'x', apiStatus: 403 }, 1));
  assert.equal(authFailure({ isError: true, text: 'TypeError: x is undefined' }, 1), null);
});

test('tokensSince sums the last week per engine', async () => {
  const { tokensSince } = await import('./lib.js');
  const u = (n) => ({ input: n, output: 1, cacheRead: 0, cacheWrite: 0 });
  const runs = [
    { engine: 'claude', startedAt: '2026-11-09T10:00:00Z', usage: u(100) },
    { engine: 'claude', startedAt: '2026-10-01T10:00:00Z', usage: u(999) },
    { engine: 'codex', startedAt: '2026-11-08T10:00:00Z', usage: u(10) },
    { engine: 'codex', startedAt: '2026-11-08T10:00:00Z' },
  ];
  assert.deepEqual(tokensSince(runs, Date.parse('2026-11-03T00:00:00Z')), { claude: { total: 101, out: 1, runs: 1 }, codex: { total: 11, out: 1, runs: 1 } });
});

test('codexRateLimits reads the latest 5-hour and weekly windows', async () => {
  const { codexRateLimits } = await import('./lib.js');
  const line = (p, s) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: p, window_minutes: 300, resets_at: 100 }, secondary: { used_percent: s, window_minutes: 10080, resets_at: 200 } } } });
  assert.deepEqual(codexRateLimits([line(1, 10), '{"bad', line(2, 20), '{"type":"other"}'].join('\n')), { fiveHour: { pct: 2, resetsAt: 100000 }, week: { pct: 20, resetsAt: 200000 } });
  assert.equal(codexRateLimits('nothing here'), null);
});

test('refFileName keeps safe image/html names only', async () => {
  const { refFileName, isImageRef } = await import('./lib.js');
  assert.equal(refFileName('Home screen (v2).PNG'), 'Home_screen__v2_.PNG');
  assert.equal(refFileName('../../etc/passwd.html'), 'passwd.html');
  assert.equal(refFileName('.hidden.png'), 'hidden.png');
  assert.equal(refFileName('script.js'), null);
  assert.equal(refFileName('logo.svg'), null);
  assert.equal(refFileName('.png'), null);
  assert.equal(isImageRef('a.webp'), true);
  assert.equal(isImageRef('a.html'), false);
});

test('parseFigmaUrl accepts figma file/frame links only', async () => {
  const { parseFigmaUrl } = await import('./lib.js');
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Salon?node-id=12-345&t=x'), { key: 'AbCdEf1234567890', nodeId: '12:345', url: 'https://www.figma.com/design/AbCdEf1234567890/Salon?node-id=12-345&t=x' });
  assert.equal(parseFigmaUrl('https://www.figma.com/file/AbCdEf1234567890/X').nodeId, null);
  assert.equal(parseFigmaUrl('http://www.figma.com/design/AbCdEf1234567890/X'), null);
  assert.equal(parseFigmaUrl('https://evil.com/design/AbCdEf1234567890/X'), null);
  assert.equal(parseFigmaUrl('https://figma.com.evil.com/design/AbCdEf1234567890/X'), null);
  assert.equal(parseFigmaUrl('not a url'), null);
});

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
  assert.equal(githubTreeUrl('https://github.com/O/R', 'a b/c#d'), 'https://github.com/O/R/tree/a%20b/c%23d');
});

test('summarySections splits on ## headings', () => {
  const s = summarySections('# Title\n## Backend changes\n- a\n\n## FE dev notes\nNone\n');
  assert.equal(s['backend changes'], '- a');
  assert.equal(s['fe dev notes'], 'None');
});

test('parseBaseline validates', () => {
  assert.deepEqual(parseBaseline('{"ran":true,"command":"npm test","failing":["x > y"]}'), { ran: true, command: 'npm test', failing: ['x > y'], error: null });
  assert.equal(parseBaseline('nope').ran, false);
  assert.equal(parseBaseline('null').error, 'baseline.json missing or invalid');
  assert.equal(parseBaseline('{"ran":false,"error":"ECONNREFUSED 5432"}').error, 'ECONNREFUSED 5432');
});

test('commitType and ticketTitle', () => {
  assert.equal(commitType('## Type\nBug\n'), 'fix');
  assert.equal(commitType('Type: Story'), 'feat');
  assert.equal(ticketTitle('\n# RECK-12: Fix login timeout\nmore'), 'Fix login timeout');
  assert.equal(ticketTitle('x'.repeat(100)).length, 72);
});

test('jiraComment pushed / push_failed / no_code', () => {
  const sections = { 'backend changes': '- added X', 'files changed': '- src/a.ts', tests: '- npm test', 'fe dev notes': 'None', 'open questions / assumptions': '- none' };
  const ok = jiraComment({ key: 'RECK-1', outcome: 'pushed', sections, cycles: 1, baselineFailing: [], branch: 'RECK-1', branchUrl: 'https://github.com/QRTiger/reviewcook-api/tree/RECK-1' });
  assert.match(ok, /^AI Team — RECK-1 done \(QA passed\)/);
  assert.match(ok, /Tests:\n- npm test\n- App test run \(npm test\): passed, no new failures\n- QA \(Codex\): PASS\. Fix cycles: 1\n\n/);
  assert.match(ok, /Already failing on main \(not caused by this change\):\n- None/);
  assert.match(ok, /Branch: https:\/\/github\.com\/QRTiger\/reviewcook-api\/tree\/RECK-1\nMerge: manual$/);
  const bad = jiraComment({ key: 'RECK-1', outcome: 'push_failed', sections, cycles: 0, baselineFailing: ['a > b'], branch: 'RECK-1', branchUrl: null });
  assert.match(bad, /Branch: RECK-1 \(not pushed yet\)/);
  assert.match(bad, /- a > b/);
  const nc = jiraComment({ key: 'GIF-2', outcome: 'no_code', sections: { findings: '- data issue', steps: '1. run X' }, cycles: 0, baselineFailing: [], branch: null, branchUrl: null });
  assert.match(nc, /^AI Team — GIF-2: no code change needed\n\nFindings:\n- data issue\n\nSteps:\n1\. run X/);
  assert.doesNotMatch(nc, /Branch:/);
});

test('poolOf separates BE tickets from the project team', () => {
  assert.equal(poolOf({ kind: 'be-ticket' }), 'be');
  assert.equal(poolOf({ kind: 'ticket' }), 'main');
  assert.equal(poolOf({ kind: 'idea' }), 'main');
});

test('newestVersion picks the highest version numerically', () => {
  assert.equal(newestVersion(['7.0.0', '10.1.0', '9.9.9']), '10.1.0');
  assert.equal(newestVersion(['5.2.0']), '5.2.0');
  assert.equal(newestVersion([]), null);
});

test('jestFailures lists failed tests and suites that failed to run, sorted', () => {
  const json = { testResults: [
    { name: '/wt/RECK-1/src/ok.test.ts', status: 'passed', assertionResults: [{ ancestorTitles: ['ok'], title: 'works', status: 'passed' }] },
    { name: '/wt/RECK-1/src/auth.test.ts', status: 'failed', assertionResults: [{ ancestorTitles: ['auth', 'login'], title: 'rejects bad pw', status: 'failed' }, { ancestorTitles: ['auth', 'login'], title: 'rejects bad pw', status: 'failed' }] },
    { name: '/wt/RECK-1/src/db.test.ts', status: 'failed', assertionResults: [] },
  ] };
  assert.deepEqual(jestFailures(json, '/wt/RECK-1'), ['src/auth.test.ts > auth > login > rejects bad pw', 'src/db.test.ts']);
  assert.deepEqual(jestFailures({}, '/wt'), []);
});

test('isTestHarness flags files that control how tests run', () => {
  for (const f of ['package.json', 'jest.config.ts', 'api/jest.setup.js', 'src/setupTests.ts', 'babel.config.js', '.babelrc', 'tsconfig.json', '__mocks__/db.js', 'tests/setup/test-db.js', 'test/globalSetup.ts', '.npmrc', 'api/.yarnrc.yml', 'vitest.config.ts', '.mocharc.json']) assert.ok(isTestHarness(f), f);
  for (const f of ['src/gift.ts', 'tests/gift.test.js', 'README.md']) assert.ok(!isTestHarness(f), f);
});
