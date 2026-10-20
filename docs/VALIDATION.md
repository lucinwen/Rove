# 首版验证记录

日期：2026-10-20。分支：`feat/copresence-mvp`。

本记录只报告本次实际执行的检查。原型不等于完整 AR/VR 产品，自动化通过不等于实体设备、真人体验或公网部署已经通过。

## 基线

- 源仓库：`https://github.com/Angelina-G/rove-site`
- 起点提交：`d0b026570fdaefb73a339d27bf2455073fb93c5a`
- 原始 64 个文件及原 Git 历史已完整克隆。
- 对原始 4 个 HTML、全部 `papers/` 文件及 PNG 执行 `git diff --exit-code`，没有内容变化。
- 本次开发目录为新增 `server/`、`shared/`、`web/`、`tests/`、`docs/` 及配置文件。

## 环境与命令

Linux 开发环境；Node.js `v24.19.0`；npm `11.9.0`；TypeScript `5.9.3`；Vite `7.3.7`。依赖精确版本由 `package-lock.json` 固定。

```bash
npm run check
```

实际结果：

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过，退出码 0 |
| `npm test` | 24 项通过，0 失败、0 跳过 |
| `npm run build` | 通过，生成 `dist/` |
| 原始资料差异检查 | 无改动 |
| `git diff --check` | 通过 |

构建输出包含约 609.8 kB 的主 JS（gzip 约 162.0 kB）和约 15.5 kB 的 CSS。Vite 提示主 JS 大于 500 kB；这是目前打包 Three.js 的性能优化项，不是构建失败。尚未测量低性能手机的帧率或首次加载时长。

## 24 项测试分别验证什么

### 真实 HTTP/WebSocket 集成：12 项

测试文件：[server.test.ts](../tests/server.test.ts)。启动真实 Node HTTP 服务与独立 WebSocket 客户端，没有用前端动画代替网络连接。

1. 两个客户端加入同房，第三人被拒绝；预览不披露参与者身份。
2. 不同房间隔离，未加入者不能发送媒体信令。
3. 共享播放状态具有服务端时间、合法范围与单调 revision。
4. 非法位置、四元数、旧序号和未知字段被拒绝。
5. 双方先允许请求，接收者再逐次确认；输出回执不能由其他人冒认。
6. 拒绝触碰不生成执行事件；双手分离取消请求。
7. 接受时重新检查追踪新鲜度，请求过期不执行。
8. 追踪失效、立即停止与恢复均不恢复旧权限；暂停时姿态与媒体信令不转发。
9. 撤销、退出、重新加入和主场离开正确清除授权。
10. 跨域 WebSocket 被拒绝，同源可以连接。
11. 生产 HTTP 不暴露源码、环境文件、Git 元数据或路径穿越目标。
12. 视频支持有界、开放结尾及后缀 Range 请求，用于跳转播放。

### 触觉适配器逻辑：6 项

测试文件：[haptics.test.ts](../tests/haptics.test.ts)。使用模拟 Gamepad API，验证默认不访问设备、重复事件不重放、显式开启、输出限幅、失败如实回退、急停 reset、撤回和销毁后的异步失效。

**这些测试未驱动真实手柄或腕带。** `mode=gamepad` 的浏览器 API 完成回执也不等于身体实际感觉或传感器测量。

### 真实主界面代码的 DOM 生命周期：6 项

测试文件：[client-lifecycle.test.ts](../tests/client-lifecycle.test.ts)。esbuild 构建实际 `web/src/main.ts`，happy-dom 执行实际界面代码。空间渲染、媒体、触觉与 Socket 被明确替换为测试边界对象。

1. 合法回应可进入输出；本机点击停止后，服务器回包之前的迟到回应与播放状态不能重新输出。
2. 本机撤销触碰许可后，在途触碰和旧授权不能绕过撤回。
3. 重复暂停状态保持媒体断开，明确恢复后重新建立配置，旧触碰权限保持关闭。
4. 对端离开和重新入房清理旧状态；尚未结束的设备授权不会卡住下一场会话。
5. 修改或拒绝邀请后，迟到预览不会重新弹出旧邀请。
6. 服务不再回应 pong 时，即使 Socket 仍宣称 OPEN，也关闭会话与设备。

**这不是浏览器 E2E，不验证 WebGL 画面、实际 WebRTC 音视频、摄像头、麦克风或 XR 硬件。**

## 运行检查

- 开发服务 `npm run dev` 已实际启动，`/api/health` 与原研究页面返回 200。
- 构建完成后启动生产模式，检查首页、构建资产、配置、研究网页和 24 秒样片的 HTTP 响应。
- 视频 Range `bytes=0-255` 实测返回 206 与 256 字节；同一行为也由集成测试覆盖。
- 测试片为脚本生成的原创合成素材，24 秒，文件约 40 kB；没有用外部影视内容代替可交付素材。

## 尚未验证

| 项目 | 当前限制与下一步 |
|---|---|
| 浏览器视觉、布局与操作 | 本次云浏览器无法连接代码运行容器：localhost 拒绝连接，容器预览地址被客户端阻止；没有宣称完成截图或视觉 QA |
| 双浏览器音视频 | 需要在可达服务上实际打开两端，验证权限、双端开麦、同时协商、关闭与恢复 |
| 公网、TURN、不同运营商 | 没有部署或跨网实测，默认 ICE 配置为空 |
| WebXR | 只有能力适配代码；没有实体头显或真实房间测试 |
| 手柄和触觉腕带 | 没有实体硬件测量；腕带驱动未实现 |
| Docker | 提供配置，但本次未构建容器 |
| 真实性能与用户效果 | 没有动作到画面、端到端触觉延迟、临场感或眩晕结论 |

## GitHub 交付状态

完整上游历史和 v0.1 开发代码已导入独立仓库 [venividici/Rove](https://github.com/venividici/Rove) 的 `main` 分支。原始资料的来源为 [Angelina-G/rove-site](https://github.com/Angelina-G/rove-site)。

- 导入合并提交：[7f3c4d47ee2bea102fe3eeb7f58b9b0d2fcad8ac](https://github.com/venividici/Rove/commit/7f3c4d47ee2bea102fe3eeb7f58b9b0d2fcad8ac)。
- 原始提交 `d0b026570fdaefb73a339d27bf2455073fb93c5a`、开发提交 `2228db5fa69b3ce46e43352df32423da19a94567` 及文档提交 `a6225c2ee82f6d9e8a60e565748c50b4ffab13f4` 均保持原 SHA，并已核验为目标主分支的祖先。
- 已从目标仓库重新执行 `git fetch`，核验原始 64 个文件的 Git 对象与源仓库完全一致；应用、测试、配置和开发文档与本地导入版本一致。
- 一次性迁移流程已成功完成：[运行记录](https://github.com/venividici/Rove/actions/runs/39395680140)。临时迁移工作流和传输文件已从当前文件树清理，正常自动检查工作流继续保留。

## GitHub 自动检查

仓库启用 [Rove checks](https://github.com/venividici/Rove/actions/workflows/check.yml)，每次推送和 Pull Request 自动执行依赖安装、类型检查、24 项测试与生产构建。自动检查使用 Node.js 22，运行 `npm ci --ignore-scripts` 和 `npm run check`。

上面的验证表记录本地实际执行结果；远端每次提交的状态和完整日志以对应的 [GitHub Actions 运行记录](https://github.com/venividici/Rove/actions) 为准。CI 不替代本记录中列明的浏览器、跨网络和实体设备实测。
