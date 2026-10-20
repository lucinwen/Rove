# G1-A 参考工程核对结论与待办

资料来源：VIVE OpenXR / UE5.3 面部驱动示例与官方 MR 透视开发说明。此页继承此前对固定旧样例的审查摘要；本轮没有重新拿到当时 136 文件及精确固定 SHA，因此没有在此页伪造完整清单或实际编辑器检查。

## 已知风险及必须核实的事实

1. **插件版本冲突**：此前检查的 UE5.3 示例包含旧版 ViveOpenXR 2.1.0；PC MR 透视官方功能要求至少 2.4.0。应从实际取得的新 SDK 读取 \`*.uplugin\` 的版本名，再核对 UE 引擎兼容；不能直接假设插件升级可运行。
2. **资源缺项**：之前示例的默认 GameMode 引用了仓库里没有的资产；MetaHuman 人物及相关动画绑定需要单独引入。检查器会列出可解析的引用，但不能证明运行时全部依赖齐备。
3. **手部追踪**：明确核查 \`OpenXRHandTracking\` 是否启用、能否和面部输入/透视同时加载，且手套不能影响追踪。
4. **透视和串流模式**：核对设备、固件、链接模式、所需权限。不能把 DisplayPort 模式与官方文档声明的 PC MR 支持混用。
5. **输入真实有效性**：Live Link 处于 Active 不等于每帧有效；追踪失效后旧值可能持续转发。需要在接收端显式携带有效性、样本时戳、超时，并测恢复。
6. **测量准确性**：发布到 Live Link 的时刻，不等于传感器采样时刻；网络 RTT 也不等于动作到渲染的端到端延迟。

官方来源（在拿到具体 SDK 和机器后再次核对）：
- VIVE OpenXR Unreal 示例与教程：https://developer.vive.com/resources/openxr/unreal/unreal-tutorials/facialexpressionmaker/metahuman/
- VIVE PC MR passthrough：https://developer.vive.com/resources/openxr/unreal/unreal-tutorials/passthrough/
- Epic MetaHuman 官方：https://dev.epicgames.com/documentation/metahuman/

## 当前可重复的核查

运行 \`preflight.py\`，获得实际检查项目、插件元数据、GameMode 引用/缺失、可解析项目设置与文件计数。**Unknown 不等于通过；Pending 不等于失败。** 其结果是静态证据，不能替代 UE 编译或者实机数据。

不在公开 GitHub 导入整个官方仓库、专有 SDK、MetaHuman 人物或厂商示例二进制；保留来源和许可证，使用用户本地的合法副本。
