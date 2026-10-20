/** Actual SpacePanel DOM/controller bundled into happy-dom. Scene loading and HTTP
 * are explicit boundary doubles; this is not a browser/WebGL or real-room test. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { resolve } from 'node:path';
import { sampleSpace, validateGLB, type RoomSpace, type SpaceConfig } from '../shared/space.ts';
import type { ClientMessage, RoomState } from '../shared/protocol.ts';
import type { SpacePanel } from '../web/src/space-panel.ts';
import type { RoveScene } from '../web/src/scene.ts';
import type { ModelInspection } from '../web/src/space-model.ts';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'c'.repeat(32);
const { outputFiles } = await build({
  entryPoints: [resolve('web/src/space-panel.ts')], bundle: true, write: false,
  format: 'iife', globalName: 'RoveSpacePanelTest', platform: 'browser', target: 'es2022', logLevel: 'silent',
  plugins: [{ name: 'space-scene-boundary', setup(builder) {
    builder.onResolve({ filter: /^\.\/scene\.ts$/ }, () => ({ path: 'scene', namespace: 'boundary' }));
    builder.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({
      contents: 'export const inspectSpaceModel = data => globalThis.__spaceBoundary.inspectSpaceModel(data);', loader: 'js',
    }));
  } }],
});
const panelCode = outputFiles[0].text;

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(done => setImmediate(done));

/** A real minimal, embedded triangle GLB for the production preflight validator. */
function glb(): ArrayBuffer {
  const json = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 });
  const encoded = new TextEncoder().encode(json), length = Math.ceil(encoded.length / 4) * 4;
  const data = new ArrayBuffer(28 + length + 36), bytes = new Uint8Array(data), view = new DataView(data);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, length, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + length); bytes.set(encoded, 20);
  view.setUint32(20 + length, 36, true); view.setUint32(24 + length, 0x004e4942, true);
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  positions.forEach((value, i) => view.setFloat32(28 + length + 4 * i, value, true));
  assert.equal(validateGLB(data).ok, true, 'fixture must pass the real GLB validator');
  return data;
}

function state(options: { id?: string; space?: RoomSpace; ready?: string[]; proposal?: RoomState['spaceProposal']; selfRole?: 'host' | 'guest' } = {}): RoomState {
  return { id: options.id ?? 'a'.repeat(32), preset: 'rose', members: [
    { id: SELF, name: '本地用户', role: options.selfRole ?? 'guest', consent: false },
    { id: OTHER, name: '远端用户', role: options.selfRole === 'host' ? 'guest' : 'host', consent: false },
  ], playback: { playing: false, position: 0, updatedAt: Date.now(), revision: 0 }, touchEnabled: false, stopped: false,
    space: options.space ?? sampleSpace(SELF), spaceProposal: options.proposal ?? null, spaceReady: options.ready ?? [],
    presentation: { ownerId: null, revision: 0 } };
}

