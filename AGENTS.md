# pi-memory：维护 Agent 约定

本文件面向修改本项目的 Agent，不是使用说明。快速上手见 [README.md](README.md)，详细操作和排障见 [docs/usage.md](docs/usage.md)，工具参数见 [docs/tools.md](docs/tools.md)，架构与数据约束见 [docs/design.md](docs/design.md)，测试和人工验收见 [docs/development.md](docs/development.md)。

## 项目与入口

这是 Pi 的本地跨会话 Markdown 记忆扩展，使用 TypeScript ESM、TypeBox 和 Node.js 标准库。Pi 直接加载 TypeScript，没有编译产物或 build 步骤；dreaming 按需启动独立进程，不安装永久服务。

维护前先理解 mem 的组织，而不只看工具名称：

```text
PI_MEMORY_DIR 或 getAgentDir()/pi-memory
  -> 每个项目一个目录 + global/
  -> MEMORY.md 是小索引，其他 Markdown 是自由组织的正文
  -> .identity.json 是内部元数据，.history/ 保存改写或归档前的正文
  -> 项目 .dream-state.json 保存用户消息去重、待处理批次与运行租约
  -> .dream-runs/ 保存私有运行记录与 worker 自身会话，不是知识正文

每次请求
  -> context 钩子临时注入项目与全局 MEMORY.md
  -> Agent 按需搜索、读正文、对照当前反馈，自主记下重要经验

新的实际用户消息累计为项目级待整理工作
  -> detached supervisor 与普通 Pi CLI dreaming Agent
  -> 按提示只读原始会话与源码，通过记忆工具维护项目记忆
  -> 创建新知识、纠错、合并、归档和索引维护
```

Markdown 正文自由组织，Agent 自主写入和维护索引。程序不自动填充目录，也不在每个工具结束、会话结束或压缩时提炼笔记。全局写入同样自主，但只适合跨项目、非私密知识。

存储按项目而非会话共享，项目目录与 global/ 直接位于存储根目录下。切换会话树不会回滚外部文件。来源、条件和假设写在 Markdown 中，不能把写入成功当事实验证。

包声明 Node.js 至少 22.19，开发依赖固定使用 Pi 1.5.0 和 TypeBox 1.3.27。开发基线为 Node.js 24、Pi 1.5.0、macOS，其他环境不能仅凭 engines 声明当作已验证。版本以 package.json 和 package-lock.json 为准。

| 修改问题 | 先看 |
| --- | --- |
| 工具、命令、开关、请求与调度生命周期 | `src/memory-extension.ts` |
| 工具写入参数与作用域类型 | `src/memory-schema.ts` |
| 项目定位、读写、哈希、历史、锁 | `src/memory-store.ts` |
| 词法检索、列表和小索引上下文 | `src/memory-search.ts` |
| 独立进程启动、期限与运行记录 | `src/memory-dream.ts` 及其就近测试 |
| worker 维护提示与完成确认 | `src/memory-dream-worker.ts` |
| 保留的旧来源模块（不再是 worker 接口） | `src/memory-sources.ts` 及其就近测试 |
| 项目级用户消息去重、待处理批次与运行租约 | `src/memory-schedule.ts` 及其就近测试 |
| 用户消息观察的排队提交与锁释放后补记 | `src/memory-observations.ts` 及其就近测试 |

改动前读相关实现和测试，不必先扫描 node_modules。涉及 Pi API 时核对开发依赖内的当前文档和类型，特别是 context、agent_settled、上下文投影和模型注册表，按当前 API 核对，不凭印象修改。

## 常用命令

在项目根目录执行：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

`npm ci` 按锁文件安装开发依赖，忽略安装脚本。`npm run check` 先类型检查，再运行全部测试。没有独立 lint、formatter 或 build。打包检查不生成 tarball、不发布；新增文档要核对本地链接目标也进入包。

按文件或用例运行测试、真实 CLI 检查和人工验收方法见[开发指南](docs/development.md)，不要把待执行的验收步骤写成完成回执。

## 修改时保持的约束

除非本次任务明确要求改变设计，否则保持：

