import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createRoveServer } from '../server/index.ts';
import type { ClientMessage, PoseFrame, ServerMessage, TouchRequest } from '../shared/protocol.ts';

class Client {
  readonly ws: WebSocket;
  readonly history: ServerMessage[] = [];
  private queue: ServerMessage[] = [];
  private changed: (() => void) | undefined;
  id = '';
  constructor(url: string, origin?: string) {
    this.ws = new WebSocket(url, origin ? { origin } : undefined);
    this.ws.on('message', data => { const msg = JSON.parse(data.toString()) as ServerMessage; this.history.push(msg); this.queue.push(msg); this.changed?.(); });
  }
  send(msg: ClientMessage) { this.ws.send(JSON.stringify(msg)); }
  raw(value: unknown) { this.ws.send(JSON.stringify(value)); }
  async take<T extends ServerMessage['type']>(type: T, predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: T }>> {
    const until = Date.now() + 2500;
    while (true) {
      const index = this.queue.findIndex(m => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>));
      if (index >= 0) return this.queue.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
      if (Date.now() >= until) throw new Error(`Timed out waiting for ${type}; messages=${this.history.map(m => m.type).join(',')}`);
      await new Promise<void>(done => {
        const timer = setTimeout(() => { this.changed = undefined; done(); }, Math.max(1, until - Date.now()));
        this.changed = () => { clearTimeout(timer); this.changed = undefined; done(); };
      });
    }
  }
  async flush() { const sentAt = Date.now(); this.send({ type: 'ping', sentAt }); await this.take('pong', m => m.sentAt === sentAt); }
}

async function fixture() {
  let clock = 1_000_000;
  const app = await createRoveServer({ port: 0, production: true, allowMissingOrigin: true, now: () => clock, maintenanceMs: 10000 });
  const address = await app.start();
  const clients: Client[] = [];
  return {
    url: address.url, wsUrl: address.url.replace('http:', 'ws:') + '/ws',
    async client() { const c = new Client(address.url.replace('http:', 'ws:') + '/ws'); clients.push(c); c.id = (await c.take('welcome')).peerId; return c; },
    advance(ms: number) { clock += ms; },
    async close() { for (const c of clients) c.ws.terminate(); await app.close(); }
  };
}

function frame(x: number, seq = 1): PoseFrame {
  return { head: { position: [x, 1.6, 0], orientation: [0, 0, 0, 1] }, left: { position: [x - 0.2, 1.2, 0], orientation: [0, 0, 0, 1] }, right: { position: [x, 1.2, 0], orientation: [0, 0, 0, 1] }, source: 'desktop', tracked: true, seq };
}

async function pair(f: Awaited<ReturnType<typeof fixture>>) {
  const a = await f.client(), b = await f.client();
  a.send({ type: 'create', name: 'A', preset: 'rose' });
  const joinedA = await a.take('joined');
  await a.take('state', m => m.state.members.length === 1);
  b.send({ type: 'join', roomId: joinedA.state.id, name: 'B' });
  await b.take('joined');
  await b.take('state', m => m.state.members.length === 2);
  await a.take('state', m => m.state.members.length === 2);
  return { a, b, roomId: joinedA.state.id };
}

async function prepareContact(a: Client, b: Client): Promise<TouchRequest> {
  a.send({ type: 'pose', pose: frame(0) }); b.send({ type: 'pose', pose: frame(0.1) });
  await a.take('pose'); await b.take('pose');
  a.send({ type: 'consent', enabled: true }); b.send({ type: 'consent', enabled: true });
  await b.take('state', m => m.state.touchEnabled);
  return (await b.take('touch-request', m => m.request.to === b.id)).request;
}

test('two real sockets join one room; a third is refused and inspect does not disclose identities', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { a, b, roomId } = await pair(f);
  assert.match(roomId, /^[0-9a-f]{32}$/);
  const c = await f.client(); c.send({ type: 'inspect', roomId });
  const preview = await c.take('preview'); assert.equal(preview.available, false); assert.equal('members' in preview, false);
  c.send({ type: 'join', roomId, name: 'C' }); assert.equal((await c.take('error')).code, 'ROOM_FULL');
  a.send({ type: 'pose', pose: frame(-0.4, 5) });
  const remote = await b.take('pose'); assert.equal(remote.peerId, a.id); assert.equal(remote.pose.seq, 5);
  assert.equal(c.history.some(m => m.type === 'pose'), false);
});

test('room isolation and joined-only signaling prevent cross-room communication', async t => {
  const f = await fixture(); t.after(() => f.close());
  const { a, b } = await pair(f); const c = await f.client();
  c.send({ type: 'signal', signal: { description: { type: 'offer', sdp: 'v=0' } } });
  assert.equal((await c.take('error')).code, 'NOT_JOINED');
  c.send({ type: 'create', name: 'C', preset: 'sage' }); await c.take('joined');
  a.send({ type: 'signal', signal: { description: { type: 'offer', sdp: 'v=0\r\n' } } });
  assert.equal((await b.take('signal')).peerId, a.id);
  await c.flush(); assert.equal(c.history.some(m => m.type === 'signal'), false);
});