async function harness(t: TestContext) {
  const window = new Window({ url: 'http://localhost:5173/' });
  const messages: ClientMessage[] = [], attempts: ClientMessage[] = [], toasts: string[] = [], logs: string[] = [];
  let allowSend = true, changes = 0;
  let loader: (space: RoomSpace, data?: ArrayBuffer) => Promise<void> = async () => {};
  let fetcher: (url: string, init: RequestInit) => Promise<Response> = async () => { throw new Error('Unexpected HTTP request'); };
  const requests: { url: string; init: RequestInit }[] = [];
  const inspection: ModelInspection = { width: 4, depth: 3, height: 2.5, min: [-2, 0, -1.5], max: [2, 2.5, 1.5],
    center: [0, 1.25, 0], meshes: 1, triangles: 1, byteLength: glb().byteLength, units: 'model-units' };
  let inspector: (data: ArrayBuffer) => Promise<ModelInspection> = async () => inspection;
  class SceneDouble {
    loads: { space: RoomSpace; data?: ArrayBuffer }[] = [];
    roles: ('host' | 'guest')[] = [];
    aligned = true;
    alignCalls = 0;
    inputEnabled = false;
    resets = 0;
    setSpace(space: RoomSpace, data?: ArrayBuffer) { this.loads.push({ space, data }); return loader(space, data); }
    async resetSpace() { this.resets++; }
    setRole(role: 'host' | 'guest') { this.roles.push(role); }
    setInputEnabled(enabled: boolean) { this.inputEnabled = enabled; }
    setRemotePose() {}
    isAligned() { return this.aligned; }
    alignXR() { this.alignCalls++; this.aligned = true; return { aligned: true }; }
  }
  const scene = new SceneDouble();
  Object.defineProperties(window, {
    __spaceBoundary: { value: { inspectSpaceModel: (data: ArrayBuffer) => inspector(data) } },
    TextDecoder: { value: TextDecoder },
    fetch: { value: async (url: string, init: RequestInit = {}) => { requests.push({ url, init }); return fetcher(url, init); }, configurable: true },
  });
  const module = window.eval(`${panelCode}\nRoveSpacePanelTest;`) as { SpacePanel: typeof SpacePanel; spacePanelMarkup: string };
  window.document.body.innerHTML = module.spacePanelMarkup;
  const panel = new module.SpacePanel(scene as unknown as RoveScene, {
    send: message => {
      // The actual transport serialises JSON, also removing VM-realm prototypes.
      const wire = JSON.parse(JSON.stringify(message)) as ClientMessage;
      attempts.push(wire); if (allowSend) messages.push(wire); return allowSend;
    },
    changed: () => changes++, toast: message => toasts.push(message), log: event => logs.push(event),
  });
  const element = (id: string) => window.document.getElementById(id)! as unknown as HTMLElement;
  const button = (id: string) => element(id) as HTMLButtonElement;
  const input = (id: string) => element(id) as HTMLInputElement;
  const select = (id: string) => element(id) as HTMLSelectElement;
  const dispatch = (id: string, event: string) => element(id).dispatchEvent(new window.Event(event) as unknown as Event);
  const click = (id: string) => element(id).click();
  const configure = (room: RoomState | null, active = true) => panel.configure(room, SELF, 'test-session-token', active);
  const readyMessages = () => messages.filter(message => message.type === 'space-ready');
  const proposals = () => messages.filter(message => message.type === 'space-propose');
  const chooseSource = (value: string) => { select('spaceSource').value = value; dispatch('spaceSource', 'change'); };
  async function chooseFile(name = 'room.glb') {
    const transfer = new window.DataTransfer();
    transfer.items.add(new window.File([glb()], name, { type: 'model/gltf-binary' }));
    Reflect.set(window.document.getElementById('spaceFile')!, 'files', transfer.files);
    dispatch('spaceFile', 'change'); await flush();
  }
  const verify = () => { input('spaceVerified').checked = true; dispatch('spaceVerified', 'change'); };
  t.after(async () => { panel.dispose(); await window.happyDOM.abort(); });
  return { window, panel, scene, messages, attempts, requests, toasts, logs, element, button, input, select, dispatch, click,
    configure, readyMessages, proposals, chooseSource, chooseFile, verify, flush,
    setLoader: (next: typeof loader) => { loader = next; }, setFetcher: (next: typeof fetcher) => { fetcher = next; },
    setInspector: (next: typeof inspector) => { inspector = next; }, setAllowSend: (next: boolean) => { allowSend = next; },
    changed: () => changes };
}

test('space ownership sets spatial role independently from session creator; load never acknowledges entry', async t => {
  const h = await harness(t); const room = state({ selfRole: 'guest', space: sampleSpace(SELF) });
  h.configure(room); await h.flush();
  assert.deepEqual(h.scene.roles, ['host']);
  assert.match(h.element('currentSpaceDetail').textContent ?? '', /由你提供主场/);
  assert.equal(h.readyMessages().length, 0); assert.equal(h.panel.canInteract, false);
  assert.equal(h.button('confirmSpace').disabled, false);
  h.click('confirmSpace');
  assert.deepEqual(h.readyMessages(), [{ type: 'space-ready', revision: 0 }]);
  assert.equal(h.panel.canInteract, false, 'local request alone does not count as accepted readiness');
  h.configure({ ...room, spaceReady: [SELF, OTHER] });
  assert.equal(h.panel.canInteract, true);
});

