# Rove v0.2 验证记录

日期：2026-10-20。版本：`0.2.0`；目标分支：独立仓库 `venividici/Rove` 的 `main`。

本记录区分实际执行的软件检查、生产 HTTP 检查与尚未执行的浏览器/硬件验收。本版增加自带空间、主场切换、视频人物、屏幕共享、HRTF 与手动 XR 对齐，不把这些代码和测试结果写成实体设备已经通过。

## 实际执行结果

环境：Linux；Node.js `v24.19.0`；npm `11.9.0`；TypeScript `5.9.3`；Vite `7.3.7`。依赖精确版本由 `package-lock.json` 固定，本轮没有新增运行依赖。

```bash
npm run check
```

| 检查 | 本轮结果 |
|---|---|
| TypeScript `tsc --noEmit` | 通过，退出码 0 |
| `tsx --test tests/*.test.ts` | **69 项通过，0 失败，0 跳过** |
| Vite 生产构建 | 通过，生成 `dist/` |
| 生产 HTTP 冒烟 | 首页、构建资产、配置、研究入口、样片 Range 与资产鉴权符合预期 |
| `git diff --check` | 通过 |
| 原始 64 文件 Git blob 核对 | 与源提交逐项一致 |

构建产物：主 JS 776,631 字节，gzip 约 209.98 kB；CSS 21,853 字节，gzip 约 5.63 kB；入口 HTML 951 字节。Vite 对超过 500 kB 的主包给出优化提示，构建成功。尚未测量实际浏览器下载、解析、GPU 帧率或低性能手机表现。

## 69 项测试的范围

| 文件 | 数量 | 实际执行的层面 |
|---|---:|---|
| [server.test.ts](../tests/server.test.ts) | 12 | 真实 Node HTTP 和独立 WebSocket：邀请、人数、隔离、播放、位置、逐次触碰、退出、来源与静态资源 |
| [server-spaces.test.ts](../tests/server-spaces.test.ts) | 11 | 真实 HTTP 模型上传/下载、同房间鉴权、GLB 限制、超限与中断、并发预算、提案、就位、主场离开、屏幕权限和版本 |
| [client-lifecycle.test.ts](../tests/client-lifecycle.test.ts) | 13 | 实际 main.ts 的 DOM 事件与生命周期；渲染器、媒体、设备和 Socket 为明确替身 |
| [space-panel.test.ts](../tests/space-panel.test.ts) | 9 | 实际 SpacePanel DOM/控制器；HTTP 与渲染器为边界替身 |
| [media-lifecycle.test.ts](../tests/media-lifecycle.test.ts) | 8 | 实际媒体模块；浏览器设备、PeerConnection 和 Web Audio 为 API 替身 |
| [haptics.test.ts](../tests/haptics.test.ts) | 6 | 视觉/手柄适配逻辑；使用模拟 Gamepad API |
| [space-model.test.ts](../tests/space-model.test.ts) | 4 | 真实 Three.js GLTFLoader 解析内嵌几何与节点变换，资源释放和无外部请求的预检 |
| [spatial-math.test.ts](../tests/spatial-math.test.ts) | 6 | 坐标、头手刚体映射、退化朝向、显式模型变换、尺寸边界和靠近落点的数值计算 |
| **合计** | **69** | 不包含真实浏览器 E2E、WebGL/GPU 呈现、真人媒体或实体头显 |

### 这轮重点核验的行为

- 上传 GLB 的字节在同房间成员下载后完全一致；其他房间和未入场者不能读取。
- 静态 GLB 的结构、索引、数值、资源引用、图像规格与实例预算在加载前检查。没有把不受支持的资源当成已加载。
- 分块上传超限返回有界拒绝；上传缓冲计入总预算，结束会话中止上传并释放暂存。
- 仅对方能接受空间提案；拒绝或过期保留当前空间，不能伪造 owner/revision。
- 接受新空间清除旧位置和触碰；加载成功不自动代替用户确认；双方当前 revision ready 后才传位置。
- 参数或文件变更使旧预览失效；正在上传时改变比例不会发送旧配置；迟到模型/渲染结果不覆盖新房间或新失败状态。
- 会话加入者可以成为空间提供者，摄像头协商角色仍保持创建者/加入者关系。
- 屏幕捕获先本地准备，得到服务端当前版本授权后才发布；相机/麦克风与屏幕分别使用连接和流。
- 本机停止、浏览器原生结束、换人、退出和迟到 grant/权限不会重开分享；旧 offer/ICE 不进入新共享连接。
- 接收分享时关闭本机摄像头/麦克风，不关闭对方的屏幕接收连接。
- HRTF 只在明确选择、音频图运行、音频轨与双方有效位置都存在时替换普通语音；本地追踪失效或恢复音频失败时保留普通声音。
- 手动对齐使用真实位姿的数学映射，头部与双手一致，拒绝无法定义水平朝向的输入；这些是数值检查，没有测头显误差。
- 原有逐次同意、撤销、暂停、断连、过期、限幅和停止逻辑继续通过。

