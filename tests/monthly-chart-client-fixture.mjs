import assert from 'node:assert/strict';
import {loadSource} from './source-module.mjs';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

// Deterministic hook lifecycle and timers; no copied request/adaptation logic.
// Real browser/React scheduling is the coordinator's separate acceptance gate.
export function chartHarness(fetch) {
  const state = [], refs = [], callbacks = [], effects = [], pendingEffects = new Set();
  const timers = new Map();
  let si = 0, ri = 0, ci = 0, ei = 0, currentSite = '', current, dirty = false, disposed = false;
  let clock = 0, nextTimer = 0, updatesAfterDispose = 0;
  const same = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]));
  const setTimeout = (fn, ms) => {const id = ++nextTimer; timers.set(id, {fn, at: clock + ms}); return id;};
  const clearTimeout = id => timers.delete(id);
  const module = loadSource('app/monthly-chart-client.ts', [], {
    fetch, AbortController, Error, TypeError, DOMException, setTimeout, clearTimeout,
    useState(initial) {
      const i = si++;
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
      return [state[i], next => {
        if (disposed) updatesAfterDispose++;
        state[i] = typeof next === 'function' ? next(state[i]) : next;
        dirty = true;
      }];
    },
    useRef(value) {return refs[ri++] ?? (refs[ri - 1] = {current: value});},
    useCallback(fn, deps) {
      const i = ci++;
      if (!callbacks[i] || !same(callbacks[i].deps, deps)) callbacks[i] = {fn, deps};
      return callbacks[i].fn;
    },
    useEffect(fn, deps) {
      const i = ei++;
      if (!effects[i] || !same(effects[i].deps, deps)) {
        effects[i] = {fn, deps, cleanup: effects[i]?.cleanup};
        pendingEffects.add(i);
      }
    },
  });
  function render(siteId = currentSite) {
    currentSite = siteId;
    si = ri = ci = ei = 0;
    dirty = false;
    current = module.useMonthlyChartData(siteId);
    return current;
  }
  async function flush() {
    // Enough microtask turns for fetch -> text -> parse -> race -> state/finally.
    for (let turn = 0; turn < 24; turn++) {
      for (const i of [...pendingEffects]) {
        pendingEffects.delete(i);
        effects[i].cleanup?.();
        effects[i].cleanup = effects[i].fn();
      }
      await Promise.resolve();
      if (dirty && !disposed) render();
    }
    return current;
  }
  return {
    render, flush,
    get current() {return current;},
    get timerCount() {return timers.size;},
    get updatesAfterDispose() {return updatesAfterDispose;},
    async tick(ms) {
      const target = clock + ms;
      let turns = 0;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        assert.ok(++turns < 100, 'timer loop did not settle');
        timers.delete(due[0]); clock = due[1].at; due[1].fn(); await flush();
      }
      clock = target;
      return flush();
    },
    dispose() {
      for (const effect of effects) effect.cleanup?.();
      pendingEffects.clear(); disposed = true;
    },
  };
}
