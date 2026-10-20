# Rove 协议 v1 · 应用 v0.2

文档日期：2026-10-20。协议真源是 [shared/protocol.ts](../shared/protocol.ts)、[shared/validation.ts](../shared/validation.ts)、[shared/space.ts](../shared/space.ts)、[shared/glb.ts](../shared/glb.ts)、[server/index.ts](../server/index.ts) 和 [server/space-assets.ts](../server/space-assets.ts)。前端接收和本地输出行为见 [web/src/main.ts](../web/src/main.ts)、[web/src/media.ts](../web/src/media.ts)、[web/src/haptics.ts](../web/src/haptics.ts)。

本协议服务一个内存中的双人研究原型。没有账户登录、数据库、离线消息、会话恢复令牌或生产级多人会议路由。v0.2 增加空间提案、GLB 临时文件和屏幕共享，欢迎包仍标记 `protocol: 1`。旧格式姿态只兼容初始 `space.revision === 0` 的样例空间；换空间后客户端必须实现新版本和就位检查。`sessionToken` 是当前连接的 HTTP 访问凭据，不是恢复会话的令牌。

## 1. HTTP 与 WebSocket 入口

| 入口 | 方法／传输 | 行为 |
|---|---|---|
| `/api/health` | GET／HEAD | 返回 `ok: true`、`protocol: 1`、`mode: "research-prototype"` |
| `/api/config` | GET／HEAD | 返回 `iceServers`、`protocol: 1`、`maxParticipants: 2`、`maxSpaceBytes: 20971520` |
| `/api/spaces` | POST | 使用当前连接的 Bearer 凭据上传内嵌资源的 GLB；只允许已加入房间的成员 |
| `/api/spaces/:assetId` | GET／HEAD | 相同鉴权；只有该模型所属房间的现有成员可以读取 |
| `/ws` | WebSocket | UTF-8 JSON 文本消息，双向交换会话、位姿、信令、播放和触碰事件 |
| `/research/` | GET／HEAD | 保留的原站首页 |
| `/research/<允许的文件>` | GET／HEAD | 原 HTML、场景图及 `papers/*.pdf` 白名单 |
| `/` 及构建静态资源 | GET／HEAD | 开发时由 Vite 服务，生产时读取 `dist/` |

`TURN_URL` 支持逗号分隔的 `turn:`／`turns:` URL，另需 `TURN_USERNAME` 和 `TURN_CREDENTIAL`。三者不足时，`iceServers` 为空数组。配置会下发给每个浏览器客户端，只能放给客户端使用的受限凭据。应用自身不发放短时凭据，需要部署方配置相应服务。

WebSocket 升级只接受与请求 Host 匹配的 HTTP(S) Origin，或明确列入 `ALLOWED_ORIGINS` 的完整 origin。默认拒绝缺少 Origin 的请求；服务端测试可显式设置 `allowMissingOrigin`。来源不允许返回 HTTP 403，达到 64 个连接的上限返回 HTTP 503。

消息最大为 64 KiB；每个连接每约 1 秒窗口最多 120 条消息，超出以代码 `1008` 关闭。姿态另有限额，见下文。缓冲积压超过 256 KiB 的服务端接收对象以 `1013` 关闭。两分钟没有收到客户端应用消息时以 `1001` 关闭。服务端另每约 15 秒发 WebSocket ping 检查存活。后台维护默认每 250 毫秒运行一次。

所有客户端消息使用闭合字段校验：多余字段、未知类型、非法数值或结构被拒绝。不要给现有消息擅自追加调试字段；如需扩展，必须同步修改协议和校验器。

## 2. 身份、房间与生命周期

