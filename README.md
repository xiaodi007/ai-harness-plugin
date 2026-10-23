# ai-harness-plugin

用户级 Claude Code 插件，本仓同时是本地 marketplace。v0.1.0 只做三件事：

- SessionStart：显示外部活账本和当前工作树未提交改动，纯文本输出不超过 3000 字符。
- Stop：按峰值上下文占窗口的比例提醒写交接卡；45% 软提示一次，70% 硬提示每次都响，仅输出 `systemMessage`，不阻止停止。
- `/harness:relay <任务卡路径>`：核对收口条件，就地更新交接节，生成不超过 15 行的开场 prompt，由维护者自行开新会话。

不包含技能、议程命令或走查派单。判据见方法论《项目记忆模型与工作流循环》§四。

安装（由维护者执行）：

```sh
claude plugin marketplace add ~/code/ai-harness-plugin
claude plugin install harness@ai-harness
```

开发时，在本仓根目录执行：

```sh
claude --plugin-dir ./plugins/harness
```

装上后需撤掉 Keel 仓 `.claude/settings.json` 中原来的 Stop 钩子，否则旧脚本和插件脚本两份都会跑。本仓测试不安装插件、不修改 `~/.claude`。

SessionStart 读取 `AI_LEDGER_FILE`，默认 `~/.local/state/ai-ledger/events.jsonl`，只读不写；`--ledger-only` 只输出账本段。每个 id 取最后一条 start/finish 事件，finish 不报；本机存活 PID（含 EPERM）为 running，其他为 lost。running 全报，lost 仅保留 24 小时内，每段最多展示 15 条。长字段用省略号截断，另报超出条数；输出不能当作完整账本。只看得见经 multi-ai 记账的活；直接敲 codex 或别的机器上的活看不见（账本已有的跨主机记录显示 lost，不能据此断言远端进程已停）。

这是 Keel `scripts/collaboration/ai-ledger.mjs` 之外的第二份账本读者，有判据漂移风险，升级任一实现时应对照复核。当前参考实现的 `list --open` 会把跨主机记录标为 unknown，默认按 48 小时过滤，并在事件折叠中保留 finish；本插件按 v1 任务书采用上述最后事件、lost 和 24 小时规则。正常本机 start/finish 的运行判据一致，异常事件序列及跨主机、时间过滤存在这些明确差异。

Git 子进程清除继承的 `GIT_*` 环境变量，并设置 `GIT_OPTIONAL_LOCKS=0`，防止 status 刷新索引。非 git 目录输出「非 git 目录，跳过」，适用于 mb 等没有 git 的项目。读取错误作为中文诊断输出，生产 hook 始终零退出。

Stop 脚本保留 Keel 原实现：按 session_id 在 `~/.claude/projects` 下找日志，取 input、cache creation、cache read 之和的峰值。窗口依次取当前目录的项目 local settings、项目 settings、用户 settings 的 `autoCompactWindow`，否则用明确标注为假设的 1000000。不额外消费 `transcript_path` 或 `stop_hook_active`；软档印记位于 `$TMPDIR/harness-context-watch`（TMPDIR 未设置时用 `/tmp`），不在插件目录里写状态。

验证：

```sh
sh scripts/test.sh
```

测试临时文件在本工作树创建并清理，不写 Git 元数据。SessionStart 自测覆盖 running、lost、过期及边界、finish 与重复 id、坏行、缺失账本、非 git 降级及环境污染、真实未提交改动、15 条截断、跨主机、空账本、异常、输出长度、ledger-only；每个场景含负向断言。非 git 测试只读使用文件系统根目录；真实 Git 测试在现有工作树创建一个临时未跟踪文件。

Stop 原有八个自测覆盖低于阈值、软档、硬档、取峰值、无 usage、软档降噪、硬档重复提醒和无日志。存在 `claude` 时还会校验插件与 marketplace；不存在时明确打印跳过。自测失败返回非零，生产 hook 的兜底行为不受影响。
