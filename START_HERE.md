# Orkas-Fork 项目入口

本文件是 `Orkas-Fork` 的统一协作入口。所有 Agent 先阅读本文件和 [`AGENTS.md`](./AGENTS.md)，再按任务读取中央规范及项目资料。官方产品说明仍以 [`README.md`](./README.md) 和 [`README.zh-CN.md`](./README.zh-CN.md) 为准；本文件只记录个人 Fork 的协作状态与导航，不改写官方说明。

## 1. 项目身份与仓库边界

| 项目 | 当前记录 |
| --- | --- |
| 项目 / 本地目录 | `Orkas-Fork` / `D:\Codex\2026-11 Orkas-Fork` |
| 个人 Fork | <https://github.com/kakikwng-art/Orkas> |
| 官方上游 | <https://github.com/Orkas-AI/Orkas> |
| 日常开发分支 | `my-changes`，或用户另行批准的个人开发分支 |
| `origin` | 个人 Fork；已完成任务的 Commit 只推送到这里 |
| `upstream` | 官方仓库；用于经授权的只读获取与差异核对，不是个人成果的 Push 目标 |
| 当前 tracking | `my-changes` → `origin/my-changes` |

2026-11-21 的接入核查中，GitHub API 返回 `fork: true`，parent 为 `Orkas-AI/Orkas`；`origin` 指向上述个人 Fork，`upstream` 指向官方仓库。当前本机还设置了 `remote.upstream.pushurl=DISABLE`，但这只是本地防误推措施，不能代替权限判断或中央规则。

个人功能迁移、验证记录及尚未迁入的事项见 [`修改日志.md`](./修改日志.md)。不要把原工作区的未提交状态、历史问题清单或其他 Agent 的私有上下文当成本仓库当前事实。

## 2. 中央规范采用记录

