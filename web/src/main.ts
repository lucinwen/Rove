import './style.css';
import { RoveScene } from './scene.ts';
import { MediaLink } from './media.ts';
import { HapticOutput } from './haptics.ts';
import { CLIP_DURATION, POSE_STALE_MS, playbackPosition, type ClientMessage, type Playback, type RoomPreset, type RoomState, type ServerMessage, type TouchRequest } from '../../shared/protocol.ts';

const icons = {
  home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2m-6 8v3m-3 0h6"/>',
  video: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-4v12l-6-4"/>',
  hand: '<path d="M8 12V5a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 4-3 6-7 6-3 0-5-2-6-4l-4-5a2 2 0 0 1 3-2l2 2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  center: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="3"/>',
  xr: '<path d="M4 7h16l2 10-3 2-7-3-7 3-3-2Z"/><circle cx="7.5" cy="12" r="1.5"/><circle cx="16.5" cy="12" r="1.5"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  users: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m3 11v-3a6 6 0 0 0-2-4"/>',
};
const icon = (name: keyof typeof icons) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<div class="shell">
  <header class="topbar">
    <a class="brand" href="/" aria-label="Rove 如晤首页"><span class="brand-symbol">r</span><span class="brand-name">Rove<small>如晤</small></span></a>
    <span class="beta">LAB 0.1</span>
    <nav class="nav" aria-label="主导航"><a href="#" class="active">共同在场</a><a href="/research/rove-overview.html" target="_blank" rel="noopener">研究与愿景 ↗</a></nav>
    <div class="top-status" role="status"><span id="serverDot" class="dot"></span><span id="serverStatus">正在连接服务</span><span class="latency" id="headerLatency">— ms</span><span class="avatar-mini">如</span></div>
  </header>
  <section class="page-heading">
    <div><div class="eyebrow">A little closer, even from afar</div><h1 id="pageTitle">留一个位置，给想见的人。</h1><p>邀请一个人，一起看、一同说，让距离变得具体一点。</p></div>
    <div class="session-count"><div class="overlap"><span>A</span><span>B</span></div><span id="countLabel">两个人 · 同一个空间</span></div>
  </section>
  <div id="notice" class="notice" role="alert" hidden></div>
  <main class="main-grid">
    <div>
      <section class="stage-card" aria-label="共享三维房间">
        <div class="stage-top"><span class="stage-room-icon">${icon('home')}</span><div><div class="stage-title" id="roomTitle">珊瑚客厅</div><div class="stage-meta" id="roomSubtitle">选好主场 · 等一个人来</div></div><span class="stage-type">程序化样例房间</span></div>
        <div class="stage">
          <div id="scene"></div>
          <div class="stage-hint"><span class="soft-pill"><i class="dot" id="spaceDot"></i><span id="spaceStatus">本地预览</span></span><span class="soft-pill" id="trackingLabel">桌面手动输入</span></div>
          <div class="stage-overlay" id="stageOverlay"><strong>一个共同的位置。</strong><br>创建房间后，把邀请链接交给对方；对方接受后才会出现在这里。</div>
          <div class="stage-note">样例空间与简化化身 · 不是房间扫描</div>
          <div class="room-legend"><span><i></i>主场</span><span><i class="sage"></i>来访</span></div>
        </div>
        <div class="toolbar" aria-label="空间操作">
          <button class="tool" id="approach" disabled>${icon('users')}靠近对方</button>
          <button class="tool" id="extend" aria-pressed="false" disabled>${icon('hand')}伸出右手</button>
          <div class="move-control" aria-label="桌面位置微调"><button data-move="0,-0.18" aria-label="向前移动" disabled>↑</button><button data-move="-0.18,0" aria-label="向左移动" disabled>←</button><button data-move="0.18,0" aria-label="向右移动" disabled>→</button><button data-move="0,0.18" aria-label="向后移动" disabled>↓</button></div>
          <span class="spacer"></span><button class="subtle-button" id="recenter">${icon('center')}回到座位</button><button class="tool xr-tool" id="xr" disabled>${icon('xr')}VR</button><button class="tool xr-tool" id="ar" disabled>AR</button>
        </div>
      </section>
      <p class="keyboard-note">点击空间后：<kbd>W A S D</kbd> 移动 · <kbd>Q E</kbd> 转身 · <kbd>空格</kbd> 伸手 · 拖动画面改变观察视角。切到后台时暂停追踪。</p>
      <div class="bottom-grid">
        <section class="activity-card" aria-label="一起观看">
          <div class="activity-head"><h3>一起看，看到同一刻</h3><span id="playbackSync">等待建立会话</span></div>
          <div class="player-content"><video class="clip-video" id="clip" src="/media/rove-sync.webm" preload="auto" playsinline muted aria-label="24 秒共享同步测试片"></video><div class="player-info"><div class="player-title">相会的节拍 · 同步测试片</div><div class="player-caption">24 秒本地样片，只交换播放时钟</div><div class="player-controls"><button id="play" aria-label="一起播放" disabled>${icon('play')}</button><input id="seek" type="range" min="0" max="24" step="0.1" value="0" aria-label="共享播放进度" disabled /><span class="timecode" id="timecode">00 / 24s</span></div></div></div>
        </section>
        <section class="activity-card media-card" aria-label="音视频通话">
          <div class="activity-head"><h3>听见你的声音</h3><span>默认关闭设备</span></div>
          <div class="video-people"><div class="video-box"><video id="localVideo" autoplay muted playsinline aria-label="自己的摄像头"></video><span class="video-caption">你</span></div><div class="video-box"><video id="remoteVideo" autoplay playsinline controls aria-label="对方的摄像头与声音"></video><span class="video-caption">对方</span></div></div>
          <div class="media-buttons"><button class="tool" id="mic" disabled>${icon('mic')}仅语音</button><button class="tool" id="camera" disabled>${icon('video')}开音视频</button><button class="tool" id="mediaOff" disabled>关闭设备</button></div><p class="media-status" id="mediaStatus">对方进入后，可自行选择语音或音视频。</p>
        </section>
      </div>
    </div>
    <aside class="side">
      <section class="card" id="lobby">
        <div class="card-label">01 / 邀请相会</div><h2>今天，来我这里坐坐。</h2><p>选一间样例客厅，给对方留个位置。<br>只有接受邀请的人会进入空间。</p>
        <label class="field-label" for="name">怎么称呼你</label><input id="name" type="text" maxlength="24" placeholder="写一个昵称" value="我" autocomplete="off" />
        <label class="field-label">今天的主场</label><div class="preset-picker"><button class="preset selected" data-preset="rose" aria-pressed="true"><span></span>珊瑚客厅</button><button class="preset" data-preset="sage" aria-pressed="false"><span></span>青苔客厅</button></div>
        <button class="primary" id="create" disabled>创建双人房间 ${icon('arrow')}</button>
        <div class="divider">收到对方的邀请了？</div>
        <label class="field-label" for="roomCode">邀请链接或房间码</label><div class="join-row"><input id="roomCode" type="text" maxlength="512" placeholder="粘贴邀请链接或房间码" autocomplete="off" /><button class="secondary" id="inspect" disabled>查看</button></div>
        <div class="join-preview" id="joinPreview" hidden><p id="previewText"></p><label class="check-row"><input id="joinConsent" type="checkbox"/><span>我同意进入这个共享空间；音视频与触碰需要另行开启。</span></label><button class="primary" id="join" disabled>接受邀请，进入房间</button><button class="subtle-button" id="decline">暂不进入</button></div>
        <button class="secondary small-gap" id="reconnect" hidden>重新连接服务</button>
      </section>
      <section class="card" id="session" hidden><div class="card-label">01 / 这一场相会</div><h2 id="sessionTitle">位置已留好。</h2><p id="sessionDescription">复制链接，交给想见的人。</p><div class="participants" id="participants"></div><label class="field-label" for="inviteLink">专属邀请链接</label><div class="invite"><input id="inviteLink" type="text" readonly aria-label="专属邀请链接"/><button class="icon-btn" id="copyInvite" aria-label="复制邀请链接">${icon('copy')}</button></div><p class="tiny">链接是进入凭据，请只发给要见的人。<br>离开主场后，这场会话会结束。</p><button class="exit" id="leave">离开这场相会</button></section>
      <section class="card touch-card" id="touchCard"><div class="card-title-row"><h3>02 / 留给触碰的选择</h3><span class="mode-label" id="outputMode">视觉模拟</span></div><p>双方先开启请求，再由接收者逐次确认。你随时可以收回这个选择。</p><label class="check-row"><input id="consent" type="checkbox" disabled/><span><strong>允许对方向我提出触碰请求</strong><br>只在双手接近、追踪有效时触发。</span></label><details><summary class="tiny">可选：本机手柄振动</summary><label class="check-row"><input id="gamepad" type="checkbox"/><span>使用已连接、支持振动的游戏手柄。未接硬件时仍显示视觉回应。</span></label></details><div class="touch-state" id="touchState">尚未加入会话</div><div class="touch-request" id="touchRequest" hidden><div id="touchRequestText"></div><div class="actions"><button class="primary" id="acceptTouch">接受这一次</button><button class="secondary" id="rejectTouch">暂不接受</button></div></div><div class="stop-row"><button class="danger" id="stop" disabled>${icon('stop')}立即停止</button><button class="secondary" id="resume" hidden>解除暂停</button></div></section>
      <p class="tiny" style="padding:0 6px;line-height:1.8">这是 Rove 的开发原型。当前可验证联网与互动流程；真实空间扫描、真人重建和触觉腕带尚未接入。</p>
    </aside>
  </main>
  <details class="diagnostics"><summary>连接与实验记录 <span class="summary-right">真实测量 · 不录制音视频</span></summary><div class="metrics"><div class="metric"><strong id="rtt">—</strong><span>客户端↔服务端往返 / ms</span></div><div class="metric"><strong id="poseCount">0</strong><span>收到的真实远端姿态包</span></div><div class="metric"><strong id="drift">—</strong><span>本地视频与共享时钟偏差 / ms</span></div><div class="metric"><strong id="touchCount">0</strong><span>已确认的视觉或手柄回应</span></div></div><div class="diagnostic-actions"><span>往返时延不等于动作或触觉端到端延迟。记录仅保存在本页，导出不包含音视频、房间码或姿态坐标。</span><button class="tool" id="export">${icon('download')}导出本次诊断</button></div><pre class="log" id="log" aria-label="技术事件记录">等待会话事件…</pre></details>
  <footer class="footer"><span>Rove 如晤 · 把相会从想象，慢慢变成日常。</span><span>桌面联调 v0.1 · <a href="/research/" target="_blank" rel="noopener">保留的研究资料 ↗</a></span></footer>