- 建立 WebSocket 后收到 `welcome`。`peerId` 是本连接的 UUID；`sessionToken` 由 32 个随机字节生成，为 64 位小写十六进制字符串，仅发给该连接。重新连接会获得新 ID 和新凭据。
- 房间 ID 为 32 位小写十六进制字符串，由 16 个随机字节生成。房间码是进入凭据，不是展示用短码。
- 一个连接同时只能属于一个房间。创建者为 `host`，加入者为 `guest`；最多两名成员。这里的 role 表示会话身份；当前空间的提供者由 `space.ownerId` 独立表示，guest 可以提供主场而不改变会话创建者。
- `inspect` 只返回房间预设和是否有空位，不返回成员昵称或身份。
- `join` 是协议上的接受并加入动作。界面提供单独的同意复选框，但服务端不具有证明操作者真实点击过复选框的机制。
- 会话创建者退出或断连会结束整个房间，清除该房间所有模型。guest 退出后，创建者仍留在房间等待；guest 上传的模型立即删除。若当前空间由 guest 提供，会回到创建者的样例空间，空间 revision 递增，重新等待就位。
- 参与者变化时清除旧姿态、触碰授权、待执行请求、空间提案和屏幕共享。新来访者不能继承上一位的许可；已在同一空间就位的剩余成员保留就位状态。
- 房间从创建起最多保留约两小时；服务重启丢失全部房间。连接重建不自动恢复房间或设备。

### 客户端会话消息

| `type` | 其余字段 | 结果 |
|---|---|---|
| `create` | `name: string, preset: "rose" \| "sage"` | 创建房间，成为会话创建者及初始空间提供者 |
| `inspect` | `roomId: string` | 查询预览，不加入 |
| `join` | `roomId: string, name: string` | 接受邀请并加入 |
| `leave` | 无 | 离开当前房间；尚未加入时为无操作 |
| `consent` | `enabled: boolean` | 本人允许／撤回触碰请求 |
| `stop` | 无 | 暂停会话、暂停播放、撤回双方触碰许可 |
| `resume` | 无 | 解除暂停；双方触碰许可仍保持关闭 |
| `ping` | `sentAt: number` | 返回时间回声与服务端时间，可在加入前发送 |

昵称长度为 1–24 个 JavaScript 字符计数单位，去掉首尾空白后不能为空，禁止控制字符。预设只影响样例场景，不代表真实房间来源。

### 服务端会话消息

```ts
type Member = { id: string; name: string; role: 'host' | 'guest'; consent: boolean };
type Playback = { playing: boolean; position: number; updatedAt: number; revision: number };
type RoomState = {
  id: string;
  preset: 'rose' | 'sage';
  members: Member[];
  playback: Playback;
  touchEnabled: boolean;
  stopped: boolean;
  space: RoomSpace;
  spaceProposal: SpaceProposal | null;
  spaceReady: string[]; // 当前空间已就位的成员 ID
  presentation: { ownerId: string | null; revision: number };
};
```

| `type` | 其余字段 | 用途 |
|---|---|---|
| `welcome` | `peerId, protocol: 1, sessionToken` | 新连接身份及仅本人可见的 HTTP 凭据 |
| `preview` | `roomId, preset, available` | 邀请预览 |
| `joined` | `selfId, state, serverTime` | 本人进入成功 |
| `state` | `state, serverTime` | 房间成员、空间、提案、就位、屏幕占用、许可和暂停状态 |
| `ended` | `reason` | 会话结束／本人离开 |
| `pong` | `sentAt, serverTime` | 回声及服务端时钟参考 |
| `error` | `code, message` | 本次操作失败；除另有关闭行为外，连接可继续使用 |

`touchEnabled` 由服务端派生：恰有两人、未暂停、两人已在当前空间就位且两人 `consent` 均为 true。初始 revision 0 自动就位。该字段不包含追踪新鲜度，真正产生触碰请求时还会检查两人有效姿态。客户端不能直接设置该字段。

## 3. 位姿协议

```json
{
  "type": "pose",
  "pose": {
    "head": { "position": [-0.65, 1.6, 0.4], "orientation": [0, 0, 0, 1] },
    "left": { "position": [-0.85, 1.2, 0.4], "orientation": [0, 0, 0, 1] },
    "right": { "position": [-0.45, 1.2, 0.4], "orientation": [0, 0, 0, 1] },
    "source": "desktop",
    "tracked": true,
    "seq": 1,
    "spaceRevision": 0
  }
}
```

