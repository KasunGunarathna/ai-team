// Event sounds for the AI Team pages, synthesized with Web Audio (no sound files).
// Off until the user turns them on: browsers only allow audio after a click on the page.
(() => {
  const REMIND_MS = 2 * 60_000; // repeat the approval reminder every 2 minutes while decisions wait
  const GAP_MS = 700; // space between sounds that happen in the same refresh
  let ctx = null, on = false, prev = null, lastAlert = 0;
  try { on = localStorage.getItem('aiteam-sound') === 'on'; } catch { /* storage blocked: default off */ }

  const audio = () => { ctx ??= new AudioContext(); if (ctx.state === 'suspended') ctx.resume(); return ctx; };
  addEventListener('pointerdown', () => { if (on) audio(); }); // unlock audio on the first click after a reload

  function tone(freq, at, dur, type = 'sine', peak = 0.18) {
    const c = audio(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime + at;
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }

  const SOUNDS = {
    start: () => { tone(523, 0, 0.12, 'triangle'); tone(784, 0.1, 0.2, 'triangle'); }, // quick rising "pop": an agent starts
    done: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.3)), // happy arpeggio: task DONE
    blocked: () => { tone(247, 0, 0.25, 'sawtooth', 0.07); tone(196, 0.24, 0.4, 'sawtooth', 0.07); }, // low "uh-oh": task blocked
    approval: () => { tone(880, 0, 0.4, 'sine', 0.22); tone(659, 0.32, 0.6, 'sine', 0.22); }, // ding-dong: decision needed
    outage: () => [880, 660, 440, 260].forEach((f, i) => tone(f, i * 0.12, 0.22, 'square', 0.06)), // power-down: limit or login problem
    handoff: () => { tone(660, 0, 0.08, 'triangle'); tone(880, 0.1, 0.08, 'triangle'); }, // two taps: Captain Plan hands a ticket to a dev
    pushed: () => { tone(1320, 0, 0.3, 'sine', 0.16); }, // bright ding: a squad branch is pushed (the done arpeggio follows)
    reminder: () => [0, 0.22, 0.44].forEach((at) => tone(988, at, 0.14, 'sine', 0.12)), // soft triple beep: still waiting
  };

  function play(name) { if (on && SOUNDS[name]) SOUNDS[name](); }

  const keys = (S) => ({
    runs: new Set(S.jobs.filter((j) => j.agentLabel).map((j) => `${j.projectId}/${j.agentLabel}`)),
    done: new Set(S.projects.flatMap((p) => p.tasks.filter((t) => t.status === 'DONE').map((t) => `${p.id}/${t.id}`))),
    dispatched: new Set(S.projects.flatMap((p) => p.tasks.filter((t) => t.dispatchedAt && t.status !== 'TODO').map((t) => `${p.id}/${t.id}/${t.dispatchedAt}`))),
    pushed: new Set(S.projects.flatMap((p) => p.tasks.filter((t) => t.outcome === 'pushed').map((t) => `${p.id}/${t.id}`))),
    blocked: new Set(S.projects.flatMap((p) => p.tasks.filter((t) => t.status === 'BLOCKED').map((t) => `${p.id}/${t.id}`))),
    pending: new Set(S.projects.flatMap((p) => p.decisions.filter((d) => !d.answer).map((d) => d.id))),
    outages: new Set(['claude', 'codex'].flatMap((e) => [S.authFail?.[e] && `${e}:auth`, S.limits?.[e] > Date.now() && `${e}:limit`]).filter(Boolean)),
  });

  // Call with every fresh /api/state. Plays a sound for each kind of new event since the last call.
  function watch(S) {
    const cur = keys(S);
    if (prev) {
      const isNew = (k) => [...cur[k]].some((x) => !prev[k].has(x));
      const events = ['outages', 'pending', 'blocked', 'pushed', 'done', 'dispatched', 'runs'].filter(isNew)
        .map((k) => ({ outages: 'outage', pending: 'approval', blocked: 'blocked', pushed: 'pushed', done: 'done', dispatched: 'handoff', runs: 'start' })[k]);
      events.forEach((name, i) => setTimeout(() => play(name), i * GAP_MS));
      if (events.includes('approval')) lastAlert = Date.now();
    } else {
      lastAlert = Date.now(); // first load: no sound for things that were already there
    }
    if (!cur.pending.size) lastAlert = Date.now();
    else if (Date.now() - lastAlert >= REMIND_MS) { play('reminder'); lastAlert = Date.now(); }
    prev = cur;
  }

  function setOn(v) {
    on = v;
    try { localStorage.setItem('aiteam-sound', v ? 'on' : 'off'); } catch { /* not remembered */ }
    if (v) play('approval'); // confirms sound works
  }

  window.AiSounds = { watch, play, setOn, isOn: () => on };
})();
