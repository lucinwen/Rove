import { inspectSpaceModel, type RoveScene } from './scene.ts';
import { rotateY } from './spatial-math.ts';
import { MAX_SPACE_BYTES, validSpaceConfig, validateGLB, type RoomSpace, type SpaceConfig } from '../../shared/space.ts';
import type { ClientMessage, RoomState, Vec3 } from '../../shared/protocol.ts';

export const spacePanelMarkup = `
<section class="space-panel activity-card" id="spacePanel" aria-label="准备自己的空间" hidden>
  <div class="activity-head"><h3>把你的房间，变成这次相会的主场</h3><span id="spacePhase" role="status">准备空间</span></div>
  <div class="space-current"><div><strong id="currentSpaceName">示例客厅</strong><p id="currentSpaceDetail"></p></div><span class="space-tag" id="spaceReadiness"></span></div>
  <div id="spaceLoadError" class="inline-error" role="alert" hidden></div>
  <div class="space-entry" id="spaceEntry" hidden><p id="spaceEntryText">看一看房间的地面、大小和朝向，然后确认进入。</p><div class="compact-actions"><button class="primary" id="confirmSpace">确认空间并进入</button><button class="secondary" id="retrySpace" hidden>重新加载空间</button><button class="secondary" id="alignSpace" hidden>按当前站位对齐</button></div><p class="tiny" id="alignmentHelp" hidden>请站到约定的入口位置，面向房间前方。此操作以当前头显站位手动对齐，地面由设备的 local-floor 追踪提供。</p></div>
  <div class="space-proposal" id="spaceProposal" hidden><div class="card-label">换一个地方见面</div><p id="spaceProposalText"></p><div class="compact-actions"><button class="primary" id="acceptSpace">接受这个空间</button><button class="secondary" id="rejectSpace">暂不切换</button></div><p class="tiny">接受后会清除旧位置与触碰授权，双方确认新空间后继续。</p></div>
  <details id="spaceBuilder" class="space-builder"><summary>准备我的空间 <span>尺寸 / 房间模型</span></summary>
    <p class="space-intro">导入已有的房间模型，或先按房间实测尺寸建立简化空间。双方都可以提供主场。</p>
    <div class="space-form-row"><label class="form-field">空间来源<select id="spaceSource"><option value="measured">按实测尺寸创建</option><option value="glb">导入我的房间模型（GLB）</option><option value="sample">使用示例客厅</option></select></label><label class="form-field">给空间起个名字<input id="spaceName" type="text" value="我的房间" maxlength="64" autocomplete="off"/></label></div>
    <div id="spaceFileFields" hidden><label class="file-drop" for="spaceFile"><strong>选择房间 GLB 文件</strong><span>模型与贴图需包含在同一文件中 · 最多 20 MB</span><input id="spaceFile" type="file" accept=".glb,model/gltf-binary"/></label><p class="field-help" id="modelInfo" role="status">可使用房间扫描或建模工具导出的 GLB；本页不会自动扫描房间。</p><div class="space-form-row"><label class="form-field">每个模型单位对应多少米<input id="spaceScale" type="number" min="0.01" max="100" step="0.01" value="1"/></label><label class="form-field">调整朝向（度）<input id="spaceYaw" type="number" min="-180" max="180" step="1" value="0"/></label></div><label class="check-row"><input id="spaceCenter" type="checkbox" checked/><span>以模型中心作为共享原点，并把模型底部放到地面</span></label><p class="field-help" id="spaceTransform"></p></div>
    <div class="dimension-fields"><label class="form-field">宽度 / 米<input id="spaceWidth" type="number" min="1" max="20" step="0.1" value="4.5"/></label><label class="form-field">进深 / 米<input id="spaceDepth" type="number" min="1" max="20" step="0.1" value="4"/></label><label class="form-field">高度 / 米<input id="spaceHeight" type="number" min="1.5" max="5" step="0.1" value="2.8"/></label></div>
    <p class="field-help" id="dimensionHelp">以米为单位：宽与深 1–20 米，高 1.5–5 米。简化空间只表达尺寸，不包含家具与真实墙体细节。</p>
    <div class="space-draft-note" id="spaceDraftNote" hidden>正在查看本地预览，对方还没有进入这个空间。返回当前空间后可继续互动。</div>
    <label class="check-row"><input id="spaceVerified" type="checkbox"/><span>我已预览并确认单位、地面与朝向适合这次相会</span></label>
    <div class="compact-actions"><button class="secondary" id="previewSpace">在这里预览</button><button class="primary" id="proposeSpace" disabled>邀请对方来我的空间</button><button class="subtle-button" id="cancelSpacePreview" hidden>返回当前空间</button></div><p class="field-help" id="spaceActionStatus" role="status"></p>
  </details>
</section>`;