| 字段／规则 | 定义 |
|---|---|
| `position` | `[x,y,z]`，单位米；右手坐标系，`+Y` 向上 |
| `orientation` | 四元数 `[x,y,z,w]`；每项为有限数，模长允许 `0.9–1.1`；服务端不代替发送者归一化 |
| 空间范围 | 按当前 `room.space` 检查：`x` 为 `[-width/2,width/2]`，`z` 为 `[-depth/2,depth/2]`，`y` 为 `[0,height]`；初始样例为 `±2.6 m`、`0–2.8 m` |
| 手部范围 | 每只手到头部的位置距离不超过 `1.65 m`；这是原型输入约束，不是个人人体测量 |
| `source` | 只允许 `desktop` 或 `webxr` |
| `tracked` | 当前输入是否有效；桌面 true 不代表真实传感器追踪 |
| `seq` | 非负安全整数，在同一成员和空间版本内严格递增；进入会话或切换空间时服务端重置序列起点，客户端可以从 0 开始或继续递增 |
| `spaceRevision` | 当前空间的非负安全整数 revision；省略等同于 0，在 revision 大于 0 的空间必须显式匹配 |
| 频率 | 客户端目标约 20 Hz；服务端每个连接每约 1 秒窗口最多 60 帧 |

服务端转发为 `{ type: "pose", peerId, pose, serverTime }`，`serverTime` 为服务器接收／处理时间。触碰计算使用服务端最后收到有效帧的时间，**不是客户端采样时间**。

`tracked: false` 也必须符合当前坐标范围、四元数和头手距离约束。服务器先核对 revision，再核对双方就位、当前边界和序列。新的空间尚未加载或就位时，客户端暂停发送有效姿态；旧帧、授权和待执行触碰已在空间切换时清空。`RoomState` 从不包含成员姿态，姿态只发给同房间对端。

跟踪新鲜度上限为 `1000 ms`。帧需 `tracked: true` 且距服务端接收不超过此时间，才有触碰资格。客户端同时按自己的接收时间进行淡出，不依赖对端机器时钟。协议 v1 没有设备采样时间戳、传感器置信度或端到端显示确认，不能由该帧直接算动作到画面的单向延迟。

## 4. WebRTC 信令

客户端发送 `{ type: "signal", signal }`；服务端只转发给同房间另一人，包装为 `{ type: "signal", peerId, signal }`。接收客户端确认 `peerId` 是当前对端。

`signal` 的负载必须只包含以下两者之一；另有 `channel` 和屏幕通道的 `presentationRevision`：

```ts
{
  channel?: 'camera' | 'screen'; // 省略等同于 camera
  presentationRevision?: number; // screen 必填；camera 禁止携带
  description: { type: 'offer' | 'answer'; sdp: string };
}
```

或：

```ts
{
  channel?: 'camera' | 'screen';
  presentationRevision?: number;
  candidate: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment?: string | null;
  }
}
```

SDP 必须非空，最多 48,000 个字符。candidate 字符串最多 2,048 字符，`sdpMid` 和 `usernameFragment` 最多 256 字符；`sdpMLineIndex` 为 null 或 0–1024 的整数。最后的 null ICE 事件不发出，空字符串 candidate 可转发。

