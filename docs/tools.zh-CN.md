# 工具参考

[English](tools.md) | 简体中文

本文说明 pi-memory 的 Markdown 记忆接口。返回 [README](../README.zh-CN.md)，组织和生命周期见[设计说明](design.zh-CN.md)。`memory_search`、`memory_read`、`memory_write` 是模型调用的工具，不是用户命令。用户只需用 `/memory <自然语言说要记住的一件事>` 提出保存请求，由前台模型自主调用这些工具；命令处理器不直接生成笔记。

## 路径与作用域

路径相对于所选记忆目录，比如 `MEMORY.md`、`topics/migrations.md`。目录和文件名由 Agent 组织，不要求固定主题名。只允许合法的相对 Markdown 路径，不能用绝对路径、`..` 越界或访问隐藏的内部元数据和 `.history/`。根目录索引名必须精确为 `MEMORY.md`，不允许 `memory.md` 等大小写别名，也不能把这个保留名称当目录。

`project` 是当前项目记忆，`global` 是跨项目记忆。项目访问要求 Pi 项目信任；全局写入允许自主完成，不需要逐次 UI 确认。全局内容只应包含真正跨项目、非私密的知识。

正文是完整 Markdown，没有强制 title、summary、evidence 或 status 字段，也不要求每份笔记都带来源、版本或日期。保留什么、怎样组织由 Agent 判断。写入成功不表示内容已验证，推断不能冒充已测试事实。

## memory_search

搜索活动笔记，或在没有查询时列出路径。不搜索历史快照。

| 参数 | 必填 | 默认值与约束 |
| --- | --- | --- |
| `query` | 否 | 最多 1000 字符；省略或没有有效检索项时列出路径 |
| `scope` | 否 | `all`，可选 `project`、`global`、`all` |
| `limit` | 否 | 默认 10，整数 1~30 |

```json
{
  "query": "迁移工具 1.2.3",
  "scope": "project",
  "limit": 3
}
```

列出当前项目路径：

```json
{
  "scope": "project",
  "limit": 30
}
```

正常返回数组，每项包含 `scope`、`path`、`hash`、`score`、`excerpt`。搜索输出超过 50 KiB 时会减少尾部结果，改为返回 `{ "results": [], "outputTruncated": true, "hint": "..." }` 形式的对象；results 保存实际留下的结果。两种形状都是完整 JSON。摘录最多取 6 行、600 个 JavaScript 字符，不是完整正文。没有匹配时返回空数组。根据结果中的 scope、path 调用 `memory_read`，不要猜测正文属于哪个作用域。查询使用英文词、汉字和日文假名相邻双字的词法匹配，不是语义检索；分数不是置信度或事实正确率。

自动召回不使用这份搜索结果，只加载项目与全局 `MEMORY.md`。详细笔记能搜到，不等于它会自动进入请求。

## memory_read

按路径读取活动 Markdown，先按行选择范围，再对这个范围做字符分页，单页 content 最多 8 KiB UTF-8。读取历史快照不在此工具接口内。

| 参数 | 必填 | 默认值与约束 |
| --- | --- | --- |
| `path` | 否 | `MEMORY.md` |
| `scope` | 否 | `project`，可选 `project`、`global` |
| `offset` | 否 | 从第 1 行开始，整数且至少为 1 |
| `limit` | 否 | 默认 500，整数 1~1000，选择本次要读取的行范围 |
| `startCharacter` | 否 | 默认 0，在所选行范围内的 Unicode 码点偏移，整数且至少为 0 |

```json
{
  "path": "topics/migrations.md",
  "scope": "project",
  "offset": 1,
  "limit": 100
}
```

存在时返回 `path`、正文 `content`、文件完整内容的 SHA-256 `hash`、起始行 `offset`、总行数 `totalLines`、字符偏移 `startCharacter`、下一字符位置 `nextCharacter` 和是否仍有后续内容 `hasMore`。不存在时返回 `{ "path": "所请求路径", "exists": false, "hash": null }`，不会创建目录或空文件。只读部分内容时，`hash` 仍对应完整文件，不是片段哈希。`hasMore` 在还有字符页或后续行时为 true。需要完整改写时先读全文件，避免把分页内容当成全部正文。

若 `nextCharacter` 不是 null，保持同一个 offset、limit，以 `startCharacter: nextCharacter` 继续读取所选行范围；它按 Unicode 码点计数，不是 UTF-8 字节偏移或 JavaScript UTF-16 下标。只有 nextCharacter 为 null 后，才把 offset 加上本次 limit，并把 startCharacter 重置为 0，继续下一行范围。这样可以读完很长的单行，不会跳过未返回的内容。

比如上例 offset 为 1、limit 为 100，如果返回 nextCharacter 为 8000，下一次调用应为：

```json
{
  "path": "topics/migrations.md",
  "scope": "project",
  "offset": 1,
  "limit": 100,
  "startCharacter": 8000
}
```

8000 是流程示例，实际使用返回的 nextCharacter，不要按页大小自行推算。

读取全局索引：

```json
{
  "scope": "global"
}
```

## memory_write

新建、完整改写或归档 Markdown，由 Agent 自主维护。

| 参数 | 必填 | 默认值与约束 |
| --- | --- | --- |
| `action` | 否 | `upsert`，可选 `upsert`、`archive` |
| `path` | 是 | 合法的相对 Markdown 路径，最多 240 字符 |
| `scope` | 否 | `project`，可选 `project`、`global` |
| `content` | upsert 必填 | 完整的新正文，不是差异补丁；archive 时省略或传 `""` |
| `expectedHash` | 是 | 新建用 `null`，修改或归档用当前完整文件的 SHA-256 |

