# Rove 协议 v1

文档日期：2026-10-20。协议真源是 [shared/protocol.ts](../shared/protocol.ts)、[shared/validation.ts](../shared/validation.ts) 和 [server/index.ts](../server/index.ts)。前端接收和本地输出行为见 [web/src/main.ts](../web/src/main.ts)、[web/src/media.ts](../web/src/media.ts)、[web/src/haptics.ts](../web/src/haptics.ts)。

本协议服务一个内存中的双人研究原型。没有账户登录、数据库、离线消息、会话恢复令牌或生产级多人会议路由。

## 1. HTTP 与 WebSocket 入口

| 入口 | 方法／传输 | 行为 |
|---|---|---|
| `/api/health` | GET／HEAD | 返回 `ok: true`、`protocol: 1`、`mode: "research-prototype"` |
| `/api/config` | GET／HEAD | 返回 `iceServers`、`protocol: 1`、`maxParticipants: 2` |
| `/ws` | WebSocket | UTF-8 JSON 文本消息，双向交换会话、位姿、信令、播放和触碰事件 |
| `/research/` | GET／HEAD | 保留的原站首页 |
| `/research/<允许的文件>` | GET／HEAD | 原 HTML、场景图及 `papers/*.pdf` 白名单 |
| `/` 及构建静态资源 | GET／HEAD | 开发时由 Vite 服务，生产时读取 `dist/` |

`TURN_URL` 支持逗号分隔的 `turn:`／`turns:` URL，另需 `TURN_USERNAME` 和 `TURN_CREDENTIAL`。三者不足时，`iceServers` 为空数组。配置会下发给每个浏览器客户端，只能放给客户端使用的受限凭据。应用自身不发放短时凭据，需要部署方配置相应服务。

WebSocket 升级只接受与请求 Host 匹配的 HTTP(S) Origin，或明确列入 `ALLOWED_ORIGINS` 的完整 origin。默认拒绝缺少 Origin 的请求；服务端测试可显式设置 `allowMissingOrigin`。来源不允许返回 HTTP 403，达到 64 个连接的上限返回 HTTP 503。

消息最大为 64 KiB；每个连接每约 1 秒窗口最多 120 条消息，超出以代码 `1008` 关闭。姿态另有限额，见下文。缓冲积压超过 256 KiB 的服务端接收对象以 `1013` 关闭。两分钟没有收到客户端应用消息时以 `1001` 关闭。服务端另每约 15 秒发 WebSocket ping 检查存活。后台维护默认每 250 毫秒运行一次。

所有客户端消息使用闭合字段校验：多余字段、未知类型、非法数值或结构被拒绝。不要给现有消息擅自追加调试字段；如需扩展，必须同步修改协议和校验器。

## 2. 身份、房间与生命周期

- 建立 WebSocket 后收到 `welcome`。`peerId` 是本连接的 UUID；重新连接会获得新 ID。
- 房间 ID 为 32 位小写十六进制字符串，由 16 个随机字节生成。房间码是进入凭据，不是展示用短码。
- 一个连接同时只能属于一个房间。创建者为 `host`，加入者为 `guest`；最多两名成员。
- `inspect` 只返回房间预设和是否有空位，不返回成员昵称或身份。
- `join` 是协议上的接受并加入动作。界面提供单独的同意复选框，但服务端不具有证明操作者真实点击过复选框的机制。
- 主场退出或断连会结束整个房间。来访者退出后，主场仍留在房间等待；双方触碰授权清空。
- 参与者变化时清除旧触碰授权和待执行请求。新来访者不能继承上一位的许可。
- 房间从创建起最多保留约两小时；服务重启丢失全部房间。连接重建不自动恢复房间或设备。

### 客户端会话消息

| `type` | 其余字段 | 结果 |
|---|---|---|
| `create` | `name: string, preset: "rose" \| "sage"` | 创建房间并成为主场 |
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
};
```

| `type` | 其余字段 | 用途 |
|---|---|---|
| `welcome` | `peerId, protocol: 1` | 新连接身份 |
| `preview` | `roomId, preset, available` | 邀请预览 |
| `joined` | `selfId, state, serverTime` | 本人进入成功 |
| `state` | `state, serverTime` | 房间成员、许可和暂停状态 |
| `ended` | `reason` | 会话结束／本人离开 |
| `pong` | `sentAt, serverTime` | 回声及服务端时钟参考 |
| `error` | `code, message` | 本次操作失败；除另有关闭行为外，连接可继续使用 |

`touchEnabled` 由服务端派生：恰有两人、未暂停且两人 `consent` 均为 true。客户端不能直接设置该字段。

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
    "seq": 1
  }
}
```

| 字段／规则 | 定义 |
|---|---|
| `position` | `[x,y,z]`，单位米；右手坐标系，`+Y` 向上 |
| `orientation` | 四元数 `[x,y,z,w]`；每项为有限数，模长允许 `0.9–1.1`；服务端不代替发送者归一化 |
| 空间范围 | 每个点的 `x,z` 均为 `[-2.6,2.6]`，`y` 为 `[0,2.8]` |
| 手部范围 | 每只手到头部的位置距离不超过 `1.65 m`；这是原型输入约束，不是个人人体测量 |
| `source` | 只允许 `desktop` 或 `webxr` |
| `tracked` | 当前输入是否有效；桌面 true 不代表真实传感器追踪 |
| `seq` | 非负安全整数，在同一成员的会话中严格递增；每次进入会话重新检查序列起点 |
| 频率 | 客户端目标约 20 Hz；服务端每个连接每约 1 秒窗口最多 60 帧 |