test('a room change invalidates an unresolved model fetch and cannot acknowledge or apply the old room', async t => {
  const h = await harness(t), pending = deferred<Response>();
  h.setFetcher(async () => pending.promise);
  h.configure(state({ space: { ...sampleSpace(OTHER), source: 'glb', assetId: ASSET } }));
  assert.equal(h.requests.length, 1);
  assert.equal(new Headers(h.requests[0].init.headers).get('authorization'), 'Bearer test-session-token');
  h.configure(state({ id: 'b'.repeat(32), space: { ...sampleSpace(SELF), name: '新房间' } })); await h.flush();
  pending.resolve(new Response(glb(), { headers: { 'content-length': String(glb().byteLength) } })); await h.flush();
  assert.equal(h.requests[0].init.signal?.aborted, true);
  assert.equal(h.scene.loads.length, 1); assert.equal(h.scene.loads[0].space.name, '新房间');
  assert.equal(h.readyMessages().length, 0); assert.equal(h.panel.canInteract, false);
  assert.equal(h.button('confirmSpace').disabled, false);
});

test('late renderer completion cannot clear a newer failed load; retry still needs explicit confirmation', async t => {
  const h = await harness(t), oldLoad = deferred<void>();
  h.setLoader(async space => { if (space.revision === 0) return oldLoad.promise; throw new Error('new model failed'); });
  h.configure(state());
  const newer = state({ space: { ...sampleSpace(OTHER, 1), name: '加载失败的新空间' } });
  h.configure(newer); await h.flush();
  assert.equal(h.element('spaceLoadError').hidden, false); assert.equal(h.button('confirmSpace').disabled, true);
  oldLoad.resolve(); await h.flush();
  h.configure({ ...newer, spaceReady: [OTHER] });
  assert.equal(h.element('spaceLoadError').hidden, false, 'same-revision room updates preserve the failed load');
  assert.equal(h.button('confirmSpace').disabled, true); h.click('confirmSpace');
  assert.equal(h.readyMessages().length, 0);
  h.setLoader(async () => {}); h.click('retrySpace'); await h.flush();
  assert.equal(h.element('spaceLoadError').hidden, true); assert.equal(h.readyMessages().length, 0);
  h.click('confirmSpace'); assert.deepEqual(h.readyMessages(), [{ type: 'space-ready', revision: 1 }]);
});

test('editing dimensions during an unresolved preview cannot revive approval for unpreviewed parameters', async t => {
  const h = await harness(t); h.configure(state()); await h.flush();
  const preview = deferred<void>(); h.setLoader(async () => preview.promise);
  h.click('previewSpace');
  h.input('spaceWidth').value = '7'; h.dispatch('spaceWidth', 'input');
  preview.resolve(); await h.flush();
  assert.equal(h.input('spaceVerified').disabled, true);
  h.verify(); h.click('proposeSpace');
  assert.equal(h.button('proposeSpace').disabled, true); assert.equal(h.proposals().length, 0);
  h.setLoader(async () => {}); h.click('previewSpace'); await h.flush(); h.verify(); h.click('proposeSpace');
  assert.equal(h.proposals().length, 1); assert.equal(h.proposals()[0].space.width, 7);
});

test('replacing a model while preview loading invalidates the older file approval', async t => {
  const h = await harness(t); h.configure(state()); await h.flush();
  h.chooseSource('glb'); await h.chooseFile('first.glb');
  const preview = deferred<void>(); h.setLoader(async () => preview.promise);
  h.click('previewSpace'); await h.chooseFile('replacement.glb');
  preview.resolve(); await h.flush();
  assert.match(h.element('modelInfo').textContent ?? '', /replacement\.glb/);
  assert.equal(h.input('spaceVerified').disabled, true); h.verify(); h.click('proposeSpace');
  assert.equal(h.proposals().length, 0); assert.equal(h.requests.length, 0);
});