摄像头／语音通道使用会话 host impolite／guest polite 的 [W3C Perfect Negotiation](https://www.w3.org/TR/webrtc/#perfect-negotiation-example)，串行接收信令、缓存提前到达的候选并处理 offer 冲突。屏幕通道使用独立 PeerConnection，只有当前共享者可以发 offer，对端可以发 answer，双方均可发 ICE；详见屏幕共享一节。SDP/ICE 不等于媒体内容；音视频在 WebRTC 管线传输，姿态和触碰仍走 WebSocket。

创建 PeerConnection 或接收对方 offer 不会自动打开本地设备；只有按钮调用 `enable()` 才请求采集。对端离开或替换后，不自动恢复采集。

## 5. 共享播放与时钟

客户端发送：

```ts
{ type: 'playback'; action: 'play' | 'pause' | 'seek'; position: number }
```

`position` 为秒，范围 `[0,24]`。当前协议固定使用仓库内 24 秒测试片，没有媒体 ID 或任意媒体 URL。两名成员均可控制播放；服务端按实际收到消息的顺序处理，不做共同编辑冲突合并。

服务端生成递增 `revision`，以当前服务端时间写入 `updatedAt`，广播 `{ type: "playback", playback, serverTime }`。暂停时拒绝控制。`seek` 保留此前是否播放；到达 24 秒时自动改为暂停。

播放中的目标位置为：

```text
min(24, max(0, position + max(0, serverNow - updatedAt) / 1000))
```

`ping.sentAt`、`serverTime`、`updatedAt` 和请求失效时间均以毫秒表示；应用默认使用 `Date.now()` 的 Unix epoch 毫秒。客户端 RTT 使用本机 `performance.now()` 的耗时差，按低 RTT 样本估计：

```text
serverOffset ≈ serverTime + RTT / 2 - localReceiveTime
```

这假设往返延迟近似对称，只是原型估计。客户端每约 250 毫秒跟随共享时钟，偏差大于约 250 毫秒或收到强制同步时调整播放器位置。`playbackClockErrorMs` 不等于两端实际显示帧之间的精确差值，RTT 也不等于音频或触觉端到端延迟。

## 6. 逐次触碰协议

### 6.1 接近与请求

仅当双方都在房间、都已在当前空间就位、都允许触碰请求、会话未暂停且双方追踪新鲜时，服务端才比较**双方右手**的位置。进入距离阈值为 `0.22 m`。分离阈值为 `0.32 m`，形成滞回；两轮接触至少间隔 `1500 ms`。

一次接近会生成两条方向相反、各自独立的请求，每名接收者自行选择。连续重叠不会重复触发；要开始新一轮，需要先分开双手再靠近。请求广播给同房间成员，但前端只向对应接收者展示接受／拒绝按钮。

```ts
type TouchRequest = {
  id: string;       // UUID，由服务端生成
  from: string;
  to: string;
  hand: 'left' | 'right'; // v1 当前只生成 right
  expiresAt: number;     // 创建后约 5000 ms
};
// 服务端：{ type: 'touch-request', request: TouchRequest }
// 接收方：{ type: 'touch-response', requestId: string, accepted: boolean }
```

接收方接受时，服务端重新检查接收者身份、请求存在、有效期、双方追踪和许可、暂停状态，以及两手尚未超过分离阈值。请求只能消费一次。拒绝或不再满足条件时广播：

```ts
{ type: 'touch-cancelled'; requestId: string; reason: string }
```

### 6.2 执行事件

通过检查后，只向接收方发：

```ts
{
  type: 'touch';
  event: {
    id: string;        // 与本次请求 ID 相同
    from: string;
    to: string;
    hand: 'right';
    intensity: 0.2;    // 无量纲原型幅值
    durationMs: 100;
    serverTime: number;
  };
}
```

当前客户端检查房间仍允许触碰、来源／接收方匹配，以及估计服务端时间与事件时间相差不超过 `2000 ms`。本地适配器另对最近 100 个事件去重，并将幅值限制到不超过 `0.2`、持续时间不超过 `100 ms`。

视觉输出是默认值。用户明确选择且存在可用游戏手柄时，才尝试浏览器振动 API。取消会使较早的异步完成结果失效；正在执行的手柄输出会请求 reset。驱动或浏览器的实际物理停止性能仍需实测。

### 6.3 输出回执

```ts
// 接收客户端 → 服务端
{ type: 'haptic-result'; eventId: string; mode: 'visual' | 'gamepad'; ok: boolean }

// 服务端 → 房间成员
{ type: 'haptic-result'; peerId: string; eventId: string; mode: 'visual' | 'gamepad'; ok: boolean }
```

服务端只接受已投递给该客户端、仍在投递后约 5 秒回执窗口内的事件，并在收到回执后删除匹配记录。此回执是客户端报告：`visual` 表示画面回应，`gamepad` 表示浏览器 API 完成，不是腕带传感器测量，更不证明人的触觉感知。

## 7. 暂停、撤回与失效

`stop` 设置 `stopped: true`，冻结共享播放位置，清空双方姿态、触碰许可、待接受请求、待确认投递、空间提案和屏幕占用。随附客户端同时停止输入、当前输出和本地媒体采集。`resume` 解除暂停但再次清空姿态和触碰许可；必须等到新的有效帧，设备需要用户再次开启。暂停没有改变空间原点，因此保留当前空间配置、revision 及 `spaceReady`。

服务端在暂停状态下拒绝 `pose` 和所有通道的 `signal`，返回 `STOPPED` 且不转发；播放、重新允许触碰、发起空间提案、确认就位和申请屏幕共享也受此状态门限制。旧空间提案已被清除，不能在恢复后继续接受。客户端暂停时关闭当前 PeerConnection，恢复后可重新建连，但本地麦克风、摄像头和屏幕采集仍需用户再次开启。

任何一方撤回 `consent` 会取消所有尚未完成的请求并清空投递记录。接收者离开、发起者离开、换人、换空间、房间结束、追踪失效或双手分离都不能留下可继续接受的旧请求。客户端断线后停止设备和触觉，重连不自动重新加入。

`consent` 只针对触碰请求。摄像头／麦克风权限属于各端浏览器；服务端没有权限替用户授权，也不能以收到音视频信令推断对方已经同意触碰。

## 8. 共享空间与主场切换

```ts
type SpaceConfig = {
  source: 'sample' | 'measured' | 'glb';
  name: string;
  width: number; depth: number; height: number;
  assetId: string | null;
  scale: number; yaw: number; offset: [number, number, number];
};
type RoomSpace = SpaceConfig & { revision: number; ownerId: string };
type SpaceProposal = {
  id: string;        // 服务端 UUID
  fromId: string;    // 空间提供者
  space: SpaceConfig;
  expiresAt: number; // 创建后 60 秒
};
```

`source` 表示样例、手动输入尺寸的房间或上传的 GLB。尺寸定义双方共同使用的轴对齐可活动范围，原点在地面中央。GLB 按显式 `scale → yaw → offset` 变换到该米制坐标；协议不从模型、视频或相机推断物理单位，也不暗中移动模型中心。普通尺寸房间使用其宽深高生成几何，模型变换字段保留默认值。

| 配置 | 允许值 |
|---|---|
| `name` | 1–64 个 JavaScript 字符计数单位，trim 后非空，无控制字符 |
| `width, depth` | 有限数，`1–20 m` |
| `height` | 有限数，`1.5–5 m` |
| `scale` | 有限数，`0.01–100` |
| `yaw` | 绕 +Y 轴的弧度，`[-π,π]` |
| `offset` | 有限三元组，x/z 各 `±10 m`，y `±5 m` |
| `assetId` | GLB 为 32 位小写十六进制 ID；sample/measured 必须为 null |
| `revision, ownerId` | 由服务器生成；客户端提案携带这两个字段会被拒绝 |

客户端消息：

```ts
{ type: 'space-propose'; space: SpaceConfig }
{ type: 'space-response'; proposalId: string; accepted: boolean }
{ type: 'space-ready'; revision: number }
```

任一成员都可以提供空间。提案要求对方已加入、房间未暂停且没有其他有效提案；GLB 只能由本次会话的上传者提出。模型可以先在单人房间上传暂存，但不能在对方缺席时跳过接受步骤。

服务端广播 `state.spaceProposal`。只有提案之外的另一人能回应；提案 ID、接收者和 60 秒有效期均在回应时重验。拒绝、过期、暂停或成员变化清空提案，当前空间不变。服务器不会把对邀请的接受自动当作对触碰或设备采集的同意。

接受后，服务器更新 `ownerId`，将空间 revision 加一，并清空双方姿态、序列起点、就位记录、触碰授权、触碰请求／投递和屏幕占用。两人使用相同配置和资产加载新场景，加载成功且各自完成校准／就位后分别发送 `space-ready`。服务器仅接受当前 revision；两人未全部就位之前拒绝姿态和开启触碰许可。

初始样例空间为 `5.2 × 5.2 × 2.8 m`、revision 0，进入者自动就位以兼容首版体验。后续任何切换，包括切回样例，revision 都继续递增并要求重新就位。`space-ready` 是客户端确认，服务器不能验证人已在物理空间正确校准；WebXR 的手动对齐和追踪有效性由前端另外检查。

`Member.role` 不随主场切换而变化。它仍决定谁是会话创建者、谁离开会结束房间，以及摄像头通道的协商角色；场景显示的主场标签应读取 `space.ownerId`。

## 9. 模型上传、读取与暂存

### 9.1 HTTP 合同

```http
POST /api/spaces
Authorization: Bearer <welcome.sessionToken>
Content-Type: model/gltf-binary

<原始 GLB 二进制>
```

也接受 `application/octet-stream`。不接受 multipart、JSON/base64 包装、压缩 Content-Encoding 或外部文件 URL。成功返回 HTTP 201：

```json
{
  "assetId": "32位小写十六进制字符串",
  "size": 123456,
  "sha256": "原始文件字节的64位小写SHA256"
}
```

读取使用 `GET /api/spaces/:assetId` 和同样的 Authorization 头。成功返回原始字节、`Content-Type: model/gltf-binary`、精确 Content-Length 和 `Cache-Control: no-store`；HEAD 仅返回头部。不通过静态目录暴露模型，也不接受 URL 查询参数代替凭据。

token 只授权其当前仍存活、仍加入房间的 WebSocket 身份。上传后，同一房间的两位现有成员可以读取；其他房间返回 404，未加入或凭据失效返回 401。token 不包含在广播状态、邀请预览或成员列表中，不应用作分享链接。HTTP 模型接口拒绝不匹配且未配置允许的 Origin；缺少 Origin 的非浏览器客户端仍须通过 Bearer 鉴权。

模型不写入磁盘。创建者结束房间、房间到期或服务器关闭时删除全部房间资产；guest 离开时删除 guest 自己上传的资产。未完成上传同时中断，上传完成前再次核对当前房间身份。停止会话保留暂存文件，恢复不需要重复上传；进入另一个房间不能读取上一房间的资产。

### 9.2 上传与资源上限

| 项目 | 限额／处理 |
|---|---|
| 单文件 | 20 MiB，含 GLB 标头、JSON 与 BIN |
| 每位成员 | 当前会话最多 3 个成功上传；更换当前空间不自动删除此前上传 |
| 同一成员并发上传 | 最多 1 个；重复请求返回 409 |
| 上传尝试频率 | 每位连接每约 60 秒最多 10 次进入上传处理的尝试 |
| 上传期限 | 30 秒 |
| 全局模型内存预算 | 128 MiB，含已保存文件和上传中的预留 |
| 预留方式 | 为分块输入与组装缓冲预留两份文件容量；未知 Content-Length 按单文件上限预留 |
| 超限／中断 | 拒绝请求、释放预留；不会保留半个模型 |

128 MiB 是资产和上传缓冲的应用预算，不是整个 Node 进程内存上限；JSON 解析、WebSocket、框架和运行时另有内存开销。

### 9.3 允许的 GLB 子集

客户端和服务器复用 `validateGLB(ArrayBuffer | Uint8Array)`。成功返回 `{ ok: true, json, byteLength, vertexCount, triangleCount }`，失败返回 `{ ok: false, error }`。当前仅支持便于浏览器直接加载的静态子集：

- GLB 2 标头和 glTF asset 2.0；一个 JSON 区块后接一个内嵌 BIN 区块。长度、顺序、4 字节对齐、BIN 填充和声明的 buffer 范围均检查。
- 只有一个内嵌 buffer。所有 URI，包括 data URI，均拒绝；所有非空 glTF 扩展均拒绝。压缩模型需先导出成普通 GLB。
- 只允许三角形网格、有限顶点数据、合法索引和材质引用。拒绝动画、蒙皮、morph targets、稀疏 accessor 和相机。
- JSON 最多 2 MiB，元数据遍历最多 120,000 项／64 层；节点最多 2,048 个，节点层级最多 48 层，不允许循环或多父节点。
- 最多 4,096 个 bufferView、4,096 个 accessor、512 个 mesh、512 个 primitive。几何及实例累计最多一百万顶点、一百万三角形和 512 次绘制；所有 accessor 的数据分量合计最多一千二百万个。
- 最多 16 个 scene、256 个 material；image、texture、sampler 各最多 32 个。
- 纹理只能是 BIN 中的 PNG/JPEG；每边最多 4,096 像素，所有图片总计最多 16,777,216 像素。拒绝 APNG。
- 节点变换、四元数和累计变换幅度均受限，避免有限单个值组合后溢出。位置 accessor 的实际值必须位于其声明边界内。

这是受限格式预检，不是完整 glTF 生态兼容承诺，也不证明浏览器已经解码纹理或成功创建 GPU 资源。客户端仍须等待实际 GLTFLoader 加载完成，加载失败保持未就位。该文件结构依据 [Khronos glTF 2.0 / GLB 规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification)；上述资源限制和功能子集是 Rove 自身约束。

## 10. 屏幕共享占用与信令版本

```ts
// 客户端申请／释放本人共享
{ type: 'presentation'; active: boolean }

// RoomState 中的权威结果
presentation: { ownerId: string | null; revision: number }
```

共享要求房间中有两人且未暂停。第一个成功申请者成为 owner；另一人的竞争申请返回 `PRESENTATION_BUSY`。owner 的重复申请为无操作，不增加 revision。只有 owner 能释放自己的占用，其他成员不能用 `active: false` 中断对方；任何成员仍可用全局 `stop` 停止会话。

首次占用、释放和 owner 变化都会产生新 revision；初始为 `{ ownerId: null, revision: 0 }`。每次屏幕信令必须携带 `channel: "screen"` 和当前 `presentationRevision`。服务器同时核对：

1. 发送者和接收者都在同一房间，房间未暂停。
2. 当前存在共享 owner，且信令 revision 精确匹配。
3. offer 只能由 owner 发送；answer 只能由对端发送；ICE 可由任一方发送。

失去占用或 revision 改变后，迟到的旧 offer／answer／ICE 不再转发。摄像头／语音通道不携带屏幕 revision，独立于空间就位状态和屏幕占用。正常客户端在 epoch 改变时关闭旧屏幕 PeerConnection，并把新信令绑定到新的共享版本。

共享者停止、任一成员离开／替换、房间停止或切换空间都会清空占用；恢复不自动重开共享。浏览器采集必须由用户操作启动，先准备本地采集，收到服务器确认本人占用后再向对端发布；竞争失败、取消或权限失效要立即停止已准备的轨道。服务器只控制信令和占用，不能替代浏览器关闭真实采集的操作。

## 11. 错误码

| 代码 | 条件／含义 |
|---|---|
| `INVALID_MESSAGE` | 非 JSON 文本、JSON 解析失败、未知字段、非法结构或参数 |
| `ROOM_NOT_FOUND` | 预览／加入时房间不存在或已结束 |
| `ROOM_FULL` | 加入的双人房间已满 |
| `ALREADY_JOINED` | 已在房间中又创建／加入 |
| `NOT_JOINED` | 发送了需要房间身份的消息，但尚未进入 |
| `STOPPED` | 暂停时尝试重新允许触碰、控制播放、发送位姿／媒体信令、发起空间提案、确认就位或开始共享 |
| `STALE_SEQUENCE` | 位姿序号不大于此前已接受的序号 |
| `POSE_RATE_LIMIT` | 位姿发送频率超过服务端窗口限制 |
| `PEER_UNAVAILABLE` | 当前没有另一人可接收信令、接受空间提案或参与屏幕共享 |
| `TOUCH_UNAVAILABLE` | 触碰请求不存在、已消费或不属于该接收者 |
| `EVENT_UNAVAILABLE` | 回执没有匹配事件、接收者不匹配或回执窗口已过 |
| `SPACE_PROPOSAL_PENDING` | 已有另一份尚未过期的空间提案 |
| `SPACE_PROPOSAL_UNAVAILABLE` | 提案不存在、已过期、已被清理或回应者是提案者本人 |
| `SPACE_ASSET_UNAVAILABLE` | 提案模型不是发起人在当前会话上传的资产，或模型已被删除 |
| `SPACE_REVISION` | 姿态或就位确认不属于当前空间版本 |
| `SPACE_NOT_READY` | 当前空间尚未由所有在场成员确认就位 |
| `PRESENTATION_BUSY` | 对方正在共享屏幕 |
| `PRESENTATION_UNAVAILABLE` | 不存在共享、screen 信令版本／角色不匹配，或试图释放别人的共享 |

`touch-cancelled` 是协议状态结果，不一定是错误。用户拒绝触碰属于正常完成分支。

模型 HTTP 错误的响应格式为 `{ error: string, code: string }`，与 WebSocket 的 `{ type: "error", code, message }` 不同。

| HTTP／代码 | 含义 |
|---|---|
| 401 `UNAUTHORIZED` | Bearer 无效、连接已结束或未加入房间 |
| 403 `ORIGIN_NOT_ALLOWED` | 明确的请求 Origin 不被允许 |
| 403 `ROOM_CHANGED` | 上传期间身份或房间发生变化 |
| 404 `ASSET_NOT_FOUND` | 模型不存在或不在请求者当前房间 |
| 405 `METHOD_NOT_ALLOWED` | 模型入口方法不正确 |
| 415 `INVALID_MEDIA_TYPE` | 不是原始 GLB／octet-stream，或带压缩编码 |
| 400 `INVALID_GLB` | 数据不完整或模型未通过共享预检 |
| 400 `UPLOAD_INTERRUPTED` | 上传中断；被关闭的连接可能只表现为网络中断 |
| 408 `UPLOAD_TIMEOUT` | 超过上传期限 |
| 413 `ASSET_TOO_LARGE` | Content-Length 或实际流量超过单文件限制 |
| 409 `UPLOAD_BUSY` | 本人已有上传进行中 |
| 409 `ASSET_LIMIT` | 本人当前会话已上传三个文件 |
| 429 `UPLOAD_RATE_LIMIT` | 上传尝试过于频繁 |
| 503 `STORAGE_LIMIT` | 已保存文件与上传预留超过全局预算 |

## 12. 扩展约定

本轮共享静态空间没有实现自动扫描、持久空间锚、重定位地图交换或多人路由。要加入真实设备采样时间、持久空间锚、真实腕带回执、任意媒体选择或多人参与时，需显式更新协议和闭合校验器，并定义旧／新客户端协商方式；不能仅靠当前 `protocol: 1` 数字推断已支持所有 v0.2 能力。不要把 UI 标签变化当作协议能力已经实现。

浏览器媒体协商的规范依据为 [W3C WebRTC Recommendation](https://www.w3.org/TR/webrtc/)。本仓库的房间、姿态、逐次触碰与回执协议是应用自定义协议，不是标准触觉编解码器。