| 项目 | 采用值 |
| --- | --- |
| 中央仓库 | `app-development-standards` |
| GitHub | <https://github.com/kakikwng-art/app-development-standards> |
| 采用集合版本 | **1.2.0** |
| 采用 Commit | **`4b3ea7463d5fe24e541a923509c124dd42f3a6d4`** |
| 默认分支 | `main` |
| 本机 Windows 副本 | `D:\Codex\_Global\app-development-standards` |
| 中央入口 | 中央仓库根目录的 `AGENTS.md` |
| 固定版本入口 | [中央 AGENTS.md（采用 Commit）](https://github.com/kakikwng-art/app-development-standards/blob/4b3ea7463d5fe24e541a923509c124dd42f3a6d4/AGENTS.md) |

接入核查时，中央本地 HEAD、`origin/main` 与 GitHub `main` 均为上述 Commit。本项目采用该固定版本，不因中央仓库后来出现新提交而自动升级。

### 跨设备读取与访问失败

1. Windows 优先读取上述本机副本，并核对版本和 Commit。
2. macOS 或其他设备使用自己的中央仓库克隆；Windows 绝对路径不是唯一有效入口。
3. 也可通过 GitHub 按上述 Commit 读取。中央文件引用均使用中央仓库内的相对路径，例如 `rules/development-workflow.md`。
4. 不在本项目中复制整套中央规范作为长期维护副本。
5. 本地副本不可访问时，尝试有权限的 GitHub 来源；仍不可用时，停止依赖这些规则的工作并报告，不能假装已经读取。
6. 本地中央版本与上述采用记录不一致时，先核对差异并报告；未经任务授权，不擅自修改本项目的采用版本。

## 3. Agent 开工顺序

1. 阅读项目 [`START_HERE.md`](./START_HERE.md)。
2. 阅读项目 [`AGENTS.md`](./AGENTS.md)。
3. 阅读中央仓库 `AGENTS.md`。
4. 按任务加载相关 Rules、Skills、Workflows 和 Templates，不无差别读取全部 Skill。
5. 检查当前分支、HEAD、remotes、tracking、工作区、暂存区、未跟踪文件及 ahead/behind。
6. 阅读 [`修改日志.md`](./修改日志.md) 和与任务有关的已有资料，确认范围、授权和工作归属；发现未提交工作或归属不明时立即暂停并报告。

基础检查命令：

```bash
git branch --show-current
git status --short --untracked-files=all
git remote -v
git rev-parse HEAD
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
git rev-list --left-right --count HEAD...@{upstream}
```

干净的工作区只能证明没有可见的未提交改动，不能单独证明没有其他 Agent 正在执行；仍须核对任务记录、修改日志和可用交接资料。不得猜测其他 Agent 的私有会话。

## 4. 按任务加载中央规范

以下路径均相对于中央仓库根目录：

| 任务 | 必读入口 |
| --- | --- |
| 开发、文档或仓库维护 | `rules/workspace-safety.md`、`rules/authorization-and-scope.md`、`rules/development-workflow.md` |
| 多 Agent 协作或交接 | `rules/agent-collaboration.md`、`rules/handoff.md`；需要时使用 `templates/handoff-report.md` |
| 新任务说明 | 需要时使用 `templates/task-instruction.md` |
| 凭据、隐私、日志或敏感数据 | `rules/information-security.md` |
| 项目接入或中央版本升级 | `integration/project-adoption.md` |
| UI 设计、实现、修改或审查 | [`skills/generic-ui-standards/SKILL.md`](https://github.com/kakikwng-art/app-development-standards/blob/4b3ea7463d5fe24e541a923509c124dd42f3a6d4/skills/generic-ui-standards/SKILL.md)，并读取本仓库与目标功能相关的既有 UI Skill |

项目技术约束用于解释 Orkas 的具体实现，但不得削弱中央安全、授权和协作规则。发现冲突或证据不足时暂停并报告，不自行选择更宽松的解释。

## 5. Fork 持续同步入口

详细规则以中央 `rules/development-workflow.md` 和项目 [`AGENTS.md`](./AGENTS.md) 为准。本项目的执行基线如下：

1. 在 `my-changes` 或用户批准的个人开发分支完成一个独立任务。
2. 更新 [`修改日志.md`](./修改日志.md)，执行与风险相称的定向验证。
3. 检查工作区，排除其他 Agent、其他任务及无关文件。
4. 使用显式文件列表暂存，检查完整 staged diff。
5. 创建独立 Commit，并 Push 到个人 Fork 的对应 `origin` 分支。
6. 复核本地 HEAD、远程 HEAD、ahead/behind、工作区和暂存区。

禁止 Push 到官方 `upstream`，禁止强制 Push、擅自修改 Remote、混合提交他人工作或为了同步丢弃未完成修改。测试失败、工作区不干净、Fork/分支不明确或同步受阻时，保留现状并明确报告；不能静默把已完成成果只留在本地。

## 6. 项目专属技术资料索引

以下是本 Fork 已提交实现的主要入口，不替代源码和定向测试。功能迁移归属及验证口径见 [`修改日志.md`](./修改日志.md)。

| 功能 | 当前实现与验证入口 |
| --- | --- |
| Grok CLI / Grok Build Provider（迁移提交 `f134b92e`） | [`backends/grok.ts`](./src/main/features/local_agents/backends/grok.ts)、[`registry.ts`](./src/main/features/local_agents/registry.ts)、[`runtime_options.ts`](./src/main/features/local_agents/runtime_options.ts)、[`grok-build-provider.ts`](./src/main/model/core-agent/grok-build-provider.ts)、[`provider_catalog.ts`](./src/main/model/provider_catalog.ts)、[`grok-build-provider.test.ts`](./test/main/model/core-agent/grok-build-provider.test.ts) |
| Grok Commander 派发桥（`ec1ee684`） | [`bridge.ts`](./src/main/features/local_agents/bridge.ts)、[`orkas-bridge.cjs`](./bin/orkas-bridge.cjs)、[`bus.ts`](./src/main/features/group_chat/bus.ts)、[`bridge.test.ts`](./test/main/features/local_agents/bridge.test.ts) |
| Grok 执行轨迹（`dd1748c7`） | [`_acp.ts`](./src/main/features/local_agents/backends/_acp.ts)、[`event-mapper.ts`](./src/main/model/core-agent/event-mapper.ts)、[`conversation.js`](./src/renderer/modules/conversation.js)、[`grok-commander-trace.test.ts`](./test/main/model/core-agent/grok-commander-trace.test.ts) |
| Token 看板（`f3f5f8b1`） | [`token_usage.ts`](./src/main/features/token_usage.ts)、[`IPC token_usage.ts`](./src/main/ipc/token_usage.ts)、[`token-dashboard.js`](./src/renderer/modules/token-dashboard.js)、[`token_usage.test.ts`](./test/main/features/token_usage.test.ts)、[`token_dashboard_e2e_render.spec.ts`](./test/e2e/token_dashboard_e2e_render.spec.ts) |
| 对话导出（`60f16e05`） | [`conversation_export.ts`](./src/main/features/conversation_export.ts)、[`conversation.js`](./src/renderer/modules/conversation.js)、[`conversation_export.test.ts`](./test/main/features/conversation_export.test.ts) |
| 架构、运行与回归资料 | [`README.zh-CN.md`](./README.zh-CN.md)、[`package.json`](./package.json)、[`local-agents-regression.md`](./docs/test/local-agents-regression.md)、[`agent-orchestration-regression.md`](./docs/test/agent-orchestration-regression.md) |

Core Provider、CLI/ACP Agent、Commander 和普通 Agent 是不同执行路径。排查认证、上下文、工作区、模型或 Token 问题时必须分别定位，不能因模型名称相同而合并判断。

## 7. 历史交接与未完成事项索引

本 Fork 在接入时没有 `Grok执行链路对照.md` 或 `handoff/` 目录。本次不复制、不重排原工作区历史文件。以下仅是本机只读背景，不是跨设备规范入口，也不是本 Fork 当前状态的证明：

- `D:\Codex\2026-11 Orkas\Grok执行链路对照.md`：2026-11-08 的原工作区分析，包含当时的绝对路径、源码行号和问题结论；后续 Grok 执行轨迹已经迁入本 Fork，引用前必须重新验证。
- `D:\Codex\2026-11 Orkas\handoff\2026-11-20-model-dispatch-architecture.md`：原工作区的模型管理、Commander/Worker 候选池和 CLI Runtime 架构交接。其中的 P0/P1 内容是设计建议，原文明确标为当时未实现；本 Fork 的迁移日志也明确未迁入 P0 模型停用和候选池。

这些资料只用于以后经用户批准的任务定位背景。本次不恢复 P0、不实现 Commander 或 Dispatch 候选池、不合并官方更新。其他设备需要这些历史资料时，应由用户提供可访问来源，不得假设上述 Windows 路径存在。

## 8. 修改与交接记录

- 实际修改项目文件时，必须在同一任务更新 [`修改日志.md`](./修改日志.md)，记录原因、文件、验证、限制、Commit 和同步结果；纯只读核查可不记录。
- 历史修改者或执行细节无法确认时标为 `unknown`，不得猜测或归到当前执行者名下。
- 需要交接时遵循中央 `rules/handoff.md` 和 `templates/handoff-report.md`，区分已完成、部分完成、未验证和待核实。
- 未经用户授权，不自动合并上游、创建 PR、推送其他仓库、安装依赖或启动新的开发事项。
