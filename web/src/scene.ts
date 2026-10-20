import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Pose, PoseFrame, RoomPreset, Role, Vec3 } from '../../shared/protocol.ts';
import { POSE_STALE_MS } from '../../shared/protocol.ts';
import { validPose } from '../../shared/validation.ts';
import { sampleSpace, spaceBounds, validSpaceConfig, type RoomSpace } from '../../shared/space.ts';
import { applyFloorAlignment, approachPosition, computeFloorAlignment, desktopHeadHeight, entrancePosition, headingFromQuaternion, movementLimits, observerFraming, type FloorAlignment } from './spatial-math.ts';
import { disposeObjectRoots, loadEmbeddedSpaceModel, type LoadedSpaceModel } from './space-model.ts';
export { inspectSpaceModel, type ModelInspection } from './space-model.ts';

/** Shared metre coordinates, imported or procedural rooms, and explicitly labelled video avatars. */
export class RoveScene {
  onPose: ((pose: PoseFrame) => void) | null = null;
  onTracking: ((tracked: boolean, source: 'desktop' | 'webxr') => void) | null = null;
  onXREnd: (() => void) | null = null;
  onHandChange: ((extended: boolean) => void) | null = null;
  onAlignmentChange: ((aligned: boolean) => void) | null = null;
  onXRReadyRequest: (() => void) | null = null;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.04, 60);
  private readonly rig = new THREE.Group();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly room = new THREE.Group();
  private readonly screen = new THREE.Group();
  private markers = new THREE.Group();
  private customRoom: THREE.Group | null = null;
  private importedModel: LoadedSpaceModel | null = null;
  private space: RoomSpace = sampleSpace('');
  private spaceLoaded = false;
  private spaceLoading = false;
  private spaceGeneration = 0;
  private loadedSpaceKey = '';
  private pendingSpaceKey = '';
  private pendingSpace: Promise<void> | null = null;
  private alignmentReported = false;
  private sun: THREE.DirectionalLight | null = null;
  private readonly local: Avatar;
  private readonly remote: Avatar;
  private readonly observer: ResizeObserver;
  private readonly keys = new Set<string>();
  private readonly screenMaterial: THREE.MeshBasicMaterial;
  private readonly accentMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly screenPlaceholder: THREE.CanvasTexture;
  private videoTexture: THREE.VideoTexture | null = null;
  private remoteVideo: HTMLVideoElement | null = null;
  private remoteVideoTexture: THREE.VideoTexture | null = null;
  private remoteVideoFrameId: number | null = null;
  private remoteVideoFrameAt = 0;
  private remoteVideoTime = -1;
  private readonly remoteVideoGroup = new THREE.Group();
  private readonly remoteVideoMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
  private readonly remoteVideoPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.remoteVideoMaterial);
  private avatarMode: 'video' | 'simple' = 'video';
  private viewMode: 'first-person' | 'observer' = 'observer';
  private pitch = 0;
  private drag: { id: number; x: number; y: number } | null = null;
  private role: Role = 'host';
  private preset: RoomPreset = 'rose';
  private connected = false;
  private inputEnabled = false;
  private focused = true;
  private handExtended = false;
  private x = -0.65;
  private z = 0.4;
  private yaw = 0;
  private seq = 0;
  private lastPublished = 0;
  private lastFrame = 0;
  private localPose: PoseFrame;
  private remotePose: PoseFrame | null = null;
  private remoteReceived = 0;
  private remoteAllowed = false;
  private lastTracking: boolean | null = null;
  private lastTrackingSource: 'desktop' | 'webxr' | null = null;
  private localPulseUntil = 0;
  private remotePulseUntil = 0;
  private xrSession: XRSession | null = null;
  private xrStarting = false;
  private xrGeneration = 0;
  private xrMode: 'immersive-vr' | 'immersive-ar' | null = null;
  private xrAlignment: FloorAlignment | null = null;
  private rawXRHead: Pose | null = null;
  private rawXRHeadAt = 0;
  private xrReadyRequested = false;
  private xrOverlayRoot: HTMLElement | null = null;
  private xrReference: XRReferenceSpace | null = null;
  private readonly xrHints = new THREE.Group();
  private xrHintState = '';
  private disposed = false;
  private desktopCamera = new THREE.Vector3(5.5, 4.4, 6.8);
  private desktopTarget = new THREE.Vector3(0, 1.0, -0.22);

  constructor(private readonly container: HTMLElement) {
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      throw new Error('当前浏览器无法启动三维画面。请启用硬件加速，或换用支持 WebGL 的浏览器。');
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.renderer.domElement.setAttribute('aria-label', 'Rove 共在空间，拖动旋转视角，WASD 移动，Q/E 转身，空格伸手');
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none';
    this.renderer.domElement.tabIndex = 0;
    container.append(this.renderer.domElement);
    this.scene.background = new THREE.Color('#efeee8');
    this.scene.fog = new THREE.Fog('#efeee8', 15, 30);
    this.rig.add(this.camera);
    this.scene.add(this.rig, this.room, this.screen, this.markers, this.remoteVideoGroup);
    this.camera.position.copy(this.desktopCamera);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.desktopTarget);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 3.5;
    this.controls.maxDistance = 13;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minPolarAngle = 0.25;
    this.controls.enablePan = false;
    this.controls.update();

    this.addLights();
    this.buildRoom();
    this.screenPlaceholder = makeScreenTexture();
    this.screenMaterial = new THREE.MeshBasicMaterial({ map: this.screenPlaceholder, toneMapped: false });
    this.buildScreen();
    this.local = createAvatar(CORAL, '你 · 主场');
    this.remote = createAvatar(SAGE, '对方 · 来访');
    this.scene.add(this.local.group, this.remote.group);
    this.remote.group.visible = false;
    this.remoteVideoGroup.add(this.remoteVideoPlane);
    const videoLabel = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeLabel('实时视频 · 2D', SAGE), transparent: true, depthTest: false, depthWrite: false }));
    videoLabel.position.y = 0.64;
    videoLabel.scale.set(0.82, 0.205, 1);
    this.remoteVideoGroup.add(videoLabel);
    this.remoteVideoGroup.visible = false;
    const xrTitle = makeBillboard('手动空间对齐', '#476554', 1.3);
    const xrAction = makeBillboard('站定并平视约定前方', '#476554', 1.3);
    xrTitle.position.set(0, 0.06, -1.55);
    xrAction.position.set(0, -0.24, -1.55);
    for (const label of [xrTitle, xrAction]) { label.material.depthTest = false; label.renderOrder = 100; }
    this.xrHints.add(xrTitle, xrAction);
    this.xrHints.visible = false;
    this.camera.add(this.xrHints);
    this.localPose = this.desktopPose();
    placeAvatar(this.local, this.localPose, 1);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
    window.addEventListener('blur', this.blur);
    window.addEventListener('focus', this.focus);
    document.addEventListener('visibilitychange', this.visibility);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerdown);
    this.renderer.domElement.addEventListener('pointermove', this.pointermove);
    this.renderer.domElement.addEventListener('pointerup', this.pointerup);
    this.renderer.domElement.addEventListener('pointercancel', this.pointerup);
    this.renderer.setAnimationLoop(this.tick);
  }

  setPreset(preset: RoomPreset): void {
    this.preset = preset;
    const color = preset === 'rose' ? '#d8a89d' : '#a6b9a7';
    this.accentMaterials.forEach(material => material.color.set(color));
  }

  setRole(role: Role): void {
    if (this.role === role) return;
    this.role = role;
    recolorAvatar(this.local, role === 'host' ? CORAL : SAGE, role === 'host' ? '你 · 主场' : '你 · 来访');
    recolorAvatar(this.remote, role === 'host' ? SAGE : CORAL, role === 'host' ? '对方 · 来访' : '对方 · 主场');
    this.recenter();
  }

  /** Load locally before replacing the visible room. Readiness remains an explicit caller action. */
  async setSpace(space: RoomSpace, data?: ArrayBuffer): Promise<void> {
    const { ownerId, revision, ...config } = space;
    if (!validSpaceConfig(config) || typeof ownerId !== 'string' || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('空间尺寸、单位或坐标配置无效。');
    }
    if (this.disposed) throw new Error('三维场景已关闭。');
    const next = structuredClone(space);
    const key = JSON.stringify(next);
    if (this.spaceLoaded && !this.spaceLoading && key === this.loadedSpaceKey) return;
    if (key === this.pendingSpaceKey && this.pendingSpace) return this.pendingSpace;
    const generation = ++this.spaceGeneration;
    this.spaceLoading = true;
    this.spaceLoaded = false;
    this.releaseInputs();
    this.clearPulses();
    this.localPose.tracked = false;
    this.reportAlignment();
    this.publishNow();
    this.pendingSpaceKey = key;
    const pending = this.loadSpace(next, data, key, generation);
    this.pendingSpace = pending;
    try { await pending; }
    finally {
      if (generation === this.spaceGeneration) {
        this.pendingSpace = null;
        this.pendingSpaceKey = '';
      }
    }
  }

  resetSpace(): Promise<void> { return this.setSpace(sampleSpace('')); }

  isAligned(): boolean { return this.spaceLoaded && !this.spaceLoading && (!this.xrSession || this.xrAlignment !== null); }

  /** A user-triggered local-floor alignment, never inferred from room geometry or a webcam. */
  alignXR(): { aligned: boolean; source: 'webxr' | 'none'; position: Vec3 | null; yaw: number | null } {
    const unavailable = { aligned: false, source: 'none' as const, position: null, yaw: null };
    if (!this.xrSession || this.xrSession.visibilityState !== 'visible' || !this.spaceLoaded || this.spaceLoading ||
        !this.rawXRHead || performance.now() - this.rawXRHeadAt > 250) return unavailable;
    const measuredYaw = headingFromQuaternion(this.rawXRHead.orientation);
    const alignment = computeFloorAlignment(this.rawXRHead, entrancePosition(this.role, this.space), 0);
    if (!alignment || measuredYaw === null || this.rawXRHead.position[1] < 0 || this.rawXRHead.position[1] > this.space.height) return unavailable;
    this.xrAlignment = alignment;
    this.xrReadyRequested = false;
    this.rig.rotation.set(0, alignment.yaw, 0);
    this.rig.position.fromArray(alignment.offset);
    this.rig.updateMatrixWorld(true);
    // Wait for the next complete real head-and-two-hand frame before advertising tracked=true.
    this.localPose.tracked = false;
    this.reportAlignment();
    this.publishNow();
    return { aligned: true, source: 'webxr', position: [...this.rawXRHead.position], yaw: measuredYaw };
  }

  setViewMode(mode: 'first-person' | 'observer'): void {
    if (this.viewMode === mode) return;
    if (this.viewMode === 'observer' && !this.xrSession) {
      this.desktopCamera.copy(this.camera.position);
      this.desktopTarget.copy(this.controls.target);
    }
    this.viewMode = mode;
    this.releaseInputs();
    if (!this.xrSession) this.restoreDesktopView();
    this.renderer.domElement.setAttribute('aria-label', mode === 'first-person'
      ? 'Rove 第一人称，拖动转头，WASD 移动，Q/E 转身，空格伸手'
      : 'Rove 观察视角，拖动环绕，WASD 移动，Q/E 转身，空格伸手');
  }

  setAvatarMode(mode: 'video' | 'simple'): void {
    this.avatarMode = mode;
    if (mode === 'simple') this.remoteVideoGroup.visible = false;
  }

  /** Received camera video is a flat, upright card in the peer's tracked position, not a 3D body scan. */
  setRemoteVideo(video: HTMLVideoElement | null): void {
    if (this.remoteVideo === video) return;
    if (this.remoteVideo && this.remoteVideoFrameId !== null) this.remoteVideo.cancelVideoFrameCallback?.(this.remoteVideoFrameId);
    this.remoteVideoFrameId = null;
    this.remoteVideoFrameAt = 0;
    this.remoteVideoTime = -1;
    this.remoteVideoTexture?.dispose();
    this.remoteVideo = video;
    this.remoteVideoTexture = video ? new THREE.VideoTexture(video) : null;
    if (this.remoteVideoTexture) {
      this.remoteVideoTexture.colorSpace = THREE.SRGBColorSpace;
      this.remoteVideoTexture.minFilter = THREE.LinearFilter;
      this.remoteVideoTexture.magFilter = THREE.LinearFilter;
    }
    this.remoteVideoMaterial.map = this.remoteVideoTexture;
    this.remoteVideoMaterial.needsUpdate = true;
    this.remoteVideoGroup.visible = false;
    if (video?.requestVideoFrameCallback) {
      const frame = () => {
        if (this.disposed || this.remoteVideo !== video) return;
        this.remoteVideoFrameAt = performance.now();
        this.remoteVideoFrameId = video.requestVideoFrameCallback(frame);
      };
      this.remoteVideoFrameId = video.requestVideoFrameCallback(frame);
    }
  }

  setRemotePose(pose: PoseFrame | null): void {
    if (!pose) {
      this.remotePose = null;
      this.remote.group.visible = false;
      this.remoteVideoGroup.visible = false;
      return;
    }
    if ((pose.spaceRevision ?? 0) !== this.space.revision || !validPose(pose, spaceBounds(this.space))) return;
    // Reject a late packet locally too; a new connection resets via null.
    if (this.remotePose && pose.seq <= this.remotePose.seq) return;
    const first = !this.remotePose;
    this.remotePose = structuredClone(pose);
    this.remoteReceived = performance.now();
    if (first) placeAvatar(this.remote, pose, 1);
  }

  setRemoteVisible(visible: boolean): void {
    this.remoteAllowed = visible;
    if (!visible) {
      this.remotePose = null;
      this.remote.group.visible = false;
      this.remoteVideoGroup.visible = false;
    }
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
      this.xrGeneration++;
      this.localPulseUntil = this.remotePulseUntil = 0;
      this.setRemoteVisible(false);
    }
  }

  setInputEnabled(enabled: boolean): void {
    if (this.inputEnabled === enabled) return;
    this.inputEnabled = enabled;
    if (!enabled) {
      this.releaseInputs();
      this.localPose.tracked = false;
      this.localPulseUntil = this.remotePulseUntil = 0;
    }
    else if (!this.xrSession) this.renderer.domElement.focus({ preventScroll: true });
    this.publishNow();
  }

  /** Movement in shared room metres. Touch controls call this in small increments. */
  move(dx: number, dz: number): void {
    if (!this.inputEnabled || !this.isAligned() || this.xrSession || !Number.isFinite(dx) || !Number.isFinite(dz)) return;
    const limits = movementLimits(this.space);
    this.x = THREE.MathUtils.clamp(this.x + THREE.MathUtils.clamp(dx, -0.25, 0.25), -limits.x, limits.x);
    this.z = THREE.MathUtils.clamp(this.z + THREE.MathUtils.clamp(dz, -0.25, 0.25), -limits.z, limits.z);
    this.localPose = this.desktopPose();
  }

  extendHand(extended: boolean): void {
    if (!this.inputEnabled || !this.isAligned() || this.xrSession) return;
    this.setHandExtended(extended);
    this.publishNow();
  }

  pulseLocal(): void { this.localPulseUntil = performance.now() + 500; }
  pulseRemote(): void { this.remotePulseUntil = performance.now() + 500; }
  clearPulses(): void {
    this.localPulseUntil = this.remotePulseUntil = 0;
    this.local.pulse.visible = this.remote.pulse.visible = false;
  }

  setVideo(video: HTMLVideoElement): void {
    this.videoTexture?.dispose();
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.screenMaterial.map = this.videoTexture;
    this.screenMaterial.needsUpdate = true;
  }

  getLocalPose(): PoseFrame { return structuredClone(this.localPose); }

  recenter(): void {
    const entrance = entrancePosition(this.role, this.space);
    this.x = entrance[0];
    this.z = entrance[2];
    this.yaw = 0;
    this.pitch = 0;
    this.releaseInputs();
    if (this.xrSession) {
      this.xrAlignment = null;
      this.xrReadyRequested = false;
      this.localPose = { ...this.desktopPose(), source: 'webxr', tracked: false };
      this.reportAlignment();
      this.publishNow();
    } else {
      this.localPose = this.desktopPose();
      this.publishNow();
    }
  }

  /** Desktop rehearsal position, not an inferred physical movement or room calibration. */
  approach(): boolean {
    if (!this.inputEnabled || !this.isAligned() || this.xrSession) return false;
    const freshPeer = this.remoteAllowed && this.remotePose?.tracked && performance.now() - this.remoteReceived < POSE_STALE_MS;
    const target = approachPosition(this.role, this.space, freshPeer ? this.remotePose!.head.position : null);
    if (!target) return false;
    this.x = target.position[0];
    this.z = target.position[2];
    this.yaw = target.yaw;
    this.pitch = 0;
    this.setHandExtended(false);
    this.keys.clear();
    this.localPose = this.desktopPose();
    this.renderer.domElement.focus({ preventScroll: true });
    this.publishNow();
    return true;
  }

  async startXR(mode: 'immersive-vr' | 'immersive-ar'): Promise<void> {
    if (!this.connected || !this.spaceLoaded || this.spaceLoading) throw new Error('请先加入空间并完成本地空间加载，再进入头显模式。');
    if (this.xrSession) return;
    if (this.xrStarting) throw new Error('头显会话正在启动，请稍等。');
    if (!window.isSecureContext) throw new Error('头显模式需要 HTTPS 或 localhost 安全连接。');
    const generation = ++this.xrGeneration;
    const spaceGeneration = this.spaceGeneration;
    this.xrStarting = true;
    let session: XRSession | null = null;
    try {
      if (!navigator.xr || !(await navigator.xr.isSessionSupported(mode))) {
        throw new Error(mode === 'immersive-ar' ? '当前设备或浏览器未提供 WebXR AR 模式。' : '当前设备或浏览器未提供 WebXR VR 模式。');
      }
      if (!this.connected || this.disposed || generation !== this.xrGeneration || spaceGeneration !== this.spaceGeneration) throw new Error('会话或空间已改变，头显启动已取消。');
      const overlayRoot = document.getElementById('app') ?? this.container.parentElement ?? this.container;
      session = await navigator.xr.requestSession(mode, {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking', 'dom-overlay'],
        domOverlay: { root: overlayRoot },
      });
      if (!this.connected || this.disposed || generation !== this.xrGeneration || spaceGeneration !== this.spaceGeneration) throw new Error('会话或空间已改变，头显启动已取消。');
      if (this.viewMode === 'observer') {
        this.desktopCamera.copy(this.camera.position);
        this.desktopTarget.copy(this.controls.target);
      }
      this.controls.enabled = false;
      this.xrSession = session;
      this.xrMode = mode;
      this.xrAlignment = null;
      this.xrReadyRequested = false;
      this.rawXRHead = null;
      this.rawXRHeadAt = 0;
      this.releaseInputs();
      this.camera.position.set(0, 0, 0);
      this.camera.quaternion.identity();
      this.updateRoomVisibility();
      this.reportAlignment();
      this.localPose = { ...this.localPose, source: 'webxr', tracked: false };
      this.publishNow();
      this.scene.background = mode === 'immersive-ar' ? null : new THREE.Color('#efeee8');
      if (mode === 'immersive-ar') this.scene.fog = null;
      this.renderer.setClearColor(mode === 'immersive-ar' ? 0x000000 : 0xefeee8, mode === 'immersive-ar' ? 0 : 1);
      session.addEventListener('end', this.xrEnded, { once: true });
      session.addEventListener('visibilitychange', this.xrVisibility);
      session.addEventListener('select', this.xrSelect);
      this.xrOverlayRoot = overlayRoot;
      overlayRoot.addEventListener('beforexrselect', this.overlaySelect);
      await this.renderer.xr.setSession(session);
      if (!this.connected || this.disposed || generation !== this.xrGeneration || spaceGeneration !== this.spaceGeneration || this.xrSession !== session) {
        throw new Error('会话已结束，头显启动已取消。');
      }
      this.xrReference = this.renderer.xr.getReferenceSpace();
      this.xrReference?.addEventListener('reset', this.xrReferenceReset);
    } catch (error) {
      if (session) {
        await session.end().catch(() => undefined);
        if (this.xrSession === session) this.xrEnded();
      }
      throw error;
    } finally {
      this.xrStarting = false;
    }
  }

  async endXR(): Promise<void> {
    this.xrGeneration++;
    if (this.xrSession) await this.xrSession.end();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.xrGeneration++;
    this.spaceGeneration++;
    this.renderer.setAnimationLoop(null);
    this.xrOverlayRoot?.removeEventListener('beforexrselect', this.overlaySelect);
    this.xrReference?.removeEventListener('reset', this.xrReferenceReset);
    this.setRemoteVideo(null);
    if (this.xrSession) void this.xrSession.end();
    this.observer.disconnect();
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    window.removeEventListener('blur', this.blur);
    window.removeEventListener('focus', this.focus);
    document.removeEventListener('visibilitychange', this.visibility);
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerdown);
    this.renderer.domElement.removeEventListener('pointermove', this.pointermove);
    this.renderer.domElement.removeEventListener('pointerup', this.pointerup);
    this.renderer.domElement.removeEventListener('pointercancel', this.pointerup);
    this.controls.dispose();
    this.disposeCustomRoom();
    const placeholderActive = this.screenMaterial.map === this.screenPlaceholder;
    disposeObjectRoots([this.scene]);
    if (!placeholderActive) this.screenPlaceholder.dispose();
    this.sun?.shadow.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private async loadSpace(space: RoomSpace, data: ArrayBuffer | undefined, key: string, generation: number): Promise<void> {
    let model: LoadedSpaceModel | null = null;
    let geometry: THREE.Group | null = null;
    let markers: THREE.Group | null = null;
    const discard = () => {
      model?.root.removeFromParent();
      if (geometry) disposeObjectRoots([geometry]);
      model?.dispose();
      if (markers) disposeObjectRoots([markers]);
    };
    try {
      if (space.source === 'glb') {
        if (!data) throw new Error('尚未收到这个空间的 GLB 文件，请重试下载。');
        model = await loadEmbeddedSpaceModel(data);
      }
      if (this.disposed || generation !== this.spaceGeneration) throw new DOMException('空间切换已被更新的请求取代。', 'AbortError');
      if (space.source !== 'sample') {
        geometry = new THREE.Group();
        this.buildSpaceGeometry(geometry, space, model?.root ?? null);
      }
      markers = new THREE.Group();
      this.buildMarkers(markers, space);
      // All parsing and allocations finish before the previous visible room is removed.
      this.disposeCustomRoom();
      this.markers.removeFromParent();
      disposeObjectRoots([this.markers]);
      this.markers = markers;
      this.scene.add(markers);
      markers = null;
      this.customRoom = geometry;
      this.importedModel = model;
      if (geometry) this.scene.add(geometry);
      geometry = null;
      model = null;
      this.space = space;
      this.loadedSpaceKey = key;
      this.spaceLoaded = true;
      this.spaceLoading = false;
      this.xrAlignment = null;
      this.xrReadyRequested = false;
      this.rawXRHead = null;
      this.rawXRHeadAt = 0;
      this.setRemotePose(null);
      this.room.scale.set(space.width / 6.08, space.height / 2.88, space.depth / 5.94);
      const screenScale = Math.min(1, space.width * 0.75 / 2.7, space.height * 0.8 / 2.57);
      this.screen.scale.setScalar(screenScale);
      this.screen.position.set(-0.32 * screenScale, 0, -space.depth / 2 + 0.12 + 2.77 * screenScale);
      const framing = observerFraming(space);
      this.desktopCamera.fromArray(framing.position);
      this.desktopTarget.fromArray(framing.target);
      this.camera.far = Math.max(60, framing.maxDistance * 2);
      this.controls.minDistance = Math.max(1.4, Math.min(space.width, space.depth) * 0.45);
      this.controls.maxDistance = framing.maxDistance;
      const largest = Math.max(space.width, space.depth);
      if (this.sun) {
        Object.assign(this.sun.shadow.camera, { left: -largest / 2 - 1, right: largest / 2 + 1, top: largest / 2 + 1, bottom: -largest / 2 - 1 });
        this.sun.shadow.camera.updateProjectionMatrix();
      }
      this.updateRoomVisibility();
      this.recenter();
      // An old XR frame may lie outside the new room. A canonical, untracked fallback stays wire-valid.
      if (this.xrSession) this.localPose = { ...this.desktopPose(), source: 'webxr', tracked: false };
      else this.restoreDesktopView();
      this.reportAlignment();
      this.publishNow();
    } catch (error) {
      discard();
      if (generation === this.spaceGeneration) {
        this.spaceLoading = false;
        this.spaceLoaded = false;
        this.localPose.tracked = false;
        this.reportAlignment();
      }
      throw error;
    }
  }

  private disposeCustomRoom(): void {
    this.importedModel?.root.removeFromParent();
    if (this.customRoom) {
      this.customRoom.removeFromParent();
      disposeObjectRoots([this.customRoom]);
    }
    this.importedModel?.dispose();
    this.customRoom = null;
    this.importedModel = null;
  }

  private buildSpaceGeometry(group: THREE.Group, space: RoomSpace, model: THREE.Group | null): void {
    const { width, depth, height } = space;
    if (space.source === 'measured') {
      const floor = box(width, 0.08, depth, standard('#e4dfd2'));
      floor.position.y = -0.04;
      const wall = standard('#e7ece3');
      const back = box(width + 0.1, height, 0.08, wall);
      back.position.set(0, height / 2, -depth / 2 - 0.04);
      const left = box(0.08, height, depth, wall);
      left.position.set(-width / 2 - 0.04, height / 2, 0);
      group.add(floor, back, left);
      const title = makeBillboard('手动尺寸空间', '#6f8777', 1.25);
      title.position.set(0, Math.min(height - 0.15, 2.5), -depth / 2 + 0.08);
      group.add(title);
    }
    if (model) {
      const transform = new THREE.Group();
      transform.scale.setScalar(space.scale);
      transform.rotation.y = space.yaw;
      transform.position.fromArray(space.offset);
      transform.add(model);
      group.add(transform);
    }
    const points: number[] = [];
    // Rectangular reference grid in metres, independent of the uploaded model's transform.
    const step = Math.max(width, depth) > 10 ? 1 : 0.5;
    for (let x = -width / 2 + step; x < width / 2; x += step) points.push(x, 0.012, -depth / 2, x, 0.012, depth / 2);
    for (let z = -depth / 2 + step; z < depth / 2; z += step) points.push(-width / 2, 0.012, z, width / 2, 0.012, z);
    const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3)), new THREE.LineBasicMaterial({ color: '#a5b9a7', transparent: true, opacity: 0.35 }));
    group.add(grid);
    const borderPoints = [
      -width / 2, 0.015, -depth / 2, width / 2, 0.015, -depth / 2,
      width / 2, 0.015, -depth / 2, width / 2, 0.015, depth / 2,
      width / 2, 0.015, depth / 2, -width / 2, 0.015, depth / 2,
      -width / 2, 0.015, depth / 2, -width / 2, 0.015, -depth / 2,
      -width / 2, 0, -depth / 2, -width / 2, height, -depth / 2,
      width / 2, 0, -depth / 2, width / 2, height, -depth / 2,
      -width / 2, height, -depth / 2, width / 2, height, -depth / 2,
    ];
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(borderPoints, 3)), new THREE.LineBasicMaterial({ color: '#718d7b', transparent: true, opacity: 0.65 })));
    const widthLabel = makeBillboard(`${width.toFixed(2)} m`, '#718d7b', 0.78);
    widthLabel.position.set(0, 0.12, depth / 2);
    const depthLabel = makeBillboard(`${depth.toFixed(2)} m`, '#718d7b', 0.78);
    depthLabel.position.set(width / 2, 0.12, 0);
    group.add(widthLabel, depthLabel);
  }

  private buildMarkers(group: THREE.Group, space: RoomSpace): void {
    const origin = new THREE.Mesh(new THREE.RingGeometry(0.075, 0.09, 32), new THREE.MeshBasicMaterial({ color: '#476554', side: THREE.DoubleSide, depthWrite: false }));
    origin.rotation.x = -Math.PI / 2;
    origin.position.y = 0.045;
    const length = Math.min(0.55, space.depth * 0.3);
    const forward = new THREE.ArrowHelper(FORWARD, new THREE.Vector3(0, 0.045, -0.1), length, '#476554', 0.12, 0.08);
    const direction = makeBillboard('共享原点 · 朝屏幕', '#6f8777', 0.9);
    direction.position.set(0, 0.16, -length - 0.18);
    group.add(origin, forward, direction);
    for (const role of ['host', 'guest'] as const) {
      const position = entrancePosition(role, space);
      const color = role === 'host' ? CORAL : SAGE;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.185, 40), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.65, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(position[0], 0.048, position[2]);
      const label = makeBillboard(role === 'host' ? '主场入口' : '来访入口', color, 0.7);
      label.position.set(position[0], 0.14, position[2] + 0.28);
      group.add(ring, label);
    }
  }

  private updateRoomVisibility(): void {
    const visible = this.xrMode !== 'immersive-ar';
    this.room.visible = visible && this.space.source === 'sample';
    if (this.customRoom) this.customRoom.visible = visible;
    if (this.xrMode !== 'immersive-ar') {
      const span = Math.max(this.space.width, this.space.depth);
      this.scene.fog = new THREE.Fog('#efeee8', Math.max(15, span * 2), Math.max(30, span * 4));
    }
  }

  private reportAlignment(): void {
    const aligned = this.isAligned();
    if (this.alignmentReported === aligned) return;
    this.alignmentReported = aligned;
    this.onAlignmentChange?.(aligned);
  }

  private updateXRHints(): void {
    // The HTML overlay is optional. These camera-relative instructions also work without it.
    this.xrHints.visible = !!this.xrSession && !this.xrSession.domOverlayState && (!this.inputEnabled || !this.localPose.tracked);
    if (!this.xrHints.visible) return;
    const state = !this.spaceLoaded || this.spaceLoading ? 'loading' : !this.xrAlignment ? 'align'
      : !this.inputEnabled ? this.xrReadyRequested ? 'waiting' : 'ready' : 'tracking';
    if (state === this.xrHintState) return;
    this.xrHintState = state;
    const texts: Record<string, [string, string]> = {
      loading: ['正在载入共享空间', '姿态暂未启用'],
      align: ['站定 · 平视约定前方', '按扳机或捏合手动对齐'],
      ready: ['已手动对齐', '再次按扳机确认进入'],
      waiting: ['等待双方空间就绪', '未回应可再次按扳机'],
      tracking: ['追踪尚未就绪', '保持头部与双手在范围内'],
    };
    this.xrHints.children.forEach((child, index) => {
      const label = child as THREE.Sprite;
      label.material.map?.dispose();
      label.material.map = makeLabel(texts[state][index], '#476554');
      label.material.needsUpdate = true;
    });
  }

  private restoreDesktopView(): void {
    this.controls.enabled = this.viewMode === 'observer';
    this.camera.fov = this.viewMode === 'observer' ? 42 : 65;
    this.camera.updateProjectionMatrix();
    if (this.viewMode === 'observer') {
      this.camera.position.copy(this.desktopCamera);
      this.controls.target.copy(this.desktopTarget);
      this.controls.update();
    } else {
      this.camera.position.fromArray(this.localPose.head.position);
      this.camera.quaternion.fromArray(this.localPose.head.orientation);
    }
  }

  private updateRemoteVideo(fresh: boolean, now: number): void {
    const video = this.remoteVideo;
    if (video && !video.requestVideoFrameCallback && video.currentTime !== this.remoteVideoTime) {
      this.remoteVideoTime = video.currentTime;
      this.remoteVideoFrameAt = now;
    }
    const stream = video?.srcObject;
    const live = typeof MediaStream !== 'undefined' && stream instanceof MediaStream && stream.getVideoTracks().some(track => track.readyState === 'live' && track.enabled && !track.muted);
    const visible = !!(fresh && this.avatarMode === 'video' && video && live && !video.paused && video.readyState >= 2 &&
      this.remoteVideoFrameAt > 0 && now - this.remoteVideoFrameAt < 1500);
    this.remoteVideoGroup.visible = visible;
    this.remote.head.visible = this.remote.body.visible = !visible;
    this.remote.label.visible = !visible;
    if (!visible || !video) return;
    const aspect = video.videoWidth / Math.max(1, video.videoHeight);
    const width = Math.min(1.2, Math.max(0.5, aspect * 0.9));
    const height = width / Math.max(0.25, aspect);
    this.remoteVideoPlane.scale.set(width, height, 1);
    this.remoteVideoGroup.position.copy(this.remote.head.position);
    this.remoteVideoGroup.position.y -= height / 2 - 0.18;
    const label = this.remoteVideoGroup.children[1];
    label.position.y = height / 2 + 0.16;
    const camera = this.xrSession ? this.renderer.xr.getCamera() : this.camera;
    const viewPosition = camera.getWorldPosition(new THREE.Vector3());
    this.remoteVideoGroup.rotation.set(0, Math.atan2(viewPosition.x - this.remoteVideoGroup.position.x, viewPosition.z - this.remoteVideoGroup.position.z), 0);
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight('#fff5e6', '#c3c9c3', 2.4));
    const sun = new THREE.DirectionalLight('#fff6e5', 3.8);
    this.sun = sun;
    sun.position.set(-2.8, 7.4, 4.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -5;
    sun.shadow.camera.right = 5;
    sun.shadow.camera.top = 5;
    sun.shadow.camera.bottom = -5;
    sun.shadow.normalBias = 0.025;
    sun.shadow.bias = -0.0002;
    this.scene.add(sun);
    const bounce = new THREE.DirectionalLight('#d8ede6', 1.2);
    bounce.position.set(5, 3, -2);
    this.scene.add(bounce);
  }

  private buildRoom(): void {
    const cream = standard('#ece4d7');
    const wall = standard('#f0ede4');
    const oak = standard('#be9974');
    const oakLight = standard('#d9bc97');
    const brass = standard('#a3936f', 0.5, 0.35);
    const upholstery = standard('#d8a89d');
    this.accentMaterials.push(upholstery);
    const base = box(6.35, 0.2, 6.2, cream);
    base.position.y = -0.15;
    this.room.add(base);
    const floor = box(6.08, 0.06, 5.94, standard('#ddd1ba'));
    floor.position.y = -0.025;
    this.room.add(floor);
    for (let i = -5; i <= 5; i++) {
      const seam = box(0.008, 0.003, 5.92, standard('#d0c4af'));
      seam.position.set(i * 0.53, 0.01, 0);
      this.room.add(seam);
    }
    const backWall = box(6.12, 2.88, 0.12, wall);
    backWall.position.set(0, 1.43, -3.0);
    this.room.add(backWall);
    const leftWall = box(0.12, 2.88, 4.6, wall);
    leftWall.position.set(-3.02, 1.43, -0.75);
    this.room.add(leftWall);
    const backSkirt = box(6.1, 0.11, 0.04, cream);
    backSkirt.position.set(0, 0.08, -2.91);
    this.room.add(backSkirt);

    const rug = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.018, 64), standard('#e9dfca'));
    rug.scale.z = 0.72;
    rug.position.set(0, 0.023, 0.45);
    rug.receiveShadow = true;
    this.room.add(rug);
    const rugEdge = new THREE.Mesh(new THREE.RingGeometry(1.8, 1.82, 64), standard('#d5c7ad'));
    rugEdge.rotation.x = -Math.PI / 2;
    rugEdge.scale.y = 0.72;
    rugEdge.position.set(0, 0.034, 0.45);
    this.room.add(rugEdge);

    const sofa = new THREE.Group();
    sofa.position.set(0, 0, 1.82);
    const sofaBase = roundedBox(2.55, 0.26, 0.86, 0.08, upholstery);
    sofaBase.position.y = 0.36;
    sofa.add(sofaBase);
    const sofaBack = roundedBox(2.55, 0.69, 0.22, 0.08, upholstery);
    sofaBack.position.set(0, 0.77, 0.36);
    sofa.add(sofaBack);
    for (const sign of [-1, 1]) {
      const arm = roundedBox(0.2, 0.48, 0.86, 0.07, upholstery);
      arm.position.set(sign * 1.2, 0.55, 0);
      sofa.add(arm);
      const cushion = roundedBox(1.08, 0.16, 0.71, 0.06, standard('#e2beb1'));
      cushion.position.set(sign * 0.57, 0.52, -0.035);
      sofa.add(cushion);
      const pillow = roundedBox(0.36, 0.37, 0.13, 0.06, standard(sign < 0 ? '#faf1df' : '#9fae97'));
      pillow.position.set(sign * 0.9, 0.85, 0.18);
      pillow.rotation.z = sign * 0.12;
      sofa.add(pillow);
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.23, 12), oak);
        leg.position.set(sign * 1.05, 0.12, side * 0.3);
        sofa.add(leg);
      }
    }
    this.room.add(sofa);

    // The translucent grid is only a canonical coordinate reference, never a scanned safety mesh.
    const grid = new THREE.GridHelper(5.2, 13, '#b0bcb2', '#d6dcd2');
    grid.position.y = 0.042;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.2;
    this.room.add(grid);
    const origin = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.105, 32), new THREE.MeshBasicMaterial({ color: '#7e9486', transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    origin.rotation.x = -Math.PI / 2;
    origin.position.set(0, 0.05, 0);
    this.room.add(origin);

    // Window on the left wall: luminous sky panel and wood mullions.
    const windowGroup = new THREE.Group();
    windowGroup.position.set(-2.94, 1.83, -1.2);
    windowGroup.rotation.y = Math.PI / 2;
    const glass = box(1.45, 1.15, 0.025, new THREE.MeshBasicMaterial({ color: '#d1e6dc' }));
    windowGroup.add(glass);
    for (const yy of [-0.6, 0, 0.6]) {
      const slat = box(1.56, 0.045, 0.07, oakLight);
      slat.position.set(0, yy, 0.04);
      windowGroup.add(slat);
    }
    for (const xx of [-0.755, 0, 0.755]) {
      const slat = box(0.045, 1.25, 0.07, oakLight);
      slat.position.set(xx, 0, 0.04);
      windowGroup.add(slat);
    }
    const sill = box(1.68, 0.08, 0.24, oakLight);
    sill.position.set(0, -0.65, 0.04);
    windowGroup.add(sill);
    this.room.add(windowGroup);

    // Side table and modest books create scale without obstructing the shared interaction area.
    const tableTop = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.07, 48), oakLight);
    tableTop.position.set(-1.94, 0.57, 1.4);
    const tableStem = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.13, 0.55, 20), oak);
    tableStem.position.set(-1.94, 0.28, 1.4);
    this.room.add(tableTop, tableStem);
    const book = box(0.3, 0.045, 0.23, standard('#6f8979'));
    book.position.set(-1.92, 0.63, 1.37);
    book.rotation.y = 0.15;
    const book2 = box(0.26, 0.035, 0.2, standard('#dec9a1'));
    book2.position.set(-1.95, 0.67, 1.37);
    book2.rotation.y = -0.12;
    this.room.add(book, book2);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.058, 0.11, 20), standard('#fbf5e6'));
    cup.position.set(-2.1, 0.66, 1.56);
    this.room.add(cup);
    this.addPlant(2.25, -2.06, 1.25);
    this.addPlant(-2.4, 0.12, 0.85);

    const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.05, 32), brass);
    lampBase.position.set(2.05, 0.04, 1.62);
    const lampStem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.67, 14), brass);
    lampStem.position.set(2.05, 0.86, 1.62);
    const lampShade = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.39, 0.4, 48, 1, true), standard('#f2e8cf'));
    lampShade.position.set(2.05, 1.66, 1.62);
    lampShade.material.side = THREE.DoubleSide;
    this.room.add(lampBase, lampStem, lampShade);
    const lampLight = new THREE.PointLight('#ffe0aa', 0.5, 4, 2);
    lampLight.position.set(2.05, 1.55, 1.62);
    this.room.add(lampLight);

    // Two simple framed studies, produced from basic geometry.
    for (let i = 0; i < 2; i++) {
      const frame = box(0.48, 0.62, 0.035, oak);
      frame.position.set(-2.24 + i * 0.63, 2.07, -2.91);
      const paper = box(0.4, 0.54, 0.01, standard('#fff8eb'));
      paper.position.set(frame.position.x, frame.position.y, -2.885);
      const art = new THREE.Mesh(new THREE.CircleGeometry(0.115, 32), new THREE.MeshBasicMaterial({ color: i ? '#a4b8a2' : '#d9a699' }));
      art.position.set(frame.position.x, frame.position.y + (i ? -0.04 : 0.04), -2.876);
      this.room.add(frame, paper, art);
    }
    this.room.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.receiveShadow = true;
        object.castShadow = !(object.material instanceof THREE.MeshBasicMaterial);
      }
    });
  }

  private addPlant(x: number, z: number, height: number): void {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.2 * height, 0.14 * height, 0.32 * height, 24), standard('#c5ab8c'));
    pot.position.set(x, 0.16 * height, z);
    this.room.add(pot);
    for (let i = 0; i < 8; i++) {
      const angle = i * 2.399;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), standard(i % 2 ? '#708d70' : '#91a482'));
      leaf.scale.set(0.1 * height, (0.25 + (i % 3) * 0.055) * height, 0.045 * height);
      leaf.position.set(x + Math.cos(angle) * 0.15 * height, (0.63 + (i % 3) * 0.08) * height, z + Math.sin(angle) * 0.15 * height);
      leaf.rotation.set(Math.sin(angle) * 0.5, angle, Math.cos(angle) * 0.55);
      const stem = cylinderBetween(new THREE.Vector3(x, 0.2 * height, z), leaf.position, 0.012 * height, standard('#6f8055'));
      this.room.add(stem, leaf);
    }
  }

  private buildScreen(): void {
    const casing = roundedBox(2.36, 1.4, 0.1, 0.07, standard('#3b4943'));
    casing.position.set(0.32, 1.87, -2.77);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.2375), this.screenMaterial);
    panel.position.set(0.32, 1.89, -2.708);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 10), new THREE.MeshBasicMaterial({ color: '#b9d8c3' }));
    led.position.set(0.32, 1.225, -2.706);
    const cabinet = roundedBox(2.7, 0.5, 0.48, 0.025, standard('#cfb58f'));
    cabinet.position.set(0.32, 0.35, -2.57);
    for (const x of [-0.6, 0.32, 1.24]) {
      const line = box(0.007, 0.39, 0.012, standard('#b49b77'));
      line.position.set(x, 0.36, -2.32);
      this.screen.add(line);
    }
    const stripe = box(1.75, 0.04, 0.07, standard('#5d6a60'));
    stripe.position.set(0.32, 0.64, -2.52);
    this.screen.add(casing, panel, led, cabinet, stripe);
    this.screen.traverse(object => {
      if (object instanceof THREE.Mesh && object !== panel) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
  }

  private desktopPose(): PoseFrame {
    const bodyQ = new THREE.Quaternion().setFromAxisAngle(UP, this.yaw);
    const headQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const head = new THREE.Vector3(this.x, desktopHeadHeight(this.space), this.z);
    const left = new THREE.Vector3(-0.28, -0.45, -0.05).applyQuaternion(bodyQ).add(head);
    const right = new THREE.Vector3(...(this.handExtended ? [0.06, -0.28, -0.42] : [0.28, -0.45, -0.05]) as [number, number, number]).applyQuaternion(bodyQ).add(head);
    return {
      head: toPose(head, headQ), left: toPose(left, bodyQ), right: toPose(right, bodyQ),
      source: 'desktop', tracked: this.inputEnabled && this.isAligned() && this.focused && document.visibilityState !== 'hidden',
      seq: this.seq, spaceRevision: this.space.revision,
    };
  }

  private readXR(frame: XRFrame): void {
    const untracked = () => { this.localPose = { ...this.localPose, source: 'webxr', tracked: false }; };
    const ref = this.renderer.xr.getReferenceSpace();
    if (!ref || !this.xrSession || this.xrSession.visibilityState !== 'visible') {
      this.rawXRHead = null;
      untracked();
      return;
    }
    const viewer = frame.getViewerPose(ref);
    if (!viewer) {
      this.rawXRHead = null;
      untracked();
      return;
    }
    const rawPose = (transform: XRRigidTransform): Pose => ({
      position: [transform.position.x, transform.position.y, transform.position.z],
      orientation: [transform.orientation.x, transform.orientation.y, transform.orientation.z, transform.orientation.w],
    });
    this.rawXRHead = rawPose(viewer.transform);
    this.rawXRHeadAt = performance.now();
    if (!this.isAligned() || !this.xrAlignment) { untracked(); return; }
    const head = applyFloorAlignment(this.rawXRHead, this.xrAlignment);
    let left: Pose | null = null;
    let right: Pose | null = null;
    for (const source of this.xrSession.inputSources) {
      let trackedPose: XRPose | null = null;
      if (source.gripSpace) trackedPose = frame.getPose(source.gripSpace, ref) ?? null;
      if (!trackedPose && source.hand) {
        const wrist = source.hand.get('wrist');
        if (wrist) trackedPose = frame.getJointPose?.(wrist, ref) ?? null;
      }
      if (!trackedPose) continue;
      const pose = applyFloorAlignment(rawPose(trackedPose.transform), this.xrAlignment);
      if (source.handedness === 'left') left = pose;
      if (source.handedness === 'right') right = pose;
    }
    // A lost hand invalidates this complete frame; do not attach an old hand to a new head.
    if (!left || !right) { untracked(); return; }
    const next: PoseFrame = {
      head, left, right, source: 'webxr', tracked: this.inputEnabled,
      seq: this.seq, spaceRevision: this.space.revision,
    };
    if (validPose(next, spaceBounds(this.space))) this.localPose = next;
    else untracked();
  }

  private publishNow(): void {
    if (this.disposed) return;
    if (!this.xrSession) this.localPose = this.desktopPose();
    if (!this.inputEnabled || !this.isAligned()) this.localPose.tracked = false;
    this.localPose.spaceRevision = this.space.revision;
    if (!validPose(this.localPose, spaceBounds(this.space))) this.localPose = { ...this.desktopPose(), source: this.xrSession ? 'webxr' : 'desktop', tracked: false };
    this.localPose.seq = ++this.seq;
    if (this.lastTracking !== this.localPose.tracked || this.lastTrackingSource !== this.localPose.source) {
      this.lastTracking = this.localPose.tracked;
      this.lastTrackingSource = this.localPose.source;
      this.onTracking?.(this.localPose.tracked, this.localPose.source);
    }
    this.onPose?.(structuredClone(this.localPose));
    this.lastPublished = performance.now();
  }

  private tick = (now: number, frame?: XRFrame): void => {
    if (this.disposed) return;
    const dt = Math.min(Math.max((now - this.lastFrame) / 1000, 0), 0.05);
    this.lastFrame = now;
    if (frame && this.xrSession) {
      try { this.readXR(frame); }
      catch { this.rawXRHead = null; this.localPose.tracked = false; }
    }
    else if (!this.xrSession) {
      if (this.inputEnabled && this.isAligned() && this.focused && !editable(document.activeElement)) {
        let dx = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
        let dz = Number(this.keys.has('KeyS')) - Number(this.keys.has('KeyW'));
        const length = Math.hypot(dx, dz);
        if (length > 0) {
          dx /= length; dz /= length;
          if (this.viewMode === 'first-person') {
            const localX = dx;
            dx = Math.cos(this.yaw) * localX + Math.sin(this.yaw) * dz;
            dz = -Math.sin(this.yaw) * localX + Math.cos(this.yaw) * dz;
          }
          this.move(dx * dt * 1.1, dz * dt * 1.1);
        }
        this.yaw += (Number(this.keys.has('KeyQ')) - Number(this.keys.has('KeyE'))) * dt * 1.8;
      }
      this.localPose = this.desktopPose();
      if (this.viewMode === 'observer') this.controls.update();
      else {
        this.camera.position.fromArray(this.localPose.head.position);
        this.camera.quaternion.fromArray(this.localPose.head.orientation);
      }
    }
    placeAvatar(this.local, this.localPose, 1);
    const insideAvatar = !!this.xrSession || this.viewMode === 'first-person';
    this.local.group.visible = !this.xrSession || this.localPose.tracked;
    this.local.head.visible = this.local.body.visible = this.local.label.visible = this.local.ring.visible = !insideAvatar;
    this.local.ring.material.opacity = this.connected ? 0.55 : 0.25;
    this.local.pulse.visible = now < this.localPulseUntil;
    if (this.local.pulse.visible) animatePulse(this.local, now, this.localPulseUntil);
    const showRemote = this.remoteAllowed && !!this.remotePose && this.isAligned();
    this.remote.group.visible = showRemote;
    let remoteFresh = false;
    if (showRemote && this.remotePose) {
      const fresh = this.remotePose.tracked && now - this.remoteReceived < POSE_STALE_MS;
      remoteFresh = fresh;
      placeAvatar(this.remote, this.remotePose, 1 - Math.exp(-dt * 20));
      setAvatarOpacity(this.remote, fresh ? 1 : 0.17);
      this.remote.pulse.visible = fresh && now < this.remotePulseUntil;
      if (this.remote.pulse.visible) animatePulse(this.remote, now, this.remotePulseUntil);
    }
    this.updateRemoteVideo(remoteFresh, now);
    this.updateXRHints();
    if (performance.now() - this.lastPublished >= 50) this.publishNow();
    this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    if (this.xrSession) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight || 520);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private setHandExtended(extended: boolean): void {
    if (this.handExtended === extended) return;
    this.handExtended = extended;
    this.onHandChange?.(extended);
  }
  private releaseInputs(): void {
    this.keys.clear();
    this.setHandExtended(false);
    if (this.drag && this.renderer.domElement.hasPointerCapture(this.drag.id)) this.renderer.domElement.releasePointerCapture(this.drag.id);
    this.drag = null;
  }

  private pointerdown = (event: PointerEvent): void => {
    if (this.viewMode !== 'first-person' || this.xrSession || !this.inputEnabled || !this.isAligned() || event.button !== 0) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.renderer.domElement.focus({ preventScroll: true });
  };
  private pointermove = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.id) return;
    this.yaw -= (event.clientX - this.drag.x) * 0.004;
    this.pitch = THREE.MathUtils.clamp(this.pitch - (event.clientY - this.drag.y) * 0.004, -1.15, 1.15);
    this.drag.x = event.clientX;
    this.drag.y = event.clientY;
  };
  private pointerup = (event: PointerEvent): void => {
    if (this.drag?.id !== event.pointerId) return;
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) this.renderer.domElement.releasePointerCapture(event.pointerId);
    this.drag = null;
  };

  private keydown = (event: KeyboardEvent): void => {
    if (!this.inputEnabled || !this.isAligned() || this.xrSession || editable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'Space' && event.target instanceof Element && event.target.closest('button, a')) return;
    if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space'].includes(event.code)) return;
    event.preventDefault();
    this.keys.add(event.code);
    if (event.code === 'Space') this.setHandExtended(true);
  };
  private keyup = (event: KeyboardEvent): void => {
    const wasHeld = this.keys.delete(event.code);
    if (event.code === 'Space' && wasHeld) { this.setHandExtended(false); this.publishNow(); }
  };
  private blur = (): void => {
    this.focused = false;
    this.releaseInputs();
    // An immersive session can remain visible while the desktop window loses focus.
    if (!this.xrSession) { this.localPose.tracked = false; this.publishNow(); }
  };
  private focus = (): void => { this.focused = true; if (!this.xrSession) this.publishNow(); };
  private visibility = (): void => {
    if (this.xrSession) return;
    if (document.visibilityState === 'hidden') { this.focused = false; this.releaseInputs(); this.localPose.tracked = false; this.publishNow(); }
    else { this.focused = document.hasFocus(); this.publishNow(); }
  };
  private xrVisibility = (): void => {
    if (this.xrSession?.visibilityState !== 'visible') {
      this.localPose = { ...this.localPose, tracked: false };
      this.publishNow();
    }
  };
  private xrReferenceReset = (): void => {
    // A runtime relocalization changes local-floor coordinates; the previous manual map is invalid.
    this.xrAlignment = null;
    this.xrReadyRequested = false;
    this.rawXRHead = null;
    this.rawXRHeadAt = 0;
    this.localPose.tracked = false;
    this.clearPulses();
    this.reportAlignment();
    this.publishNow();
  };
  private overlaySelect = (event: Event): void => { if (this.xrSession?.domOverlayState) event.preventDefault(); };
  private xrSelect = (): void => {
    if (!this.xrSession || this.xrSession.visibilityState !== 'visible' || !this.spaceLoaded || this.spaceLoading) return;
    if (!this.xrAlignment) { this.alignXR(); return; }
    if (!this.inputEnabled && this.onXRReadyRequest) {
      this.xrReadyRequested = true;
      this.onXRReadyRequest();
    }
  };
  private xrEnded = (): void => {
    this.xrSession?.removeEventListener('visibilitychange', this.xrVisibility);
    this.xrSession?.removeEventListener('select', this.xrSelect);
    this.xrOverlayRoot?.removeEventListener('beforexrselect', this.overlaySelect);
    this.xrOverlayRoot = null;
    this.xrReference?.removeEventListener('reset', this.xrReferenceReset);
    this.xrReference = null;
    const wasActive = !!this.xrSession;
    this.xrSession = null;
    this.xrMode = null;
    this.xrAlignment = null;
    this.rawXRHead = null;
    this.rawXRHeadAt = 0;
    this.xrReadyRequested = false;
    this.xrHints.visible = false;
    this.rig.position.set(0, 0, 0);
    this.rig.quaternion.identity();
    this.restoreDesktopView();
    this.updateRoomVisibility();
    this.scene.background = new THREE.Color('#efeee8');
    this.renderer.setClearColor(0xefeee8, 1);
    this.releaseInputs();
    this.focused = document.hasFocus();
    this.localPose = this.desktopPose();
    this.reportAlignment();
    this.publishNow();
    this.resize();
    if (wasActive) this.onXREnd?.();
  };
}

