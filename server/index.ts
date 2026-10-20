import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { ViteDevServer } from 'vite';
import { parseClientMessage, validPose } from '../shared/validation.ts';
import { MAX_SPACE_BYTES, SPACE_PROPOSAL_TTL_MS, sampleSpace, spaceBounds, type SpaceConfig } from '../shared/space.ts';
import { createSpaceAssetStore } from './space-assets.ts';
import { CLIP_DURATION, POSE_STALE_MS, PROTOCOL_VERSION, TOUCH_DISTANCE, playbackPosition,
  type ClientMessage, type Member, type PoseFrame, type RoomState, type ServerMessage, type TouchEvent, type TouchRequest } from '../shared/protocol.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUEST_TTL = 5000;
const MAX_CONNECTIONS = 64;
const MAX_PAYLOAD = 64 * 1024;
const IDLE_MS = 120_000;
const SESSION_MS = 2 * 60 * 60 * 1000;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
type Peer = { id: string; sessionToken: string; ws: WebSocket; room?: Room; member?: Member; frame?: PoseFrame; frameAt: number; lastSeq: number; lastSeen: number; rateAt: number; rateCount: number; poseRateAt: number; poseCount: number; alive: boolean; heartbeatAt: number };
type Room = { state: RoomState; peers: Peer[]; requests: Map<string, TouchRequest>; delivered: Map<string, { event: TouchEvent; expiresAt: number }>; contacting: boolean; lastContact: number; createdAt: number };
export type RoveServerOptions = { port?: number; host?: string; production?: boolean; now?: () => number; allowMissingOrigin?: boolean; allowedOrigins?: string[]; maintenanceMs?: number; root?: string; maxSpaceBytes?: number; maxSpaceStorageBytes?: number; maxSpaceFilesPerPeer?: number };

