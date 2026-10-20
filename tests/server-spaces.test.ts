import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createRoveServer, type RoveServerOptions } from '../server/index.ts';
import { validateGLB, type SpaceConfig } from '../shared/space.ts';
import type { ClientMessage, PoseFrame, ServerMessage } from '../shared/protocol.ts';

class Client {
  readonly ws: WebSocket;
  readonly history: ServerMessage[] = [];
  private queue: ServerMessage[] = [];
  private changed?: () => void;
  private ping = 0;
  id = '';
  token = '';
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', data => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.history.push(msg); this.queue.push(msg); this.changed?.();
    });
  }
  send(msg: ClientMessage) { this.ws.send(JSON.stringify(msg)); }
  raw(msg: unknown) { this.ws.send(JSON.stringify(msg)); }
  async take<T extends ServerMessage['type']>(type: T, predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: T }>> {
    const until = Date.now() + 2500;
    while (true) {
      const i = this.queue.findIndex(m => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>));
      if (i >= 0) return this.queue.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
      if (Date.now() >= until) throw new Error('Timed out waiting for ' + type + '; received: ' + this.history.map(m => m.type === 'error' ? m.code : m.type).join(','));
      await new Promise<void>(done => {
        const timer = setTimeout(() => { this.changed = undefined; done(); }, Math.max(1, until - Date.now()));
        this.changed = () => { clearTimeout(timer); this.changed = undefined; done(); };
      });
    }
  }
  async flush() { const sentAt = ++this.ping; this.send({ type: 'ping', sentAt }); await this.take('pong', m => m.sentAt === sentAt); }
}