</div><div class="toast" id="toast" role="status" hidden></div>`;

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const text = (id: string, value: string) => { el(id).textContent = value; };
const button = (id: string) => el<HTMLButtonElement>(id);
const input = (id: string) => el<HTMLInputElement>(id);
const clip = el<HTMLVideoElement>('clip');
let scene: RoveScene | undefined;
try { scene = new RoveScene(el('scene')); scene.setVideo(clip); }
catch (error) { const p = document.createElement('p'); p.className = 'fallback'; p.textContent = error instanceof Error ? error.message : '三维画面暂时不可用。'; el('scene').append(p); }

let socket: WebSocket | undefined;
let selfId = '';
let room: RoomState | null = null;
let otherId: string | null = null;
let preset: RoomPreset = 'rose';
let previewId = '';
let previewAvailable = false;
let extended = false;
let xrActive = false;
let pendingTouch: TouchRequest | null = null;
let serverOffset = 0;
let bestRtt = Infinity;
let latestRtt: number | null = null;
let remoteReceivedAt = 0;
let remoteTracked = false;
let receivedPoses = 0;
let sentPoses = 0;
let touchCount = 0;
let drift = 0;
let mediaBusy = false;
let mediaAttempt = 0;
let localTouchAllowed = false;
let localStopLatched = false;
let resumePending = false;
let lastPongAt = 0;
let pendingPreviewId = '';
let offsetReady = false;
let iceServers: RTCIceServer[] = [];
let disposed = false;
const events: { at: string; event: string; detail: string }[] = [];
const pings = new Map<number, number>();
const clock = () => Date.now() + serverOffset;
const log = (event: string, detail = '') => {
  events.push({ at: new Date().toISOString(), event, detail });
  if (events.length > 160) events.shift();
  text('log', events.slice(-12).map(e => `${e.at.slice(11, 19)}  ${e.event}  ${e.detail}`).join('\n'));
};
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) { text('toast', message); el('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el('toast').hidden = true; }, 4500); }
function notice(message: string, error = false) { text('notice', message); el('notice').classList.toggle('error', error); el('notice').hidden = !message; }
function send(message: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > 64 * 1024) {
    if (message.type === 'pose') return false;
    failClosed('网络发送阻塞，请重新连接后再加入。'); socket.close(); return false;
  }
  socket.send(JSON.stringify(message)); return true;
}

const media = new MediaLink(el('localVideo'), el('remoteVideo'), signal => { if (room && otherId && !room.stopped && !localStopLatched) send({ type: 'signal', signal }); }, message => { text('mediaStatus', message); });
const haptics = new HapticOutput(() => {
  scene?.pulseLocal();
  el('touchCard').classList.remove('pulse'); void el('touchCard').offsetWidth; el('touchCard').classList.add('pulse');
});

function updateButtons() {
  const live = socket?.readyState === WebSocket.OPEN;
  const active = !!room && !room.stopped && !localStopLatched;
  for (const id of ['create', 'inspect']) button(id).disabled = !live || !!room;
  button('join').disabled = !live || !!room || !previewAvailable || !input('joinConsent').checked;
  for (const id of ['approach', 'extend', 'xr', 'ar']) button(id).disabled = !active || !scene;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-move]')) b.disabled = !active || !scene;
  for (const id of ['play']) button(id).disabled = !active;
  input('seek').disabled = !active;
  input('consent').disabled = !active || !otherId;
  button('stop').disabled = !active;
  button('resume').hidden = !room?.stopped;
  for (const id of ['mic', 'camera']) button(id).disabled = !active || !otherId || mediaBusy;
  button('mediaOff').disabled = !room;
}
function setExtended(value: boolean) {
  extended = value; scene?.extendHand(value); button('extend').setAttribute('aria-pressed', String(value)); button('extend').classList.toggle('pressed', value);
  button('extend').innerHTML = `${icon('hand')}${value ? '收回右手' : '伸出右手'}`;
}
function clearTouch() { pendingTouch = null; el('touchRequest').hidden = true; }
function stopLocally() {
  localStopLatched = true; localTouchAllowed = false; resumePending = false;
  clearTouch(); haptics.stop(); scene?.clearPulses(); input('gamepad').checked = false; haptics.setGamepadEnabled(false); text('outputMode', '视觉模拟');
  scene?.setInputEnabled(false); setExtended(false); mediaAttempt++; mediaBusy = false;
  media.configure(selfId, null, room?.members.find(m => m.id === selfId)?.role ?? 'host', iceServers);
  clip.pause(); updateButtons();
}
function setPreset(value: RoomPreset) {
  preset = value; scene?.setPreset(value); text('roomTitle', value === 'rose' ? '珊瑚客厅' : '青苔客厅');
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(b => { const selected = b.dataset.preset === value; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', String(selected)); });
}
function renderRoom(next: RoomState, joined = false) {
  const wasStopped = room?.stopped ?? false;
  const previousOther = otherId;
  room = next;
  otherId = next.members.find(m => m.id !== selfId)?.id ?? null;
  const me = next.members.find(m => m.id === selfId);
  if (!me) { failClosed('会话成员信息无效，请重新加入。'); return; }
  setPreset(next.preset);
  if (joined) { scene?.setRole(me.role); setExtended(false); clearTouch(); localStopLatched = next.stopped; localTouchAllowed = false; resumePending = false; }
  if ((resumePending || wasStopped) && !next.stopped) { localStopLatched = false; resumePending = false; }
  if (previousOther !== otherId) { scene?.setRemotePose(null); remoteTracked = false; remoteReceivedAt = 0; clearTouch(); haptics.stop(); scene?.clearPulses(); localTouchAllowed = false; mediaAttempt++; mediaBusy = false; }
  scene?.setConnected(true); scene?.setRemoteVisible(!!otherId); scene?.setInputEnabled(!next.stopped && !localStopLatched);
  media.configure(selfId, next.stopped || localStopLatched ? null : otherId, me.role, iceServers);
  if (next.stopped) {
    stopLocally();
    if (!wasStopped) { log('会话停止'); toast('空间、播放和本机设备已停止。恢复后需要重新开启设备与触碰请求。'); }
  }
  if (!next.touchEnabled) { clearTouch(); haptics.stop(); scene?.clearPulses(); }
  input('consent').checked = me.consent && localTouchAllowed;
  el('lobby').hidden = true; el('session').hidden = false; el('stageOverlay').hidden = !!otherId && !next.stopped;
  if (next.stopped) text('stageOverlay', '会话已暂停。位置更新和触碰已停止；解除暂停后，各自重新选择权限。');
  else if (!otherId) text('stageOverlay', '你的位子已经留好。把邀请链接交给对方，对方接受后才会出现在这里。');
  text('spaceStatus', next.stopped ? '会话已暂停' : otherId ? '双人已连接' : '等待对方进入');
  el('spaceDot').classList.toggle('online', !!otherId && !next.stopped);
  text('roomSubtitle', `${me.role === 'host' ? '你是主场' : '你是来访者'} · 共享原点 · 米制坐标`);
  text('pageTitle', otherId ? '相隔两地，也在同一刻。' : '留一个位置，给想见的人。');
  text('sessionTitle', otherId ? '这一刻，一起在。' : '位置已留好。');
  text('sessionDescription', otherId ? '共享房间已连接，设备由各自决定。' : '复制链接，交给想见的人。');
  text('countLabel', `${next.members.length} / 2 人已进入 · ${next.preset === 'rose' ? '珊瑚' : '青苔'}主场`);
  text('touchState', next.stopped ? '已停止，旧授权已清空' : next.touchEnabled ? '双方已允许请求 · 靠近并伸手可发起' : me.consent ? '你已允许 · 等待对方选择' : '触碰请求关闭');
  const participants = el('participants'); participants.replaceChildren();
  for (const member of next.members) {
    const row = document.createElement('div'); row.className = 'person';
    const avatar = document.createElement('span'); avatar.className = `person-icon ${member.role === 'guest' ? 'guest' : ''}`; avatar.textContent = member.name.slice(0, 1);
    const info = document.createElement('div'); const name = document.createElement('div'); name.className = 'person-name'; name.textContent = `${member.name}${member.id === selfId ? ' · 你' : ''}`;
    const meta = document.createElement('div'); meta.className = 'person-meta'; meta.textContent = `${member.role === 'host' ? '主场' : '来访'} · ${member.consent ? '允许触碰请求' : '触碰请求关闭'}`;
    info.append(name, meta); const status = document.createElement('span'); status.className = 'person-right'; status.textContent = '已进入'; row.append(avatar, info, status); participants.append(row);
  }
  const invite = new URL(location.href); invite.search = ''; invite.hash = `room=${next.id}`; input('inviteLink').value = invite.href;
  if (joined) history.replaceState(null, '', `${location.pathname}#room=${next.id}`);
  updateButtons(); syncPlayback(true);
}
function endSession(reason: string) {
  stopLocally();
  pendingPreviewId = '';
  room = null; otherId = null; previewAvailable = false; input('consent').checked = false; clearTouch(); haptics.stop(); setExtended(false);
  scene?.setInputEnabled(false); scene?.setConnected(false); scene?.setRemotePose(null);
  media.configure(selfId, null, 'host', iceServers); clip.pause(); xrActive = false; void scene?.endXR().catch(() => {});
  button('xr').textContent = 'VR'; input('seek').value = '0'; text('timecode', '00 / 24s');
  el('lobby').hidden = false; el('session').hidden = true; el('joinPreview').hidden = true; el('stageOverlay').hidden = false;
  text('stageOverlay', reason); text('spaceStatus', '本地预览'); el('spaceDot').classList.remove('online'); text('touchState', '尚未加入会话'); text('countLabel', '两个人 · 同一个空间'); text('roomSubtitle', '选好主场 · 等一个人来'); text('playbackSync', '等待建立会话');
  history.replaceState(null, '', location.pathname); updateButtons();
}
function failClosed(reason: string) { endSession(reason); notice(reason, true); log('连接停止', reason); }
function receive(message: ServerMessage) {
  switch (message.type) {
    case 'welcome': selfId = message.peerId; log('服务已连接', `协议 ${message.protocol}`); updateButtons(); break;
    case 'preview': if (message.roomId !== pendingPreviewId || room) break; previewId = message.roomId; previewAvailable = message.available; input('joinConsent').checked = false; el('joinPreview').hidden = false; text('previewText', `${message.preset === 'rose' ? '珊瑚客厅' : '青苔客厅'} · ${message.available ? '有一个位置留给你' : '当前房间已满'}`); setPreset(message.preset); updateButtons(); break;
    case 'joined': selfId = message.selfId; if (!offsetReady) serverOffset = message.serverTime - Date.now(); renderRoom(message.state, true); notice(''); log('进入房间', `${message.state.members.find(m => m.id === selfId)?.role} / ${message.state.preset}`); break;
    case 'state': if (room?.id === message.state.id) renderRoom(message.state); break;
    case 'pose': if (!room || message.peerId !== otherId || room.stopped || localStopLatched) break; receivedPoses++; remoteReceivedAt = performance.now(); remoteTracked = message.pose.tracked; scene?.setRemotePose(message.pose); text('poseCount', String(receivedPoses)); break;
    case 'signal': if (room && !room.stopped && !localStopLatched && message.peerId === otherId) void media.receiveSignal(message.signal).catch(() => { log('媒体协商失败'); text('mediaStatus', '协商未完成，可关闭设备后重试。'); }); break;
    case 'playback': if (room && message.playback.revision >= room.playback.revision) { room.playback = message.playback; syncPlayback(true); log('共享播放', `${message.playback.playing ? '播放' : '暂停'} @ ${message.playback.position.toFixed(1)}s`); } break;
    case 'pong': {
      const began = pings.get(message.sentAt); if (began === undefined) break; pings.delete(message.sentAt);
      const rtt = performance.now() - began; latestRtt = rtt; lastPongAt = performance.now();
      if (rtt < bestRtt || !offsetReady) { bestRtt = rtt; serverOffset = message.serverTime + rtt / 2 - Date.now(); offsetReady = true; }
      text('rtt', rtt.toFixed(0)); text('headerLatency', `${rtt.toFixed(0)} ms`); break;
    }
    case 'touch-request':
      if (!room?.touchEnabled || room.stopped || localStopLatched || !localTouchAllowed || message.request.to !== selfId || message.request.from !== otherId) break;
      pendingTouch = message.request; el('touchRequest').hidden = false; text('touchRequestText', '对方的右手接近了你。接受这一次轻触回应吗？'); log('收到逐次触碰请求'); break;
    case 'touch-cancelled': if (pendingTouch?.id === message.requestId) { clearTouch(); text('touchState', message.reason); log('触碰未执行', message.reason); } break;
    case 'touch': {
      const e = message.event;
      if (!room?.touchEnabled || room.stopped || localStopLatched || !localTouchAllowed || !scene?.getLocalPose().tracked || !remoteTracked || performance.now() - remoteReceivedAt >= POSE_STALE_MS || e.to !== selfId || e.from !== otherId || Math.abs(clock() - e.serverTime) > 2000) { log('丢弃过期或未授权触碰'); break; }
      clearTouch();
      const sessionId = room.id;
      void haptics.play(e).then(result => {
        if (room?.id !== sessionId || !room.touchEnabled || room.stopped || localStopLatched || !localTouchAllowed) return;
        send({ type: 'haptic-result', eventId: e.id, ...result });
        touchCount += Number(result.ok); text('touchCount', String(touchCount)); text('outputMode', result.mode === 'gamepad' ? '手柄振动' : '视觉模拟');
        text('touchState', result.ok ? (result.mode === 'gamepad' ? '已执行一次手柄振动' : '已显示一次视觉回应 · 未输出实体触觉') : '本次输出未完成'); log('触碰输出', `${result.mode} / ${result.ok ? '完成' : '未完成'}`);
      }); break;
    }
    case 'haptic-result': if (message.peerId === otherId && room && !room.stopped && !localStopLatched) { if (message.ok) scene?.pulseRemote(); log('对端输出回执', `${message.mode} / ${message.ok ? '完成' : '未完成'}`); toast(!message.ok ? '对方的这次回应未完成。' : message.mode === 'visual' ? '对方确认后，已看见一次视觉回应。' : '对方报告已完成一次手柄振动。'); } break;
    case 'ended': endSession(message.reason); toast(message.reason); log('会话结束', message.reason); break;
    case 'error': if (message.code === 'STALE_SEQUENCE' || message.code === 'POSE_RATE_LIMIT') { log(message.code); } else { toast(message.message); log('服务提示', message.code); } break;
  }
}
function connect() {
  if (disposed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  text('serverStatus', '正在连接服务'); button('reconnect').hidden = true; bestRtt = Infinity; offsetReady = false; pings.clear();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); socket = ws;
  ws.onopen = () => { if (socket !== ws) return; lastPongAt = performance.now(); el('serverDot').classList.add('online'); text('serverStatus', '服务已连接'); notice(''); updateButtons(); ping(); };
  ws.onmessage = ({ data }) => { if (socket !== ws || typeof data !== 'string') return; try { receive(JSON.parse(data) as ServerMessage); } catch (error) { log('消息处理异常', error instanceof Error ? error.message.slice(0, 100) : '未知错误'); } };
  ws.onerror = () => { text('serverStatus', '连接不可用'); };
  ws.onclose = () => { if (socket !== ws) return; el('serverDot').classList.remove('online'); text('serverStatus', '服务未连接'); text('headerLatency', '— ms'); text('rtt', '—'); latestRtt = null; pings.clear(); failClosed('连接已断开，设备和触碰已停止。重连后，请重新创建房间或接受邀请。'); button('reconnect').hidden = false; };
}
function ping() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (performance.now() - lastPongAt > 10_000) { failClosed('服务连续 10 秒未回应，已停止设备与触碰，请重新连接。'); socket.close(); return; }
  const sentAt = Date.now(); pings.set(sentAt, performance.now()); send({ type: 'ping', sentAt });
  for (const [id, time] of pings) if (performance.now() - time > 10_000) pings.delete(id);
}