test('shared playback clock is authoritative, monotonic, bounded and shared by both participants', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
  a.send({ type: 'playback', action: 'play', position: 3 });
  const first = await a.take('playback'); assert.equal(first.playback.playing, true);
  assert.deepEqual((await b.take('playback')).playback, first.playback);
  f.advance(500);
  b.send({ type: 'playback', action: 'seek', position: 12 });
  const second = await a.take('playback'); assert.equal(second.playback.revision, first.playback.revision + 1); assert.equal(second.playback.position, 12);
  b.send({ type: 'playback', action: 'pause', position: 13 });
  assert.equal((await a.take('playback')).playback.playing, false);
  a.raw({ type: 'playback', action: 'seek', position: 25 }); assert.equal((await a.take('error')).code, 'INVALID_MESSAGE');
});

test('pose bounds, invalid quaternion, stale sequence and unknown keys are rejected before forwarding', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
  const invalid = frame(0); invalid.head.position[0] = 100;
  a.send({ type: 'pose', pose: invalid }); assert.equal((await a.take('error')).code, 'INVALID_MESSAGE');
  const badQ = frame(0); badQ.right.orientation = [0, 0, 0, 0];
  a.send({ type: 'pose', pose: badQ }); assert.equal((await a.take('error')).code, 'INVALID_MESSAGE');
  const farHand = frame(0); farHand.right.position = [2.5, 1, 0];
  a.send({ type: 'pose', pose: farHand }); assert.equal((await a.take('error')).code, 'INVALID_MESSAGE');
  a.send({ type: 'pose', pose: frame(0, 5) }); await b.take('pose');
  a.send({ type: 'pose', pose: frame(1, 4) }); assert.equal((await a.take('error')).code, 'STALE_SEQUENCE');
  a.raw({ type: 'consent', enabled: true, targetId: b.id }); assert.equal((await a.take('error')).code, 'INVALID_MESSAGE');
  await b.flush(); assert.equal(b.history.filter(m => m.type === 'pose').length, 1);
});

test('contact requires both opt-ins and a fresh one-shot recipient acceptance; output acknowledgement is attributable', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
  a.send({ type: 'pose', pose: frame(0) }); b.send({ type: 'pose', pose: frame(0.1) });
  a.send({ type: 'consent', enabled: true }); await a.flush(); await b.flush();
  assert.equal(b.history.some(m => m.type === 'touch-request' || m.type === 'touch'), false);
  b.send({ type: 'consent', enabled: true });
  const req = (await b.take('touch-request', m => m.request.to === b.id)).request;
  assert.equal(b.history.some(m => m.type === 'touch'), false);
  a.send({ type: 'touch-response', requestId: req.id, accepted: true }); assert.equal((await a.take('error')).code, 'TOUCH_UNAVAILABLE');
  b.send({ type: 'touch-response', requestId: req.id, accepted: true });
  const touch = (await b.take('touch')).event; assert.equal(touch.to, b.id); assert.equal(touch.durationMs, 100);
  a.send({ type: 'haptic-result', eventId: touch.id, mode: 'gamepad', ok: true }); assert.equal((await a.take('error')).code, 'EVENT_UNAVAILABLE');
  b.send({ type: 'haptic-result', eventId: touch.id, mode: 'visual', ok: true });
  const report = await a.take('haptic-result'); assert.equal(report.peerId, b.id); assert.equal(report.mode, 'visual');
  b.send({ type: 'touch-response', requestId: req.id, accepted: true }); assert.equal((await b.take('error')).code, 'TOUCH_UNAVAILABLE');
  a.send({ type: 'pose', pose: frame(0, 2) }); b.send({ type: 'pose', pose: frame(0.1, 2) });
  await b.flush(); assert.equal(b.history.filter(m => m.type === 'touch-request').length, 2);
});

test('declining a touch produces no actuator event and separating hands cancels pending requests', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
  const req = await prepareContact(a, b);
  b.send({ type: 'touch-response', requestId: req.id, accepted: false });
  await a.take('touch-cancelled', m => m.requestId === req.id);
  b.send({ type: 'pose', pose: frame(1, 2) }); await a.take('pose', m => m.pose.seq === 2);
  await a.take('touch-cancelled'); await b.flush();
  assert.equal(a.history.some(m => m.type === 'touch'), false); assert.equal(b.history.some(m => m.type === 'touch'), false);
});

test('stale tracking is rechecked on acceptance, and an expired request cannot execute', async t => {
  for (const lapse of [1001, 6000]) {
    const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
    const req = await prepareContact(a, b); f.advance(lapse);
    b.send({ type: 'touch-response', requestId: req.id, accepted: true });
    await b.take('touch-cancelled', m => m.requestId === req.id);
    assert.equal(b.history.some(m => m.type === 'touch'), false);
  }
});

