# harness 完整参考（中文）

> 这是 harness 插件各版本的完整行为说明（变更记录式）。入门介绍见仓库根目录的 [README](../README.md)（English）/ [README.zh-CN](../README.zh-CN.md)（中文）。文中出现的 `~/code/web2/...` 路径是作者本机的方法论与试点仓库，不随本仓发布。

用户级 Claude Code 插件，本仓同时是本地 marketplace。v0.1.0 只做三件事（0.6.0 起的接入与交付校验见下文）：

- SessionStart：显示外部活账本和当前工作树未提交改动，纯文本输出不超过 3000 字符。
- Stop：按峰值上下文占窗口的比例提醒写交接卡；45% 软提示一次，70% 硬提示每次都响，仅输出 `systemMessage`，不阻止停止。
- `/harness:relay <任务卡路径>`：核对收口条件，就地更新交接节，生成不超过 15 行的开场 prompt，由维护者自行开新会话。

0.3.0 起 SessionStart 最上面多一段「回到现场」，整体输出不超过 4800 字符（三段各自限长）。见下文。

0.4.0 起 SessionStart 输出 JSON：`systemMessage` 是给维护者界面看的三行摘要（等你几条、WIP 超没超、最该先做的一件），`hookSpecificOutput.additionalContext` 是给模型的全文，开头要求模型在第一条回复里先转述这三行。依据官方 hooks 文档：SessionStart 的纯文本 stdout 与 `additionalContext` 只进模型上下文、界面上不显示，`systemMessage` 显示给用户；实测 `claude -p --output-format stream-json --include-hook-events` 里会话记录把它存为 `hook_system_message`。`--ledger-only` 仍输出纯文本。

0.8.0 加「防全绿没用的测试」三件（D9，依据见 ai-use 仓 `研究/外部稿/grok-2026-11-13-多模型互评偏差/`；与 `设计/P1-1-收敛看板与发布闸.md` §3 冻结用例、`设计/P1-2-验收表与项目体检.md` §4 写的人不判自己对齐）。默认都偏保守：能提示的不拦。