async function fixture(options: RoveServerOptions = {}) {
  let clock = 1_000_000;
  const app = await createRoveServer({ port: 0, production: true, allowMissingOrigin: true, now: () => clock, maintenanceMs: 10_000, ...options });
  const { url } = await app.start();
  const clients: Client[] = [];
  return {
    url, advance(ms: number) { clock += ms; },
    async client() {
      const c = new Client(url.replace('http:', 'ws:') + '/ws'); clients.push(c);
      const hello = await c.take('welcome'); c.id = hello.peerId; c.token = hello.sessionToken; return c;
    },
    async close() { for (const c of clients) c.ws.terminate(); await app.close(); }
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function pair(f: Fixture) {
  const a = await f.client(), b = await f.client();
  a.send({ type: 'create', name: 'A', preset: 'rose' }); const { state } = await a.take('joined');
  await a.take('state');
  b.send({ type: 'join', roomId: state.id, name: 'B' }); await b.take('joined');
  await a.take('state', m => m.state.members.length === 2); await b.take('state');
  return { a, b, roomId: state.id };
}
const measured = (name = '我的客厅'): SpaceConfig => ({ source: 'measured', name, width: 12, depth: 8, height: 3.2, assetId: null, scale: 1, yaw: 0, offset: [0, 0, 0] });
function pose(x: number, seq: number, spaceRevision?: number): PoseFrame {
  return { head: { position: [x, 1.6, 0], orientation: [0, 0, 0, 1] }, left: { position: [x - 0.2, 1.2, 0], orientation: [0, 0, 0, 1] }, right: { position: [x, 1.2, 0], orientation: [0, 0, 0, 1] }, source: 'desktop', tracked: true, seq, ...(spaceRevision === undefined ? {} : { spaceRevision }) };
}
async function propose(from: Client, to: Client, space: SpaceConfig) {
  from.send({ type: 'space-propose', space });
  return (await to.take('state', m => m.state.spaceProposal?.fromId === from.id)).state.spaceProposal!;
}
async function switchSpace(from: Client, to: Client, space: SpaceConfig, revision: number) {
  const proposal = await propose(from, to, space);
  to.send({ type: 'space-response', proposalId: proposal.id, accepted: true });
  const next = (await from.take('state', m => m.state.space.revision === revision)).state;
  await to.take('state', m => m.state.space.revision === revision);
  return next;
}
async function ready(a: Client, b: Client, revision: number) {
  a.send({ type: 'space-ready', revision }); b.send({ type: 'space-ready', revision });
  await a.take('state', m => m.state.space.revision === revision && m.state.spaceReady.length === 2);
  await b.take('state', m => m.state.space.revision === revision && m.state.spaceReady.length === 2);
}

type GLTF = Record<string, any>;
function triangle(mutate?: (json: GLTF, bin: Buffer) => void): Buffer {
  const bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((n, i) => bin.writeFloatLE(n, i * 4));
  const json: GLTF = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] };
  mutate?.(json, bin);
  return packGLB(json, bin);
}
function packGLB(json: GLTF, bin: Buffer): Buffer {
  const encoded = Buffer.from(JSON.stringify(json)), jsonLength = Math.ceil(encoded.length / 4) * 4, binaryLength = Math.ceil(bin.length / 4) * 4;
  const output = Buffer.alloc(28 + jsonLength + binaryLength);
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonLength, 12); output.writeUInt32LE(0x4e4f534a, 16);
  output.fill(0x20, 20, 20 + jsonLength); encoded.copy(output, 20);
  output.writeUInt32LE(binaryLength, 20 + jsonLength); output.writeUInt32LE(0x004e4942, 24 + jsonLength); bin.copy(output, 28 + jsonLength);
  return output;
}
async function upload(f: Fixture, c: Client, bytes = triangle(), headers: Record<string, string> = {}) {
  const response = await fetch(f.url + '/api/spaces', { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'model/gltf-binary', ...headers }, body: bytes as unknown as BodyInit });
  return { status: response.status, body: await response.json() as { assetId: string; size: number; sha256: string; code?: string; error?: string } };
}
async function download(f: Fixture, token: string | null, assetId: string) {
  const response = await fetch(f.url + '/api/spaces/' + assetId, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

test('space assets use private live session tokens, isolate rooms, and round-trip exact GLB bytes over HTTP', async t => {
  const f = await fixture(); t.after(() => f.close());
  const unjoined = await f.client(); assert.equal((await upload(f, unjoined)).status, 401);
  const { a, b } = await pair(f), c = await f.client();
  c.send({ type: 'create', name: 'C', preset: 'sage' }); await c.take('joined');
  assert.match(a.token, /^[a-f0-9]{64}$/); assert.notEqual(a.token, b.token);
  assert.equal(JSON.stringify(a.history).includes(b.token), false); assert.equal(JSON.stringify(b.history).includes(a.token), false);
  const bytes = triangle(), posted = await upload(f, a, bytes);
  assert.equal(posted.status, 201); assert.match(posted.body.assetId, /^[a-f0-9]{32}$/);
  assert.equal(posted.body.size, bytes.length); assert.equal(posted.body.sha256, createHash('sha256').update(bytes).digest('hex'));
  for (const member of [a, b]) {
    const got = await download(f, member.token, posted.body.assetId);
    assert.equal(got.response.status, 200); assert.deepEqual(got.bytes, bytes);
    assert.equal(got.response.headers.get('content-type'), 'model/gltf-binary'); assert.equal(got.response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await download(f, null, posted.body.assetId)).response.status, 401);
  assert.equal((await download(f, c.token, posted.body.assetId)).response.status, 404);
  assert.equal((await upload(f, a, bytes, { Origin: 'https://foreign.invalid' })).status, 403);
  a.send({ type: 'leave' }); await b.take('ended');
  assert.equal((await download(f, a.token, posted.body.assetId)).response.status, 401);
  b.send({ type: 'create', name: 'B', preset: 'rose' }); await b.take('joined');
  assert.equal((await download(f, b.token, posted.body.assetId)).response.status, 404);
});

test('HTTP upload rejects external resources, extensions, malformed ranges, nonfinite geometry and oversized bodies', async t => {
  const f = await fixture({ maxSpaceBytes: 1024 }); t.after(() => f.close()); const { a } = await pair(f);
  for (const bytes of [
    Buffer.from('not a GLB'),
    triangle(json => { json.buffers[0].uri = 'https://unrelated.invalid/model.bin'; }),
    triangle(json => { json.images = [{ uri: 'data:image/png;base64,AAAA' }]; }),
    triangle(json => { json.extensionsUsed = ['KHR_draco_mesh_compression']; }),
    triangle(json => { json.accessors[0].count = 30; }),
    triangle((_json, bin) => { bin.writeFloatLE(Infinity, 0); })
  ]) {
    const result = await upload(f, a, bytes);
    assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_GLB');
  }
  const tooLarge = await upload(f, a, Buffer.alloc(1025));
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.body.code, 'ASSET_TOO_LARGE');
  assert.equal((await upload(f, a, triangle(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await upload(f, a)).status, 201);
});

test('chunked oversized uploads return a bounded HTTP rejection and release their reservation', async t => {
  const f = await fixture({ maxSpaceBytes: 1024, maxSpaceStorageBytes: 4096 }); t.after(() => f.close()); const { a } = await pair(f);
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(f.url + '/api/spaces', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'model/gltf-binary', 'Transfer-Encoding': 'chunked' } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.write(Buffer.alloc(600)); req.end(Buffer.alloc(600));
  });
  assert.equal(status, 413);
  assert.equal((await upload(f, a)).status, 201);
});

test('in-flight uploads count toward the global budget, cannot overlap for one member, and are cancelled on session end', async t => {
  const bytes = triangle(), f = await fixture({ maxSpaceStorageBytes: bytes.length * 3 }); t.after(() => f.close()); const { a, b } = await pair(f);
  let started!: () => void;
  const readyToSend = new Promise<void>(resolve => { started = resolve; });
  let req!: ReturnType<typeof httpRequest>;
  const result = new Promise<number>((resolve, reject) => {
    req = httpRequest(f.url + '/api/spaces', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'Content-Type': 'model/gltf-binary', 'Content-Length': bytes.length, Expect: '100-continue' } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode!));
    });
    req.once('continue', started); req.on('error', reject);
    req.flushHeaders();
  });
  void result.catch(() => {}); // The deliberate session close terminates this request.
  await readyToSend; req.write(bytes.subarray(0, 8));
  const sameMember = await upload(f, a, bytes); assert.equal(sameMember.status, 409); assert.equal(sameMember.body.code, 'UPLOAD_BUSY');
  const otherMember = await upload(f, b, bytes); assert.equal(otherMember.status, 503); assert.equal(otherMember.body.code, 'STORAGE_LIMIT');
  a.send({ type: 'leave' }); await b.take('ended');
  await assert.rejects(result);
  b.send({ type: 'create', name: '新会话', preset: 'sage' }); await b.take('joined');
  assert.equal((await upload(f, b, bytes)).status, 201);
});