test('tracking loss, emergency stop and resumed sessions never restore old touch permission', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
  const req = await prepareContact(a, b);
  const lost = frame(0, 2); lost.tracked = false; a.send({ type: 'pose', pose: lost });
  await b.take('touch-cancelled', m => m.requestId === req.id);
  a.send({ type: 'stop' });
  const stopped = await b.take('state', m => m.state.stopped);
  assert.equal(stopped.state.members.every(m => !m.consent), true); assert.equal(stopped.state.touchEnabled, false);
  const poseCount = b.history.filter(m => m.type === 'pose').length;
  const signalCount = a.history.filter(m => m.type === 'signal').length;
  a.send({ type: 'pose', pose: frame(0, 3) }); assert.equal((await a.take('error')).code, 'STOPPED');
  b.send({ type: 'signal', signal: { description: { type: 'offer', sdp: 'v=0\r\n' } } }); assert.equal((await b.take('error')).code, 'STOPPED');
  await a.flush(); await b.flush();
  assert.equal(b.history.filter(m => m.type === 'pose').length, poseCount);
  assert.equal(a.history.filter(m => m.type === 'signal').length, signalCount);
  b.send({ type: 'consent', enabled: true }); assert.equal((await b.take('error')).code, 'STOPPED');
  b.send({ type: 'resume' });
  const resumed = await b.take('state', m => !m.state.stopped && m.state.playback.revision === stopped.state.playback.revision && m.state.members.every(m => !m.consent));
  assert.equal(resumed.state.touchEnabled, false);
  b.send({ type: 'touch-response', requestId: req.id, accepted: true }); assert.equal((await b.take('error')).code, 'TOUCH_UNAVAILABLE');
});

test('consent revocation cancels pending events and leaving invalidates both participants’ authorization', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b, roomId } = await pair(f);
  const req = await prepareContact(a, b);
  a.send({ type: 'consent', enabled: false }); await b.take('touch-cancelled', m => m.requestId === req.id);
  b.send({ type: 'touch-response', requestId: req.id, accepted: true }); assert.equal((await b.take('error')).code, 'TOUCH_UNAVAILABLE');
  b.send({ type: 'leave' });
  const solo = await a.take('state', m => m.state.members.length === 1 && !m.state.members[0].consent);
  assert.equal(solo.state.touchEnabled, false);
  const c = await f.client(); c.send({ type: 'join', roomId, name: 'C' });
  assert.equal((await c.take('joined')).state.members.every(m => !m.consent), true);
  a.ws.close(); assert.equal((await c.take('ended')).reason, '主场已结束会话');
  b.send({ type: 'join', roomId, name: 'B' }); assert.equal((await b.take('error')).code, 'ROOM_NOT_FOUND');
});

test('cross-origin websocket upgrades are denied while same-origin clients are admitted', async t => {
  const app = await createRoveServer({ port: 0, production: true }); t.after(() => app.close());
  const { url } = await app.start();
  const status = await new Promise<number>((yes, no) => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws', { origin: 'https://unrelated.invalid' });
    ws.on('unexpected-response', (_, res) => { yes(res.statusCode!); res.destroy(); ws.terminate(); });
    ws.on('error', () => {});
    ws.on('open', () => no(new Error('Cross-origin upgrade unexpectedly allowed')));
  });
  assert.equal(status, 403);
  const good = new Client(url.replace('http:', 'ws:') + '/ws', url); assert.equal((await good.take('welcome')).protocol, 1); good.ws.terminate();
});

function getRaw(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((yes, no) => {
    const req = httpRequest(base, { path, headers }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => yes({ status: res.statusCode!, body, headers: res.headers })); });
    req.on('error', no); req.end();
  });
}

test('health is public; source, environment and path traversal are not exposed by production HTTP', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal((await getRaw(f.url, '/api/health')).status, 200);
  const config = JSON.parse((await getRaw(f.url, '/api/config')).body); assert.equal(config.maxParticipants, 2);
  for (const path of ['/research/../package.json', '/research/%2e%2e/package.json', '/research/%2e%2e%2fpackage.json', '/research/.env', '/server/index.ts', '/.git/config', '/research/papers/../../.env', '/research/%5c..%5c.env']) assert.equal((await getRaw(f.url, path)).status, 404, path);
  const research = await getRaw(f.url, '/research/rove-overview.html'); assert.equal(research.status, 200); assert.match(research.body, /Rove/);
});

test('production media serves bounded, open-ended and suffix byte ranges for video seeking', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rove-http-test-'));
  await mkdir(join(root, 'dist', 'media'), { recursive: true });
  // These bytes test HTTP Range semantics, not video decoding or codec support.
  await writeFile(join(root, 'dist', 'media', 'range-test.webm'), '0123456789');
  const app = await createRoveServer({ port: 0, production: true, root });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const { url } = await app.start();
  for (const [range, body, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=8-', '89', 'bytes 8-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=7-99', '789', 'bytes 7-9/10']
  ]) {
    const result = await getRaw(url, '/media/range-test.webm', { Range: range });
    assert.equal(result.status, 206); assert.equal(result.body, body); assert.equal(result.headers['content-range'], contentRange); assert.equal(result.headers['content-type'], 'video/webm');
  }
  for (const range of ['bytes=100-', 'bytes=7-3', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-']) assert.equal((await getRaw(url, '/media/range-test.webm', { Range: range })).status, 416);
});