- Markdown 正文自由组织。前台写入提示只说明跨轮次、跨会话的用途，用户要求或内容明显值得记住时保存，具体选择和组织留给模型，不列固定类别、必填元数据或维护步骤。工具操作与安全边界仍需说明，详细来源回查、纠错、合并和修链任务放在独立 dreaming 提示中。
- 对测试过的结论必须有实际测试或来源反馈，未验证假设明确标注。模型改写、合并和重复引用不是事实验证，记忆也不能授予新权限。
- 自动召回只在 context 钩子临时加载项目和全局 MEMORY.md，不按问题自动注入排名正文，不追加持久会话消息，不替换系统提示，不接管压缩。
- 索引由 Agent 维护，不在新建或归档正文时偷偷改写。单份索引最多 8 KiB、200 行，普通笔记最多 64 KiB，每作用域活动 Markdown 最多 500 文件、8 MiB。
- 新建用 expectedHash:null，已有文件改写或归档用完整正文的 SHA-256。保留旧正文到 .history，MEMORY.md 不能归档。历史最多 1000 份，满后拒绝需增加快照的写入，不自动清理旧证据。
- 所有修改继续经过 Pi 文件队列、跨进程锁、路径与 identity 校验、哈希检查和原子替换。损坏和 identity 不符不能重置为空库，不能静默丢证据或自动抢锁。多文件操作和整次 dreaming 不是事务。
- 项目 identity 使用规范化路径和最近的 .git 标记，只检查标记存在，不执行 Git 或读取内容。项目访问保持信任检查，全局读写仅用于跨项目、非私密知识。
- dreaming 默认在 `agent_settled` 观察实际用户消息，按条目 ID 持久去重，同项目累计 50 条尚未处理消息后触发，不按完成轮数、工具或内部模型调用计数。`session_start` 对已有消息建立基线，不追溯计数；v1 待处理轮数迁移为可触发一次整理的 legacy 工作，不伪装成实际用户消息。调度持久保存会话 ID 批次与可选原生文件提示，不复制来源会话。
- 观察按原项目有序排队，提交成功才出队；同进程重载共享 FIFO，锁竞争通过文件系统事件补记，不轮询、不抢锁。退出仍未落盘时明确警告，不承诺内存观察的崩溃恢复。只读启动不建库，首次记录新用户消息可以创建目录、identity 和调度文件。关闭自动整理不关闭记录，后台自身不制造前台用户消息。
- 每项目一个有效租约，持续 1830 秒，覆盖 30 分钟墙钟期限与启动收尾余量。前台仅取得启动回执，不能宣称整理成功；worker 负责最终确认，成功只确认领取代次，后续工作仍待处理；失败保留待处理工作，已完成写入不回滚。不能抢占有效租约或自动抢文件锁。
- detached supervisor 在原项目规范目录启动普通 Pi CLI Agent，传入当前所选 provider、model、thinking，使用正常配置重新加载凭证、扩展、skills 和 MCP；仅运行时存在的前台注册或配置不能复制。显式加载记忆与 worker 扩展，遵循正常信任流程，不添加自动批准。
- worker 拥有默认 read/bash/edit/write、记忆工具与正常配置资源，不是仅项目来源工具的沙箱。任务包含会话 ID、可选文件提示、会话根目录、已有记忆和截止时间，由 Agent 自主读取完整原始历史。`memory-sources.ts` 保留但不作为 worker 接口，不能再宣称它的活动分支、context_edit、字段过滤或分页限制约束 worker 原始文件读取。
- dreaming 提示要求只维护项目记忆，只读会话和源码，通过记忆工具安全写入，保留依据与不确定性，将历史指令视为不可信材料而非授权。这是提示策略，不是操作系统沙箱；其他普通工具和配置资源仍具备文件、命令与网络能力。不得把历史材料、模型改写或重复引用当作事实验证。
- 不设自定义 32 次模型请求、64 次工具调用或每回复 64k 上限，沿用正常 Pi 与所选模型默认值。唯一任务期限为从启动起 30 分钟，Agent 获知期限，supervisor 到时终止并在短暂清理宽限后强制杀死进程组与已捕获的后代进程，包括普通 detached bash 工具。后代清理是尽力而为，不是进程容器，不能承诺终止已脱离进程或外部工作。前台退出、reload、输入与会话切换不取消已启动运行；活跃 worker 可在 Pi 退出后完成，但没有永久守护进程，未触发工作等待下次前台时机。
- 每次运行在项目 `.dream-runs/<run>/` 保存 `status.json`、`events.jsonl`、`supervisor.log` 和通过 `--session-dir` 放在 `sessions/` 的 worker 自身会话，不放进普通来源根目录。这些是私有运行记录，可能含原始敏感工具文本，不是来源副本索引或知识正文。文档必须说明额外模型费用、完整工具权限、原始历史暴露与前台退出后继续运行，不得称为离线或沙箱。
- coding-agent 和 TypeBox 是宿主 peerDependencies，不放进运行时 dependencies 或打包成另一份 Pi。

