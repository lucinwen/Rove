import { MAX_SPACE_BYTES } from './space.ts';

export type GLBValidation =
  | { ok: true; json: Record<string, unknown>; byteLength: number; vertexCount: number; triangleCount: number }
  | { ok: false; error: string };

type Obj = Record<string, unknown>;
const obj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const int = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vector = (value: unknown, size: number, limit = 1_000_000): value is number[] => Array.isArray(value) && value.length === size && value.every(n => finite(n) && Math.abs(n) <= limit);
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const ref = (value: unknown, list: unknown[]) => int(value, 0, list.length - 1);
const componentBytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Restricted static glTF 2.0 profile, shared by upload and browser preflight.
 * No URI, extensions, animations, skins, sparse accessors, or external decoders.
 * <=1M vertices/triangles, <=512 draws; PNG/JPEG <=4096px per dimension
 * and <=16,777,216 pixels combined. No Node, DOM, or renderer dependencies. */
export function validateGLB(input: ArrayBuffer | Uint8Array): GLBValidation {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    assert(bytes.byteLength >= 32 && bytes.byteLength <= MAX_SPACE_BYTES, '模型必须是 20 MiB 以内的完整 GLB 文件');
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert(data.getUint32(0, true) === 0x46546c67 && data.getUint32(4, true) === 2 && data.getUint32(8, true) === bytes.byteLength, 'GLB 标头、版本或文件长度无效');
    const jsonLength = data.getUint32(12, true);
    assert(data.getUint32(16, true) === 0x4e4f534a && jsonLength > 0 && jsonLength <= 2 * 1024 * 1024 && jsonLength % 4 === 0 && 20 + jsonLength + 8 <= bytes.length, 'GLB JSON 区块无效或过大');
    const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, 20 + jsonLength)));
    assert(obj(json), 'GLB JSON 必须是对象');
    const binaryHeader = 20 + jsonLength;
    const binaryLength = data.getUint32(binaryHeader, true), binaryStart = binaryHeader + 8;
    assert(data.getUint32(binaryHeader + 4, true) === 0x004e4942 && binaryLength > 0 && binaryLength % 4 === 0 && binaryStart + binaryLength === bytes.length, '仅支持一个 JSON 区块与一个内嵌 BIN 区块');
    const pending: { value: unknown; depth: number }[] = [{ value: json, depth: 0 }];
    let items = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      assert(++items <= 120_000 && depth <= 64, '模型元数据过于复杂');
      if (typeof value === 'number') assert(Number.isFinite(value), '模型包含非有限数值');
      if (typeof value === 'string') assert(value.length <= 65_536, '模型元数据文本过长');
      if (Array.isArray(value)) {
        assert(items + pending.length + value.length <= 120_000, '模型元数据过于复杂');
        for (const child of value) pending.push({ value: child, depth: depth + 1 });
      }
      else if (obj(value)) for (const [key, child] of Object.entries(value)) {
        assert(!['uri', '__proto__', 'prototype', 'constructor'].includes(key), '模型包含外部资源、数据 URI 或不安全字段');
        if (key === 'extensions') assert(obj(child) && Object.keys(child).length === 0, '暂不支持 glTF 扩展，请导出未压缩的标准 GLB');
        if (key === 'extensionsUsed' || key === 'extensionsRequired') assert(Array.isArray(child) && child.length === 0, '暂不支持 glTF 扩展，请导出未压缩的标准 GLB');
        pending.push({ value: child, depth: depth + 1 });
      }
    }
    assert(obj(json.asset) && json.asset.version === '2.0' && (json.asset.minVersion === undefined || json.asset.minVersion === '2.0'), '模型必须使用 glTF 2.0');
    for (const field of ['animations', 'skins', 'cameras']) assert(json[field] === undefined || Array.isArray(json[field]) && json[field].length === 0, '仅支持静态房间模型，不支持动画、骨骼或相机');
    const root: Obj = json;
    function list(key: string, max: number, required = false): Obj[] {
      const value = root[key];
      if (value === undefined && !required) return [];
      assert(Array.isArray(value) && value.length <= max && (!required || value.length > 0) && value.every(obj), '模型 ' + key + ' 列表无效或过大');
      return value;
    }
    const buffers = list('buffers', 1, true), views = list('bufferViews', 4096, true), accessors = list('accessors', 4096, true);
    const meshes = list('meshes', 512, true), nodes = list('nodes', 2048, true), scenes = list('scenes', 16, true);
    const materials = list('materials', 256), textures = list('textures', 32), images = list('images', 32), samplers = list('samplers', 32);
    const length = buffers[0].byteLength;
    assert(int(length, 1, binaryLength) && binaryLength - length <= 3, '模型 BIN 长度与声明的 buffer 不一致');
    for (let i = length; i < binaryLength; i++) assert(bytes[binaryStart + i] === 0, '模型 BIN 填充必须为零');
    for (const view of views) {
      assert(view.buffer === 0 && int(view.byteOffset ?? 0) && int(view.byteLength, 1) && ((view.byteOffset as number | undefined) ?? 0) + view.byteLength <= length, '模型 bufferView 超出内嵌数据范围');
      assert(view.byteStride === undefined || int(view.byteStride, 4, 252) && view.byteStride % 4 === 0, '模型交错 bufferView 步长无效');
      assert(view.target === undefined || view.target === 34962 || view.target === 34963, '模型 bufferView target 无效');
    }
    type Accessor = { value: Obj; start: number; stride: number; count: number; size: number; type: number; min: number[]; max: number[] };
    let componentCount = 0;
    const checked: Accessor[] = accessors.map(accessor => {
      assert(accessor.sparse === undefined && ref(accessor.bufferView, views), '不支持 sparse 或缺少 bufferView 的 accessor');
      assert(int(accessor.componentType) && componentBytes[accessor.componentType] && typeof accessor.type === 'string' && components[accessor.type], '模型 accessor 的类型不受支持');
      assert(int(accessor.count, 1, 1_000_000) && int(accessor.byteOffset ?? 0), '模型 accessor 数量或偏移无效');
      const view = views[accessor.bufferView as number], type = accessor.componentType, size = components[accessor.type], step = componentBytes[type];
      const relativeOffset = (accessor.byteOffset as number | undefined) ?? 0;
      const start = ((view.byteOffset as number | undefined) ?? 0) + relativeOffset, stride = (view.byteStride as number | undefined) ?? size * step;
      assert(start % step === 0 && relativeOffset % step === 0 && stride >= size * step && stride % step === 0, '模型 accessor 对齐或步长无效');
      assert(relativeOffset + (accessor.count - 1) * stride + size * step <= (view.byteLength as number), '模型 accessor 超出 bufferView 范围');
      assert(accessor.normalized === undefined || typeof accessor.normalized === 'boolean' && (!accessor.normalized || ![5125, 5126].includes(type)), '模型 accessor normalized 无效');
      for (const key of ['min', 'max']) assert(accessor[key] === undefined || vector(accessor[key], size), '模型 accessor 边界无效');
      if (accessor.min && accessor.max) assert((accessor.min as number[]).every((v, i) => v <= (accessor.max as number[])[i]), '模型 accessor 边界顺序无效');
      componentCount += accessor.count * size;
      assert(componentCount <= 12_000_000, '模型几何数据过于复杂');
      const result: Accessor = { value: accessor, start: binaryStart + start, stride, count: accessor.count, size, type, min: Array(size).fill(Infinity), max: Array(size).fill(-Infinity) };
      if (type === 5126) for (let i = 0; i < result.count; i++) for (let j = 0; j < size; j++) {
        const n = data.getFloat32(result.start + i * stride + j * step, true);
        assert(Number.isFinite(n) && Math.abs(n) <= 1_000_000, '模型包含非有限或过大的顶点数据');
        result.min[j] = Math.min(result.min[j], n); result.max[j] = Math.max(result.max[j], n);
      }
      return result;
    });
    const readIndex = (a: Accessor, n: number) => a.type === 5121 ? data.getUint8(a.start + n * a.stride) : a.type === 5123 ? data.getUint16(a.start + n * a.stride, true) : data.getUint32(a.start + n * a.stride, true);
    let sourceVertices = 0, sourceTriangles = 0, sourcePrimitives = 0;
    const meshSizes = meshes.map(mesh => {
      assert(mesh.weights === undefined && Array.isArray(mesh.primitives) && mesh.primitives.length > 0 && mesh.primitives.length <= 512, '模型 mesh 无效或包含变形权重');
      sourcePrimitives += mesh.primitives.length;
      assert(sourcePrimitives <= 512, '模型最多支持 512 个网格 primitive');
      let vertices = 0, triangles = 0;
      for (const primitive of mesh.primitives) {
        assert(obj(primitive) && (primitive.mode === undefined || primitive.mode === 4) && primitive.targets === undefined && obj(primitive.attributes), '仅支持静态三角形网格');
        const attributes = primitive.attributes;
        assert(ref(attributes.POSITION, checked), '模型缺少有效 POSITION');
        const position = checked[attributes.POSITION as number];
        assert(position.type === 5126 && position.size === 3 && position.value.type === 'VEC3' && vector(position.value.min, 3) && vector(position.value.max, 3), '顶点 POSITION 必须使用带边界的 FLOAT VEC3');
        assert(position.min.every((v, i) => v >= (position.value.min as number[])[i] - 1e-4 && position.max[i] <= (position.value.max as number[])[i] + 1e-4), '顶点数据超出声明的 POSITION 边界');
        for (const [semantic, index] of Object.entries(attributes)) {
          assert(['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0'].includes(semantic) && ref(index, checked), '模型包含不受支持的顶点属性');
          const a = checked[index as number];
          assert(a.count === position.count, '模型顶点属性数量不一致');
          if (semantic === 'NORMAL') assert(a.type === 5126 && a.size === 3, 'NORMAL 类型无效');
          if (semantic === 'TANGENT') assert(a.type === 5126 && a.size === 4, 'TANGENT 类型无效');
          if (semantic.startsWith('TEXCOORD')) assert(a.size === 2 && (a.type === 5126 || [5121, 5123].includes(a.type) && a.value.normalized === true), '纹理坐标类型无效');
          if (semantic === 'COLOR_0') assert([3, 4].includes(a.size) && (a.type === 5126 || [5121, 5123].includes(a.type) && a.value.normalized === true), '顶点颜色类型无效');
        }
        let count = position.count;
        if (primitive.indices !== undefined) {
          assert(ref(primitive.indices, checked), '模型索引 accessor 无效');
          const indices = checked[primitive.indices as number];
          assert(indices.size === 1 && [5121, 5123, 5125].includes(indices.type) && !indices.value.normalized, '模型索引必须为无符号整数');
          count = indices.count;
          assert(sourceTriangles + count / 3 <= 1_000_000, '模型三角形数据过于复杂');
          for (let i = 0; i < count; i++) assert(readIndex(indices, i) < position.count, '模型索引引用了不存在的顶点');
        }
        assert(count % 3 === 0 && (primitive.material === undefined || ref(primitive.material, materials)), '模型三角形数量或材质引用无效');
        sourceVertices += position.count; sourceTriangles += count / 3;
        assert(sourceVertices <= 1_000_000 && sourceTriangles <= 1_000_000, '模型几何数据过于复杂');
        vertices += position.count; triangles += count / 3;
      }
      return { vertices, triangles, calls: mesh.primitives.length };
    });
    let texturePixels = 0;
    for (const image of images) {
      assert(ref(image.bufferView, views) && ['image/png', 'image/jpeg'].includes(image.mimeType as string), '纹理必须是 BIN 内嵌的 PNG 或 JPEG');
      const view = views[image.bufferView as number];
      assert(view.byteStride === undefined, '纹理 bufferView 不允许交错步长');
      const start = binaryStart + ((view.byteOffset as number | undefined) ?? 0), end = start + (view.byteLength as number);
      const imageBytes = bytes.subarray(start, end), imageData = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
      let width = 0, height = 0;
      if (image.mimeType === 'image/png') {
        assert(imageBytes.length >= 45 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => imageBytes[i] === n), 'PNG 纹理标头无效');
        let offset = 8, ended = false;
        while (offset + 12 <= imageBytes.length) {
          const chunkLength = imageData.getUint32(offset), type = String.fromCharCode(...imageBytes.subarray(offset + 4, offset + 8));
          assert(offset + 12 + chunkLength <= imageBytes.length && !['acTL', 'fcTL', 'fdAT'].includes(type), 'PNG 区块无效或包含动画');
          if (offset === 8) {
            assert(type === 'IHDR' && chunkLength === 13, 'PNG 必须以 IHDR 开始');
            width = imageData.getUint32(offset + 8); height = imageData.getUint32(offset + 12);
          } else assert(type !== 'IHDR', 'PNG 包含重复 IHDR');
          offset += 12 + chunkLength;
          if (type === 'IEND') { assert(chunkLength === 0 && offset === imageBytes.length, 'PNG 结束区块无效'); ended = true; break; }
        }
        assert(ended, 'PNG 缺少完整结束区块');
      } else {
        assert(imageBytes.length >= 12 && imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes.at(-2) === 0xff && imageBytes.at(-1) === 0xd9, 'JPEG 纹理标头无效');
        let offset = 2;
        while (offset + 4 <= imageBytes.length) {
          assert(imageBytes[offset++] === 0xff, 'JPEG marker 无效');
          while (imageBytes[offset] === 0xff) offset++;
          const marker = imageBytes[offset++];
          if (marker === 0xda || marker === 0xd9) break;
          assert(offset + 2 <= imageBytes.length, 'JPEG 数据被截断');
          const segmentLength = imageData.getUint16(offset);
          assert(segmentLength >= 2 && offset + segmentLength <= imageBytes.length, 'JPEG 区块长度无效');
          if ([0xc0, 0xc1, 0xc2].includes(marker)) {
            assert(segmentLength >= 8 && width === 0, 'JPEG 帧无效');
            height = imageData.getUint16(offset + 3); width = imageData.getUint16(offset + 5);
          }
          offset += segmentLength;
        }
      }
      assert(width > 0 && height > 0 && width <= 4096 && height <= 4096, '纹理尺寸最多为 4096 × 4096');
      texturePixels += width * height;
      assert(texturePixels <= 16_777_216, '模型纹理总像素数超过 16,777,216');
    }
    for (const sampler of samplers) {
      assert(sampler.magFilter === undefined || [9728, 9729].includes(sampler.magFilter as number), '纹理放大滤镜无效');
      assert(sampler.minFilter === undefined || [9728, 9729, 9984, 9985, 9986, 9987].includes(sampler.minFilter as number), '纹理缩小滤镜无效');
      for (const key of ['wrapS', 'wrapT']) assert(sampler[key] === undefined || [33071, 33648, 10497].includes(sampler[key] as number), '纹理环绕模式无效');
    }
    for (const texture of textures) assert(ref(texture.source, images) && (texture.sampler === undefined || ref(texture.sampler, samplers)), '模型纹理引用无效');
    function textureInfo(value: unknown) {
      assert(obj(value) && ref(value.index, textures) && (value.texCoord === undefined || value.texCoord === 0 || value.texCoord === 1), '材质纹理引用无效');
      if (value.scale !== undefined) assert(finite(value.scale) && Math.abs(value.scale) <= 100, '法线纹理强度无效');
      if (value.strength !== undefined) assert(finite(value.strength) && value.strength >= 0 && value.strength <= 1, '遮蔽纹理强度无效');
    }
    for (const material of materials) {
      assert(material.alphaMode === undefined || ['OPAQUE', 'MASK', 'BLEND'].includes(material.alphaMode as string), '材质 alphaMode 无效');
      assert(material.doubleSided === undefined || typeof material.doubleSided === 'boolean', '材质 doubleSided 无效');
      assert(material.alphaCutoff === undefined || finite(material.alphaCutoff) && material.alphaCutoff >= 0 && material.alphaCutoff <= 1, '材质透明阈值无效');
      if (material.emissiveFactor !== undefined) assert(vector(material.emissiveFactor, 3, 1) && material.emissiveFactor.every(n => n >= 0), '材质自发光颜色无效');
      for (const key of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) if (material[key] !== undefined) textureInfo(material[key]);
      if (material.pbrMetallicRoughness !== undefined) {
        const pbr = material.pbrMetallicRoughness;
        assert(obj(pbr), '材质 PBR 参数无效');
        if (pbr.baseColorFactor !== undefined) assert(vector(pbr.baseColorFactor, 4, 1) && pbr.baseColorFactor.every(n => n >= 0), '材质颜色无效');
        for (const key of ['metallicFactor', 'roughnessFactor']) assert(pbr[key] === undefined || finite(pbr[key]) && (pbr[key] as number) >= 0 && (pbr[key] as number) <= 1, '材质 PBR 数值无效');
        for (const key of ['baseColorTexture', 'metallicRoughnessTexture']) if (pbr[key] !== undefined) textureInfo(pbr[key]);
      }
    }
    const parents = Array(nodes.length).fill(0) as number[];
    let vertexCount = 0, triangleCount = 0, calls = 0;
    for (const node of nodes) {
      assert(node.skin === undefined && node.camera === undefined && node.weights === undefined, '模型节点包含不支持的动态内容');
      if (node.mesh !== undefined) {
        assert(ref(node.mesh, meshes), '模型节点引用了不存在的 mesh');
        const size = meshSizes[node.mesh as number];
        vertexCount += size.vertices; triangleCount += size.triangles; calls += size.calls;
        assert(vertexCount <= 1_000_000 && triangleCount <= 1_000_000 && calls <= 512, '模型实例过多；最多一百万顶点、三角形及 512 次绘制');
      }
      if (node.matrix !== undefined) assert(vector(node.matrix, 16) && node.translation === undefined && node.rotation === undefined && node.scale === undefined && node.matrix[3] === 0 && node.matrix[7] === 0 && node.matrix[11] === 0 && node.matrix[15] === 1, '模型节点矩阵无效');
      if (node.translation !== undefined) assert(vector(node.translation, 3), '模型节点平移无效');
      if (node.rotation !== undefined) assert(vector(node.rotation, 4, 1) && Math.abs(Math.hypot(...node.rotation) - 1) <= 0.001, '模型节点四元数无效');
      if (node.scale !== undefined) assert(vector(node.scale, 3, 1000) && node.scale.every(n => Math.abs(n) >= 0.000001), '模型节点缩放无效');
      if (node.children !== undefined) {
        assert(Array.isArray(node.children) && node.children.length <= nodes.length && new Set(node.children).size === node.children.length, '模型节点子列表无效');
        for (const child of node.children) { assert(ref(child, nodes), '模型节点引用不存在的子节点'); assert(++parents[child as number] === 1, '模型节点不能有多个父节点'); }
      }
    }
    const visited = new Set<number>();
    const stack = parents.flatMap((parent, index) => parent === 0 ? [{ index, depth: 0, scale: 1, offset: 0 }] : []);
    while (stack.length) {
      const item = stack.pop()!;
      assert(!visited.has(item.index) && item.depth <= 48, '模型节点循环或层级过深');
      visited.add(item.index);
      const node = nodes[item.index], m = node.matrix as number[] | undefined;
      const localScale = m ? Math.max(Math.abs(m[0]) + Math.abs(m[4]) + Math.abs(m[8]), Math.abs(m[1]) + Math.abs(m[5]) + Math.abs(m[9]), Math.abs(m[2]) + Math.abs(m[6]) + Math.abs(m[10])) : Math.max(...((node.scale as number[] | undefined) ?? [1, 1, 1]).map(Math.abs));
      const localOffset = Math.hypot(...(m ? [m[12], m[13], m[14]] : (node.translation as number[] | undefined) ?? [0, 0, 0]));
      const scale = item.scale * localScale, offset = item.offset + item.scale * localOffset;
      assert(Number.isFinite(scale) && Number.isFinite(offset) && scale <= 1_000_000 && offset <= 1_000_000, '模型累计变换过大');
      for (const child of (node.children as number[] | undefined) ?? []) stack.push({ index: child, depth: item.depth + 1, scale, offset });
    }
    assert(visited.size === nodes.length, '模型节点存在循环');
    for (const scene of scenes) {
      assert(Array.isArray(scene.nodes) && scene.nodes.length > 0 && new Set(scene.nodes).size === scene.nodes.length, '模型场景缺少节点');
      for (const index of scene.nodes) assert(ref(index, nodes) && parents[index as number] === 0, '场景必须引用根节点');
    }
    assert((json.scene === undefined || ref(json.scene, scenes)) && vertexCount > 0 && triangleCount > 0, '模型缺少可展示的几何体或默认场景无效');
    const selected = [...(scenes[(json.scene as number | undefined) ?? 0].nodes as number[])];
    let visibleMesh = false;
    while (selected.length) {
      const node = nodes[selected.pop()!];
      if (node.mesh !== undefined) visibleMesh = true;
      selected.push(...((node.children as number[] | undefined) ?? []));
    }
    assert(visibleMesh, '默认场景不包含可展示的几何体');
    return { ok: true, json, byteLength: bytes.byteLength, vertexCount, triangleCount };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'GLB 文件无法解析' };
  }
}