## 生产 HTTP 检查

最终构建后启动真实生产模式服务，使用临时本地端口，检查完毕后关闭。以下是实际响应，不是浏览器渲染结果：

| 路径 | 结果 |
|---|---|
| `/` | 200，入口引用当前哈希 JS/CSS |
| `/assets/index-gmzLQwoT.js` | 200，776,631 字节 |
| `/assets/index-D58tP9_q.css` | 200，21,853 字节 |
| `/api/health` | 200 |
| `/api/config` | 200，模型上限 20 MiB |
| `/research/` | 200 |
| `/research/rove-overview.html` | 200，117,525 字节 |
| `/media/rove-sync.webm`，Range `bytes=0-255` | 206，256 字节 |
| `/api/spaces/:assetId`，没有当前会话凭据 | 401 |

此 HTTP 检查没有执行页面 JavaScript、申请摄像头、播放远端画面或渲染 3D。

## 尚未完成的实测

| 项目 | 当前证据边界 |
|---|---|
| 双浏览器完整旅程 | 当前执行环境没有可访问本地应用的浏览器验收通道；未完成真实页面的双端操作或截图验收 |
| 摄像头、麦克风与屏幕双路传输 | 生命周期与信令已测试；未观察真实双方持续变化的图像和声音 |
| HRTF 听感 | API 路由和降级已测试；未用耳机测方向、距离和舒适度 |
| WebGL 与模型材质显示 | 真实 GLTFLoader 解析通过；未验收浏览器 GPU、贴图外观、布局或帧率 |
| AR/VR、手动对齐和 reset | 输入与恢复代码已实现，数学已测；无实体头显结果或配准误差报告 |
| 公网 HTTPS / TURN / 运营商差异 | 未部署或跨网实测；默认 ICE 配置为空 |
| 手柄与触觉腕带 | 模拟 Gamepad 生命周期通过；真实硬件未测，腕带驱动未实现 |
| Docker | 提供配置，本轮未构建镜像 |
| 空间扫描、人体重建、持久锚点 | 未实现；GLB 为用户事先准备的静态模型 |

下一次真实验收按 [ACCEPTANCE.md](ACCEPTANCE.md) 执行，分别记录同机、双设备、跨网络与头显结果。

## 来源保留与 GitHub

原始基线为 [Angelina-G/rove-site](https://github.com/Angelina-G/rove-site) 的 `d0b026570fdaefb73a339d27bf2455073fb93c5a`。原始 4 个 HTML、59 个 PDF、1 张 PNG 共 64 个文件在原路径保留。本轮以 `git ls-tree` 读取原 blob，再逐项计算工作区 `git hash-object`，结果全部相同。

v0.1 已通过独立仓库导入保留完整上游历史；导入合并为 [7f3c4d47ee2bea102fe3eeb7f58b9b0d2fcad8ac](https://github.com/venividici/Rove/commit/7f3c4d47ee2bea102fe3eeb7f58b9b0d2fcad8ac)。本轮在原主分支 `e4b2f37f06efc029e5aebe08aeed2a92abb0f5aa` 之后继续开发，不创建 Fork、不重写来源历史。

仓库 [Rove checks](https://github.com/venividici/Rove/actions/workflows/check.yml) 对每次 push/PR 使用 Node.js 22，运行 `npm ci --ignore-scripts` 和 `npm run check`。本记录中的检查表是本地实际结果；远端每次提交的成功/失败及 SHA 以对应 [Actions 记录](https://github.com/venividici/Rove/actions) 为准。CI 不替代上表中尚未完成的体验验收。