test('shared GLB preflight rejects structural and renderer allocation hazards before parsing', () => {
  const valid = validateGLB(triangle()); assert.equal(valid.ok, true);
  if (valid.ok) { assert.equal(valid.vertexCount, 3); assert.equal(valid.triangleCount, 1); }
  const cases = [
    triangle(json => { json.asset.version = '1.0'; }),
    triangle(json => { json.buffers[0].byteLength = 1000; }),
    triangle(json => { json.bufferViews[0].byteOffset = 20; }),
    triangle(json => { json.bufferViews[0].byteStride = 7; }),
    triangle(json => { json.accessors[0].byteOffset = 1; }),
    triangle(json => { json.accessors[0].sparse = { count: 1 }; }),
    triangle(json => { json.accessors[0].max = [0.1, 1, 0]; }),
    triangle(json => { json.nodes[0].children = [0]; }),
    triangle(json => { json.nodes[0].mesh = 99; }),
    triangle(json => { json.meshes[0].primitives[0].attributes.POSITION = 999; }),
    triangle(json => { json.nodes = Array.from({ length: 513 }, () => ({ mesh: 0 })); json.scenes[0].nodes = json.nodes.map((_n: unknown, i: number) => i); }),
    triangle(json => { json.animations = [{ channels: [] }]; }),
    triangle(json => { json.extras = { deeper: { uri: 'https://unrelated.invalid' } }; }),
    triangle(json => { json.scene = 10; })
  ];
  for (const bytes of cases) assert.equal(validateGLB(bytes).ok, false);
  const wrongLength = triangle(); wrongLength.writeUInt32LE(wrongLength.length - 4, 8); assert.equal(validateGLB(wrongLength).ok, false);
  const wrongVersion = triangle(); wrongVersion.writeUInt32LE(1, 4); assert.equal(validateGLB(wrongVersion).ok, false);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  png.writeUInt32BE(50_000, 16); // Advertised decoded dimensions, not file size, bound allocation.
  const base = validateGLB(triangle()); assert.equal(base.ok, true);
  if (base.ok) {
    const json = base.json as GLTF, binary = Buffer.concat([Buffer.alloc(36), png]);
    json.buffers[0].byteLength = binary.length; json.bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: png.length });
    json.images = [{ bufferView: 1, mimeType: 'image/png' }];
    assert.equal(validateGLB(packGLB(json, binary)).ok, false);
  }
});

