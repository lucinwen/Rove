import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Pose, PoseFrame, RoomPreset, Role, Vec3 } from '../../shared/protocol.ts';
import { POSE_STALE_MS } from '../../shared/protocol.ts';
import { validPose } from '../../shared/validation.ts';

/** A procedural room and head/hand avatar view. Geometry is not a scan or body reconstruction. */
export class RoveScene {
  onPose: ((pose: PoseFrame) => void) | null = null;
  onTracking: ((tracked: boolean, source: 'desktop' | 'webxr') => void) | null = null;
  onXREnd: (() => void) | null = null;
  onHandChange: ((extended: boolean) => void) | null = null;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.04, 60);
  private readonly rig = new THREE.Group();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly room = new THREE.Group();
  private readonly screen = new THREE.Group();
  private readonly local: Avatar;
  private readonly remote: Avatar;
  private readonly observer: ResizeObserver;
  private readonly keys = new Set<string>();
  private readonly screenMaterial: THREE.MeshBasicMaterial;
  private readonly accentMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly screenPlaceholder: THREE.CanvasTexture;
  private videoTexture: THREE.VideoTexture | null = null;
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
  private xrNeedsRecenter = false;
  private xrTargetYaw = 0;
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
    this.scene.add(this.rig, this.room, this.screen);
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
    this.renderer.setAnimationLoop(this.tick);
  }

  setPreset(preset: RoomPreset): void {
    this.preset = preset;
    const color = preset === 'rose' ? '#d8a89d' : '#a6b9a7';
    this.accentMaterials.forEach(material => material.color.set(color));
  }

  setRole(role: Role): void {
    this.role = role;
    recolorAvatar(this.local, role === 'host' ? CORAL : SAGE, role === 'host' ? '你 · 主场' : '你 · 来访');
    recolorAvatar(this.remote, role === 'host' ? SAGE : CORAL, role === 'host' ? '对方 · 来访' : '对方 · 主场');
    this.recenter();
  }

  setRemotePose(pose: PoseFrame | null): void {
    if (!pose) {
      this.remotePose = null;
      this.remote.group.visible = false;
      return;
    }
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
    }
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
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
    if (!this.inputEnabled || this.xrSession || !Number.isFinite(dx) || !Number.isFinite(dz)) return;
    this.x = THREE.MathUtils.clamp(this.x + THREE.MathUtils.clamp(dx, -0.25, 0.25), -2.05, 2.05);
    this.z = THREE.MathUtils.clamp(this.z + THREE.MathUtils.clamp(dz, -0.25, 0.25), -2.05, 2.05);
    this.localPose = this.desktopPose();
  }

  extendHand(extended: boolean): void {
    if (!this.inputEnabled || this.xrSession) return;
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
    this.x = this.role === 'host' ? -0.65 : 0.65;
    this.z = 0.4;
    this.yaw = 0;
    this.releaseInputs();
    if (this.xrSession) {
      this.xrNeedsRecenter = true;
      this.xrTargetYaw = 0;
    } else {
      this.localPose = this.desktopPose();
      this.publishNow();
    }
  }

  /** Desktop rehearsal position, not an inferred physical movement or room calibration. */
  approach(): void {
    if (!this.inputEnabled || this.xrSession) return;
    this.x = this.role === 'host' ? -0.42 : 0.42;
    this.z = 0.1;
    this.yaw = this.role === 'host' ? -Math.PI / 2 : Math.PI / 2;
    this.setHandExtended(false);
    this.keys.clear();
    this.localPose = this.desktopPose();
    this.renderer.domElement.focus({ preventScroll: true });
    this.publishNow();
  }

  async startXR(mode: 'immersive-vr' | 'immersive-ar'): Promise<void> {
    if (!this.inputEnabled) throw new Error('请先加入双人空间，再进入头显模式。');
    if (this.xrSession) return;
    if (this.xrStarting) throw new Error('头显会话正在启动，请稍等。');
    if (!window.isSecureContext) throw new Error('头显模式需要 HTTPS 或 localhost 安全连接。');
    const generation = ++this.xrGeneration;
    this.xrStarting = true;
    let session: XRSession | null = null;
    try {
      if (!navigator.xr || !(await navigator.xr.isSessionSupported(mode))) {
        throw new Error(mode === 'immersive-ar' ? '当前设备或浏览器未提供 WebXR AR 模式。' : '当前设备或浏览器未提供 WebXR VR 模式。');
      }
      if (!this.inputEnabled || this.disposed || generation !== this.xrGeneration) throw new Error('会话已结束，头显启动已取消。');
      session = await navigator.xr.requestSession(mode, {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking', 'dom-overlay'],
        domOverlay: { root: this.container.parentElement ?? this.container },
      });
      if (!this.inputEnabled || this.disposed || generation !== this.xrGeneration) throw new Error('会话已结束，头显启动已取消。');
      this.desktopCamera.copy(this.camera.position);
      this.desktopTarget.copy(this.controls.target);
      this.controls.enabled = false;
      this.xrSession = session;
      this.xrNeedsRecenter = true;
      this.xrTargetYaw = this.yaw;
      this.releaseInputs();
      this.camera.position.set(0, 0, 0);
      this.camera.quaternion.identity();
      this.room.visible = mode !== 'immersive-ar';
      this.scene.background = mode === 'immersive-ar' ? null : new THREE.Color('#efeee8');
      this.scene.fog = mode === 'immersive-ar' ? null : new THREE.Fog('#efeee8', 15, 30);
      this.renderer.setClearColor(mode === 'immersive-ar' ? 0x000000 : 0xefeee8, mode === 'immersive-ar' ? 0 : 1);
      session.addEventListener('end', this.xrEnded, { once: true });
      session.addEventListener('visibilitychange', this.xrVisibility);
      await this.renderer.xr.setSession(session);
      if (!this.inputEnabled || this.disposed || generation !== this.xrGeneration || this.xrSession !== session) {
        throw new Error('会话已结束，头显启动已取消。');
      }
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
    this.renderer.setAnimationLoop(null);
    if (this.xrSession) void this.xrSession.end();
    this.observer.disconnect();
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    window.removeEventListener('blur', this.blur);
    window.removeEventListener('focus', this.focus);
    document.removeEventListener('visibilitychange', this.visibility);
    this.controls.dispose();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite || object instanceof THREE.LineSegments) {
        if ('geometry' in object) object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
    });
    materials.forEach(material => {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    });
    textures.add(this.screenPlaceholder);
    if (this.videoTexture) textures.add(this.videoTexture);
    textures.forEach(texture => texture.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight('#fff5e6', '#c3c9c3', 2.4));
    const sun = new THREE.DirectionalLight('#fff6e5', 3.8);
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
    const q = new THREE.Quaternion().setFromAxisAngle(UP, this.yaw);
    const head = new THREE.Vector3(this.x, 1.55, this.z);
    const left = new THREE.Vector3(-0.28, -0.45, -0.05).applyQuaternion(q).add(head);
    const right = new THREE.Vector3(...(this.handExtended ? [0.06, -0.28, -0.42] : [0.28, -0.45, -0.05]) as [number, number, number]).applyQuaternion(q).add(head);
    return {
      head: toPose(head, q), left: toPose(left, q), right: toPose(right, q),
      source: 'desktop', tracked: this.inputEnabled && this.focused && document.visibilityState !== 'hidden', seq: this.seq,
    };
  }

  private readXR(frame: XRFrame): void {
    const ref = this.renderer.xr.getReferenceSpace();
    if (!ref || !this.xrSession || this.xrSession.visibilityState !== 'visible') {
      this.localPose = { ...this.localPose, source: 'webxr', tracked: false };
      return;
    }
    const viewer = frame.getViewerPose(ref);
    if (!viewer) {
      this.localPose = { ...this.localPose, source: 'webxr', tracked: false };
      return;
    }
    if (this.xrNeedsRecenter) {
      const t = viewer.transform;
      const viewQ = new THREE.Quaternion(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
      const measuredYaw = new THREE.Euler().setFromQuaternion(viewQ, 'YXZ').y;
      this.rig.rotation.y = this.xrTargetYaw - measuredYaw;
      const horizontalOrigin = new THREE.Vector3(t.position.x, 0, t.position.z).applyQuaternion(this.rig.quaternion);
      this.rig.position.set(this.x - horizontalOrigin.x, 0, this.z - horizontalOrigin.z);
      this.rig.updateMatrixWorld(true);
      this.xrNeedsRecenter = false;
    }
    const worldPose = (transform: XRRigidTransform): Pose => {
      const p = new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z).applyQuaternion(this.rig.quaternion).add(this.rig.position);
      const q = new THREE.Quaternion(transform.orientation.x, transform.orientation.y, transform.orientation.z, transform.orientation.w).premultiply(this.rig.quaternion);
      return toPose(p, q);
    };
    const head = worldPose(viewer.transform);
    let left: Pose | null = null;
    let right: Pose | null = null;
    for (const source of this.xrSession.inputSources) {
      let trackedPose: XRPose | null = null;
      if (source.gripSpace) trackedPose = frame.getPose(source.gripSpace, ref) ?? null;
      else if (source.hand) {
        const wrist = source.hand.get('wrist');
        if (wrist) trackedPose = frame.getJointPose?.(wrist, ref) ?? null;
      }
      if (!trackedPose) continue;
      if (source.handedness === 'left') left = worldPose(trackedPose.transform);
      if (source.handedness === 'right') right = worldPose(trackedPose.transform);
    }
    // Never synthesize a tracked hand when an XR input source is absent.
    if (!left || !right) {
      this.localPose = { ...this.localPose, source: 'webxr', tracked: false };
      return;
    }
    const next: PoseFrame = {
      head, left, right,
      source: 'webxr', tracked: this.inputEnabled, seq: this.seq,
    };
    // Reuse the wire validator so loss notices never contain rejected stale-hand geometry.
    if (validPose(next)) this.localPose = next;
    else this.localPose = { ...this.localPose, source: 'webxr', tracked: false };
  }

  private publishNow(): void {
    if (this.disposed) return;
    if (!this.xrSession) this.localPose = this.desktopPose();
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
    if (frame && this.xrSession) this.readXR(frame);
    else if (!this.xrSession) {
      if (this.inputEnabled && this.focused && !editable(document.activeElement)) {
        let dx = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
        let dz = Number(this.keys.has('KeyS')) - Number(this.keys.has('KeyW'));
        const length = Math.hypot(dx, dz);
        if (length > 0) { dx /= length; dz /= length; this.move(dx * dt * 1.1, dz * dt * 1.1); }
        this.yaw += (Number(this.keys.has('KeyQ')) - Number(this.keys.has('KeyE'))) * dt * 1.8;
      }
      this.localPose = this.desktopPose();
      this.controls.update();
    }
    placeAvatar(this.local, this.localPose, 1);
    this.local.group.visible = !this.xrSession;
    this.local.ring.material.opacity = this.connected ? 0.55 : 0.25;
    this.local.pulse.visible = now < this.localPulseUntil;
    if (this.local.pulse.visible) animatePulse(this.local, now, this.localPulseUntil);
    const showRemote = this.remoteAllowed && !!this.remotePose;
    this.remote.group.visible = showRemote;
    if (showRemote && this.remotePose) {
      const fresh = this.remotePose.tracked && now - this.remoteReceived < POSE_STALE_MS;
      placeAvatar(this.remote, this.remotePose, 1 - Math.exp(-dt * 20));
      setAvatarOpacity(this.remote, fresh ? 1 : 0.17);
      this.remote.pulse.visible = fresh && now < this.remotePulseUntil;
      if (this.remote.pulse.visible) animatePulse(this.remote, now, this.remotePulseUntil);
    }
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
  private releaseInputs(): void { this.keys.clear(); this.setHandExtended(false); }

  private keydown = (event: KeyboardEvent): void => {
    if (!this.inputEnabled || this.xrSession || editable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
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
  private xrEnded = (): void => {
    this.xrSession?.removeEventListener('visibilitychange', this.xrVisibility);
    const wasActive = !!this.xrSession;
    this.xrSession = null;
    this.rig.position.set(0, 0, 0);
    this.rig.quaternion.identity();
    this.camera.position.copy(this.desktopCamera);
    this.controls.target.copy(this.desktopTarget);
    this.controls.enabled = true;
    this.controls.update();
    this.room.visible = true;
    this.scene.background = new THREE.Color('#efeee8');
    this.scene.fog = new THREE.Fog('#efeee8', 15, 30);
    this.renderer.setClearColor(0xefeee8, 1);
    this.releaseInputs();
    this.focused = document.hasFocus();
    this.localPose = this.desktopPose();
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
