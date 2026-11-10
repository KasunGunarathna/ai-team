import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Load sounds.js in a fake browser whose AudioContext records the first note of each sound played.
function load() {
  const played = [];
  let clock = 0;
  class FakeCtx {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createOscillator() { const o = { frequency: {}, connect: (g) => g, start: (t) => { if (t === 0) played.push(`${o.type}:${o.frequency.value}`); }, stop() {} }; return o; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (d) => d }; }
  }
  const store = { 'aiteam-sound': 'on' };
  const win = {};
  vm.runInNewContext(fs.readFileSync(new URL('./sounds.js', import.meta.url), 'utf8'), {
    window: win, AudioContext: FakeCtx, addEventListener() {}, setTimeout: (fn) => fn(),
    localStorage: { getItem: (k) => store[k], setItem: (k, v) => { store[k] = v; } },
    Date: { now: () => clock },
  });
  return { sounds: win.AiSounds, played, advance: (ms) => { clock += ms; } };
}

const state = ({ jobs = [], tasks = [], decisions = [] } = {}) => ({ jobs, projects: [{ id: 'p', tasks, decisions }] });
const START = 'triangle:523', DONE = 'sine:523', BLOCKED = 'sawtooth:247', APPROVAL = 'sine:880', REMINDER = 'sine:988';

test('sounds: nothing on first load, then one sound per new event', () => {
  const { sounds, played } = load();
  sounds.watch(state({ tasks: [{ id: 'T1', status: 'DONE' }], decisions: [{ id: 'd0', answer: 'x' }] }));
  assert.deepEqual(played, []);
  sounds.watch(state({ jobs: [{ projectId: 'p', agentLabel: 'T2-dev-0' }], tasks: [{ id: 'T1', status: 'DONE' }] }));
  assert.deepEqual(played, [START]);
  sounds.watch(state({ tasks: [{ id: 'T1', status: 'DONE' }, { id: 'T2', status: 'DONE' }, { id: 'T3', status: 'BLOCKED' }], decisions: [{ id: 'd1' }] }));
  assert.deepEqual(played, [START, APPROVAL, BLOCKED, DONE]);
});

test('sounds: approval reminder every 2 minutes while a decision waits, then stops', () => {
  const { sounds, played, advance } = load();
  sounds.watch(state());
  sounds.watch(state({ decisions: [{ id: 'd1' }] }));
  assert.deepEqual(played, [APPROVAL]);
  advance(119_000); sounds.watch(state({ decisions: [{ id: 'd1' }] }));
  assert.deepEqual(played, [APPROVAL]);
  advance(2_000); sounds.watch(state({ decisions: [{ id: 'd1' }] }));
  assert.deepEqual(played, [APPROVAL, REMINDER]);
  advance(120_000); sounds.watch(state({ decisions: [{ id: 'd1', answer: 'approve' }] }));
  assert.deepEqual(played, [APPROVAL, REMINDER]);
});

test('sounds: silent when turned off', () => {
  const { sounds, played } = load();
  sounds.setOn(false);
  sounds.watch(state());
  sounds.watch(state({ decisions: [{ id: 'd1' }] }));
  assert.deepEqual(played, []);
});