test('editing model scale during upload aborts the stale proposal and requires a fresh preview', async t => {
  const h = await harness(t); h.configure(state()); await h.flush();
  h.chooseSource('glb'); await h.chooseFile(); h.click('previewSpace'); await h.flush(); h.verify();
  const upload = deferred<Response>(); h.setFetcher(async () => upload.promise);
  h.click('proposeSpace');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].init.method, 'POST');
  h.input('spaceScale').value = '2'; h.dispatch('spaceScale', 'input');
  upload.resolve(new Response(JSON.stringify({ assetId: ASSET }), { headers: { 'content-type': 'application/json' } })); await h.flush();
  assert.equal(h.requests[0].init.signal?.aborted, true); assert.equal(h.proposals().length, 0);
  assert.equal(h.button('proposeSpace').disabled, true);
  h.setFetcher(async () => new Response(JSON.stringify({ assetId: ASSET }), { headers: { 'content-type': 'application/json' } }));
  h.click('previewSpace'); await h.flush(); h.verify(); h.click('proposeSpace'); await h.flush();
  assert.equal(h.proposals().length, 1); assert.equal(h.proposals()[0].space.scale, 2);
  assert.equal(h.proposals()[0].space.width, 8); assert.equal(h.proposals()[0].space.assetId, ASSET);
});

test('accepting a peer space changes no readiness until the new space is loaded and explicitly confirmed', async t => {
  const h = await harness(t), next: SpaceConfig = { source: 'measured', name: '对方的书房', width: 4, depth: 3,
    height: 2.5, assetId: null, scale: 1, yaw: 0, offset: [0, 0, 0] };
  const room = state({ selfRole: 'host', ready: [SELF, OTHER], proposal: {
    id: 'proposal-id', fromId: OTHER, space: next, expiresAt: Date.now() + 60_000,
  } });
  h.configure(room); await h.flush(); h.click('acceptSpace');
  assert.deepEqual(h.messages, [{ type: 'space-response', proposalId: 'proposal-id', accepted: true }]);
  h.configure(state({ selfRole: 'host', space: { ...next, ownerId: OTHER, revision: 1 } })); await h.flush();
  assert.equal(h.scene.roles.at(-1), 'guest', 'the session creator can be the spatial guest');
  assert.equal(h.readyMessages().length, 0); assert.equal(h.panel.canInteract, false);
  assert.equal(h.button('confirmSpace').disabled, false);
  h.click('confirmSpace'); assert.deepEqual(h.readyMessages(), [{ type: 'space-ready', revision: 1 }]);
});

test('an unaligned XR view cannot confirm space until an explicit alignment action succeeds', async t => {
  const h = await harness(t); h.scene.aligned = false; h.configure(state()); await h.flush();
  assert.equal(h.button('confirmSpace').disabled, true); h.click('confirmSpace');
  assert.equal(h.readyMessages().length, 0); assert.equal(h.panel.canInteract, false);
  h.click('alignSpace'); assert.equal(h.scene.alignCalls, 1); assert.equal(h.button('confirmSpace').disabled, false);
  h.click('confirmSpace'); assert.equal(h.readyMessages().length, 1);
});

test('failed sends and server readiness errors allow explicit retry without pretending the model failed', async t => {
  const h = await harness(t); h.configure(state()); await h.flush();
  h.setAllowSend(false); h.click('confirmSpace');
  assert.equal(h.readyMessages().length, 0); assert.equal(h.button('confirmSpace').disabled, false);
  h.setAllowSend(true); h.click('confirmSpace'); assert.equal(h.button('confirmSpace').disabled, true);
  h.panel.handleError('SPACE_NOT_READY', '请重新确认当前空间');
  assert.equal(h.button('confirmSpace').disabled, false); assert.equal(h.element('spaceLoadError').hidden, true);
  assert.equal(h.panel.canInteract, false); h.click('confirmSpace');
  assert.equal(h.readyMessages().length, 2);
  h.panel.handleError('STOPPED', '会话已暂停'); h.panel.setActive(false);
  assert.equal(h.button('confirmSpace').disabled, true);
  h.panel.setActive(true); assert.equal(h.button('confirmSpace').disabled, false);
});
