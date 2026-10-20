/**
 * Runs the actual main.ts bundle and its actual DOM event handlers in happy-dom.
 * Scene, media capture, haptic hardware and WebSocket transport are boundary doubles.
 * This is a UI lifecycle integration test, NOT browser E2E, WebGL, WebRTC or hardware QA.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { resolve } from 'node:path';
import type { ClientMessage, PoseFrame, RoomState, ServerMessage, TouchEvent } from '../shared/protocol.ts';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const ROOM = 'a'.repeat(32);

const bundle = await build({
  entryPoints: [resolve('web/src/main.ts')], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
  plugins: [{
    name: 'explicit-lifecycle-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/(scene|media|haptics)\.ts$/ }, args => ({ path: args.path, namespace: 'boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => {
        const name = args.path.includes('scene') ? 'RoveScene' : args.path.includes('media') ? 'MediaLink' : 'HapticOutput';
        return { contents: `export const ${name} = globalThis.__roveBoundary.${name};`, loader: 'js' };
      });
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'style-omitted' }));
      builder.onLoad({ filter: /.*/, namespace: 'style-omitted' }, () => ({ contents: '', loader: 'js' }));
    }
  }]
});
const mainCode = bundle.outputFiles[0].text;

function pose(seq = 1): PoseFrame {
  return { head: { position: [0, 1.55, 0], orientation: [0, 0, 0, 1] }, left: { position: [-0.2, 1.2, 0], orientation: [0, 0, 0, 1] }, right: { position: [0.1, 1.2, 0], orientation: [0, 0, 0, 1] }, source: 'desktop', tracked: true, seq };
}

