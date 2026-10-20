import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { validateGLB } from '../../shared/space.ts';
import type { Vec3 } from '../../shared/protocol.ts';

export type ModelInspection = {
  width: number; depth: number; height: number;
  center: Vec3; min: Vec3; max: Vec3;
  meshes: number; triangles: number; byteLength: number;
  units: 'model-units';
};
export type LoadedSpaceModel = { root: THREE.Group; roots: THREE.Object3D[]; inspection: ModelInspection; dispose: () => void };

/** The same closed GLB subset is checked on client and server before Three.js sees it. */
export async function loadEmbeddedSpaceModel(data: ArrayBuffer): Promise<LoadedSpaceModel> {
  const preflight = validateGLB(data);
  if (!preflight.ok) throw new Error(preflight.error);
  const manager = new THREE.LoadingManager();
  let imageFailed = false;
  manager.onError = () => { imageFailed = true; };
  manager.setURLModifier(url => {
    // GLTFLoader creates local blob URLs for already-validated embedded PNG/JPEG images.
    // No external URI, decoder CDN, .bin URL, or remote texture is ever allowed here.
    if (!url.startsWith('blob:')) throw new Error('空间模型只能使用 GLB 内嵌资源，不能加载外部文件。');
    return url;
  });
  const loader = new GLTFLoader(manager);
  const allocatedRoots = new Set<THREE.Object3D>();
  const allocatedMaterials = new Set<THREE.Material>();
  const allocatedTextures = new Set<THREE.Texture>();
  const release = resourceDisposer();
  const cleanup = () => release([...allocatedRoots], [...allocatedMaterials], [...allocatedTextures]);
  let rejected = false;
  // Capture asynchronous dependencies through GLTFLoader's plugin hook. If one image fails,
  // both completed allocations and later-resolving dependencies must be released.
  loader.register(parser => {
    const dependency = parser.getDependency.bind(parser);
    parser.getDependency = (type, index) => dependency(type, index).then((resource: unknown) => {
      if (resource instanceof THREE.Object3D) allocatedRoots.add(resource);
      if (resource instanceof THREE.Material) allocatedMaterials.add(resource);
      if (resource instanceof THREE.Texture) allocatedTextures.add(resource);
      if (rejected) cleanup();
      return resource;
    });
    return { name: 'RoveEmbeddedResourceCleanup' };
  });
  let model;
  try {
    model = await loader.parseAsync(data, '');
    if (imageFailed) throw new Error('模型的内嵌图片无法解码，请重新导出 PNG/JPEG 纹理。');
  } catch (error) {
    rejected = true;
    cleanup();
    throw error;
  }
  const roots = model.scenes.length ? model.scenes : [model.scene];
  roots.forEach(root => allocatedRoots.add(root));
  try {
    let meshes = 0, triangles = 0;
    model.scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        meshes++;
        const count = object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0;
        triangles += Math.floor(count / 3);
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    if (!meshes || triangles < 1) throw new Error('模型没有可显示的三角网格。');
    if (meshes > 512 || triangles > 1_000_000) throw new Error('模型超出当前原型可承载的网格数量，请先简化。');
    model.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model.scene, true);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    if (![...bounds.min.toArray(), ...bounds.max.toArray(), ...size.toArray()].every(Number.isFinite) ||
        bounds.isEmpty() || Math.max(size.x, size.y, size.z) < 0.000001 || Math.max(size.x, size.y, size.z) > 1_000_000) {
      throw new Error('模型的几何范围无效，请检查导出坐标和单位。');
    }
    const inspection: ModelInspection = {
      width: size.x, depth: size.z, height: size.y,
      center: center.toArray() as Vec3, min: bounds.min.toArray() as Vec3, max: bounds.max.toArray() as Vec3,
      meshes, triangles, byteLength: data.byteLength, units: 'model-units',
    };
    let disposed = false;
    return { root: model.scene, roots, inspection, dispose: () => { if (!disposed) { disposed = true; cleanup(); } } };
  } catch (error) {
    rejected = true;
    cleanup();
    throw error;
  }
}

/** Inspect geometry in its original model units; choosing a metre scale is an explicit user action. */
export async function inspectSpaceModel(data: ArrayBuffer): Promise<ModelInspection> {
  const model = await loadEmbeddedSpaceModel(data);
  try { return { ...model.inspection, center: [...model.inspection.center], min: [...model.inspection.min], max: [...model.inspection.max] }; }
  finally { model.dispose(); }
}

export function disposeObjectRoots(roots: THREE.Object3D[]): void {
  resourceDisposer()(roots);
}

function resourceDisposer() {
  const disposed = new WeakSet<object>();
  return (roots: THREE.Object3D[], extraMaterials: THREE.Material[] = [], extraTextures: THREE.Texture[] = []) => {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>(extraMaterials);
    const textures = new Set<THREE.Texture>(extraTextures);
    for (const root of roots) root.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      } else if (object instanceof THREE.Sprite) materials.add(object.material);
    });
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      if (!disposed.has(material)) { disposed.add(material); material.dispose(); }
    }
    for (const texture of textures) {
      const bitmap = texture.source?.data;
      if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap && !disposed.has(bitmap)) {
        disposed.add(bitmap); bitmap.close();
      }
      if (!disposed.has(texture)) { disposed.add(texture); texture.dispose(); }
    }
    for (const geometry of geometries) if (!disposed.has(geometry)) { disposed.add(geometry); geometry.dispose(); }
  };
}
