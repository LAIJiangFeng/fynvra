# Fynvra 开发约定

适用于人类和 AI 贡献者。架构契约见 `docs/ARCHITECTURE.md`，产品定义见 `docs/PRODUCT.md`。

## 原则
- 变更范围最小，不做无关重构。任务书里写明的范围之外的文件不要动。
- 保持 Fynvra 精简，遵循本项目的产品定义和架构契约，只实现任务书要求的能力。
- 跨层改动先写清：行为差异、所属层、必改文件、明确不做的事。

## 测试先行
纯函数、解析器、状态机、路径校验、reducer 按 Red-Green：先写失败测试，再最小实现，再跑全量。
文件读写测试用临时目录；断言可观察行为。

## 提交前
```bash
pnpm typecheck && pnpm lint && pnpm test
```
一个可独立描述的改动一个提交。提交信息格式：`<type>(<scope>): <summary>`，正文说明动机，末尾一行
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不 push、不建 PR。

## 关键边界
- IPC 三件事同步（通道常量 / Main handler / preload typed 出口）；入参 `unknown` 收窄；Renderer 只传 id。
- 密钥、MCP env 明文只在 Main。
- 会话正文是投影，pi jsonl 是权威源；过期 seq 丢弃。
- `packages/*` 不得 import Electron；`src/shared` 不得 import Node/Electron。
- 大段文本不进 `settings.json`。
