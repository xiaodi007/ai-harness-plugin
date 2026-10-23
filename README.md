# ai-harness-plugin

用户级 Claude Code 插件，本仓同时是本地 marketplace。v0.1.0 只做三件事：

- SessionStart：显示外部活账本和当前工作树未提交改动，纯文本输出不超过 3000 字符。
- Stop：按峰值上下文占窗口的比例提醒写交接卡；45% 软提示一次，70% 硬提示每次都响，仅输出 `systemMessage`，不阻止停止。
- `/harness:relay <任务卡路径>`：核对收口条件，就地更新交接节，生成不超过 15 行的开场 prompt，由维护者自行开新会话。

0.3.0 起 SessionStart 最上面多一段「回到现场」，整体输出不超过 4800 字符（三段各自限长）。见下文。

0.4.0 起 SessionStart 输出 JSON：`systemMessage` 是给维护者界面看的三行摘要（等你几条、WIP 超没超、最该先做的一件），`hookSpecificOutput.additionalContext` 是给模型的全文，开头要求模型在第一条回复里先转述这三行。依据官方 hooks 文档：SessionStart 的纯文本 stdout 与 `additionalContext` 只进模型上下文、界面上不显示，`systemMessage` 显示给用户；实测 `claude -p --output-format stream-json --include-hook-events` 里会话记录把它存为 `hook_system_message`。`--ledger-only` 仍输出纯文本。

0.2.0 加一个技能 `project-methodology`（调用名 `harness:project-methodology`）：方法论资产的取用指针，源目录默认 `~/code/web2/keel/docs/方法论`，可用 `HARNESS_METHODOLOGY_DIR` 覆盖。

不包含议程命令（议程只在开会话时摘要显示）、走查派单，也不包含 multi-ai 入口技能：那份技能的上游源在 multi-ai 仓 `integration/skills/multi-ai`，由 multi-ai 自己安装，本仓不另存副本。判据见方法论《项目记忆模型与工作流循环》§四。

安装（由维护者执行）：

```sh
claude plugin marketplace add ~/code/ai-harness-plugin
claude plugin install harness@ai-harness
```

开发时，在本仓根目录执行：

```sh
claude --plugin-dir ./plugins/harness
```

装上后需撤掉 Keel 仓 `.claude/settings.json` 中原来的 Stop 钩子，否则旧脚本和插件脚本两份都会跑。同时删掉 `~/.claude/skills/project-methodology`，否则同一个技能有两份。本仓测试不安装插件、不修改 `~/.claude`。

SessionStart 读取 `AI_LEDGER_FILE`，默认 `~/.local/state/ai-ledger/events.jsonl`，只读不写；`--ledger-only` 只输出账本段。每个 id 取最后一条 start/finish 事件，finish 不报；别的机器或没有 pid 的记录为 unknown（本机判不了死活）；本机存活 PID（含 EPERM）为 running，其他为 lost。running 全报，lost 仅保留 12 小时内（过了维护者已处理不了，只剩噪音；账本本身不动），unknown 仅保留 24 小时内，每段最多展示 15 条。长字段用省略号截断，另报超出条数；输出不能当作完整账本。只看得见经 multi-ai 记账的活；直接敲 codex 或别的机器上的活看不见。

这是 Keel `scripts/collaboration/ai-ledger.mjs` 之外的第二份账本读者，有判据漂移风险，升级任一实现时应对照复核。running / lost / unknown 三态判据与参考实现一致（0.2.1 起）；仍有的差异：参考实现 `list --open` 默认按 48 小时过滤（含 running），本插件 running 不限时、lost 限 12 小时、unknown 限 24 小时；异常事件序列（finish 后又出现 start）本插件按最后一条事件判。读账本暂不迁 multi-ai：Keel 那份同时是夜间全量的记账与等待工具，迁走读者也删不掉它的判据。

「回到现场」从任务卡目录摘要（依次找 `docs/协作/任务`、`docs/tasks`、`tasks`，都没有就输出一行「未找到任务卡目录」）：