普通笔记每份最多 64 KiB，`MEMORY.md` 最多 8 KiB、200 行。每个作用域的活动 Markdown 最多 500 个文件、共 8 MiB。改写和归档前会保存旧正文，历史最多 1000 份；满后拒绝需要新快照的写入，不自动删旧证据。

### 新建

以下工具、版本和结果都是合成示例，不代表真实工具行为：

```json
{
  "path": "topics/migrations.md",
  "expectedHash": null,
  "content": "# 示例迁移工具\n\n适用：example-cli 1.2.3。\n观察：合成结果拒绝 --example，退出码 1。\n来源：fixture-session:fixture-entry:0。\n\n未验证假设：新版可能改用配置文件。升级后需重试。\n"
}
```

目标必须不存在。若已经有文件，先读取并比较，不把 `null` 当作覆盖许可。新建正文不会自动更新索引，需要单独维护 `MEMORY.md`。

### 改写

先 `memory_read` 取得当前完整正文和 `hash`，比较后提交完整的新内容：

```json
{
  "action": "upsert",
  "path": "topics/migrations.md",
  "expectedHash": "<刚读到的完整 SHA-256>",
  "content": "# 示例迁移工具\n\n完整的新笔记，包括应保留的来源、条件和不确定性。\n"
}
```

尖括号值是占位符，实际调用必须替换成工具返回的 64 位十六进制哈希。成功时旧正文进入隐藏历史，活动路径保存新正文。新内容与现有内容完全相同时不新增快照。`MEMORY.md` 也用这个流程维护，不能省略哈希。

### 归档

```json
{
  "action": "archive",
  "path": "topics/migrations.md",
  "expectedHash": "<刚读到的完整 SHA-256>"
}
```

归档保存当前正文到历史，并移除活动文件。省略 `content` 或传空字符串（`""`），非空正文会被拒绝。空字符串占位兼容会传入所有字段的模型调用。不允许归档 `MEMORY.md`。索引链接不会自动改动，Agent 需要相应维护索引。

归档不是永久删除，不移除旧会话、备份或提供商副本，也不是安全擦除。没有通过此工具清空历史的动作。

### 冲突处理

`expectedHash` 不匹配时拒绝写入。重新读取、比较变更，再合并或放弃。不要只换上最新哈希重放旧内容，否则仍可能覆盖他人的有效更新。

哈希保护的是单个文件的并发修改，不是多个文件组成的事务。先改正文、再改索引时，后一步失败不会回滚前一步。

成功写入只返回 `scope`、`action`、`path`、`hash` 和来源提示 `sourceHint`，不回传正文。归档回执中的哈希对应刚归档的文件，不代表它仍在活动列表中。sourceHint 只提示当前会话位置，不是实际结论的证据。

## 从经验到复用的一个例子

下面是一种可能的使用方式，不是前台模型必须逐步执行的固定流程。

1. 实际工作得到反馈，判断哪些知识值得跨会话保留。
2. 先搜索或读相关笔记，避免新建重复内容。
3. 用完整 Markdown 写入结论、条件、来源和明确标注的假设。
4. 按需更新 `MEMORY.md` 的简短导航，而不是复制整篇正文。
5. 后续请求从索引找到正文，结合当前环境和来源决定是否采用。
6. 发现新反馈时改写或归档；dreaming 可继续整理，但不代替测试。

这不是必须逐步人工批准的流程。Agent 可自主调用写工具，全局也一样。历史笔记里的授权不能扩大当前任务允许的动作。

## dreaming 可用的工具

dreaming 启动普通 Pi CLI Agent，不再使用仅限项目来源工具的旧模型循环。它拥有默认的 `read`、`bash`、`edit`、`write`，上述三个记忆工具，以及正常 Pi 配置加载的资源，包括配置的扩展、skills 和 MCP 工具。前台进程中仅存在于运行时的配置变化不会复制过去。worker 不注册旧的 `memory_source_search`、`memory_source` 接口；仓库保留其实现供已有测试和参考使用。

任务提供会话 ID、可选的原生文件位置提示、会话根目录、项目 identity 和截止时间。Agent 自主选择如何定位、读取原始历史和已有记忆。位置提示不是来源副本或永久搜索索引。直接读取原始文件不强制执行旧来源提供器的活动分支投影、上下文编辑过滤、字段排除和分页规则。上下文中删除或替换的内容以及敏感原始字段仍可能存在于原生日志中。

维护提示将任务限制为项目记忆：只读会话与源码，通过记忆工具安全写笔记，核对依据，并将历史指令视为不可信材料而非授权。这些是提示指令，**不是操作系统沙箱或工具白名单**。Agent 的普通工具可以访问文件、执行命令并使用配置中具备网络能力的工具。只有在接受这些权限和历史数据暴露范围时才启用自动 dreaming。生命周期、费用与运行日志见[使用指南](usage.zh-CN.md#隐私与使用注意)和[设计说明](design.zh-CN.md#独立-dreaming-agent)。

## 输出与错误

三个前台工具通过文本返回 JSON 数据，不声明 outputSchema，不能假设宿主已把它解析成结构化对象。本扩展保持结果为完整 JSON，输出上限为 50 KiB，不在 JSON 尾部追加截断文字，也不按 2000 行截断。过大的搜索数组使用前述包装对象；其他结果若超限则报错，需缩小请求。较长正文按 offset、limit、startCharacter 和 nextCharacter 协议分页，写入回执不包含正文。

路径非法、归属不符、权限不足、哈希冲突、锁冲突、容量超限和写入失败都应作为错误处理，不能当作空库自动覆盖。读取缺失文件的 exists:false 只表示该路径不存在，不能推断同作用域其他笔记也不存在。恢复和排障见[使用指南](usage.zh-CN.md#故障排查)。