服务端转发为 `{ type: "pose", peerId, pose, serverTime }`，`serverTime` 为服务器接收／处理时间。触碰计算使用服务端最后收到有效帧的时间，**不是客户端采样时间**。

跟踪新鲜度上限为 `1000 ms`。帧需 `tracked: true` 且距服务端接收不超过此时间，才有触碰资格。客户端同时按自己的接收时间进行淡出，不依赖对端机器时钟。协议 v1 没有设备采样时间戳、传感器置信度或端到端显示确认，不能由该帧直接算动作到画面的单向延迟。

## 4. WebRTC 信令

客户端发送 `{ type: "signal", signal }`；服务端只转发给同房间另一人，包装为 `{ type: "signal", peerId, signal }`。接收客户端确认 `peerId` 是当前对端。

`signal` 必须只包含以下两者之一：

```ts
{ description: { type: 'offer' | 'answer'; sdp: string } }
```

或：

```ts
{
  candidate: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment?: string | null;
  }
}
```

SDP 必须非空，最多 48,000 个字符。candidate 字符串最多 2,048 字符，`sdpMid` 和 `usernameFragment` 最多 256 字符；`sdpMLineIndex` 为 null 或 0–1024 的整数。最后的 null ICE 事件不发出，空字符串 candidate 可转发。

本客户端使用 host impolite／guest polite 的 [W3C Perfect Negotiation](https://www.w3.org/TR/webrtc/#perfect-negotiation-example)，串行接收信令、缓存提前到达的候选并处理 offer 冲突。SDP/ICE 不等于媒体内容；音视频在 WebRTC 管线传输，姿态和触碰仍走 WebSocket。

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

仅当双方都在房间、都允许触碰请求、会话未暂停且双方追踪新鲜时，服务端才比较**双方右手**的位置。进入距离阈值为 `0.22 m`。分离阈值为 `0.32 m`，形成滞回；两轮接触至少间隔 `1500 ms`。

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

`stop` 设置 `stopped: true`，冻结共享播放位置，清空双方触碰许可、待接受请求和待确认投递。随附客户端同时停止输入、当前输出和本地媒体采集。`resume` 解除暂停但再次清空触碰许可；设备需要用户再次开启。

服务端在暂停状态下拒绝 `pose` 和 `signal`，返回 `STOPPED` 且不转发；播放和重新允许触碰请求也受此状态门限制。客户端暂停时关闭当前 PeerConnection，恢复后可重新建连，但本地麦克风和摄像头仍需用户再次开启。

任何一方撤回 `consent` 会取消所有尚未完成的请求并清空投递记录。接收者离开、发起者离开、换人、房间结束、追踪失效或双手分离都不能留下可继续接受的旧请求。客户端断线后停止设备和触觉，重连不自动重新加入。

`consent` 只针对触碰请求。摄像头／麦克风权限属于各端浏览器；服务端没有权限替用户授权，也不能以收到音视频信令推断对方已经同意触碰。

## 8. 错误码

| 代码 | 条件／含义 |
|---|---|
| `INVALID_MESSAGE` | 非 JSON 文本、JSON 解析失败、未知字段、非法结构或参数 |
| `ROOM_NOT_FOUND` | 预览／加入时房间不存在或已结束 |
| `ROOM_FULL` | 加入的双人房间已满 |
| `ALREADY_JOINED` | 已在房间中又创建／加入 |
| `NOT_JOINED` | 发送了需要房间身份的消息，但尚未进入 |
| `STOPPED` | 暂停时尝试重新允许触碰、控制播放、发送位姿或媒体信令 |
| `STALE_SEQUENCE` | 位姿序号不大于此前已接受的序号 |
| `POSE_RATE_LIMIT` | 位姿发送频率超过服务端窗口限制 |
| `PEER_UNAVAILABLE` | 当前没有可接收 WebRTC 信令的另一人 |
| `TOUCH_UNAVAILABLE` | 触碰请求不存在、已消费或不属于该接收者 |
| `EVENT_UNAVAILABLE` | 回执没有匹配事件、接收者不匹配或回执窗口已过 |

`touch-cancelled` 是协议状态结果，不一定是错误。用户拒绝触碰属于正常完成分支。

## 9. 扩展约定

要加入真实设备采样时间、房间 mesh、持久空间锚、真实腕带回执、媒体选择或多人参与时，需显式更新协议版本与校验器，并增加能区分旧／新客户端的行为。不要把 UI 标签变化当作协议能力已经实现。

浏览器媒体协商的规范依据为 [W3C WebRTC Recommendation](https://www.w3.org/TR/webrtc/)。本仓库的房间、姿态、逐次触碰与回执协议是应用自定义协议，不是标准触觉编解码器。
