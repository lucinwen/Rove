# G1-B / G1-C Windows 工作站执行手册

## 目标

这不是替换现有网页原型。使用合法取得、**固定具体 commit** 的官方 UE5.3 参考工程，在单独目录准备实验副本；核对较新 SDK、插件和实际引擎后，再编译、加载和打包。所有失败都保留日志，不通过合成成功截图或默认打勾掩盖问题。

## 操作顺序

1. 记录主机 Windows 版本、GPU 与显存、UE5.x **精确版本**、设备/固件/链接模式、官方示例 URL 与 SHA、新 SDK 下载来源及许可证。建议固定在 \`experiments/copresence-v1/evidence/\` 中，**不要提交个人数据和私有 SDK**。
2. 使用已有的固定旧版源码副本，运行静态检查：
   ~~~powershell
   py experiments/copresence-v1/preflight.py --project-root "D:\Rove\OfficialSample" --out "D:\Rove\evidence\preflight.json"
   ~~~
3. 准备完整可追踪副本（输出目录须不存在）：
   ~~~powershell
   py experiments/copresence-v1/prepare_reference.py --source "D:\Rove\OfficialSample" --destination "D:\Rove\UEExperiment"
   ~~~
   工具不下载 SDK、不覆盖源文件，也不暗中替换插件。安装新版 SDK 时**整体替换对应插件目录**，确保旧 DLL/旧头文件未混入；之后重新执行 preflight。
4. 修复实际默认 GameMode / 资源引用，导入许可允许的人物资产，建立表情映射。**保存更改前后实际文件 diff**。
5. 生成实际构建命令计划：
   ~~~powershell
   py experiments/copresence-v1/run_ue_check.py --engine-root "C:\Program Files\Epic Games\UE_5.3" --project "D:\Rove\UEExperiment\Sample.uproject" --mode editor --target "Sample" --out "D:\Rove\evidence\editor"
   ~~~
6. **审核命令无误后**，添加 \`--execute\` 在 Windows 上执行，查看非零返回码和对应日志；只有编辑器构建成功、实际加载项目后，再用 \`--mode package\` 准备打包。
7. 最后才接设备：透视、眼/面部输入和手部追踪分别验证，再三者同时运行至少 20 分钟。通过条件不是“Live Link 显示 Active”，而是移动、失效、恢复、对端输出与视频证据均成立。

## 停止条件

- 缺少必要 SDK、版本或许可证；没有确切引擎；缺资源/修复无证据；编译错误；输入虽连接但值不更新；停止后仍继续输出。均停止晋级，不得在汇报中称 G1 通过。
- 外部模型、SDK、设备测量视频、原始人脸或身份素材不要上传到当前公开仓库。