- 测试文件锁（`scripts/test-lock.mjs`，PreToolUse 钩子，匹配 Edit、Write、MultiEdit）：只对 `.harness.json` 配了 `checks.testLock` 的仓生效，`block` 拒绝这次编辑并说明「实现会话不改断言；要改测试请另开卡或在卡里写『改测试：理由』」，`warn` 只提示（模型和维护者都看得到），`off` 或不配不管。被锁路径是 `testLock.paths` 的 glob（从仓根锚定，`**` 跨目录含零层，`*` 不跨 `/`），默认 `docs/scenarios/**` 和 `.harness/scenarios.lock.json`，即 P1-1 §3 的冻结用例目录和锁文件。卡目录顶层近 6 小时改过、不是 dropped 的卡里有一行写了理由的「改测试：…」就放行；放行、warn 命中、拦下都记进 `.harness/test-lock.jsonl`，地基检查报近 7 天放行几次、warn 下改了几次。拒绝用当前的 `hookSpecificOutput.permissionDecision: "deny"`（官方文档里 PreToolUse 顶层的 `decision: "block"` 已标废弃，效果相同）。依据：测试和规格冲突时，GPT-5 在仓库级任务上 76% 会改测试或绕过测试（arXiv 2510.20270）。
- 红-绿回执（`card-check.mjs`）：判定为「根因修复」的 done 卡，证据节要有同一条命令（命令行一样、在仓里同一子目录跑）的一对回执：一张 `receipt.mjs --expect-fail` 改动前（或回退改动后）跑红，红要红在用例上（不是命令没起来、不是 0 用例、解析出用例数时要有失败的）；一张改完跑绿，按原有规则核对（退出 0、无异常、HEAD 是当前 HEAD 的祖先）。两张跑在同一提交且都没有未提交改动时报「红不是这次改动造成的」。多对里有一对站得住就算。推荐写法 `- [已验证] 红绿：回执 R-…（改前红）→ R-…（改后绿）`：同一行里配成对的校准回执按「红」核对，不再报「校准回执不能当证据」；单独引用的校准回执照旧报。没有能跑的测试写一行「红绿不适用：理由」。`.harness.json` 的 `checks.redGreen`：`warn`（默认，Stop 时提示一次、不拦，CLI 打 ⚠ 不算红）、`require`（进缺项，按 `cardOnDone` 拦）、`off`。依据：只有「不带这次改动就失败」的测试，才证明它测到了这次修复。
- 回执记会话：`receipt.mjs` 的回执新增 `session` 字段，取 `HARNESS_SESSION_ID`（手动或别的 agent 指定）或 Claude Code 给 Bash 的 `CLAUDE_CODE_SESSION_ID`（本机桌面端实测有），都没有记 `null`。这补上了 P1-2 §4「待确认：Bash 里能不能拿到会话编号」；独立验证检查本身（绿回执的会话 ≠ 改代码的会话）仍按 P1-2 第 3 批做，本版只记不判。
- 变异测试信号（`scripts/mutate.mjs`，只做信号，不拦任何东西）：`node mutate.mjs [--base <ref>] [--dry-run]` 取相对基点（`--base`，否则 `mutation.base`，否则与 main/master 的分叉点，就在主干上时为 HEAD）`git diff` 出的改动文件加未跟踪的新文件，默认去掉测试、文档、配置与锁文件（配了 `mutation.include` 就只认 include，`mutation.exclude` 再排除），交给 `.harness.json` 的 `mutation.command`（插件不带变异引擎）：`{files}` 换成逐个加引号的路径，`{files,}` 换成逗号连起来的一个参数，另设环境变量 `HARNESS_MUTATE_FILES`（换行分隔）。例：`npx stryker run --mutate {files,}`、`mutmut run --paths-to-mutate {files,}`。解析 Stryker 文本表、mutmut 进度行与 3.x 的 `results`、cargo-mutants 摘要与 MISSED 行；配了 `mutation.report` 就优先读 mutation-testing-elements JSON 报告（跑前先删旧报告）。分数 =（杀死＋超时）÷（杀死＋超时＋存活＋未覆盖）；认不出记「未解析」，不猜。记录写 `.harness/mutation/M-MMDD-HHMM-xxx.json`（基点、文件、命令、HEAD、会话、分数、存活清单前 50 条、输出尾部），工具退出非 0 也照记，脚本跑完总是退出 0（配错退出 2）。SessionStart 全文的「地基」段和 `/harness:brief` 汇总页末尾显示最近一次（按结束时间）。依据：前沿 agent 写的测试约 88% 能在参考实现上通过，但变异分数最好的只有 55.5%（arXiv 2610.13065）；也有研究认为变异测试比覆盖率强不了多少，所以先只当信号。
- 模板：`.harness.json` 加 `checks.redGreen: "warn"`、`checks.testLock: "warn"`、`testLock.paths`（默认两条）、`mutation`（`command` 留空，不配不跑）；任务卡模板的契约节加「改测试」注释、证据节加红绿写法。已接入的仓（如 call）的 `.harness.json` 不会被改：没配 `checks.testLock` 就不锁，`redGreen` 不配按默认 `warn` 提示。
- 已知局限：测试锁只看 Edit、Write、MultiEdit，用 Bash（`sed -i`、重定向）改文件看不见；「改测试：」只认最近 6 小时改过的任意一张卡，不核对理由真假、也不核对是哪张卡的事，靠地基计数和抽查。红绿能证明「这条命令改前红、改后绿」，证明不了红的原因就是这次修的问题。

0.7.0 加「不变量、回执、简报」（方法论 v1 P0-2～P0-4，设计见 `~/code/web2/ai-use/设计/P0-2至4-不变量-回执-简报.md`）：