type ModelInfo = Awaited<ReturnType<typeof inspectSpaceModel>>;
type Hooks = { send: (message: ClientMessage) => boolean; changed: () => void; toast: (message: string) => void; log: (event: string, detail?: string) => void };

/** Coordinates local preview, authenticated assets, and explicit entry into a room revision.
 * A resolved fetch/loader alone never acknowledges a newly selected shared space. */
export class SpacePanel {
  private room: RoomState | null = null;
  private selfId = '';
  private token = '';
  private active = false;
  private context = 0;
  private loadVersion = 0;
  private fileVersion = 0;
  private draftVersion = 0;
  private requestedKey = '';
  private appliedKey = '';
  private busy = false;
  private preparing = false;
  private previewing = false;
  private previewValid = false;
  private pendingReady = false;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private error = '';
  private fileData: ArrayBuffer | null = null;
  private model: ModelInfo | null = null;
  private uploadedId: string | null = null;
  private assets = new Map<string, ArrayBuffer>();
  private loadAbort?: AbortController;
  private uploadAbort?: AbortController;
  private disposed = false;

  constructor(private scene: RoveScene | undefined, private hooks: Hooks) {
    this.select('spaceSource').onchange = () => { this.invalidateDraft(); this.updateSource(); };
    for (const id of ['spaceName', 'spaceWidth', 'spaceDepth', 'spaceHeight', 'spaceScale', 'spaceYaw', 'spaceCenter']) {
      this.input(id).addEventListener('input', () => { this.invalidateDraft(); this.updateModelDimensions(); });
    }
    this.input('spaceVerified').onchange = () => this.render();
    this.input('spaceFile').onchange = () => { void this.readFile(); };
    this.button('previewSpace').onclick = () => { void this.preview(); };
    this.button('proposeSpace').onclick = () => { void this.propose(); };
    this.button('cancelSpacePreview').onclick = () => { void this.loadCurrent(true); };
    this.button('confirmSpace').onclick = () => this.confirm();
    this.button('retrySpace').onclick = () => { void this.loadCurrent(true); };
    this.button('alignSpace').onclick = () => {
      if (!this.active || !this.isLoaded() || this.previewing) return;
      const result = this.scene?.alignXR();
      this.hooks.toast(result?.aligned ? '当前位置与朝向已对齐。确认空间后即可继续。' : '还没有可用的头显追踪，请戴好设备并看向前方后重试。');
      this.refreshAlignment();
    };
    this.button('acceptSpace').onclick = () => this.respond(true);
    this.button('rejectSpace').onclick = () => this.respond(false);
    this.updateSource();
  }

  private element(id: string) { return document.getElementById(id)!; }
  private input(id: string) { return this.element(id) as HTMLInputElement; }
  private select(id: string) { return this.element(id) as HTMLSelectElement; }
  private button(id: string) { return this.element(id) as HTMLButtonElement; }
  private text(id: string, value: string) { this.element(id).textContent = value; }
  private key() { return this.room ? `${this.room.id}:${this.room.space.revision}` : ''; }
  private isLoaded() { return !!this.room && this.appliedKey === this.key() && !this.busy && !this.error; }
  private isAligned() { return !!this.scene?.isAligned(); }

