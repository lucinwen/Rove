# Rove 如晤｜从软件原型到真实共处实验

状态：**规划与离线工具准备；尚未通过 UE/头显/触觉硬件验收**。本目录为 G1 checkpoint（2026-10-21），根据此前会话中的已审查结论重新整理；此前暂存的 bcd6609 工作目录在当前执行会话不可读取，因此本提交**不是**对该本地提交的逐字还原。

## 产品目标

两位熟悉的人，通过主场 AR / 来访 VR，在一间选定的真实房间里自然相处 20 分钟：共享内容、看向彼此、无声表情、指向和一次双方主动回应的手部轻压。轻薄透明眼镜是独立的最终产品形态目标，不以较重 XR 头显通过实验替代证明。

## 阶段闸门（Gate）

| Gate | 核心问题 | 关键证据 | 当前状态 |
| --- | --- | --- | --- |
| G0 | 谁在什么空间，做哪些自然互动？ | [双端体验脚本](EXPERIENCE_PROTOCOL.md)、前后测与失败登记 | 设计冻结；未有人体试验 |
| G1-A | 候选 UE 工程、SDK、模型和输入接口是否可复现？ | [参考工程审查](REFERENCE_AUDIT.md)、离线检查器、固定提交及完整清单 | 参考问题已归档；新增工具由 CI 检查 |
| G1-B | 插件、GameMode、人物等依赖齐备吗？ | 整洁工作副本、具体 SDK/UE SHA、资源许可证、缺项清单 | 需提供实际 SDK 与人物资产 |
| G1-C | UE 编辑器能编译、打包、加载吗？ | 编译日志、UE 版本、打包结果、实际人物/地图画面 | 未执行；[工作站步骤](UE_WORKSTATION.md) |
| G1-D | 透视、眼/面部/手部追踪是否能共存？ | 真机日志、输入新鲜度、连续 20 分钟录屏、失效恢复 | 未执行 |
| G2 | 本人相似度与共同空间是否可信？ | 同身份 A/B 人物对比、位置/遮挡误差、双端共处录像 | 未执行 |
| G3 | 手部压力是真实可感知的吗？ | 驱动/传感器回执、接触时间、停止释放 | 未执行 |
| G4 | 是否优于普通视频通话且愿意复用？ | 用户观察、对照记录、再次使用 | 未执行 |

**立即下一项：G1-B → G1-C。** 在一台真实 Windows+UE5 工作站上核对插件版本及许可证，补齐 SDK、人物、GameMode 后执行编译；只有通过后才进入设备并发测试。不要优先开发新网页 UI。

## 运行离线检查

无需 UE、硬件、互联网、额外 Python 包：

~~~bash
python experiments/copresence-v1/preflight.py --project-root /PATH/TO/UE_SAMPLE --out preflight.json
python experiments/copresence-v1/prepare_reference.py --source /PATH/TO/UE_SAMPLE --destination /PATH/TO/CLEAN_COPY
python experiments/copresence-v1/run_ue_check.py --project /PATH/TO/Project.uproject --engine-root /PATH/TO/UE --mode editor --out build-evidence
python -m unittest discover -s experiments/copresence-v1/tests -v
~~~

前三步分别是只读评估、创建独立副本、**默认只生成命令计划**；真正构建必须显式传入 \`--execute\` 并且在 Windows 工作站上运行。不要提交 SDK 二进制、个人扫描、模型素材、隐私录像或设备数据到公开仓库。

## 真实性与来源

- 浏览器原型 v0.2 的 69 项软件测试见 [原记录](../VALIDATION.md)，不能作为 G1 真实设备证据。
- 此目录中的实验表默认空白，必须在实际执行后填写。
- 根据上轮口头记录，曾从官方 UE5.3 示例固定版本取得并校验 136 个文件（约 655MB），但相应本地文件与完整 SHA 清单**未在本轮会话恢复，也没有上传到 GitHub**。不得以这一口头记录替代可下载的源码固定引用。
- 独立检查工具仅报告可确定的文件/配置事实；无法凭配置文件证明实时传感器有效、插件在真实 UE 中兼容，或设备实际触觉输出。