/** A deliberately memory-only, two-person prototype; no media or poses are persisted. */
export async function createRoveServer(options: RoveServerOptions = {}) {
  const now = options.now ?? Date.now;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const root = options.root ?? ROOT;
  const peers = new Map<string, Peer>();
  const rooms = new Map<string, Room>();
  const tokens = new Map<string, Peer>();
  const assets = createSpaceAssetStore({
    authorize: token => {
      const peer = tokens.get(token);
      return peer?.room && peer.ws.readyState === WebSocket.OPEN ? { id: peer.id, roomId: peer.room.state.id } : null;
    },
    now, maxBytes: options.maxSpaceBytes, maxStorageBytes: options.maxSpaceStorageBytes, maxFilesPerPeer: options.maxSpaceFilesPerPeer
  });
  let vite: ViteDevServer | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing = false;

  function send(peer: Peer, message: ServerMessage) {
    if (peer.ws.readyState === WebSocket.OPEN) {
      if (peer.ws.bufferedAmount > 256 * 1024) { peer.ws.close(1013, 'Slow receiver'); return; }
      peer.ws.send(JSON.stringify(message));
    }
  }
  function broadcast(room: Room, message: ServerMessage) { for (const peer of room.peers) send(peer, message); }
  function fail(peer: Peer, code: string, message: string) { send(peer, { type: 'error', code, message }); }
  function spaceReady(room: Room) { return room.state.space.revision === 0 || room.peers.every(p => room.state.spaceReady.includes(p.id)); }
  function state(room: Room) {
    room.state.members = room.peers.map(p => ({ ...p.member! }));
    room.state.touchEnabled = room.peers.length === 2 && !room.state.stopped && spaceReady(room) && room.peers.every(p => p.member!.consent);
    broadcast(room, { type: 'state', state: room.state, serverTime: now() });
  }
  function cancelRequests(room: Room, reason: string) {
    for (const requestId of room.requests.keys()) broadcast(room, { type: 'touch-cancelled', requestId, reason });
    room.requests.clear();
  }
  function revoke(room: Room, reason: string) {
    for (const peer of room.peers) peer.member!.consent = false;
    cancelRequests(room, reason);
    room.delivered.clear();
    room.contacting = false;
  }
  function clearFrames(room: Room, resetSequence = false) {
    for (const peer of room.peers) { peer.frame = undefined; peer.frameAt = 0; if (resetSequence) peer.lastSeq = -1; }
  }
  function clearPresentation(room: Room) {
    if (room.state.presentation.ownerId !== null) room.state.presentation = { ownerId: null, revision: room.state.presentation.revision + 1 };
  }
  function setSpace(room: Room, config: SpaceConfig, ownerId: string) {
    revoke(room, '共享空间已切换，请重新就位并确认');
    clearFrames(room, true);
    clearPresentation(room);
    room.state.space = { ...config, name: config.name.trim(), offset: [...config.offset], ownerId, revision: room.state.space.revision + 1 };
    room.state.spaceProposal = null;
    room.state.spaceReady = [];
  }
  function fresh(peer: Peer) { return !!peer.frame?.tracked && now() - peer.frameAt <= POSE_STALE_MS; }
  function distance(a: Peer, b: Peer) { return Math.hypot(...a.frame!.right.position.map((v, i) => v - b.frame!.right.position[i])); }
  function eligible(room: Room) { return room.state.touchEnabled && !room.state.stopped && room.peers.length === 2 && room.peers.every(fresh); }
  function contacts(room: Room) {
    if (!eligible(room)) { cancelRequests(room, '追踪失效或触碰权限已撤回'); room.contacting = false; return; }
    const [a, b] = room.peers;
    const d = distance(a, b);
    if (d > TOUCH_DISTANCE + 0.10) { room.contacting = false; cancelRequests(room, '双方的手已分开'); return; }
    if (d > TOUCH_DISTANCE || room.contacting || now() - room.lastContact < 1500) return;
    room.contacting = true;
    room.lastContact = now();
    // Each recipient makes an independent, one-shot decision. A continuous overlap
    // cannot repeatedly produce requests; separate the hands to start a new contact.
    for (const [from, to] of [[a, b], [b, a]]) {
      const request: TouchRequest = { id: randomUUID(), from: from.id, to: to.id, hand: 'right', expiresAt: now() + REQUEST_TTL };
      room.requests.set(request.id, request);
      broadcast(room, { type: 'touch-request', request });
    }
  }
  function leave(peer: Peer, reason = '已离开会话') {
    const room = peer.room;
    if (!room) return;
    revoke(room, reason);
    clearFrames(room);
    clearPresentation(room);
    room.state.spaceProposal = null;
    const isHost = peer.member?.role === 'host';
    if (isHost) {
      assets.clearRoom(room.state.id);
      for (const p of room.peers) { send(p, { type: 'ended', reason: '主场已结束会话' }); p.room = undefined; p.member = undefined; p.frame = undefined; p.lastSeq = -1; }
      rooms.delete(room.state.id);
      room.peers = [];
    } else {
      assets.clearPeer(peer.id, room.state.id);
      room.peers = room.peers.filter(p => p !== peer);
      room.state.spaceReady = room.state.spaceReady.filter(id => id !== peer.id);
      if (room.state.space.ownerId === peer.id) {
        const hostId = room.peers[0].id;
        const { ownerId: _ownerId, revision: _revision, ...config } = sampleSpace(hostId);
        setSpace(room, config, hostId);
      }
      peer.room = undefined; peer.member = undefined; peer.frame = undefined; peer.lastSeq = -1;
      send(peer, { type: 'ended', reason });
      state(room);
    }
  }
  function handle(peer: Peer, msg: ClientMessage) {
    if (msg.type === 'ping') { send(peer, { type: 'pong', sentAt: msg.sentAt, serverTime: now() }); return; }
    if (msg.type === 'inspect') {
      const room = rooms.get(msg.roomId);
      if (!room) { fail(peer, 'ROOM_NOT_FOUND', '房间不存在或已经结束'); return; }
      send(peer, { type: 'preview', roomId: msg.roomId, preset: room.state.preset, available: room.peers.length < 2 }); return;
    }
    if (msg.type === 'create' || msg.type === 'join') {
      if (peer.room) { fail(peer, 'ALREADY_JOINED', '请先退出当前房间'); return; }
      let room: Room;
      if (msg.type === 'create') {
        const id = randomBytes(16).toString('hex');
        room = { state: { id, preset: msg.preset, members: [], playback: { playing: false, position: 0, updatedAt: now(), revision: 0 }, touchEnabled: false, stopped: false, space: sampleSpace(peer.id), spaceProposal: null, spaceReady: [], presentation: { ownerId: null, revision: 0 } }, peers: [], requests: new Map(), delivered: new Map(), contacting: false, lastContact: -Infinity, createdAt: now() };
        rooms.set(id, room);
      } else {
        const found = rooms.get(msg.roomId);
        if (!found) { fail(peer, 'ROOM_NOT_FOUND', '房间不存在或已经结束'); return; }
        if (found.peers.length >= 2) { fail(peer, 'ROOM_FULL', '这个双人房间已经满员'); return; }
        room = found;
      }
      peer.room = room;
      peer.member = { id: peer.id, name: msg.name.trim(), role: msg.type === 'create' ? 'host' : 'guest', consent: false };
      peer.frame = undefined; peer.frameAt = 0; peer.lastSeq = -1;
      room.peers.push(peer);
      if (room.state.space.revision === 0) room.state.spaceReady.push(peer.id);
      room.state.spaceProposal = null;
      clearFrames(room);
      clearPresentation(room);
      // New arrivals cannot inherit a previous visitor's touch authorization.
      revoke(room, '参与者已变化，请重新确认');
      room.state.members = room.peers.map(p => ({ ...p.member! }));
      room.state.touchEnabled = false;
      send(peer, { type: 'joined', selfId: peer.id, state: room.state, serverTime: now() });
      state(room);
      return;
    }
    if (msg.type === 'leave') { leave(peer); return; }
    const room = peer.room;
    if (!room || !peer.member) { fail(peer, 'NOT_JOINED', '请先创建或接受邀请进入房间'); return; }
    // A stopped room rejects input at the authority too, including a stale or
    // modified client that keeps sending poses or WebRTC negotiation messages.
    if (room.state.stopped && (msg.type === 'pose' || msg.type === 'signal')) {
      fail(peer, 'STOPPED', '会话已暂停，位置更新和音视频信令已停止'); return;
    }
    switch (msg.type) {
      case 'consent':
        if (msg.enabled && room.state.stopped) { fail(peer, 'STOPPED', '会话已暂停，请先解除暂停并重新确认'); return; }
        if (msg.enabled && !spaceReady(room)) { fail(peer, 'SPACE_NOT_READY', '双方需在当前空间重新确认就位'); return; }
        peer.member.consent = msg.enabled;
        if (!msg.enabled) { cancelRequests(room, '触碰权限已撤回'); room.delivered.clear(); }
        state(room); contacts(room); return;
      case 'stop':
        room.state.stopped = true;
        revoke(room, '一方按下了立即停止');
        clearFrames(room);
        clearPresentation(room);
        room.state.spaceProposal = null;
        room.state.playback = { playing: false, position: playbackPosition(room.state.playback, now()), updatedAt: now(), revision: room.state.playback.revision + 1 };
        state(room); return;
      case 'resume':
        room.state.stopped = false;
        revoke(room, '恢复后须重新确认触碰权限'); clearFrames(room); state(room); return;
      case 'pose': {
        if ((msg.pose.spaceRevision ?? 0) !== room.state.space.revision) { fail(peer, 'SPACE_REVISION', '姿态不属于当前共享空间'); return; }
        if (!spaceReady(room)) { fail(peer, 'SPACE_NOT_READY', '双方需在当前空间重新确认就位'); return; }
        if (!validPose(msg.pose, spaceBounds(room.state.space))) { fail(peer, 'INVALID_MESSAGE', '姿态超出当前共享空间边界'); return; }
        if (msg.pose.seq <= peer.lastSeq) { fail(peer, 'STALE_SEQUENCE', '姿态序号已过期'); return; }
        if (now() - peer.poseRateAt >= 1000) { peer.poseRateAt = now(); peer.poseCount = 0; }
        if (++peer.poseCount > 60) { fail(peer, 'POSE_RATE_LIMIT', '姿态更新频率过高'); return; }
        peer.lastSeq = msg.pose.seq;
        peer.frame = msg.pose;
        peer.frameAt = now();
        for (const p of room.peers) if (p !== peer) send(p, { type: 'pose', peerId: peer.id, pose: msg.pose, serverTime: now() });
        contacts(room); return;
      }
      case 'signal': {
        const other = room.peers.find(p => p !== peer);
        if (!other) { fail(peer, 'PEER_UNAVAILABLE', '对方尚未进入房间'); return; }
        if (msg.signal.channel === 'screen') {
          const owner = room.state.presentation.ownerId;
          if (!owner || msg.signal.presentationRevision !== room.state.presentation.revision ||
            msg.signal.description?.type === 'offer' && owner !== peer.id ||
            msg.signal.description?.type === 'answer' && owner === peer.id) {
            fail(peer, 'PRESENTATION_UNAVAILABLE', '屏幕共享已结束、版本已变化或信令角色不匹配'); return;
          }
        }
        send(other, { type: 'signal', peerId: peer.id, signal: msg.signal }); return;
      }
      case 'space-propose': {
        if (room.state.stopped) { fail(peer, 'STOPPED', '请先解除暂停再切换空间'); return; }
        if (room.peers.length !== 2) { fail(peer, 'PEER_UNAVAILABLE', '对方进入房间后才能确认空间切换'); return; }
        if (room.state.spaceProposal && room.state.spaceProposal.expiresAt > now()) { fail(peer, 'SPACE_PROPOSAL_PENDING', '请先处理当前空间邀请'); return; }
        if (msg.space.source === 'glb' && !assets.owns(msg.space.assetId!, peer.id, room.state.id)) { fail(peer, 'SPACE_ASSET_UNAVAILABLE', '只能分享自己在本次会话上传的模型'); return; }
        room.state.spaceProposal = { id: randomUUID(), fromId: peer.id, space: { ...msg.space, name: msg.space.name.trim(), offset: [...msg.space.offset] }, expiresAt: now() + SPACE_PROPOSAL_TTL_MS };
        state(room); return;
      }
      case 'space-response': {
        const proposal = room.state.spaceProposal;
        if (!proposal || proposal.id !== msg.proposalId || proposal.fromId === peer.id) { fail(peer, 'SPACE_PROPOSAL_UNAVAILABLE', '空间邀请已失效或不属于你'); return; }
        if (proposal.expiresAt <= now() || room.state.stopped || !room.peers.some(p => p.id === proposal.fromId)) {
          room.state.spaceProposal = null; state(room); fail(peer, 'SPACE_PROPOSAL_UNAVAILABLE', '空间邀请已过期或会话已暂停'); return;
        }
        if (!msg.accepted) { room.state.spaceProposal = null; state(room); return; }
        if (proposal.space.source === 'glb' && !assets.owns(proposal.space.assetId!, proposal.fromId, room.state.id)) {
          room.state.spaceProposal = null; state(room); fail(peer, 'SPACE_ASSET_UNAVAILABLE', '模型已不再属于当前会话'); return;
        }
        setSpace(room, proposal.space, proposal.fromId);
        state(room); return;
      }
      case 'space-ready':
        if (msg.revision !== room.state.space.revision) { fail(peer, 'SPACE_REVISION', '请确认当前版本的空间'); return; }
        if (room.state.stopped) { fail(peer, 'STOPPED', '请先解除暂停再确认就位'); return; }
        if (!room.state.spaceReady.includes(peer.id)) room.state.spaceReady.push(peer.id);
        state(room); return;
      case 'presentation': {
        if (msg.active) {
          if (room.state.stopped) { fail(peer, 'STOPPED', '会话暂停期间不能共享屏幕'); return; }
          if (room.peers.length !== 2) { fail(peer, 'PEER_UNAVAILABLE', '对方进入后才能共享屏幕'); return; }
          if (room.state.presentation.ownerId && room.state.presentation.ownerId !== peer.id) { fail(peer, 'PRESENTATION_BUSY', '对方正在共享屏幕'); return; }
          if (room.state.presentation.ownerId !== peer.id) room.state.presentation = { ownerId: peer.id, revision: room.state.presentation.revision + 1 };
        } else {
          if (room.state.presentation.ownerId && room.state.presentation.ownerId !== peer.id) { fail(peer, 'PRESENTATION_UNAVAILABLE', '只能结束自己的屏幕共享'); return; }
          clearPresentation(room);
        }
        state(room); return;
      }
      case 'playback': {
        if (room.state.stopped) { fail(peer, 'STOPPED', '会话已暂停'); return; }
        const old = room.state.playback;
        room.state.playback = { playing: msg.action === 'play' ? true : msg.action === 'pause' ? false : old.playing, position: msg.position, updatedAt: now(), revision: old.revision + 1 };
        if (msg.position >= CLIP_DURATION) room.state.playback.playing = false;
        broadcast(room, { type: 'playback', playback: room.state.playback, serverTime: now() }); return;
      }
      case 'touch-response': {
        const request = room.requests.get(msg.requestId);
        if (!request || request.to !== peer.id) { fail(peer, 'TOUCH_UNAVAILABLE', '触碰请求已失效或不属于你'); return; }
        room.requests.delete(request.id);
        const from = room.peers.find(p => p.id === request.from);
        if (!msg.accepted || request.expiresAt < now() || !from || !eligible(room) || distance(from, peer) > TOUCH_DISTANCE + 0.10) {
          broadcast(room, { type: 'touch-cancelled', requestId: request.id, reason: msg.accepted ? '请求已过期、追踪失效或双方已分开' : '接收方拒绝了这次触碰' }); return;
        }
        const event: TouchEvent = { id: request.id, from: from.id, to: peer.id, hand: request.hand, intensity: 0.2, durationMs: 100, serverTime: now() };
        room.delivered.set(event.id, { event, expiresAt: now() + 5000 });
        send(peer, { type: 'touch', event }); return;
      }
      case 'haptic-result': {
        const delivery = room.delivered.get(msg.eventId);
        if (!delivery || delivery.event.to !== peer.id || delivery.expiresAt < now()) { fail(peer, 'EVENT_UNAVAILABLE', '没有可匹配的触碰执行事件'); return; }
        room.delivered.delete(msg.eventId);
        broadcast(room, { type: 'haptic-result', peerId: peer.id, eventId: msg.eventId, mode: msg.mode, ok: msg.ok }); return;
      }
    }
  }
  function headers(res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  }
  function json(res: ServerResponse, status: number, value: unknown) { headers(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  function validOrigin(req: IncomingMessage, allowMissing: boolean) {
    const origin = req.headers.origin;
    if (!origin) return allowMissing;
    try {
      const parsed = new URL(origin);
      return ['http:', 'https:'].includes(parsed.protocol) && (parsed.host === req.headers.host || (options.allowedOrigins ?? process.env.ALLOWED_ORIGINS?.split(',') ?? []).includes(origin));
    } catch { return false; }
  }
  async function file(req: IncomingMessage, res: ServerResponse, path: string) {
    try {
      const info = await stat(path);
      if (!info.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      headers(res);
      const mime = TYPES[extname(path)] ?? 'application/octet-stream';
      let start = 0, end = info.size - 1;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2]) || info.size === 0) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
        const first = Number(match[1]), last = Number(match[2]);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
        if (!match[1]) {
          if (last === 0) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
          start = Math.max(0, info.size - last);
        } else { start = first; end = match[2] ? Math.min(last, info.size - 1) : end; }
        if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
        res.writeHead(206, { 'Content-Type': mime, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Accept-Ranges': 'bytes' });
      } else res.writeHead(200, { 'Content-Type': mime, 'Content-Length': info.size, 'Accept-Ranges': 'bytes' });
      if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
      const stream = createReadStream(path, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404); res.end('Not found'); }
  }
  const server = createServer(async (req, res) => {
    try {
      const rawPath = (req.url ?? '/').split('?')[0];
      let path: string;
      try { path = decodeURIComponent(rawPath); } catch { json(res, 400, { error: 'Invalid path' }); return; }
      if (path.includes('\\') || path.includes('\0') || path.split('/').some(p => p === '..' || p === '.')) { json(res, 404, { error: 'Not found' }); return; }
      if (path === '/api/spaces' || path.startsWith('/api/spaces/')) {
        if (!validOrigin(req, true)) { json(res, 403, { code: 'ORIGIN_NOT_ALLOWED', error: 'Origin not allowed' }); req.resume(); return; }
        headers(res);
        await assets.handle(req, res, path);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'Method not allowed' }); req.resume(); return; }
      if (path === '/api/health') { json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, mode: 'research-prototype' }); return; }
      if (path === '/api/config') {
        // Prototype config is delivered to every browser client. Use short-lived,
        // restricted TURN credentials, never an administrative secret.
        const urls = process.env.TURN_URL?.split(',').map(s => s.trim()).filter(s => /^turns?:/.test(s));
        const iceServers = urls?.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL ? [{ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }] : [];
        json(res, 200, { iceServers, protocol: PROTOCOL_VERSION, maxParticipants: 2, maxSpaceBytes: MAX_SPACE_BYTES }); return;
      }
      if (path.startsWith('/api/')) { json(res, 404, { error: 'Not found' }); return; }
      if (path === '/research' || path === '/research/') { await file(req, res, join(root, 'index.html')); return; }
      if (path.startsWith('/research/')) {
        const relative = path.slice('/research/'.length);
        const allowed = ['index.html', 'rove-overview.html', 'pieeg-feasibility.html', 'pieeg-supplement.html', 'rove_scenario_4steps.png'].includes(relative) || /^papers\/[A-Za-z0-9_.-]+\.pdf$/.test(relative);
        if (!allowed) { json(res, 404, { error: 'Not found' }); return; }
        await file(req, res, join(root, relative)); return;
      }
      if (!production && vite) { headers(res); vite.middlewares(req, res, () => { res.writeHead(404); res.end('Not found'); }); return; }
      const base = resolve(root, 'dist');
      const target = resolve(base, '.' + (path === '/' ? '/index.html' : path));
      if (!target.startsWith(base + sep)) { json(res, 404, { error: 'Not found' }); return; }
      await file(req, res, target);
    } catch { if (!res.headersSent) json(res, 500, { error: 'Request failed' }); else res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/ws') {
      if (production) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); }
      return; // Vite handles its own HMR upgrade during development.
    }
    const allowed = validOrigin(req, options.allowMissingOrigin === true);
    if (!allowed || peers.size >= MAX_CONNECTIONS) { socket.write(`HTTP/1.1 ${allowed ? '503 Service Unavailable' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    const peer: Peer = { id: randomUUID(), sessionToken: randomBytes(32).toString('hex'), ws, frameAt: 0, lastSeq: -1, lastSeen: now(), rateAt: now(), rateCount: 0, poseRateAt: now(), poseCount: 0, alive: true, heartbeatAt: now() };
    peers.set(peer.id, peer);
    tokens.set(peer.sessionToken, peer);
    send(peer, { type: 'welcome', peerId: peer.id, protocol: PROTOCOL_VERSION, sessionToken: peer.sessionToken });
    ws.on('pong', () => { peer.alive = true; });
    ws.on('message', (data, binary) => {
      if (now() - peer.rateAt >= 1000) { peer.rateAt = now(); peer.rateCount = 0; }
      if (++peer.rateCount > 120) { ws.close(1008, 'Rate limit'); return; }
      peer.lastSeen = now();
      if (binary) { fail(peer, 'INVALID_MESSAGE', '仅接受 JSON 文本消息'); return; }
      let raw: unknown;
      try { raw = JSON.parse(data.toString()); } catch { fail(peer, 'INVALID_MESSAGE', '消息不是有效 JSON'); return; }
      const msg = parseClientMessage(raw);
      if (!msg) { fail(peer, 'INVALID_MESSAGE', '消息结构或参数不正确'); return; }
      handle(peer, msg);
    });
    ws.on('error', () => { /* close owns cleanup; never log personal payloads */ });
    ws.on('close', () => { leave(peer, '对方已断开连接'); peers.delete(peer.id); tokens.delete(peer.sessionToken); assets.forget(peer.id); });
  });
  if (!production) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({ configFile: join(root, 'vite.config.ts'), server: { middlewareMode: { server }, hmr: { server } } });
  }
  function maintenance() {
    for (const room of rooms.values()) {
      if (now() - room.createdAt > SESSION_MS) { const host = room.peers.find(p => p.member?.role === 'host'); if (host) leave(host, '会话达到两小时上限'); continue; }
      if (room.state.spaceProposal && room.state.spaceProposal.expiresAt <= now()) { room.state.spaceProposal = null; state(room); }
      for (const [id, req] of room.requests) if (req.expiresAt < now()) { room.requests.delete(id); broadcast(room, { type: 'touch-cancelled', requestId: id, reason: '触碰请求已过期' }); }
      for (const [id, delivery] of room.delivered) if (delivery.expiresAt < now()) room.delivered.delete(id);
      if (room.requests.size && !eligible(room)) cancelRequests(room, '追踪暂时丢失，请重新靠近');
      if (room.state.playback.playing && playbackPosition(room.state.playback, now()) >= CLIP_DURATION) {
        room.state.playback = { playing: false, position: CLIP_DURATION, updatedAt: now(), revision: room.state.playback.revision + 1 };
        broadcast(room, { type: 'playback', playback: room.state.playback, serverTime: now() });
      }
    }
    for (const peer of peers.values()) {
      if (now() - peer.lastSeen > IDLE_MS) { peer.ws.close(1001, 'Idle timeout'); continue; }
      if (now() - peer.heartbeatAt >= 15_000) {
        if (!peer.alive) { peer.ws.terminate(); continue; }
        peer.alive = false; peer.heartbeatAt = now();
        if (peer.ws.readyState === WebSocket.OPEN) peer.ws.ping();
      }
    }
  }
  return {
    server, wss,
    async start() {
      const host = options.host ?? process.env.HOST ?? '127.0.0.1';
      const port = options.port ?? Number(process.env.PORT ?? 5173);
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(port, host, () => { server.off('error', no); yes(); }); });
      timer = setInterval(maintenance, options.maintenanceMs ?? 250);
      timer.unref();
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return { host, port: actualPort, url: `http://${host}:${actualPort}` };
    },
    async close() {
      if (closing) return;
      closing = true;
      if (timer) clearInterval(timer);
      for (const peer of peers.values()) { leave(peer, '服务器关闭'); peer.ws.terminate(); }
      await new Promise<void>(done => wss.close(() => done()));
      await vite?.close();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createRoveServer({ production: process.argv.includes('--production') ? true : undefined });
  const address = await app.start();
  console.log(`Rove prototype: ${address.url}`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