const CORAL = '#cf8273';
const SAGE = '#759884';
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

type Avatar = {
  group: THREE.Group; head: THREE.Group; body: THREE.Group; left: THREE.Mesh; right: THREE.Mesh;
  arms: [THREE.Mesh, THREE.Mesh]; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  pulse: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>; label: THREE.Sprite;
  colored: THREE.MeshStandardMaterial[]; materials: THREE.Material[];
};

function standard(color: THREE.ColorRepresentation, roughness = 0.8, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}
function box(w: number, h: number, d: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
function roundedBox(w: number, h: number, d: number, radius: number, material: THREE.Material): THREE.Mesh {
  const r = Math.min(radius, w / 2, h / 2);
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + r, -h / 2);
  shape.lineTo(w / 2 - r, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  shape.lineTo(w / 2, h / 2 - r);
  shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  shape.lineTo(-w / 2 + r, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  shape.lineTo(-w / 2, -h / 2 + r);
  shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: d - 0.025, bevelEnabled: true, bevelThickness: 0.0125, bevelSize: 0.0125, bevelSegments: 2, steps: 1, curveSegments: 5 });
  geometry.translate(0, 0, -d / 2 + 0.0125);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
function cylinderBetween(start: THREE.Vector3, end: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 12), material);
  positionCylinder(mesh, start, end);
  return mesh;
}
function positionCylinder(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3): void {
  const delta = end.clone().sub(start);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.scale.y = delta.length();
  if (delta.lengthSq() > 1e-8) mesh.quaternion.setFromUnitVectors(UP, delta.normalize());
}
function toPose(position: THREE.Vector3, q: THREE.Quaternion): Pose {
  return { position: position.toArray() as Vec3, orientation: q.toArray() as [number, number, number, number] };
}
function editable(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"]');
}
function makeLabel(text: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法绘制空间标签，请检查图形加速设置。');
  context.fillStyle = '#fffdf5';
  context.beginPath();
  if (typeof context.roundRect === 'function') context.roundRect(10, 10, 364, 76, 38);
  else context.rect(10, 10, 364, 76);
  context.fill();
  context.fillStyle = color;
  context.beginPath();
  context.arc(50, 48, 9, 0, Math.PI * 2);
  context.fill();
  context.font = '500 30px "Microsoft YaHei", "PingFang SC", sans-serif';
  context.fillStyle = '#34473e';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 213, 49);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeBillboard(text: string, color: string, width: number): THREE.Sprite {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeLabel(text, color), transparent: true, depthWrite: false }));
  sprite.scale.set(width, width / 4, 1);
  return sprite;
}

