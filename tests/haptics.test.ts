import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { HapticOutput } from '../web/src/haptics.ts';
import type { TouchEvent } from '../shared/protocol.ts';

// Mock Gamepad API tests validate adapter policy and async cancellation only.
// They are not evidence of a real controller or wristband producing a physical sensation.
function mockNavigator(t: TestContext, getGamepads: () => unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { getGamepads } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
}
function event(id: string, durationMs = 100, intensity = 0.2): TouchEvent {
  return { id, from: 'sender', to: 'receiver', hand: 'right', durationMs, intensity, serverTime: 1 };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('visual default does not enumerate devices; duplicate events do not replay', async t => {
  let enumerations = 0, pulses = 0;
  mockNavigator(t, () => { enumerations++; return []; });
  const output = new HapticOutput(() => pulses++);
  t.after(() => output.dispose());
  assert.deepEqual(await output.play(event('same')), { mode: 'visual', ok: true });
  assert.deepEqual(await output.play(event('same')), { mode: 'visual', ok: false });
  assert.equal(enumerations, 0);
  assert.equal(pulses, 1);
});

test('explicit device opt-in bounds every requested effect; invalid values never output', async t => {
  let pulses = 0;
  const effects: { type: string; params: GamepadEffectParameters }[] = [];
  mockNavigator(t, () => [{ connected: true, vibrationActuator: {
    playEffect: async (type: string, params: GamepadEffectParameters) => { effects.push({ type, params }); return 'complete'; },
    reset: async () => 'complete',
  } }]);
  const output = new HapticOutput(() => pulses++);
  t.after(() => output.dispose());
  output.setGamepadEnabled(true);
  assert.deepEqual(await output.play(event('bounded', 20_000, 8)), { mode: 'gamepad', ok: true });
  assert.equal(effects.length, 1);
  assert.equal(effects[0].type, 'dual-rumble');
  assert.equal(effects[0].params.duration, 100);
  assert.equal(effects[0].params.strongMagnitude, 0.2);
  assert.equal(effects[0].params.weakMagnitude, 0.2);
  assert.equal(effects[0].params.startDelay, 0);
  assert.equal((await output.play(event('nan', Number.NaN))).ok, false);
  assert.equal((await output.play(event('negative', 100, -1))).ok, false);
  assert.equal(effects.length, 1);
  assert.equal(pulses, 1);
});

test('missing devices and rejected output report visual fallback, never device success', async t => {
  let pulses = 0, mode: 'missing' | 'failure' = 'missing', resets = 0;
  mockNavigator(t, () => mode === 'missing' ? [] : [{ connected: true, vibrationActuator: {
    playEffect: async () => { throw new Error('controller removed'); },
    reset: async () => { resets++; return 'complete'; },
  } }]);
  const output = new HapticOutput(() => pulses++);
  t.after(() => output.dispose());
  output.setGamepadEnabled(true);
  assert.deepEqual(await output.play(event('missing')), { mode: 'visual', ok: true });
  mode = 'failure';
  assert.deepEqual(await output.play(event('failure')), { mode: 'visual', ok: true });
  assert.equal(pulses, 2);
  assert.equal(resets, 1);
});

test('stop resets the active device and suppresses a late completed promise', async t => {
  const effect = deferred<GamepadHapticsResult>();
  let pulses = 0, resets = 0;
  mockNavigator(t, () => [{ connected: true, vibrationActuator: {
    playEffect: () => effect.promise,
    reset: async () => { resets++; return 'complete'; },
  } }]);
  const output = new HapticOutput(() => pulses++);
  t.after(() => output.dispose());
  output.setGamepadEnabled(true);
  const pending = output.play(event('cancel'));
  await tick();
  output.stop();
  assert.deepEqual(await pending, { mode: 'gamepad', ok: false });
  assert.equal(resets, 1);
  effect.resolve('complete');
  await tick();
  assert.equal(pulses, 0);
});

test('revoking local device permission cancels an in-flight output and stays visual', async t => {
  const effect = deferred<GamepadHapticsResult>();
  let calls = 0, pulses = 0;
  mockNavigator(t, () => [{ connected: true, vibrationActuator: {
    playEffect: () => { calls++; return effect.promise; }, reset: async () => 'complete',
  } }]);
  const output = new HapticOutput(() => pulses++);
  t.after(() => output.dispose());
  output.setGamepadEnabled(true);
  const pending = output.play(event('revoke'));
  await tick();
  output.setGamepadEnabled(false);
  assert.equal((await pending).ok, false);
  effect.resolve('complete');
  assert.deepEqual(await output.play(event('after-revoke')), { mode: 'visual', ok: true });
  await tick();
  assert.equal(calls, 1);
  assert.equal(pulses, 1);
});

test('disposal cancels an outstanding effect and forbids future output', async t => {
  const effect = deferred<GamepadHapticsResult>();
  let pulses = 0;
  mockNavigator(t, () => [{ connected: true, vibrationActuator: { playEffect: () => effect.promise, reset: async () => 'complete' } }]);
  const output = new HapticOutput(() => pulses++);
  output.setGamepadEnabled(true);
  const pending = output.play(event('dispose'));
  await tick();
  output.dispose();
  assert.equal((await pending).ok, false);
  effect.resolve('complete');
  output.setGamepadEnabled(true);
  assert.equal((await output.play(event('after-dispose'))).ok, false);
  await tick();
  assert.equal(pulses, 0);
});