let playAttempt = false;
let playbackBlocked = false;
function syncPlayback(force = false) {
  if (!room || clip.readyState < 1) return;
  const target = playbackPosition(room.playback, clock());
  drift = (clip.currentTime - target) * 1000;
  text('drift', Math.round(Math.abs(drift)).toString());
  if ((force || Math.abs(drift) > 250) && Number.isFinite(clip.duration)) clip.currentTime = Math.min(target, clip.duration - 0.01);
  if (room.playback.playing && !room.stopped && !localStopLatched && target < CLIP_DURATION - 0.03) {
    if (clip.paused && !playAttempt && !playbackBlocked) { playAttempt = true; void clip.play().catch(() => { playbackBlocked = true; }).finally(() => { playAttempt = false; }); }
  } else clip.pause();
  button('play').innerHTML = icon(room.playback.playing && target < CLIP_DURATION ? 'pause' : 'play');
  button('play').setAttribute('aria-label', room.playback.playing && target < CLIP_DURATION ? '一起暂停' : '一起播放');
  if (document.activeElement !== input('seek')) input('seek').value = String(target);
  text('timecode', `${String(Math.floor(target)).padStart(2, '0')} / 24s`);
  text('playbackSync', room.stopped || localStopLatched ? '已暂停' : playbackBlocked ? '点播放按钮允许本机播放' : Math.abs(drift) < 250 ? '共享时钟已跟随' : '正在对齐共享时钟');
}
function roomCode(raw: string): string | null {
  const s = raw.trim(); if (/^[a-f0-9]{32}$/.test(s)) return s;
  try { const url = new URL(s); const id = new URLSearchParams(url.hash.slice(1)).get('room'); return id && /^[a-f0-9]{32}$/.test(id) ? id : null; } catch { return null; }
}
function myName(): string | null { const name = input('name').value.trim(); if (!name || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) { toast('先写一个 1–24 字的昵称。'); input('name').focus(); return null; } return name; }
function inspectRoom() { const id = roomCode(input('roomCode').value); if (!id) { toast('邀请需要完整链接，或 32 位房间码。'); return; } pendingPreviewId = id; send({ type: 'inspect', roomId: id }); }
button('create').onclick = () => { const name = myName(); if (name) send({ type: 'create', name, preset }); };
button('inspect').onclick = inspectRoom;
input('roomCode').addEventListener('keydown', e => { if (e.key === 'Enter') inspectRoom(); });
input('roomCode').addEventListener('input', () => { pendingPreviewId = ''; previewAvailable = false; el('joinPreview').hidden = true; updateButtons(); });
input('joinConsent').onchange = updateButtons;
button('join').onclick = () => { const name = myName(); if (name && input('joinConsent').checked && previewAvailable) send({ type: 'join', roomId: previewId, name }); };
button('decline').onclick = () => { pendingPreviewId = ''; previewAvailable = false; input('joinConsent').checked = false; el('joinPreview').hidden = true; updateButtons(); toast('你没有进入这场会话。'); };
button('reconnect').onclick = connect;
button('leave').onclick = () => { send({ type: 'leave' }); endSession('已离开。你可以开始一场新的相会。'); log('主动离开'); };
button('copyInvite').onclick = async () => { try { await navigator.clipboard.writeText(input('inviteLink').value); toast('邀请链接已复制。'); } catch { input('inviteLink').focus(); input('inviteLink').select(); toast('已选中链接，请按 Ctrl+C 复制。'); } };
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(b => b.onclick = () => setPreset(b.dataset.preset as RoomPreset));
button('approach').onclick = () => { setExtended(false); scene?.approach(); toast('已到桌面靠近位置。双方都靠近并伸手后，接收者可确认一次回应。'); };
button('extend').onclick = () => setExtended(!extended);
button('recenter').onclick = () => { setExtended(false); scene?.recenter(); };
document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(b => b.onclick = () => { const [x, z] = b.dataset.move!.split(',').map(Number); scene?.move(x, z); });
input('consent').onchange = () => { const enabled = input('consent').checked; localTouchAllowed = enabled; if (!enabled) { clearTouch(); haptics.stop(); scene?.clearPulses(); } send({ type: 'consent', enabled }); log(enabled ? '允许触碰请求' : '撤回触碰权限'); };
input('gamepad').onchange = () => { haptics.setGamepadEnabled(input('gamepad').checked); text('outputMode', input('gamepad').checked ? '尝试手柄 · 可回退视觉' : '视觉模拟'); };
button('acceptTouch').onclick = () => { if (pendingTouch) send({ type: 'touch-response', requestId: pendingTouch.id, accepted: true }); clearTouch(); };
button('rejectTouch').onclick = () => { if (pendingTouch) send({ type: 'touch-response', requestId: pendingTouch.id, accepted: false }); clearTouch(); };
button('stop').onclick = () => { stopLocally(); send({ type: 'stop' }); };
button('resume').onclick = () => { resumePending = true; send({ type: 'resume' }); };
button('play').onclick = () => {
  if (!room || room.stopped || localStopLatched) return;
  const position = playbackPosition(room.playback, clock());
  const playing = room.playback.playing && position < CLIP_DURATION;
  if (playbackBlocked && playing) { playbackBlocked = false; void clip.play().catch(() => { playbackBlocked = true; }); return; }
  playbackBlocked = false;
  if (!playing) void clip.play().catch(() => { playbackBlocked = true; });
  send({ type: 'playback', action: playing ? 'pause' : 'play', position: position >= CLIP_DURATION - 0.05 ? 0 : position });
};
input('seek').onchange = () => { if (room) send({ type: 'playback', action: 'seek', position: Number(input('seek').value) }); input('seek').blur(); };
clip.addEventListener('loadedmetadata', () => syncPlayback(true));
clip.addEventListener('error', () => { text('playbackSync', '测试片加载失败'); log('媒体文件加载失败'); });

