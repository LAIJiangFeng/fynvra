# Fynvra 开发约定

适用于人类和 AI 贡献者。架构契约见 `docs/ARCHITECTURE.md`，产品定义见 `docs/PRODUCT.md`。

## 原则
- 变更范围最小，不做无关重构。任务书里写明的范围之外的文件不要动。
- 保持 Fynvra 精简，遵循本项目的产品定义和架构契约，只实现任务书要求的能力。
- 跨层改动先写清：行为差异、所属层、必改文件、明确不做的事。

## 执行方式：快速实现，用户自行测试
- 收到明确需求后，走最短实现路径；只读取和修改必需的文件，不做额外探索、重构或功能扩展。
- 默认不编写或运行测试，不运行构建或打包；仅在用户明确要求时执行。
- 默认不启动应用，不做截图、GUI/E2E 联调或反复视觉核对，不新增或打磨验证脚本。验证由用户自行完成。
- 不为追求验证完整而扩大任务、反复调试测试工具或延迟交付。
- 快速实现不省略必要的输入校验、安全边界和防数据丢失处理。
- 完成后简短说明改动，并注明未运行测试或构建；不得宣称未经执行的检查已通过。

## 提交规范
一个可独立描述的改动一个提交。提交信息格式：`<type>(<scope>): <summary>`，正文说明动机，末尾一行
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 关键边界
- IPC 三件事同步（通道常量 / Main handler / preload typed 出口）；入参 `unknown` 收窄；Renderer 只传 id。
- 密钥、MCP env 明文只在 Main。
- 会话正文是投影，pi jsonl 是权威源；过期 seq 丢弃。
- `packages/*` 不得 import Electron；`src/shared` 不得 import Node/Electron。
- 大段文本不进 `settings.json`。