async function harness() {
  const window = new Window({ url: 'http://localhost:5173/' });
  window.document.body.innerHTML = '<div id="app"></div>';
  let elapsed = 0, timerId = 0;
  const epoch = Date.now();
  const timers = new Map<number, { callback: () => void; due: number; repeat: number }>();
  const playing = new WeakSet<object>();
  const mediaCalls: string[] = [];
  const socketInstances: SocketDouble[] = [];
  const sceneInstances: SceneDouble[] = [];
  const mediaInstances: MediaDouble[] = [];
  const outputInstances: OutputDouble[] = [];

  class ClockDate extends Date {
    constructor(value?: string | number | Date) { super(value === undefined ? epoch + elapsed : value); }
    static now() { return epoch + elapsed; }
  }
  class SocketDouble {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
    readyState = SocketDouble.CONNECTING; bufferedAmount = 0;
    onopen: (() => void) | null = null; onclose: (() => void) | null = null;
    onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
    sent: ClientMessage[] = [];
    constructor(readonly url: string) { socketInstances.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw) as ClientMessage); }
    open() { this.readyState = SocketDouble.OPEN; this.onopen?.(); }
    receive(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close() { if (this.readyState === SocketDouble.CLOSED) return; this.readyState = SocketDouble.CLOSED; this.onclose?.(); }
  }
  class SceneDouble {
    onPose?: (value: PoseFrame) => void; onTracking?: (tracked: boolean, source: 'desktop' | 'webxr') => void;
    onXREnd?: () => void; onHandChange?: (extended: boolean) => void;
    inputEnabled = false; connected = false; remotePose: PoseFrame | null = null; remoteVisible = false;
    local = pose(); pulses = 0; clears = 0;
    constructor() { sceneInstances.push(this); }
    setVideo() {} setPreset() {} setRole() {} extendHand() {} move() {} recenter() {} approach() {}
    setConnected(value: boolean) { this.connected = value; }
    setRemoteVisible(value: boolean) { this.remoteVisible = value; }
    setRemotePose(value: PoseFrame | null) { this.remotePose = value; }
    setInputEnabled(value: boolean) { this.inputEnabled = value; this.local.tracked = value; }
    getLocalPose() { return this.local; }
    pulseLocal() { this.pulses++; } pulseRemote() {} clearPulses() { this.clears++; }
    async startXR() {} async endXR() {} dispose() {}
  }
  class MediaDouble {
    configurations: { selfId: string; peerId: string | null; role: string }[] = [];
    enables: string[] = []; pending: (() => void)[] = []; holdPermissions = false; disposals = 0; disabled = 0;
    constructor() { mediaInstances.push(this); }
    configure(selfId: string, peerId: string | null, role: string) { this.configurations.push({ selfId, peerId, role }); }
    async enable(mode: string) { this.enables.push(mode); if (this.holdPermissions) await new Promise<void>(resolve => this.pending.push(resolve)); }
    disable() { this.disabled++; } dispose() { this.disposals++; }
    async receiveSignal() {} async getStats() { return { connection: 'double', outboundAudioBytes: 0, inboundAudioBytes: 0 }; }
    get peerId() { return this.configurations.at(-1)?.peerId; }
  }
  class OutputDouble {
    plays: TouchEvent[] = []; stopped = 0; enabled = false;
    constructor(private onPulse: () => void) { outputInstances.push(this); }
    setGamepadEnabled(value: boolean) { this.enabled = value; }
    async play(event: TouchEvent) { this.plays.push(event); this.onPulse(); return { mode: 'visual' as const, ok: true }; }
    stop() { this.stopped++; } dispose() {}
  }
  Object.defineProperties(window, {
    __roveBoundary: { value: { RoveScene: SceneDouble, MediaLink: MediaDouble, HapticOutput: OutputDouble } },
    WebSocket: { value: SocketDouble, configurable: true },
    Date: { value: ClockDate, configurable: true },
    fetch: { value: async () => ({ ok: true, json: async () => ({ iceServers: [] }) }), configurable: true },
    setInterval: { value: (callback: () => void, ms: number) => { const id = ++timerId; timers.set(id, { callback, due: elapsed + ms, repeat: ms }); return id; }, configurable: true },
    setTimeout: { value: (callback: () => void, ms: number) => { const id = ++timerId; timers.set(id, { callback, due: elapsed + ms, repeat: 0 }); return id; }, configurable: true },
    clearInterval: { value: (id: number) => timers.delete(id), configurable: true },
    clearTimeout: { value: (id: number) => timers.delete(id), configurable: true }
  });
  Object.defineProperty(window.performance, 'now', { value: () => elapsed, configurable: true });
  Object.defineProperties(window.HTMLMediaElement.prototype, {
    play: { value: function(this: object) { playing.add(this); mediaCalls.push('play'); return Promise.resolve(); }, configurable: true },
    pause: { value: function(this: object) { playing.delete(this); mediaCalls.push('pause'); }, configurable: true },
    paused: { get: function(this: object) { return !playing.has(this); }, configurable: true },
    readyState: { get: () => 4, configurable: true },
    duration: { get: () => 24, configurable: true }
  });
  await window.eval(`(async () => {\n${mainCode}\n})()`);
  const socket = socketInstances[0]; assert.ok(socket, 'actual main.ts created the transport');
  socket.open(); socket.receive({ type: 'welcome', peerId: SELF, protocol: 1 });
  const scene = sceneInstances[0], media = mediaInstances[0], output = outputInstances[0];
  const element = (id: string) => window.document.getElementById(id)! as unknown as HTMLElement;
  const button = (id: string) => element(id) as unknown as HTMLButtonElement;
  const input = (id: string) => element(id) as unknown as HTMLInputElement;
  const dispatch = (id: string, event: string) => element(id).dispatchEvent(new window.Event(event) as unknown as Event);
  const click = (id: string) => element(id).click();
  const now = () => epoch + elapsed;
  function state(options: { stopped?: boolean; consent?: boolean; peerId?: string | null; revision?: number; playing?: boolean; roomId?: string } = {}): RoomState {
    const peerId = options.peerId === undefined ? OTHER : options.peerId;
    const consent = options.consent ?? false;
    return { id: options.roomId ?? ROOM, preset: 'rose', members: [
      { id: SELF, name: '测试主场', role: 'host', consent },
      ...(peerId ? [{ id: peerId, name: '测试来访', role: 'guest' as const, consent }] : [])
    ], playback: { playing: options.playing ?? false, position: 0, updatedAt: now(), revision: options.revision ?? 0 }, touchEnabled: !!peerId && consent && !options.stopped, stopped: options.stopped ?? false };
  }
  function joined(next: RoomState = state()) { socket.receive({ type: 'joined', selfId: SELF, state: next, serverTime: now() }); }
  function receiveState(next: RoomState) { socket.receive({ type: 'state', state: next, serverTime: now() }); }
  function remotePose(peerId = OTHER, seq = 1) { socket.receive({ type: 'pose', peerId, pose: pose(seq), serverTime: now() }); }
  function allowTouch() {
    input('consent').checked = true; dispatch('consent', 'change');
    receiveState(state({ consent: true })); remotePose();
  }
  function acceptRequest(id: string) {
    socket.receive({ type: 'touch-request', request: { id, from: OTHER, to: SELF, hand: 'right', expiresAt: now() + 5000 } });
    assert.equal(element('touchRequest').hidden, false, 'real DOM displayed a recipient request');
    click('acceptTouch');
    assert.ok(socket.sent.some(m => m.type === 'touch-response' && m.requestId === id && m.accepted), 'real click sent the acceptance');
  }
  function deliverTouch(id: string) { socket.receive({ type: 'touch', event: { id, from: OTHER, to: SELF, hand: 'right', durationMs: 100, intensity: 0.2, serverTime: now() } }); }
  function advance(ms: number) {
    const target = elapsed + ms;
    while (true) {
      const due = [...timers.entries()].filter(([, item]) => item.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      const [id, item] = due; elapsed = item.due;
      if (item.repeat) item.due += item.repeat; else timers.delete(id);
      item.callback();
    }
    elapsed = target;
  }
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { window, socket, scene, media, output, element, button, input, dispatch, click, now, state, joined, receiveState, remotePose, allowTouch, acceptRequest, deliverTouch, advance, flush, mediaCalls,
    async close() { timers.clear(); await window.happyDOM.close(); } };
}

