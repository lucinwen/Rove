# G1：可重复的离线准备工具

以下脚本只使用 Python 标准库，**不是 UE / XR 模拟器，也不会宣称硬件成功**。

- \`preflight.py\`：读取某个已存在的 .uproject、插件目录、配置和 GameMode；生成 JSON。未能判定的项目保持 unknown。
- \`prepare_reference.py\`：生成独立工作副本并记录来源文件 SHA-256；绝不覆盖源目录；排除本地构建缓存目录。
- \`run_ue_check.py\`：读取实际 UE 引擎信息并生成 Editor / package 命令计划；必须 \`--execute\` 才运行，且限制为 Windows；生成的计划本身不算构建成功。
- \`tests/\`：离线单元检查，可用 \`python -m unittest discover -s experiments/copresence-v1/tests -v\` 运行。

未提供最新 SDK、MetaHuman 权益/资产、Windows UE 主机或实体追踪设备。上述文件可先上传供合作方在工作站复现，**不要把前述暂存工作区的「39项软件测试」等数字冒充为此版本的 CI 结果**。
