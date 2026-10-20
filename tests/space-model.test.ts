import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { inspectSpaceModel, loadEmbeddedSpaceModel } from '../web/src/space-model.ts';

// Uses the installed GLTFLoader and actual embedded mesh bytes, without WebGL or device mocks.
// This verifies file interpretation and cleanup; it is not a GPU, camera, or XR hardware test.
function embeddedTriangle(mutate?: (json: Record<string, any>) => void): ArrayBuffer {
  const coordinates = new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 3]);
  const json: Record<string, any> = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [10, -2, 4], scale: [2, 1, 1], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: coordinates.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: coordinates.byteLength, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 1, 3] }],
  };
  mutate?.(json);
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.byteLength / 4) * 4;
  const output = new ArrayBuffer(12 + 8 + jsonLength + 8 + coordinates.byteLength);
  const header = new DataView(output), bytes = new Uint8Array(output);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, output.byteLength, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength); bytes.set(text, 20);
  header.setUint32(20 + jsonLength, coordinates.byteLength, true); header.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(new Uint8Array(coordinates.buffer), 28 + jsonLength);
  return output;
}
function close(actual: number[], expected: number[]) {
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-8));
}

test('GLB inspection reads actual embedded vertices and node transforms, preserving original model units', async () => {
  const data = embeddedTriangle();
  const model = await inspectSpaceModel(data);
  assert.equal(model.units, 'model-units');
  assert.equal(model.meshes, 1); assert.equal(model.triangles, 1); assert.equal(model.byteLength, data.byteLength);
  close([model.width, model.height, model.depth], [3, 1, 4]);
  close(model.min, [10, -2, 0]); close(model.max, [13, -1, 4]); close(model.center, [11.5, -1.5, 2]);
});

test('loaded model disposal releases geometry/material once and does not alter declared node transforms', async () => {
  const model = await loadEmbeddedSpaceModel(embeddedTriangle());
  let mesh: THREE.Mesh | null = null, geometryDisposals = 0, materialDisposals = 0;
  model.root.traverse(object => { if (object instanceof THREE.Mesh) mesh = object; });
  assert.ok(mesh);
  const selected = mesh as THREE.Mesh;
  selected.geometry.addEventListener('dispose', () => geometryDisposals++);
  const material = Array.isArray(selected.material) ? selected.material[0] : selected.material;
  material.addEventListener('dispose', () => materialDisposals++);
  close(selected.position.toArray(), [10, -2, 4]);
  model.dispose(); model.dispose();
  assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1);
});

test('external and data URI files fail preflight without making a network request', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('test forbids network'); });
  await assert.rejects(inspectSpaceModel(embeddedTriangle(json => { json.buffers[0].uri = 'https://example.com/room.bin'; })), /外部资源/);
  await assert.rejects(inspectSpaceModel(embeddedTriangle(json => { json.buffers[0].uri = 'data:application/octet-stream;base64,AAAA'; })), /外部资源/);
  assert.equal(requests, 0);
});

test('truncated files and unsupported glTF extensions fail before loader allocation', async () => {
  const data = embeddedTriangle();
  await assert.rejects(inspectSpaceModel(data.slice(0, data.byteLength - 4)), /标头|长度/);
  await assert.rejects(inspectSpaceModel(embeddedTriangle(json => { json.extensionsUsed = ['KHR_draco_mesh_compression']; })), /扩展/);
});
