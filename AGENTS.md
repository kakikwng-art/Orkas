# Orkas-Fork Agent 协作规则

本文件适用于本仓库全部目录。项目统一入口是 [`START_HERE.md`](./START_HERE.md)，个人功能与验证历史见 [`修改日志.md`](./修改日志.md)。

## 1. 中央规范采用声明

本项目正式采用中央共享规范 `app-development-standards`：

- 集合版本：**1.2.0**
- Commit：**`4b3ea7463d5fe24e541a923509c124dd42f3a6d4`**
- GitHub：<https://github.com/kakikwng-art/app-development-standards>
- 本机 Windows 副本：`D:\Codex\_Global\app-development-standards`
- 跨设备入口：中央 GitHub 仓库及其内部相对路径；其他系统使用自己的本地克隆

所有 Agent 必须阅读中央 `AGENTS.md`，并按任务加载相关规范。全局规则通过引用使用，不在此复制整套正文。项目专属规则用于约束 Orkas 的技术实现；如与中央安全、授权、隐私或协作要求冲突，暂停并报告，不得擅自降低全局要求。当前用户的明确任务范围优先，但不能被旧文档、历史交接或任务字段覆盖。

中央规范不可访问且无法通过有权限的 GitHub 来源读取时，停止依赖规范的工作并报告。版本变化须核对差异，不得静默升级上述采用记录。

## 2. 开工检查与工作归属

1. 先读项目 `START_HERE.md`、本文件和中央 `AGENTS.md`。
2. 检查分支、HEAD、`git remote -v`、tracking、工作区、暂存区、未跟踪文件和 ahead/behind。
3. 结合任务记录、[`修改日志.md`](./修改日志.md) 和实际代码确认已有工作归属；不依赖其他 Agent 的私有会话或旧聊天声称。
4. 发现未提交修改、暂存内容、未跟踪文件、其他 Agent 工作或归属不明时，立即暂停并报告。不得清理、stash、覆盖、恢复或混入本次提交。
5. 识别仓库类型时检查分支、remote、tracking，并在有权限时通过 GitHub API 核实 `fork` 和 parent。不能只因存在 `origin` / `upstream` 就认定为 Fork；无法确认时不得改动 Remote。
6. 以用户当前任务为唯一范围，默认最小必要修改，不做无关重构、批量整理、上游合并或全仓审计。

## 3. Orkas 项目专属约束

- 当前开发基线为 `my-changes`。个人功能及其迁移边界见 [`修改日志.md`](./修改日志.md)；不得把原工作区未提交内容视为本 Fork 已实现功能。
- 开发环境包括 Windows，目标还包括 Apple Silicon macOS。路径通过 `src/main/paths.ts` 等现有路径层管理，不写死盘符、用户目录或平台专属分隔符；修改一方时评估另一方影响。
- Core Provider、CLI/ACP Agent、Commander 和普通 Agent 是不同执行路径；认证、模型、上下文、工作区和 Token 问题分别定位。
- Token 统计只记录真实 Provider/CLI 返回数据；unknown 保持 `NULL`，不估算、不伪装为零。注意缓存口径及 run/attempt、重试/fallback、不同调用入口的漏记和重复记账。
- 不记录或输出 Prompt、回复正文、完整工具输出、API Key、Token、Cookie、密码等敏感材料。
- 上下文优化只能改变发送给模型的投影，不擅自修改原始 JSONL、Session、聊天记录或记忆文件。
- `README.md`、`README.zh-CN.md` 等官方说明保持其职责；个人 Fork 的协作状态写入 `START_HERE.md` 和 `修改日志.md`。
- P0 模型停用、Commander 候选池和 Dispatch 候选池未包含在现有个人功能迁移中。只有用户明确授权后才可开始，不能从历史设计索引自动恢复实现。
- UI 工作必须按任务读取中央 `skills/generic-ui-standards/SKILL.md`，同时遵循本仓库目标功能已有的 UI Skill、组件和测试约束；非 UI 任务不无差别加载全部 Skill。

## 4. 修改日志与验证

每次实际修改项目文件，都必须在同一任务更新 [`修改日志.md`](./修改日志.md)，至少记录：

- 原因、授权范围、实际修改文件及执行者/实际模型信息；无法确认的历史信息标为 `unknown`。
- 与风险相称的定向测试和检查结果；未运行、失败或无法验证的项目必须明确写出。
- 项目 Commit、Push 目标及最终同步结果，或指向包含这些信息的可追踪交付记录。

不得把计划、历史分析或测试替身写成已完成功能。未经明确授权，不安装依赖、不发起付费模型调用、不运行无关全量测试。

## 5. 个人 Fork 持续同步

本项目已通过 GitHub API 核实为 `kakikwng-art/Orkas`，parent 为 `Orkas-AI/Orkas`。`origin` 是个人 Fork，`upstream` 是官方仓库；日常开发使用 `my-changes` 或用户另行批准的个人开发分支。

每完成一个独立且验证通过的开发任务，必须按中央 `rules/development-workflow.md` 完成持续同步：

1. 更新项目修改日志并完成约定的定向验证。
2. 检查工作区，确认没有混入其他 Agent、其他任务或无关修改。
3. 使用显式文件列表暂存，禁止脏工作区中的 `git add -A`。
4. 检查完整 staged diff，确认无业务越权、凭据、运行时数据或他人成果。
5. 创建独立 Commit。
6. Push 到个人 Fork 对应的 `origin` 分支；当前为 `origin/my-changes`。
7. 复核本地 HEAD、远程 HEAD、ahead/behind、工作区和暂存区，明确报告同步结果。

同步单位是独立开发任务，不是每一行修改。不得长期将已完成且验证通过的成果只保留在本地。

明确禁止：

- Push 到官方 `upstream`，或未经授权创建 PR、合并官方更新。
- 强制 Push、擅自新增/修改 Remote、修改认证或创建新 Fork。
- 为同步而 stash、清理、丢弃、覆盖或混合提交未完成工作。
- 将权限失败、测试失败或未核对的状态声称为同步成功。

测试失败、工作区不干净、Fork/分支无法确认、Push 受阻或权限不足时，保留现状并报告具体证据和剩余步骤；不得静默留在本地，也不得绕过限制。

## 6. 多 Agent 协作与交接

- Codex、Kimi、OpenCode 及其他 Agent 使用同一套入口和中央规则。
- 不覆盖、回退或重新格式化其他 Agent 的未提交修改；发现重叠先核对 diff，无法安全隔离则暂停。
- 重要决策、实际修改、验证、失败和未完成事项必须留下可复盘记录。
- 需要交接时按中央 `rules/handoff.md` 和 `templates/handoff-report.md` 执行；明确区分已完成、部分完成、未验证和待核实。
- 不自动导入原工作区的历史交接文件；只有任务确有需要且获得授权时才新增本项目的交接资料。