function createAvatar(color: string, label: string): Avatar {
  const group = new THREE.Group();
  const coloredMaterial = standard(color, 0.65);
  const handMaterial = standard(color, 0.5);
  const cream = standard('#f8ebd6', 0.6);
  const dark = standard('#44544c');
  const head = new THREE.Group();
  const headShape = new THREE.Mesh(new THREE.SphereGeometry(0.18, 32, 24), cream);
  headShape.scale.set(0.9, 1.07, 0.91);
  head.add(headShape);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.166, 28, 20, Math.PI / 2, Math.PI, 0.3, 1.6), coloredMaterial);
  visor.rotation.y = Math.PI;
  visor.position.y = 0.034;
  head.add(visor);
  for (const x of [-0.055, 0.055]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 10), dark);
    eye.position.set(x, 0.012, -0.156);
    head.add(eye);
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), cream);
  nose.position.set(0, -0.02, -0.17);
  head.add(nose);
  const body = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.175, 0.31, 8, 20), coloredMaterial);
  torso.position.y = -0.48;
  torso.scale.z = 0.72;
  body.add(torso);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.13, 16), cream);
  neck.position.y = -0.22;
  body.add(neck);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.48, 6, 14), dark);
    leg.position.set(side * 0.096, -1.04, 0.01);
    const shoe = roundedBox(0.14, 0.12, 0.25, 0.045, cream);
    shoe.position.set(side * 0.096, -1.38, -0.05);
    body.add(leg, shoe);
  }
  const left = new THREE.Mesh(new THREE.SphereGeometry(0.078, 20, 16), handMaterial);
  const right = new THREE.Mesh(new THREE.SphereGeometry(0.078, 20, 16), handMaterial);
  const armMaterial = standard(color, 0.7);
  const arms: [THREE.Mesh, THREE.Mesh] = [
    new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.055, 1, 14), armMaterial),
    new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.055, 1, 14), armMaterial),
  ];
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.28, 48), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, wireframe: true, depthWrite: false }));
  pulse.visible = false;
  const nameSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeLabel(label, color), transparent: true, depthTest: false, depthWrite: false }));
  nameSprite.scale.set(0.9, 0.225, 1);
  nameSprite.renderOrder = 10;
  group.add(head, body, left, right, ...arms, ring, pulse, nameSprite);
  const materials: THREE.Material[] = [];
  group.traverse(object => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = object !== pulse && object !== ring;
      const material = object.material as THREE.Material;
      material.transparent = true;
      if (!materials.includes(material)) materials.push(material);
    }
  });
  materials.push(nameSprite.material);
  return { group, head, body, left, right, arms, ring, pulse, label: nameSprite, colored: [coloredMaterial, handMaterial, armMaterial], materials };
}