test('per-member file quota and global temporary memory budget are enforced and freed when a room ends', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
  for (let i = 0; i < 3; i++) assert.equal((await upload(f, a)).status, 201);
  const fourth = await upload(f, a); assert.equal(fourth.status, 409); assert.equal(fourth.body.code, 'ASSET_LIMIT');
  assert.equal((await upload(f, b)).status, 201);
  const bytes = triangle(), small = await fixture({ maxSpaceStorageBytes: bytes.length * 3 }); t.after(() => small.close());
  const old = await pair(small);
  assert.equal((await upload(small, old.a, bytes)).status, 201);
  assert.equal((await upload(small, old.b, bytes)).status, 201);
  const blocked = await upload(small, old.a, bytes); assert.equal(blocked.status, 503); assert.equal(blocked.body.code, 'STORAGE_LIMIT');
  old.a.send({ type: 'leave' }); await old.b.take('ended');
  old.b.send({ type: 'create', name: '新会话', preset: 'sage' }); await old.b.take('joined');
  assert.equal((await upload(small, old.b, bytes)).status, 201);
});

test('space proposals require the other member’s current decision; decline, expiry and spoofed authority cannot switch a room', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
  a.raw({ type: 'space-propose', space: { ...measured(), ownerId: b.id, revision: 99 } });
  assert.equal((await a.take('error')).code, 'INVALID_MESSAGE');
  a.send({ type: 'space-propose', space: { ...measured(), width: 21 } }); assert.equal((await a.take('error')).code, 'INVALID_MESSAGE');
  const proposal = await propose(a, b, measured());
  a.send({ type: 'space-response', proposalId: proposal.id, accepted: true }); assert.equal((await a.take('error')).code, 'SPACE_PROPOSAL_UNAVAILABLE');
  b.send({ type: 'space-propose', space: measured('另一个主场') }); assert.equal((await b.take('error')).code, 'SPACE_PROPOSAL_PENDING');
  b.send({ type: 'space-response', proposalId: proposal.id, accepted: false });
  const declined = (await b.take('state', m => !m.state.spaceProposal)).state;
  assert.equal(declined.space.revision, 0); assert.equal(declined.space.source, 'sample');
  const late = await propose(b, a, measured('B 的客厅')); f.advance(60_001);
  a.send({ type: 'space-response', proposalId: late.id, accepted: true });
  assert.equal((await a.take('error')).code, 'SPACE_PROPOSAL_UNAVAILABLE');
  const current = (await a.take('state', m => !m.state.spaceProposal)).state; assert.equal(current.space.revision, 0);
});