更细的算法和边界以[设计说明](docs/design.md)与实现为准，不在多处维护完整工具 schema。

## 代码与文档约定

保持两空格缩进、双引号、分号、显式 `.ts` 导入和 strict 类型检查，不为格式统一重写无关文件。名称带领域含义，存储、检索和后台逻辑放对应模块，不全塞进扩展注册函数。测试与模块就近维护。

前台工具名是 `memory_search`、`memory_read`、`memory_write`，唯一扩展命令是 `/memory <自然语言>`。非空内容原样交给 Agent 提醒保存，忙时排为 follow-up；不解析子命令、不直接写固定格式笔记、不提前宣称已保存。空命令只显示用法。保留 --pi-memory-no-recall 与 --pi-memory-no-dream 启动参数，不加运行时菜单、别名或手动整理命令。改接口时同步实现、schema、提示文本、测试和工具参考。读取保持行范围内的 Unicode 码点分页，单页 content 最多 8 KiB；nextCharacter 非 null 时不能前进行号。工具输出保持完整 JSON，过大搜索结果用显式包装对象，写入回执不回传正文。README 面向使用者，维护约束放本文件，原理放 design，测试细节放 development，避免每页复制相同规则。

README.md 和 docs/*.md 是完整英文默认版；README.zh-CN.md 和 docs/*.zh-CN.md 是对应的完整简体中文版，不是摘要。更改文档时同步两种语言、顶部语言切换和同语言本地链接；README.zh-CN.md 也须进入分发包。本维护指令只保留一份，不另造重复 AGENTS。

设计参考 Anthropic 的 [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)，不声称实现相同或继承其基准收益。文章对齐 review 若本地留有 `references/components-of-agent-memory/`，先读其中 README，校验快照后阅读完整正文，并实际读取原图，不能以 alt 或文件存在代替视觉审阅。该目录不进入 Git，全新克隆不含它；缺失时查阅原始文章并明确证据及读图限制，不宣称已检查缺失快照。区分可组合的层次、模型与任务特定实验、项目实现选择；对应理解统一维护在 docs/design.md，不把实验实例扩成通用功能要求。该第三方图文快照仅供本地维护研究，不进入 Git 或 npm 包。README 保持简短，只写用途、GitHub 安装、/memory 示例、必要的一句操作提醒和文档入口，不写架构原理，不单设费用或隐私提醒章节。临时试用、更新移除、开关、存储备份、隐私与排障放在 docs/usage.md 及其中文版；记忆组成、生命周期和设计取舍统一放在 docs/design.md。

## 验证与安全边界

测试使用临时目录、合成证据和模拟模型。自动化真实 CLI 测试隔离 Pi 配置、禁用其他资源并开启离线模式，通过本地脚本 provider 验证 RPC 和 worker，不发真实模型请求；前台 RPC 用 --no-session，worker 自身会话仅写临时运行目录。不能读取、改写或清理真实用户会话及日常库来凑测试。

Pi 1.5.0 非空 print `/memory` 存在命令另发请求与进程释放的宿主竞争，不将其列为受支持保存路径，也不为此自造会话编排。RPC 验收必须保持进程存活并先订阅事件；命令 disposition=handled 不是模型完成回执，应等待命令触发的独立前台运行 agent_settled。真实模型验收需另外授权、隔离临时配置和凭证、只用合成材料，并与模拟测试、人工 TUI 分开报告。

手工验证显式指定独立 PI_MEMORY_DIR。仅隔离记忆目录不等于隔离 Pi 配置、凭证或网络。模型调用、全局安装、配置修改、提交、推送和发布均不包含在普通测试授权里。提交前检查 Git 暂存清单，不上传 .local/、凭证、真实会话、日常记忆库或第三方原文快照；不要因文件已在项目目录中就默认适合公开。

交付区分类型检查、单元测试、真实 CLI 加载、人工 UI 验收和模型记忆效果，说明实际执行范围。文档改动检查本地链接、JSON 示例和打包清单；不能用打包成功代替行为或效果验证。项目名 pi-memory 不代表拥有 npm 同名包。