  get canInteract(): boolean {
    return this.canReportTracking && this.isAligned();
  }
  get canReportTracking(): boolean { return this.active && this.isLoaded() && !this.previewing && !!this.room && this.room.members.every(member => this.room!.spaceReady.includes(member.id)); }
  get canEnterXR(): boolean { return this.active && this.isLoaded() && !this.previewing && !!this.scene; }
  get isPreviewing(): boolean { return this.previewing; }
  get status(): string {
    if (!this.room) return '本地预览';
    if (!this.active) return '会话已暂停';
    if (this.busy) return '正在加载空间';
    if (this.error) return '空间加载未完成';
    if (this.previewing) return '本地预览 · 尚未共享';
    if (!this.isAligned()) return '请对齐当前站位';
    if (!this.room.spaceReady.includes(this.selfId)) return '请确认空间并进入';
    if (this.room.members.some(member => !this.room!.spaceReady.includes(member.id))) return '等待对方确认空间';
    return this.room.members.length === 2 ? '双方已在共享空间' : '等待对方进入';
  }

  configure(room: RoomState | null, selfId: string, token: string, active: boolean) {
    if (this.disposed) return;
    const previousRoom = this.room?.id;
    this.room = room; this.selfId = selfId; this.token = token; this.active = active;
    if (previousRoom !== room?.id) {
      this.context++; this.loadVersion++; this.fileVersion++; this.loadAbort?.abort(); this.uploadAbort?.abort(); clearTimeout(this.readyTimer);
      this.requestedKey = ''; this.appliedKey = ''; this.busy = false; this.preparing = false; this.previewing = false; this.previewValid = false; this.pendingReady = false; this.error = '';
      this.fileData = null; this.model = null; this.uploadedId = null; this.assets.clear();
      this.input('spaceFile').value = ''; this.input('spaceVerified').checked = false;
      this.text('modelInfo', '可使用房间扫描或建模工具导出的 GLB；本页不会自动扫描房间。');
      this.text('spaceActionStatus', '');
      if (!room) void this.scene?.resetSpace().catch(() => {});
    }
    if (room && this.requestedKey !== this.key()) void this.loadCurrent();
    if (room?.spaceReady.includes(selfId)) { this.pendingReady = false; clearTimeout(this.readyTimer); }
    this.render();
  }

  setActive(active: boolean) {
    this.active = active;
    if (!active) { this.uploadAbort?.abort(); this.preparing = false; this.pendingReady = false; clearTimeout(this.readyTimer); }
    this.render();
  }

  refreshAlignment() { this.render(); this.hooks.changed(); }
  confirmReady() { this.confirm(); }

  handleError(code: string, message: string) {
    if (!code.startsWith('SPACE_') && code !== 'STOPPED' && code !== 'NOT_IN_ROOM') return;
    this.pendingReady = false; clearTimeout(this.readyTimer); this.text('spaceActionStatus', message); this.render();
  }