test('accepted space revisions clear old contacts and require both ready signals before dynamic-bound poses and consent', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
  a.send({ type: 'pose', pose: pose(0, 9) }); b.send({ type: 'pose', pose: pose(0.1, 9) });
  a.send({ type: 'consent', enabled: true }); b.send({ type: 'consent', enabled: true });
  const old = (await b.take('touch-request', m => m.request.to === b.id)).request;
  const next = await switchSpace(b, a, measured('B 的主场'), 1);
  assert.equal(next.space.ownerId, b.id); assert.equal(next.space.width, 12); assert.deepEqual(next.spaceReady, []);
  assert.equal(next.members.every(m => !m.consent), true); assert.equal(next.touchEnabled, false);
  b.send({ type: 'touch-response', requestId: old.id, accepted: true }); assert.equal((await b.take('error')).code, 'TOUCH_UNAVAILABLE');
  a.send({ type: 'pose', pose: pose(0, 10) }); assert.equal((await a.take('error')).code, 'SPACE_REVISION');
  a.send({ type: 'pose', pose: pose(0, 0, 1) }); assert.equal((await a.take('error')).code, 'SPACE_NOT_READY');
  a.send({ type: 'consent', enabled: true }); assert.equal((await a.take('error')).code, 'SPACE_NOT_READY');
  a.send({ type: 'space-ready', revision: 0 }); assert.equal((await a.take('error')).code, 'SPACE_REVISION');
  await ready(a, b, 1);
  a.send({ type: 'pose', pose: pose(5, 0, 1) });
  assert.equal((await b.take('pose', m => m.pose.spaceRevision === 1)).pose.seq, 0);
  a.send({ type: 'pose', pose: pose(6.1, 1, 1) }); assert.equal((await a.take('error')).code, 'INVALID_MESSAGE');
  a.send({ type: 'pose', pose: pose(0, 1, 1) }); b.send({ type: 'pose', pose: pose(0.1, 0, 1) });
  f.advance(1600);
  // Fresh poses after the clock advance, and a fresh opt-in for each person.
  a.send({ type: 'pose', pose: pose(0, 2, 1) }); b.send({ type: 'pose', pose: pose(0.1, 1, 1) });
  a.send({ type: 'consent', enabled: true }); b.send({ type: 'consent', enabled: true });
  const current = (await b.take('touch-request', m => m.request.to === b.id && m.request.id !== old.id)).request;
  b.send({ type: 'touch-response', requestId: current.id, accepted: true }); assert.equal((await b.take('touch')).event.id, current.id);
});

test('guest-owned GLB is shareable only by its uploader, and leaving revokes the asset and restores the remaining host’s sample', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b, roomId } = await pair(f);
  const uploaded = await upload(f, b); assert.equal(uploaded.status, 201);
  const config: SpaceConfig = { ...measured('B 的模型'), source: 'glb', assetId: uploaded.body.assetId, scale: 0.5, yaw: Math.PI / 2, offset: [1, 0, -1] };
  a.send({ type: 'space-propose', space: config }); assert.equal((await a.take('error')).code, 'SPACE_ASSET_UNAVAILABLE');
  const next = await switchSpace(b, a, config, 1);
  assert.equal(next.space.ownerId, b.id); assert.deepEqual(next.space.offset, [1, 0, -1]);
  await ready(a, b, 1);
  b.send({ type: 'leave' });
  const left = (await a.take('state', m => m.state.members.length === 1)).state;
  assert.equal(left.space.source, 'sample'); assert.equal(left.space.ownerId, a.id); assert.equal(left.space.revision, 2); assert.deepEqual(left.spaceReady, []);
  assert.equal((await download(f, a.token, config.assetId!)).response.status, 404);
  assert.equal((await download(f, b.token, config.assetId!)).response.status, 401);
  const c = await f.client(); c.send({ type: 'join', roomId, name: 'C' }); const joined = (await c.take('joined')).state;
  assert.equal(joined.space.revision, 2); assert.equal(joined.members.every(m => !m.consent), true);
});

