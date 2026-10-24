# 多 agent 协作规范（fynvra 仓库）

## 角色
- **验收人（主 agent）**：不写代码。写任务书、开 worktree、派活、读 diff 验收、合并到 `main`、清理。
- **执行 agent（Claude Opus 5.5）**：在独立 Orca worktree 中按任务书实现，完成后把 worktree 置为 `in-review` 并写总结。

## 任务书位置
`.workflow/scratch/<主题>/task-<NN>-<slug>.md`，五段：范围 / 硬约束 / 验收标准 / 提交信息格式 / 完成动作。

## 执行 agent 必须做到
1. 开工先读 `docs/PRODUCT.md`、`docs/ARCHITECTURE.md`、`AGENTS.md` 和自己的任务书。
2. 只改任务书「范围」内的文件；需要越界时在总结里写明理由，不要擅自改。
3. 每个可描述的改动一个提交；提交信息末尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
4. 不 push、不建 PR、不改 `main`。
5. 完成后：跑任务书里的检查命令并把输出摘要写进总结；执行
   `orca worktree set --worktree current --workspace-status in-review --comment "<一句话总结>" --json`；
   总结写到 `.workflow/scratch/<主题>/summary-<slug>.md`（做了什么、怎么验证、未做/越界项、给验收人的注意事项），并提交。
6. 卡住或需要决策：把问题写进 summary 文件开头的 `## BLOCKED` 段，并把 workspace-status 设为 `in-review`，不要空等。

## 验收人检查项
范围 / 规范 / Co-Authored-By / 检查命令真实通过 / 合并无冲突 → `git merge --no-ff` 进 `main` → 关终端、删 worktree、删分支。