- 活跃卡：前 30 行里有 `- 状态：active|waiting` 的卡，且近 3 天有提交或未提交（没有 git 时按文件修改时间）；最多列 6 张，写明「等你」的排最前、猜出来的其次，余下只列名字。每张一行：上次定了什么、此后动过本卡的提交数（按决定日 0 点起算，不是全仓提交数）、等你什么。
- 两种定格式行（写的一端由任务卡模板规定）：全卡最后一条「维护者定（MM-DD）：…」就是上次定了什么；第一个交接节里的每条「等你：…」是一件等你的事（问时写、答完删，「等你：无」不算）。读不到才猜，并标「（猜）」：已定退到标题含「已定/答复/裁决」的节里最后一条带原话或日期的条目，再退到最后一条「原话：「…」」；等你退到交接节的「仍需拍板 / 待维护者定 / 等维护者」行，交接节没写时取全卡第一条。
- WIP：近 3 天在动的活跃卡超过 3 张（泳道上限）就写「WIP 超限」；目录里标着 active/waiting 但近 3 天没动的卡列为「可能该关」（只读每张开头 4KB 判状态，按文件名倒序列 8 张）。
- 界面摘要第三行「先做」：先答第一张写明「等你」的卡（没有就答猜出来的），其次第一条待走查，再次在 WIP 超限或有可能该关时提示把做完的卡改成 done，都没有写「没有要你做的」。
- 议程未收口：标题含「议程」的节里表格最后一格不是「已定/完成/不做/搁置…」的行，以及全卡未勾的 `- [ ]`。
- 你现在可以做：第一个交接节或未勾项里写了「待维护者走查/看/验收」的行，以及有几张卡在等你回答；都没有就写「没有要你做的」。
- 每张卡只读开头 256KB；代码围栏里的内容不算。卡里没更新的，摘出来的就是过期的，钩子判断不了。

Git 子进程清除继承的 `GIT_*` 环境变量，并设置 `GIT_OPTIONAL_LOCKS=0`，防止 status 刷新索引。非 git 目录输出「非 git 目录，跳过」，适用于 mb 等没有 git 的项目。读取错误作为中文诊断输出，生产 hook 始终零退出。

Stop 脚本保留 Keel 原实现：按 session_id 在 `~/.claude/projects` 下找日志，取 input、cache creation、cache read 之和的峰值。窗口依次取当前目录的项目 local settings、项目 settings、用户 settings 的 `autoCompactWindow`，否则用明确标注为假设的 1000000。不额外消费 `transcript_path` 或 `stop_hook_active`；软档印记位于 `$TMPDIR/harness-context-watch`（TMPDIR 未设置时用 `/tmp`），不在插件目录里写状态。

验证：

```sh
sh scripts/test.sh
```

测试临时文件在本工作树创建并清理，不写 Git 元数据。SessionStart 自测覆盖回到现场（活跃卡筛选、已定提取与前缀、提交计数、第一个交接节与围栏、议程与未勾、你现在可以做的三种情形、无卡目录与无 git 降级、截断与读取上限、还没有提交的仓、两种定格式行与（猜）、等你排序、WIP 与可能该关、界面三行摘要与先做的优先级、钩子 JSON 输出；在临时目录里建独立小仓，提交时间可控）、running、lost、12 小时过期及边界（unknown 仍留 24 小时）、finish 与重复 id、坏行、缺失账本、非 git 降级及环境污染、真实未提交改动、15 条截断、跨主机、空账本、异常、输出长度、ledger-only；每个场景含负向断言。`scripts/mutation-check.mjs` 对回到现场逐条打 45 处变异（含账本 lost 的 12 小时），每处必须恰好命中一次且让自测变红，确认用例不是一开始就绿。非 git 测试只读使用文件系统根目录；真实 Git 测试在现有工作树创建一个临时未跟踪文件。

Stop 原有八个自测覆盖低于阈值、软档、硬档、取峰值、无 usage、软档降噪、硬档重复提醒和无日志。存在 `claude` 时还会校验插件与 marketplace；不存在时明确打印跳过。自测失败返回非零，生产 hook 的兜底行为不受影响。
