---
description: 汇总上次以来完成的任务卡简报，一页看懂发生了什么
argument-hint: [--since YYYY-MM-DD]
---

1. 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/briefs.mjs" $ARGUMENTS`，把输出原样给维护者。
2. 在后面最多补三行：
   - 哪几张卡的风险最值得维护者看；
   - 哪些卡没写简报，或者缺了字段（标了 ⚠ 的）；
   - 有没有几张卡改的是同一个决定者。如果有，提示可能存在见子打子。
3. 维护者确认看过之后，运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/briefs.mjs" --mark`。如果没有给 `--since`，下次就从这个时间点开始算。