  private async asset(id: string, signal: AbortSignal): Promise<ArrayBuffer> {
    const cached = this.assets.get(id); if (cached) return cached;
    const response = await fetch(`/api/spaces/${id}`, { headers: { Authorization: `Bearer ${this.token}` }, cache: 'no-store', signal });
    if (!response.ok) throw new Error('房间模型未能加载，请让提供者重新分享，或点击重新加载。');
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_SPACE_BYTES) throw new Error('模型超过 20 MB，无法加载。');
    const data = await response.arrayBuffer();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const validation = validateGLB(data);
    if (!validation.ok) throw new Error(validation.error);
    this.cache(id, data); return data;
  }

  private cache(id: string, data: ArrayBuffer) {
    this.assets.delete(id); this.assets.set(id, data);
    while (this.assets.size > 3) this.assets.delete(this.assets.keys().next().value!);
  }

  private async loadCurrent(force = false) {
    const room = this.room; if (!room || !this.scene) { this.error = this.scene ? '' : '当前设备未能建立三维画面。'; this.render(); return; }
    const key = this.key();
    if (!force && this.requestedKey === key) return;
    this.loadAbort?.abort(); const abort = new AbortController(); this.loadAbort = abort;
    const version = ++this.loadVersion;
    this.requestedKey = key; this.busy = true; this.error = ''; this.previewing = false; this.previewValid = false; this.pendingReady = false; clearTimeout(this.readyTimer);
    this.input('spaceVerified').checked = false; this.scene.setInputEnabled(false); this.scene.setRemotePose(null);
    this.render(); this.hooks.changed();
    try {
      const data = room.space.assetId ? await this.asset(room.space.assetId, abort.signal) : undefined;
      if (version !== this.loadVersion || abort.signal.aborted || this.key() !== key) return;
      this.scene.setRole(room.space.ownerId === this.selfId ? 'host' : 'guest');
      await this.scene.setSpace(room.space, data);
      if (version !== this.loadVersion || abort.signal.aborted || this.key() !== key) return;
      this.appliedKey = key; this.error = ''; this.hooks.log('共享空间已加载', `${room.space.source} / revision ${room.space.revision}`);
    } catch (error) {
      if (version !== this.loadVersion || abort.signal.aborted) return;
      this.error = error instanceof Error ? error.message : '空间加载失败，请重试。';
    } finally {
      if (version === this.loadVersion) { this.busy = false; this.render(); this.hooks.changed(); }
    }
  }

  private invalidateDraft() {
    this.draftVersion++; this.uploadAbort?.abort(); this.preparing = false;
    this.previewValid = false; this.input('spaceVerified').checked = false; this.text('spaceActionStatus', '参数已修改，请重新预览后再邀请对方。'); this.render();
  }

  private updateSource() {
    const source = this.select('spaceSource').value;
    this.element('spaceFileFields').hidden = source !== 'glb';
    for (const id of ['spaceWidth', 'spaceDepth', 'spaceHeight']) this.input(id).readOnly = source !== 'measured';
    if (source === 'sample') { this.input('spaceWidth').value = '5.2'; this.input('spaceDepth').value = '5.2'; this.input('spaceHeight').value = '2.8'; }
    else if (source === 'measured') { this.input('spaceWidth').value = '4.5'; this.input('spaceDepth').value = '4'; this.input('spaceHeight').value = '2.8'; }
    this.text('dimensionHelp', source === 'glb' ? '下面是模型外包范围，按你确认的比例换算为米；旋转后的范围按包围盒估算。请与房间实际尺寸核对。支持宽深 1–20 米、高 1.5–5 米。' : source === 'sample' ? '示例客厅用于连接体验，可随时更换为你们的空间。' : '以米为单位：宽与深 1–20 米，高 1.5–5 米。简化空间只表达尺寸，不包含家具与真实墙体细节。');
    this.updateModelDimensions(); this.render();
  }

  private updateModelDimensions() {
    if (this.select('spaceSource').value !== 'glb' || !this.model) return;
    const scale = Number(this.input('spaceScale').value), yaw = Number(this.input('spaceYaw').value) * Math.PI / 180;
    const width = (Math.abs(this.model.width * Math.cos(yaw)) + Math.abs(this.model.depth * Math.sin(yaw))) * scale;
    const depth = (Math.abs(this.model.width * Math.sin(yaw)) + Math.abs(this.model.depth * Math.cos(yaw))) * scale;
    this.input('spaceWidth').value = width.toFixed(3); this.input('spaceDepth').value = depth.toFixed(3); this.input('spaceHeight').value = (this.model.height * scale).toFixed(3);
    const offset = this.modelOffset(scale, yaw);
    this.text('spaceTransform', `模型单位 × ${scale} = 米；朝向 ${this.input('spaceYaw').value}°；原点平移 ${offset.map(v => v.toFixed(2)).join(' / ')} 米。`);
  }

  private modelOffset(scale: number, yaw: number): Vec3 {
    if (!this.model || !this.input('spaceCenter').checked) return [0, 0, 0];
    const center = rotateY(this.model.center, yaw);
    return [-center[0] * scale, -this.model.min[1] * scale, -center[2] * scale];
  }

  private async readFile() {
    const file = this.input('spaceFile').files?.[0];
    const version = ++this.fileVersion, context = this.context;
    this.fileData = null; this.model = null; this.uploadedId = null; this.invalidateDraft();
    if (!file) return;
    if (file.size > MAX_SPACE_BYTES) { this.text('modelInfo', '文件超过 20 MB，请先简化模型或压缩内嵌贴图。'); return; }
    this.text('modelInfo', '正在检查模型和尺寸…');
    try {
      const data = await file.arrayBuffer();
      const validation = validateGLB(data); if (!validation.ok) throw new Error(validation.error);
      const model = await inspectSpaceModel(data);
      if (version !== this.fileVersion || context !== this.context || this.disposed) return;
      this.fileData = data; this.model = model;
      this.text('modelInfo', `${file.name} · ${(data.byteLength / 1024 / 1024).toFixed(1)} MB · ${model.meshes} 个网格 · ${model.triangles.toLocaleString()} 个三角面`);
      this.updateModelDimensions(); this.render();
    } catch (error) {
      if (version === this.fileVersion && context === this.context) this.text('modelInfo', error instanceof Error ? error.message : '模型无法读取，请换一个 GLB 文件。');
    }
  }

  private config(): SpaceConfig {
    const source = this.select('spaceSource').value as SpaceConfig['source'];
    if (source === 'glb' && (!this.fileData || !this.model)) throw new Error('请先选择一个可读取的房间 GLB。');
    const scale = source === 'glb' ? Number(this.input('spaceScale').value) : 1;
    const yaw = source === 'glb' ? Number(this.input('spaceYaw').value) * Math.PI / 180 : 0;
    const space: SpaceConfig = {
      source, name: this.input('spaceName').value.trim(), width: Number(this.input('spaceWidth').value), depth: Number(this.input('spaceDepth').value), height: Number(this.input('spaceHeight').value),
      assetId: source === 'glb' ? this.uploadedId ?? '0'.repeat(32) : null, scale, yaw, offset: source === 'glb' ? this.modelOffset(scale, yaw) : [0, 0, 0]
    };
    if (!validSpaceConfig(space)) throw new Error('请检查名称与尺寸：宽深 1–20 米，高 1.5–5 米；模型单位比例 0.01–100，朝向 −180° 至 180°。模型原点过远时，请先在建模工具中整理原点。');
    return space;
  }

  private async preview() {
    if (!this.room || !this.active || !this.scene || this.busy || this.preparing) return;
    let config: SpaceConfig;
    try { config = this.config(); } catch (error) { this.hooks.toast((error as Error).message); return; }
    this.loadAbort?.abort(); const version = ++this.loadVersion, context = this.context, draftVersion = this.draftVersion;
    this.busy = true; this.previewing = true; this.previewValid = false; this.error = ''; this.input('spaceVerified').checked = false;
    this.scene.setInputEnabled(false); this.scene.setRemotePose(null); this.hooks.changed(); this.render();
    try {
      await this.scene.setSpace({ ...config, ownerId: this.selfId, revision: this.room.space.revision } as RoomSpace, config.source === 'glb' ? this.fileData! : undefined);
      if (context !== this.context || version !== this.loadVersion || draftVersion !== this.draftVersion) return;
      this.previewValid = true; this.text('spaceActionStatus', '检查地面、尺寸与前方标记。确认后即可邀请对方切换。');
    } catch (error) {
      if (context === this.context && version === this.loadVersion) this.text('spaceActionStatus', error instanceof Error ? error.message : '预览失败，请检查模型。');
    } finally {
      if (context === this.context && version === this.loadVersion) { this.busy = false; this.render(); this.hooks.changed(); }
    }
  }

  private async propose() {
    if (!this.room || !this.active || !this.previewValid || !this.input('spaceVerified').checked || this.preparing || this.room.members.length !== 2 || this.room.spaceProposal) return;
    const context = this.context, fileVersion = this.fileVersion, draftVersion = this.draftVersion, roomId = this.room.id;
    this.preparing = true; this.uploadAbort?.abort(); const abort = new AbortController(); this.uploadAbort = abort;
    try {
      const config = this.config();
      if (config.source === 'glb' && !this.uploadedId) {
        this.text('spaceActionStatus', '正在上传房间模型…'); this.render();
        const response = await fetch('/api/spaces', { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary', Authorization: `Bearer ${this.token}` }, body: this.fileData, signal: abort.signal });
        const result = await response.json() as { assetId?: string; error?: string; message?: string };
        if (!response.ok || !result.assetId || !/^[a-f0-9]{32}$/.test(result.assetId)) throw new Error(result.message ?? result.error ?? '模型上传未完成，请重试。');
        if (context !== this.context || fileVersion !== this.fileVersion || draftVersion !== this.draftVersion || abort.signal.aborted || this.room?.id !== roomId || !this.active) return;
        this.uploadedId = result.assetId; this.cache(result.assetId, this.fileData!); config.assetId = result.assetId;
      }
      if (context !== this.context || draftVersion !== this.draftVersion || abort.signal.aborted || this.room?.id !== roomId || !this.active) return;
      if (!this.hooks.send({ type: 'space-propose', space: config })) throw new Error('连接未就绪，空间尚未分享。');
      this.text('spaceActionStatus', '邀请已发出，等待对方接受。空间会在双方确认后开始同步。'); this.hooks.log('发出空间提案', config.source);
    } catch (error) {
      if (context === this.context && !abort.signal.aborted) { const message = error instanceof Error ? error.message : '空间尚未分享。'; this.text('spaceActionStatus', message); this.hooks.toast(message); }
    } finally { if (context === this.context) { this.preparing = false; this.render(); } }
  }

  private respond(accepted: boolean) {
    const proposal = this.room?.spaceProposal;
    if (!proposal || proposal.fromId === this.selfId || !this.active) return;
    if (this.hooks.send({ type: 'space-response', proposalId: proposal.id, accepted })) {
      this.button('acceptSpace').disabled = true; this.button('rejectSpace').disabled = true;
      this.hooks.log(accepted ? '接受空间提案' : '保留当前空间');
    }
  }

  private confirm() {
    if (!this.active || !this.isLoaded() || this.previewing || !this.isAligned() || !this.room || this.pendingReady) return;
    if (this.hooks.send({ type: 'space-ready', revision: this.room.space.revision })) {
      this.pendingReady = true; const key = this.key(); this.hooks.log('确认共享空间', `revision ${this.room.space.revision}`); this.render();
      clearTimeout(this.readyTimer); this.readyTimer = setTimeout(() => {
        if (this.key() !== key || !this.pendingReady) return;
        this.pendingReady = false; this.render(); this.hooks.toast('空间确认尚未得到回应，请检查连接后重试。');
      }, 8000);
    }
  }

  private render() {
    const room = this.room;
    this.element('spacePanel').hidden = !room;
    if (!room) return;
    const source = room.space.source === 'glb' ? '你们的房间模型' : room.space.source === 'measured' ? '按实测尺寸建立' : '示例客厅';
    const owner = room.members.find(member => member.id === room.space.ownerId);
    this.text('currentSpaceName', room.space.name);
    this.text('currentSpaceDetail', `${owner?.id === this.selfId ? '由你提供主场' : `由 ${owner?.name ?? '对方'} 提供主场`} · ${source} · ${room.space.width.toFixed(1)} × ${room.space.depth.toFixed(1)} × ${room.space.height.toFixed(1)} 米`);
    this.text('spacePhase', this.status); this.text('spaceReadiness', `${room.spaceReady.length} / ${room.members.length} 已确认`);
    this.element('spaceLoadError').hidden = !this.error; this.text('spaceLoadError', this.error);
    const ready = room.spaceReady.includes(this.selfId);
    const aligned = this.isAligned();
    this.element('spaceEntry').hidden = this.previewing || (!this.error && ready && aligned && !this.busy);
    this.text('spaceEntryText', this.busy ? '正在把同一份空间载入本机…' : !aligned ? '进入 XR 后，请在约定的入口对齐站位与朝向。' : '看看地面、大小和前方标记。确认后，你的位置才会出现在对方的空间里。');
    this.button('confirmSpace').disabled = !this.active || !this.isLoaded() || !aligned || this.pendingReady;
    this.button('confirmSpace').textContent = this.pendingReady ? '正在确认…' : '确认空间并进入';
    this.button('retrySpace').hidden = !this.error; this.button('retrySpace').disabled = !this.active || this.busy;
    this.button('alignSpace').hidden = aligned || !this.isLoaded(); this.button('alignSpace').disabled = !this.active || !this.isLoaded();
    this.element('alignmentHelp').hidden = aligned;
    const proposal = room.spaceProposal;
    this.element('spaceProposal').hidden = !proposal;
    if (proposal) {
      const proposer = room.members.find(member => member.id === proposal.fromId);
      this.text('spaceProposalText', `${proposal.fromId === this.selfId ? '你邀请对方' : `${proposer?.name ?? '对方'} 邀请你`}进入「${proposal.space.name}」：${proposal.space.width.toFixed(1)} × ${proposal.space.depth.toFixed(1)} × ${proposal.space.height.toFixed(1)} 米，${proposal.space.source === 'glb' ? '上传的房间模型' : proposal.space.source === 'measured' ? '按实测尺寸建立' : '示例客厅'}。${proposal.fromId === this.selfId ? '等待对方接受。' : '接受后先预览并确认空间。'}邀请将在一分钟内过期。`);
    }
    for (const id of ['acceptSpace', 'rejectSpace']) { this.button(id).hidden = !proposal || proposal.fromId === this.selfId; this.button(id).disabled = !this.active; }
    this.button('previewSpace').disabled = !this.active || !this.scene || this.busy || this.preparing;
    for (const id of ['spaceSource', 'spaceName', 'spaceFile', 'spaceWidth', 'spaceDepth', 'spaceHeight', 'spaceScale', 'spaceYaw', 'spaceCenter']) (this.element(id) as HTMLInputElement | HTMLSelectElement).disabled = !this.active || this.busy || this.preparing;
    this.button('proposeSpace').disabled = !this.active || !this.previewValid || !this.input('spaceVerified').checked || this.busy || this.preparing || room.members.length !== 2 || !!proposal;
    this.input('spaceVerified').disabled = !this.previewValid || this.busy || this.preparing;
    this.button('cancelSpacePreview').hidden = !this.previewing; this.button('cancelSpacePreview').disabled = this.busy || this.preparing;
    this.element('spaceDraftNote').hidden = !this.previewing;
    if (room.members.length < 2 && !this.preparing) this.text('spaceActionStatus', '可以先预览自己的空间。对方加入后，再邀请对方切换。');
  }

  dispose() { this.disposed = true; this.context++; this.loadVersion++; this.fileVersion++; this.loadAbort?.abort(); this.uploadAbort?.abort(); clearTimeout(this.readyTimer); this.assets.clear(); this.fileData = null; this.model = null; }
}