- 不变量与单写者（`scripts/invariants.mjs`，命令 `/harness:invariants`）：`docs/SYSTEM.md`「不变量」表每行写权威实现 `路径#符号`、指纹正则（单元格里的竖线写 `\|`，`—` 表示空）、消费者查询命令、例外（反引号路径不扫）。`check [ID…]` 查表格（ID 重复、权威实现文件或符号不存在、坏正则、超 40 条）并用指纹扫权威实现之外的源码（跳过测试、文档、生成物；命中按「文件:行文本」记，挪行号不算新增）。`baseline` 把存量记进 `.harness/invariants-baseline.json`，之后只收缩；`--accept-new ID` 才放宽。`consumers ID` 运行该行的查询命令。指纹是网不是证明：换种写法的重复实现扫不到。
- 执行回执（`scripts/receipt.mjs`）：`node receipt.mjs [--expect-fail] -- <命令>` 自己起子进程拿真实退出码，解析 vitest、jest、pytest、unittest、cargo、node:test、go -v 的通过/失败/跳过数（认不出标未解析），报 0 用例、跳过过半、全部跳过、退出 0 却有失败或 FAIL 行；回执写 `.harness/receipts/R-MMDD-HHMM-xxx.json`，打印一行摘要，退出码透传（`--expect-fail` 反转，用来证明门禁会红）。`.harness/.gitignore` 只放过基线文件。
- 任务卡新增「简报」五行（行为变化、决定者、保住、证据、风险），done 时必填。card-check 在有仓库上下文时另查：「触碰的规则」里和表里同前缀的 ID 必须存在、且没有新增第二处实现；`[已验证]` 引用的回执要存在、退出 0、不是校准回执、没有异常、HEAD 是当前 HEAD 的祖先。`.harness.json` 的 `checks.receipts`：`cite`（默认，引用了才核对）、`require`（每条 `[已验证]` 要带回执或写「人工：」）、`off`。
- 简报汇总（`scripts/briefs.mjs`，命令 `/harness:brief`）：把上次看过以来（默认近 7 天，记在 `.harness/brief-seen`）done 卡的简报汇成一页，缺的字段标 ⚠；`--mark` 记为看过。SessionStart 在接入的仓里有新完成的卡时摘要多一行 `ℹ 上次看简报以来 N 张卡完成`，全文带「harness 工具：<脚本目录>」一行（插件升级后目录会变，所以不写进项目指令）。
- 系统地图（`docs/SYSTEM.md`「系统地图」，命令 `/harness:map`）：地基检查在有代码的已接入仓里报地图没写、路径不存在、顶层源码目录没登记（docs、tests、dist 等不算）、没写「最后核对：提交号」、核对以来改了 30 个以上文件、提交号找不到；同时报不变量表问题和没记基线的条目。
- `/harness:tour <流程> [--guess]`：纯提示词，沿地图和不变量表讲一条链路，可先让维护者猜。

0.7.1 修：SessionStart「回到现场」不再把 `_` 开头的模板卡（如 `_模板.md`）算进活跃卡，与 card-check、foundation 同口径（call 试点接入时发现）。

0.6.0 加「接入与交付校验」（方法论 v1 P0-1，设计见 `~/code/web2/ai-use/设计/P0-1-接入器与任务卡.md`）：

- `/harness:init`：把 `plugins/harness/templates/` 里缺的地基拷进仓库（AGENTS.md、只含 `@AGENTS.md` 的 CLAUDE.md、PROJECT.md、DECISIONS.md、docs/SYSTEM.md、任务卡 README 与 `_模板.md`、`.harness.json`），**已有文件一律不覆盖**，只给建议；已有 `docs/tasks`、`docs/协作/任务` 或 `tasks` 就沿用。落盘由 `scripts/init.mjs` 做（`--dry-run` 预演），起草 AGENTS.md 空位和立项对话由命令里的模型做，起草稿先给维护者看。
- SessionStart 地基检查（`scripts/foundation.mjs`）：git 仓里有非 Markdown 的跟踪文件却没有 `.harness.json` 时报「本仓未接入方法论」；已接入的报地基缺失、熵超预算（AGENTS.md 行数、DECISIONS 体积、进行中卡数，阈值读 `.harness.json` 的 `budgets`）、上月及更早的 done/dropped 卡可归档、单卡超 30KB、交付校验豁免张数。有告警时界面摘要在三行前多一行 `⚠ …`，全文最前面多一段「地基」；非 git、纯文档仓、`optOut: true`、`checks.foundation: "off"` 不报；`--ledger-only` 不带。只报警，不拦会话。
- Stop 交付校验（`scripts/card-check.mjs --stop`）：只对有 `.harness.json` 的仓生效（从 cwd 往上找到 git 仓根）。卡目录顶层、近 6 小时改过、状态为 `done` 的卡，检查契约（验收剧本、改什么、保住什么）、同类扫描（不适用要写理由，至少 8 个字）、判定（根因修复 / 样例补丁二选一）、证据（至少一条带等级，且要有 `[已验证]` 或 `[未验证]`）、类别债节、交接的别重做；HTML 注释、代码围栏、`<…>` 占位不算填了。缺项时 `decision: block` 让模型补全；同一张卡每会话只拦一次（印记在 `$TMPDIR/harness-card-check/`），`stop_hook_active` 时只提示；`checks.cardOnDone` 为 `warn` 只提示、`off` 不管；卡里写「校验豁免：理由」跳过并被地基检查计数。`archive/`、`README.md`、`_` 开头的模板不扫。也可当 CLI：`node card-check.mjs <卡…>`，红了退出 1。`/harness:relay` 收口时对 done 卡跑一遍。
- 已知局限：字段能挡空，挡不住敷衍（例如同类扫描写得够长但没真扫），试点里靠「扫描实际发现遗漏的比例」和维护者抽查补；Stop 只认文件修改时间，不认「本会话改的」。

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
- WIP（0.5.0 起）：数实施泳道，不数卡。泳道＝账本里 running 的活，加上有未提交改动、或有主工作树 HEAD 之外提交的工作树；账本活的目录落在某棵工作树里就并进那一条。超过 3 条写「WIP 超限」，全文逐条列出泳道。目录里标着 active/waiting 但近 3 天没动的卡列为「停着的未完成」（不叫「可能该关」：留着的卡多半有未完成项；只读每张开头 4KB 判状态，按文件名倒序列 8 张）。
- 界面摘要第一行与第三行「先做」只认交接节写明的「等你：」；猜出来的可能早已答过、或还轮不到维护者（例如「下一会话出推荐」），只报「另有 n 张卡没按格式写，不算」。「先做」依次取：第一条写明的等你、第一条待走查、泳道超限时先收一条、没有要你做的（有停着的未完成时补一句「想接着做，从停着的未完成里挑一张」，不指向改 done）。
- 议程未收口：标题含「议程」的节里表格最后一格不是「已定/完成/不做/搁置…」的行，以及全卡未勾的 `- [ ]`。
- 你现在可以做：第一个交接节或未勾项里写了「待维护者走查/看/验收」的行，以及有几张卡在等你回答；都没有就写「没有要你做的」。
- 每张卡只读开头 256KB；代码围栏里的内容不算。卡里没更新的，摘出来的就是过期的，钩子判断不了。

