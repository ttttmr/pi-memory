# pi-memory：维护 Agent 约定

本文件面向修改本项目的 Agent，不是使用说明。快速上手见 [README.md](README.md)，详细操作和排障见 [docs/usage.md](docs/usage.md)，工具参数见 [docs/tools.md](docs/tools.md)，架构与数据约束见 [docs/design.md](docs/design.md)，测试和人工验收见 [docs/development.md](docs/development.md)。

## 项目与入口

这是 Pi 的本地跨会话 Markdown 记忆扩展，使用 TypeScript ESM、TypeBox 和 Node.js 标准库。Pi 直接加载 TypeScript，没有独立服务、编译产物或 build 步骤。

维护前先理解 mem 的组织，而不只看工具名称：

```text
PI_MEMORY_DIR 或 getAgentDir()/pi-memory
  -> 每个项目一个目录 + global/
  -> MEMORY.md 是小索引，其他 Markdown 是自由组织的正文
  -> .identity.json 是内部元数据，.history/ 保存改写或归档前的正文
  -> 项目 .dream-state.json 保存待整理轮数与运行租约，不是知识正文

每次请求
  -> context 钩子临时注入项目与全局 MEMORY.md
  -> Agent 按需搜索、读正文、对照当前反馈，自主记下重要经验

已完成前台交互累计为项目级待整理工作
  -> 受限的独立 dreaming 上下文
  -> 同项目原生历史的只读来源与项目记忆
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
| 后台模型循环与工具预算 | `src/memory-dream.ts` 及其就近测试 |
| 同项目原生历史只读来源、分支与上下文编辑 | `src/memory-sources.ts` 及其就近测试 |
| 项目级持久调度、轮数去重与运行租约 | `src/memory-schedule.ts` 及其就近测试 |
| 已完成交互的排队提交与锁释放后补记 | `src/memory-observations.ts` 及其就近测试 |

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
- dreaming 默认在 agent_settled 后累计 8 次未处理前台交互时触发，不依赖 memory_write 或已有笔记。项目级调度保存在 .dream-state.json，已提交状态跨会话、进程保留。观察先按原项目/session/leaf 排队，提交成功后才出队；同进程模块重载复用同一 FIFO，回调切换到当前运行时，不能让新旧队列独立重放而倒退最新 leaf。锁竞争通过文件系统事件唤醒补记，不轮询、不抢锁、不乱序重放。队列内及同会话最新 leaf 的重复通知不重复计数。会话变化不能用旧上下文触发模型；退出时仍未落盘的观察必须明确警告，不承诺内存队列的崩溃恢复。只读启动不建库，首次记录前台交互可以创建目录、identity 和调度文件。
- 自动运行通过 120 秒逻辑租约避免跨进程重复领取，成功仅确认领取时的代次，之后的新工作仍待处理；取消或失败释放租约但保留待处理轮数。不自动抢文件锁，不在退出 Pi 后常驻处理。自动整理与 recall 的启动关闭参数独立，关闭自动整理不关闭轮数记录，后台写入不制造新轮数。没有手动整理入口或运行时开关。
- 后台使用当前同一所选模型和注册表凭证、独立上下文，仅项目记忆工具与 memory_source_search、memory_source。来源由宿主注入的会话根目录与当前运行时会话提供，按会话头 cwd 的规范项目 identity 筛选，不接受模型提供文件路径。
- 历史来源只读扫描 Pi 原生会话，允许跨会话及压缩前仍保留的原文，但只选择活动分支并尊重 context_edit 删除与替换。仅 user、assistant、普通工具结果文本，排除自身记忆工具结果，不读 thinking、签名、图片、自定义消息或系统提示。不得调用可能写盘的 SessionManager.open 或 getDefaultSessionDir；不得保存会话副本索引或改写原始日志。
- 来源 ID 为 sessionId:entryId:0，精确读取不依赖当前搜索页，文本按 Unicode 码点分页，每页最多 8 KiB。扫描的分页、不完整范围和拒绝文件必须显式呈现，不能把未找到当作不存在。继承的同一来源不能算独立趋势，编辑替换文本不能冒充原始观察。后台不调用任意文件、shell、网络、全局记忆或测试工具，不能声称已核验未读取的来源或自己运行过测试。
- 后台最多 6 次模型请求、16 次工具调用、每请求输出 4096 tokens、总超时 90 秒。输入、agent_start、session_before_tree/fork/switch、新会话和 shutdown 取消后台，但已完成写入保留。文档必须说明额外模型费用，不能把无网络工具写成不联网。
- coding-agent 和 TypeBox 是宿主 peerDependencies，不放进运行时 dependencies 或打包成另一份 Pi。

更细的算法和边界以[设计说明](docs/design.md)与实现为准，不在多处维护完整工具 schema。

## 代码与文档约定

保持两空格缩进、双引号、分号、显式 `.ts` 导入和 strict 类型检查，不为格式统一重写无关文件。名称带领域含义，存储、检索和后台逻辑放对应模块，不全塞进扩展注册函数。测试与模块就近维护。

前台工具名是 `memory_search`、`memory_read`、`memory_write`，唯一扩展命令是 `/memory <自然语言>`。非空内容原样交给 Agent 提醒保存，忙时排为 follow-up；不解析子命令、不直接写固定格式笔记、不提前宣称已保存。空命令只显示用法。保留 --pi-memory-no-recall 与 --pi-memory-no-dream 启动参数，不加运行时菜单、别名或手动整理命令。改接口时同步实现、schema、提示文本、测试和工具参考。读取保持行范围内的 Unicode 码点分页，单页 content 最多 8 KiB；nextCharacter 非 null 时不能前进行号。工具输出保持完整 JSON，过大搜索结果用显式包装对象，写入回执不回传正文。README 面向使用者，维护约束放本文件，原理放 design，测试细节放 development，避免每页复制相同规则。

README.md 和 docs/*.md 是完整英文默认版；README.zh-CN.md 和 docs/*.zh-CN.md 是对应的完整简体中文版，不是摘要。更改文档时同步两种语言、顶部语言切换和同语言本地链接；README.zh-CN.md 也须进入分发包。本维护指令只保留一份，不另造重复 AGENTS。

设计参考 Anthropic 的 [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)，不声称实现相同或继承其基准收益。文章对齐 review 若本地留有 `references/components-of-agent-memory/`，先读其中 README，校验快照后阅读完整正文，并实际读取原图，不能以 alt 或文件存在代替视觉审阅。该目录不进入 Git，全新克隆不含它；缺失时查阅原始文章并明确证据及读图限制，不宣称已检查缺失快照。区分可组合的层次、模型与任务特定实验、项目实现选择；对应理解统一维护在 docs/design.md，不把实验实例扩成通用功能要求。该第三方图文快照仅供本地维护研究，不进入 Git 或 npm 包。README 保持简短，只写用途、GitHub 安装、/memory 示例、必要的一句操作提醒和文档入口，不写架构原理，不单设费用或隐私提醒章节。临时试用、更新移除、开关、存储备份、隐私与排障放在 docs/usage.md 及其中文版；记忆组成、生命周期和设计取舍统一放在 docs/design.md。

## 验证与安全边界

测试使用临时目录、合成证据和模拟模型。自动化真实 CLI 测试隔离 Pi 配置、禁用其他资源、开启离线模式并使用 --no-session，通过本地脚本 provider 验证 RPC，不发真实模型请求。不能读取、改写或清理真实用户会话及日常库来凑测试。

Pi 1.5.0 非空 print `/memory` 存在命令另发请求与进程释放的宿主竞争，不将其列为受支持保存路径，也不为此自造会话编排。RPC 验收必须保持进程存活并先订阅事件；命令 disposition=handled 不是模型完成回执，应等待命令触发的独立前台运行 agent_settled。真实模型验收需另外授权、隔离临时配置和凭证、只用合成材料，并与模拟测试、人工 TUI 分开报告。

手工验证显式指定独立 PI_MEMORY_DIR。仅隔离记忆目录不等于隔离 Pi 配置、凭证或网络。模型调用、全局安装、配置修改、提交、推送和发布均不包含在普通测试授权里。提交前检查 Git 暂存清单，不上传 .local/、凭证、真实会话、日常记忆库或第三方原文快照；不要因文件已在项目目录中就默认适合公开。

交付区分类型检查、单元测试、真实 CLI 加载、人工 UI 验收和模型记忆效果，说明实际执行范围。文档改动检查本地链接、JSON 示例和打包清单；不能用打包成功代替行为或效果验证。项目名 pi-memory 不代表拥有 npm 同名包。