function recolorAvatar(avatar: Avatar, color: string, label: string): void {
  avatar.colored.forEach(material => material.color.set(color));
  avatar.ring.material.color.set(color);
  avatar.pulse.material.color.set(color);
  avatar.label.material.map?.dispose();
  avatar.label.material.map = makeLabel(label, color);
  avatar.label.material.needsUpdate = true;
}

function placeAvatar(avatar: Avatar, pose: PoseFrame, alpha: number): void {
  const headP = new THREE.Vector3(...pose.head.position);
  const headQ = new THREE.Quaternion(...pose.head.orientation);
  avatar.head.position.lerp(headP, alpha);
  avatar.head.quaternion.slerp(headQ, alpha);
  avatar.body.position.copy(avatar.head.position);
  // This is only a body proxy; scaling keeps its feet near the local-floor reference.
  avatar.body.scale.y = Math.max(0.4, avatar.head.position.y / 1.55);
  const forward = FORWARD.clone().applyQuaternion(avatar.head.quaternion);
  const yaw = Math.atan2(-forward.x, -forward.z);
  avatar.body.rotation.y = yaw;
  avatar.left.position.lerp(new THREE.Vector3(...pose.left.position), alpha);
  avatar.right.position.lerp(new THREE.Vector3(...pose.right.position), alpha);
  avatar.left.quaternion.slerp(new THREE.Quaternion(...pose.left.orientation), alpha);
  avatar.right.quaternion.slerp(new THREE.Quaternion(...pose.right.orientation), alpha);
  const shoulderQ = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  const shoulderLeft = new THREE.Vector3(-0.18, -0.35, 0).applyQuaternion(shoulderQ).add(avatar.head.position);
  const shoulderRight = new THREE.Vector3(0.18, -0.35, 0).applyQuaternion(shoulderQ).add(avatar.head.position);
  positionCylinder(avatar.arms[0], shoulderLeft, avatar.left.position);
  positionCylinder(avatar.arms[1], shoulderRight, avatar.right.position);
  avatar.ring.position.set(avatar.head.position.x, 0.055, avatar.head.position.z);
  avatar.label.position.copy(avatar.head.position).add(new THREE.Vector3(0, 0.42, 0));
  avatar.pulse.position.copy(avatar.right.position);
}