async function enableMedia(mode: 'audio' | 'video') {
  if (!room || !otherId || room.stopped || localStopLatched || mediaBusy) return;
  const attempt = ++mediaAttempt;
  mediaBusy = true; updateButtons();
  try { log(mode === 'audio' ? '用户请求开启麦克风' : '用户请求开启摄像头和麦克风'); await media.enable(mode); }
  catch (error) { const message = error instanceof Error ? error.message : '设备未打开'; toast(message); log('设备未打开', message.slice(0, 100)); }
  finally { if (attempt === mediaAttempt) { mediaBusy = false; updateButtons(); } }
}
button('mic').onclick = () => { void enableMedia('audio'); };
button('camera').onclick = () => { void enableMedia('video'); };
button('mediaOff').onclick = () => { mediaAttempt++; mediaBusy = false; media.disable(); updateButtons(); log('关闭本机设备'); };
async function toggleXR(mode: 'immersive-ar' | 'immersive-vr') {
  try {
    if (xrActive) { await scene?.endXR(); xrActive = false; }
    else { await scene?.startXR(mode); xrActive = true; log('进入 WebXR', mode); }
    button('xr').textContent = xrActive ? '退出 XR' : 'VR';
  } catch (error) { toast(error instanceof Error ? error.message : '当前设备不支持此 XR 模式'); }
}
button('xr').onclick = () => { void toggleXR('immersive-vr'); };
button('ar').onclick = () => { void toggleXR('immersive-ar'); };
if (scene) {
  scene.onPose = pose => { if (room && !room.stopped && !localStopLatched && send({ type: 'pose', pose })) sentPoses++; };
  scene.onTracking = (tracked, source) => { text('trackingLabel', `${source === 'webxr' ? 'WebXR 设备输入' : '桌面手动输入'}${tracked ? '' : ' · 已暂停'}`); if (!tracked) { haptics.stop(); scene?.clearPulses(); clearTouch(); extended = false; button('extend').setAttribute('aria-pressed', 'false'); button('extend').classList.remove('pressed'); button('extend').innerHTML = `${icon('hand')}伸出右手`; } };
  scene.onXREnd = () => { xrActive = false; button('xr').textContent = 'VR'; log('退出 WebXR'); };
  scene.onHandChange = value => { extended = value; button('extend').setAttribute('aria-pressed', String(value)); button('extend').classList.toggle('pressed', value); button('extend').innerHTML = `${icon('hand')}${value ? '收回右手' : '伸出右手'}`; };
}

