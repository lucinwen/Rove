import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_SPACE_BYTES, validateGLB } from '../shared/space.ts';

type Identity = { id: string; roomId: string };
type Asset = Identity & { bytes: Buffer; sha256: string };
type Options = {
  authorize: (token: string) => Identity | null;
  now: () => number;
  maxBytes?: number;
  maxStorageBytes?: number;
  maxFilesPerPeer?: number;
};

/** Assets are capabilities scoped to a currently joined WebSocket identity.
 * Buffers are never written to disk and never served from the static handler. */
export function createSpaceAssetStore(options: Options) {
  const assets = new Map<string, Asset>();
  const uploads = new Map<string, { roomId: string; req: IncomingMessage }>();
  const attempts = new Map<string, { at: number; count: number }>();
  const maxBytes = Math.min(MAX_SPACE_BYTES, options.maxBytes ?? MAX_SPACE_BYTES);
  const maxStorage = Math.min(128 * 1024 * 1024, options.maxStorageBytes ?? 128 * 1024 * 1024);
  const maxFiles = Math.min(3, options.maxFilesPerPeer ?? 3);
  let storedBytes = 0, reservedBytes = 0;
  function json(res: ServerResponse, status: number, code: string, error: string) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error, code }));
  }
  function remove(predicate: (asset: Asset) => boolean) {
    for (const [id, asset] of assets) if (predicate(asset)) { storedBytes -= asset.bytes.byteLength; assets.delete(id); }
  }
  return {
    owns(assetId: string, ownerId: string, roomId: string) {
      const asset = assets.get(assetId);
      return !!asset && asset.id === ownerId && asset.roomId === roomId;
    },
    clearPeer(peerId: string, roomId: string) {
      remove(asset => asset.id === peerId && asset.roomId === roomId);
      const active = uploads.get(peerId);
      if (active?.roomId === roomId) active.req.destroy();
    },
    clearRoom(roomId: string) {
      remove(asset => asset.roomId === roomId);
      for (const upload of uploads.values()) if (upload.roomId === roomId) upload.req.destroy();
    },
    forget(peerId: string) { attempts.delete(peerId); },
    async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
      if (path !== '/api/spaces' && !path.startsWith('/api/spaces/')) return false;
      const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
      const identity = match ? options.authorize(match[1]) : null;
      if (!identity) { json(res, 401, 'UNAUTHORIZED', '请先进入会话；上传凭证只在当前连接有效'); req.resume(); return true; }
      if (path !== '/api/spaces') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, 'METHOD_NOT_ALLOWED', '仅支持读取模型'); req.resume(); return true; }
        const id = path.slice('/api/spaces/'.length);
        const asset = /^[a-f0-9]{32}$/.test(id) ? assets.get(id) : undefined;
        if (!asset || asset.roomId !== identity.roomId) { json(res, 404, 'ASSET_NOT_FOUND', '模型不存在或不属于当前会话'); return true; }
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': asset.bytes.byteLength, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : asset.bytes);
        return true;
      }
      if (req.method !== 'POST') { json(res, 405, 'METHOD_NOT_ALLOWED', '请使用 POST 上传 GLB 模型'); req.resume(); return true; }
      const mime = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!['model/gltf-binary', 'application/octet-stream'].includes(mime) || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
        json(res, 415, 'INVALID_MEDIA_TYPE', '请直接上传未压缩的 GLB 二进制文件'); req.resume(); return true;
      }
      const declared = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
      if (declared !== null && (!Number.isSafeInteger(declared) || declared <= 0 || declared > maxBytes)) {
        json(res, 413, 'ASSET_TOO_LARGE', '每个模型最多 20 MiB'); req.resume(); return true;
      }
      if (uploads.has(identity.id)) { json(res, 409, 'UPLOAD_BUSY', '上一个模型还在上传'); req.resume(); return true; }
      if ([...assets.values()].filter(a => a.id === identity.id && a.roomId === identity.roomId).length >= maxFiles) {
        json(res, 409, 'ASSET_LIMIT', '每位参与者每次会话最多上传 3 个模型'); req.resume(); return true;
      }
      const at = options.now(), previous = attempts.get(identity.id);
      const rate = previous && at - previous.at < 60_000 ? previous : { at, count: 0 };
      attempts.set(identity.id, rate);
      if (++rate.count > 10) { json(res, 429, 'UPLOAD_RATE_LIMIT', '模型上传过于频繁，请稍后再试'); req.resume(); return true; }
      // Reserve both incoming chunks and the assembled buffer, including uploads
      // with chunked transfer encoding, before accepting any body data.
      const reservation = 2 * (declared ?? maxBytes);
      if (storedBytes + reservedBytes + reservation > maxStorage) { json(res, 503, 'STORAGE_LIMIT', '当前模型暂存空间已满，请稍后再试'); req.resume(); return true; }
      reservedBytes += reservation;
      uploads.set(identity.id, { roomId: identity.roomId, req });
      let bytesRead = 0;
      const chunks: Buffer[] = [];
      const deadline = setTimeout(() => {
        if (res.destroyed) { req.destroy(); return; }
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
        json(res, 408, 'UPLOAD_TIMEOUT', '模型上传超时');
      }, 30_000);
      deadline.unref();
      try {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytesRead += bytes.byteLength;
          if (bytesRead > maxBytes || declared !== null && bytesRead > declared) {
            res.setHeader('Connection', 'close');
            json(res, 413, 'ASSET_TOO_LARGE', '每个模型最多 20 MiB');
            req.resume();
            return true;
          }
          chunks.push(bytes);
        }
        const current = options.authorize(match![1]);
        if (!current || current.id !== identity.id || current.roomId !== identity.roomId) { json(res, 403, 'ROOM_CHANGED', '会话已变化，模型没有保存'); return true; }
        if (!bytesRead || declared !== null && bytesRead !== declared) { json(res, 400, 'INVALID_GLB', '模型传输不完整'); return true; }
        const bytes = Buffer.concat(chunks, bytesRead);
        chunks.length = 0;
        const validation = validateGLB(bytes);
        if (!validation.ok) { json(res, 400, 'INVALID_GLB', validation.error); return true; }
        const assetId = randomBytes(16).toString('hex'), sha256 = createHash('sha256').update(bytes).digest('hex');
        assets.set(assetId, { ...identity, bytes, sha256 });
        storedBytes += bytes.byteLength;
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ assetId, size: bytes.byteLength, sha256 }));
      } catch {
        json(res, 400, 'UPLOAD_INTERRUPTED', '模型上传已中断，没有保存');
      } finally {
        clearTimeout(deadline);
        chunks.length = 0;
        reservedBytes -= reservation;
        uploads.delete(identity.id);
      }
      return true;
    }
  };
}