Git 子进程清除继承的 `GIT_*` 环境变量，并设置 `GIT_OPTIONAL_LOCKS=0`，防止 status 刷新索引。非 git 目录输出「非 git 目录，跳过」，适用于 mb 等没有 git 的项目。读取错误作为中文诊断输出，生产 hook 始终零退出。

Stop 脚本保留 Keel 原实现：按 session_id 在 `~/.claude/projects` 下找日志，取 input、cache creation、cache read 之和的峰值。窗口依次取当前目录的项目 local settings、项目 settings、用户 settings 的 `autoCompactWindow`，否则用明确标注为假设的 1000000。不额外消费 `transcript_path` 或 `stop_hook_active`；软档印记位于 `$TMPDIR/harness-context-watch`（TMPDIR 未设置时用 `/tmp`），不在插件目录里写状态。

验证：

```sh
sh scripts/test.sh
```

测试临时文件在本工作树创建并清理，不写 Git 元数据。SessionStart 自测覆盖回到现场（活跃卡筛选、已定提取与前缀、提交计数、第一个交接节与围栏、议程与未勾、你现在可以做的三种情形、无卡目录与无 git 降级、截断与读取上限、还没有提交的仓、两种定格式行与（猜）、等你排序、WIP 按泳道（未合入提交、未提交改动、账本 running 并进工作树、lost 不算）与停着的未完成、界面三行摘要与先做的优先级（猜的不进）、钩子 JSON 输出；在临时目录里建独立小仓，提交时间可控）、running、lost、12 小时过期及边界（unknown 仍留 24 小时）、finish 与重复 id、坏行、缺失账本、非 git 降级及环境污染、真实未提交改动、15 条截断、跨主机、空账本、异常、输出长度、ledger-only；每个场景含负向断言。`scripts/mutation-check.mjs` 对回到现场（含地基告警接入）、交付校验、地基检查、接入器共打 210 处变异（0.7.0 起含不变量、回执、简报；0.8.0 起含测试锁、红绿、变异信号），每处必须恰好命中一次且让对应脚本的自测变红，确认用例不是一开始就绿。card-check、foundation、init、invariants、receipt、briefs、test-lock、mutate 各有 `--self-test`（28、19、7、12、10、5、9、9 项），临时仓建在本工作树内并清理。非 git 测试只读使用文件系统根目录；真实 Git 测试在现有工作树创建一个临时未跟踪文件。

Stop 原有八个自测覆盖低于阈值、软档、硬档、取峰值、无 usage、软档降噪、硬档重复提醒和无日志。存在 `claude` 时还会校验插件与 marketplace；不存在时明确打印跳过。自测失败返回非零，生产 hook 的兜底行为不受影响。