button('export').onclick = async () => {
  const stats = await media.getStats().catch(() => ({ connection: 'unavailable', outboundAudioBytes: 0, inboundAudioBytes: 0 }));
  const report = { schema: 'rove-diagnostics-v1', exportedAt: new Date().toISOString(), scope: 'Browser prototype; round trip to signaling server, not motion-to-photon or haptic latency.', sources: { room: 'procedural-preset', avatar: 'head-and-hand-proxy', hapticPreference: input('gamepad').checked ? 'gamepad-if-available' : 'visual' }, metrics: { serverRttMs: latestRtt, receivedPosePackets: receivedPoses, sentPosePackets: sentPoses, playbackClockErrorMs: room ? drift : null, completedResponses: touchCount, ...stats }, events };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `rove-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('诊断已导出；不包含音视频、邀请凭据或姿态坐标。');
};
const pingTimer = setInterval(ping, 2000);
const updateTimer = setInterval(() => {
  syncPlayback();
  if (pendingTouch && clock() >= pendingTouch.expiresAt) { clearTouch(); text('touchState', '这次请求已过期，请分开双手后重新尝试。'); }
  if (otherId && room && !room.stopped) {
    const live = remoteTracked && performance.now() - remoteReceivedAt < POSE_STALE_MS;
    text('spaceStatus', live ? '双人已连接 · 姿态同步' : '对方已进入 · 追踪暂停');
    el('spaceDot').classList.toggle('online', live);
    if (!live) { clearTouch(); haptics.stop(); }
  }
}, 250);
window.addEventListener('pagehide', () => {
  disposed = true; send({ type: 'leave' }); haptics.dispose(); media.dispose(); scene?.dispose(); socket?.close(); clearInterval(pingTimer); clearInterval(updateTimer); clearTimeout(toastTimer);
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
const initialRoom = new URLSearchParams(location.hash.slice(1)).get('room');
if (initialRoom && /^[a-f0-9]{32}$/.test(initialRoom)) { input('roomCode').value = initialRoom; text('pageTitle', '有人，给你留了一个位置。'); }
try { const config = await fetch('/api/config').then(r => { if (!r.ok) throw new Error('config'); return r.json(); }); if (Array.isArray(config.iceServers)) iceServers = config.iceServers; }
catch { log('未载入 ICE 配置', '使用仅局域网连接'); }
connect();