function setAvatarOpacity(avatar: Avatar, opacity: number): void {
  avatar.materials.forEach(material => {
    material.opacity = material === avatar.ring.material ? opacity * 0.55 : opacity;
  });
}
function animatePulse(avatar: Avatar, now: number, until: number): void {
  const progress = 1 - Math.max(0, (until - now) / 500);
  avatar.pulse.scale.setScalar(1 + progress * 2.5);
  avatar.pulse.material.opacity = (1 - progress) * 0.5;
}

function makeScreenTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 576;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器无法绘制共享屏幕，请检查图形加速设置。');
  const gradient = ctx.createLinearGradient(0, 0, 1024, 576);
  gradient.addColorStop(0, '#233f35');
  gradient.addColorStop(1, '#587767');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1024, 576);
  ctx.strokeStyle = '#b8c9b645';
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.ellipse(760, 440, 130 + i * 36, 130 + i * 36, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#e7ecdc';
  ctx.font = '400 84px Georgia, serif';
  ctx.fillText('rove', 90, 235);
  ctx.fillStyle = '#c7d5c5';
  ctx.font = '26px "Microsoft YaHei", sans-serif';
  ctx.fillText('一起，把此刻留在这里。', 94, 305);
  ctx.font = '18px sans-serif';
  ctx.fillStyle = '#a9bdac';
  ctx.fillText('A SHARED MOMENT', 96, 410);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