test('actual UI accepts an authorized visual response, then local stop blocks a late response before server acknowledgement', async t => {
  const h = await harness(); t.after(() => h.close()); h.joined(); h.allowTouch();
  const baseline = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  h.acceptRequest(baseline); h.deliverTouch(baseline); await h.flush(); assert.equal(h.output.plays.length, 1);
  const inFlight = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; h.acceptRequest(inFlight);
  h.receiveState(h.state({ consent: true, playing: true })); await h.flush();
  h.click('stop'); assert.equal(h.media.peerId, null); assert.equal(h.scene.inputEnabled, false);
  h.deliverTouch(inFlight);
  h.receiveState(h.state({ consent: true, playing: true })); // Earlier state already in transit.
  h.advance(250); await h.flush();
  assert.equal(h.output.plays.length, 1, 'no second output while stop acknowledgement is pending');
  assert.equal((h.element('clip') as unknown as HTMLVideoElement).paused, true);
  assert.equal(h.button('play').disabled, true); assert.equal(h.media.peerId, null);
});

test('actual UI permission revocation blocks an accepted response already in transit', async t => {
  const h = await harness(); t.after(() => h.close()); h.joined(); h.allowTouch();
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; h.acceptRequest(id);
  h.input('consent').checked = false; h.dispatch('consent', 'change');
  h.receiveState(h.state({ consent: true })); // Old server authorization must not override the local choice.
  h.deliverTouch(id); await h.flush();
  assert.equal(h.output.plays.length, 0); assert.equal(h.input('consent').checked, false);
  assert.ok(h.socket.sent.some(m => m.type === 'consent' && !m.enabled));
});

test('repeated paused states keep media detached; an explicit resumed state rebuilds it without old permission', async t => {
  const h = await harness(); t.after(() => h.close()); h.joined();
  const paused = h.state({ stopped: true, revision: 1 }); h.receiveState(paused); h.receiveState(paused);
  assert.equal(h.media.peerId, null); assert.equal(h.button('mic').disabled, true);
  h.click('resume'); assert.ok(h.socket.sent.some(m => m.type === 'resume'));
  assert.equal(h.media.peerId, null, 'resume click alone must not reattach media');
  h.receiveState(h.state({ revision: 1 }));
  assert.equal(h.media.peerId, OTHER); assert.equal(h.button('mic').disabled, false);
  assert.equal(h.input('consent').checked, false); assert.equal(h.media.disposals, 0);
});

test('peer departure clears remote state and a new session accepts media while an old permission request is unresolved', async t => {
  const h = await harness(); t.after(() => h.close()); h.joined(); h.remotePose();
  h.media.holdPermissions = true; h.click('mic'); assert.equal(h.button('mic').disabled, true);
  h.receiveState(h.state({ peerId: null }));
  assert.equal(h.scene.remotePose, null); assert.equal(h.media.peerId, null);
  h.socket.receive({ type: 'ended', reason: '主场已结束会话' });
  assert.equal(h.element('lobby').hidden, false); assert.equal(h.media.disposals, 0);
  h.joined(h.state({ peerId: THIRD, roomId: 'b'.repeat(32) }));
  assert.equal(h.button('camera').disabled, false); h.click('camera');
  assert.deepEqual(h.media.enables, ['audio', 'video']); assert.equal(h.button('mic').disabled, true);
  h.media.pending[0](); await h.flush();
  assert.equal(h.button('mic').disabled, true, 'old completion must not unlock the newer request');
  h.media.pending[1](); await h.flush(); assert.equal(h.button('mic').disabled, false);
});

test('preview replies for edited or declined invitations cannot reopen an obsolete choice', async t => {
  const h = await harness(); t.after(() => h.close());
  const a = 'c'.repeat(32), b = 'd'.repeat(32);
  h.input('roomCode').value = a; h.dispatch('roomCode', 'input'); h.click('inspect');
  h.input('roomCode').value = b; h.dispatch('roomCode', 'input');
  h.socket.receive({ type: 'preview', roomId: a, preset: 'rose', available: true });
  assert.equal(h.element('joinPreview').hidden, true);
  h.click('inspect'); h.click('inspect'); // Two legitimate requests may be in flight.
  h.socket.receive({ type: 'preview', roomId: b, preset: 'sage', available: true });
  assert.equal(h.element('joinPreview').hidden, false);
  h.click('decline'); h.socket.receive({ type: 'preview', roomId: b, preset: 'sage', available: true });
  assert.equal(h.element('joinPreview').hidden, true); assert.equal(h.button('join').disabled, true);
});

test('missing server pongs close the session and devices even while transport claims OPEN', async t => {
  const h = await harness(); t.after(() => h.close()); h.joined();
  h.advance(12_000); await h.flush();
  assert.equal(h.socket.readyState, 3); assert.equal(h.media.peerId, null);
  assert.equal(h.scene.inputEnabled, false); assert.equal(h.element('lobby').hidden, false);
  assert.equal(h.button('reconnect').hidden, false);
});