test('stop cancels space proposals and presentation, while resume preserves coordinates but requires fresh poses', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f);
  await switchSpace(a, b, measured(), 1); await ready(a, b, 1);
  a.send({ type: 'pose', pose: pose(0, 1, 1) }); b.send({ type: 'pose', pose: pose(0.1, 1, 1) });
  await a.take('pose'); await b.take('pose');
  const pending = await propose(b, a, measured('下一间'));
  a.send({ type: 'presentation', active: true }); await b.take('state', m => m.state.presentation.ownerId === a.id);
  b.send({ type: 'stop' }); const stopped = (await a.take('state', m => m.state.stopped)).state;
  assert.equal(stopped.spaceProposal, null); assert.equal(stopped.presentation.ownerId, null); assert.equal(stopped.spaceReady.length, 2);
  a.send({ type: 'space-response', proposalId: pending.id, accepted: true }); assert.equal((await a.take('error')).code, 'SPACE_PROPOSAL_UNAVAILABLE');
  a.send({ type: 'presentation', active: true }); assert.equal((await a.take('error')).code, 'STOPPED');
  b.send({ type: 'resume' });
  await a.take('state', m => !m.state.stopped && m.state.playback.revision === stopped.playback.revision);
  const count = b.history.filter(m => m.type === 'touch-request').length;
  a.send({ type: 'consent', enabled: true }); b.send({ type: 'consent', enabled: true });
  await a.flush(); await b.flush(); assert.equal(b.history.filter(m => m.type === 'touch-request').length, count);
  a.send({ type: 'pose', pose: pose(0, 2, 1) }); b.send({ type: 'pose', pose: pose(0.1, 2, 1) });
  await b.take('touch-request', m => m.request.to === b.id);
});

test('presentation is exclusive; screen signaling is scoped to the current owner, room, role and revision', async t => {
  const f = await fixture(); t.after(() => f.close()); const { a, b } = await pair(f), c = await f.client();
  c.send({ type: 'create', name: 'C', preset: 'sage' }); await c.take('joined');
  const signal = (revision: number, type: 'offer' | 'answer' = 'offer') => ({ type: 'signal', signal: { channel: 'screen', presentationRevision: revision, description: { type, sdp: 'v=0\r\n' } } } as const);
  a.send(signal(0)); assert.equal((await a.take('error')).code, 'PRESENTATION_UNAVAILABLE');
  a.send({ type: 'presentation', active: true });
  const occupied = (await a.take('state', m => m.state.presentation.ownerId === a.id)).state.presentation;
  b.send({ type: 'presentation', active: true }); assert.equal((await b.take('error')).code, 'PRESENTATION_BUSY');
  b.send({ type: 'presentation', active: false }); assert.equal((await b.take('error')).code, 'PRESENTATION_UNAVAILABLE');
  b.send(signal(occupied.revision)); assert.equal((await b.take('error')).code, 'PRESENTATION_UNAVAILABLE');
  a.send(signal(occupied.revision)); assert.equal((await b.take('signal')).signal.channel, 'screen');
  b.send(signal(occupied.revision, 'answer')); assert.equal((await a.take('signal')).signal.presentationRevision, occupied.revision);
  b.send({ type: 'signal', signal: { channel: 'screen', presentationRevision: occupied.revision, candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } } });
  assert.equal((await a.take('signal')).signal.channel, 'screen');
  await c.flush(); assert.equal(c.history.some(m => m.type === 'signal'), false);
  a.send({ type: 'presentation', active: false });
  const released = (await b.take('state', m => m.state.presentation.ownerId === null && m.state.presentation.revision > occupied.revision)).state.presentation;
  b.send({ type: 'presentation', active: true });
  const replacement = (await b.take('state', m => m.state.presentation.ownerId === b.id)).state.presentation;
  assert.ok(replacement.revision > released.revision);
  a.send(signal(occupied.revision)); assert.equal((await a.take('error')).code, 'PRESENTATION_UNAVAILABLE');
  b.send(signal(replacement.revision)); assert.equal((await a.take('signal')).signal.presentationRevision, replacement.revision);
  await switchSpace(a, b, measured(), 1);
  a.send({ type: 'signal', signal: { description: { type: 'offer', sdp: 'camera still permitted before alignment' } } });
  assert.equal((await b.take('signal')).signal.channel, undefined);
  b.send(signal(replacement.revision)); assert.equal((await b.take('error')).code, 'PRESENTATION_UNAVAILABLE');
  a.send({ type: 'presentation', active: true }); await a.take('state', m => m.state.presentation.ownerId === a.id && m.state.presentation.revision > replacement.revision);
  b.send({ type: 'leave' }); const solo = (await a.take('state', m => m.state.members.length === 1)).state;
  assert.equal(solo.presentation.ownerId, null);
});
