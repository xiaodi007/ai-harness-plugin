# ai-harness-plugin · `harness`

[English](README.md) · [完整参考](docs/REFERENCE.md) · [许可证：MIT](LICENSE)

**harness** 是一个 [Claude Code](https://docs.claude.com/en/docs/claude-code) 插件，用来给跨多个会话的长期 AI 开发加上工作纪律。它保证：

- 每次开新会话都**从上次停下的地方接着干**，不用从头摸索；
- 没有契约、证据和交接，任务就标不成 *done*；
- 「全绿」要经过核对：测试确实跑了，改之前确实是红的，断言也没被悄悄改掉；
- 维护者**不读 diff** 也知道发生了什么。

本仓库同时是一个插件 **marketplace**（`ai-harness`），里面只有一个插件 `harness`。

## 功能

### 钩子（自动运行）

| 钩子 | 脚本 | 作用 |
|---|---|---|
| **SessionStart** | `session-start.mjs`、`foundation.mjs` | 输出「回到现场」。维护者界面上只显示三行摘要：等你几条、WIP 有没有超、最该先做的一件。模型拿到全文：活跃任务卡（上次定了什么、在等你什么）、实施泳道、停着的未完成、未收口议程、AI 账本里在跑或已丢失的外部活、未提交改动，以及**地基告警**（缺文件、熵超预算、可归档的卡、系统地图过期） |
| **PreToolUse**（Edit / Write / MultiEdit） | `test-lock.mjs` | **测试锁**：改冻结的测试路径时提示或直接拦下；卡里写了「改测试：理由」才放行 |
| **Stop** | `card-check.mjs --stop` | **交付校验**：标成 `done` 的卡必须有契约、同类扫描、判定（根因修复或样例补丁）、带等级的证据、类别债和交接；缺项时拦一次，让模型补全 |
| **Stop** | `context-watch.py` | 上下文用量到 45% 软提示一次，到 70% 每次都硬提示，提醒写交接卡 |

### 斜杠命令

| 命令 | 用途 |
|---|---|
| `/harness:init [--card-dir 目录]` | 接入一个仓库：补齐缺的地基文件（`AGENTS.md`、`CLAUDE.md`、`PROJECT.md`、`DECISIONS.md`、`docs/SYSTEM.md`、任务卡模板、`.harness.json`），**已有文件一律不覆盖**；然后起草项目指令，新仓则走立项对话 |
| `/harness:relay <任务卡>` | 核对收口条件，重写卡的交接节，生成不超过 15 行的下一会话开场 prompt |
| `/harness:brief [--since 日期]` | 把上次看过以来完成的卡的五行简报汇成一页 |
| `/harness:map` | 起草或更新 `docs/SYSTEM.md` 里一页纸的**系统地图**（模块、路径、职责、决定者、外部依赖） |
| `/harness:invariants [规则]` | 起草**不变量**：每条业务规则只有一处权威实现，再配一段指纹正则，用来扫出别处的重复实现 |
| `/harness:tour <流程> [--guess]` | 沿着系统地图带维护者走一遍某条业务链路，可以先让维护者猜 |

### 命令行工具

脚本在 `plugins/harness/scripts/`，用 `node` 运行：

| 脚本 | 用途 |
|---|---|
| `receipt.mjs [--expect-fail] -- <命令>` | 跑测试命令并生成**执行回执**（`.harness/receipts/R-….json`）：记录真实退出码，解析 vitest、jest、pytest、unittest、cargo、node:test、`go test -v` 的通过 / 失败 / 跳过数，并标出异常（0 用例、跳过过半、退出 0 却有失败）。改前跑出红回执、改后跑出绿回执，两张配成一对，就能证明这条测试测到了这次修复 |
| `card-check.mjs <卡…>` | 手动跑交付校验，有缺项时退出 1 |
| `invariants.mjs check \| baseline \| consumers ID` | 检查不变量表，扫重复实现；基线只许收缩 |
| `mutate.mjs [--base REF] [--dry-run]` | 对改动文件跑**变异测试信号**：调用你配置的引擎（Stryker、mutmut、cargo-mutants 等），记录分数，不拦任何操作 |
| `briefs.mjs [--mark]` | `/harness:brief` 背后的脚本 |

## 安装

需要：Claude Code、Node.js ≥ 18（在 22 上测过）、Python 3、git。

```sh
claude plugin marketplace add xiaodi007/ai-harness-plugin
claude plugin install harness@ai-harness
```

或者从本地克隆安装：

```sh
git clone https://github.com/xiaodi007/ai-harness-plugin.git
claude plugin marketplace add ./ai-harness-plugin
claude plugin install harness@ai-harness
```

不安装、只试用：在仓库根目录运行

```sh
claude --plugin-dir ./plugins/harness
```

## 快速上手

1. 在项目里打开 Claude Code，运行 `/harness:init`。它会先预演要建哪些文件，等你同意后才落盘，而且只补缺的。
2. 每个非单步的改动都配一张**任务卡**，放在卡目录里（默认 `docs/tasks/`，已有的 `docs/协作/任务`、`tasks/` 也认）。从 `_模板.md` 起草，卡里包括契约、影响面扫描、证据、简报和交接。
3. 测试通过回执来跑，证据才核对得了：

   ```sh
   node <插件目录>/scripts/receipt.mjs -- pnpm test
   ```

   然后在卡里引用回执，比如 `- [已验证] 红绿：回执 R-…（改前红）→ R-…（改后绿）`。插件脚本所在的目录会在 SessionStart 的全文里打印出来。
4. 会话快满时，运行 `/harness:relay docs/tasks/<卡>.md`，把生成的 prompt 贴进新会话。
5. 隔一段时间运行一次 `/harness:brief`，看看完成了哪些事。

没有 `.harness.json` 的仓库不启用交付校验、测试锁和地基检查。SessionStart 照常显示账本和未提交改动；有代码的 git 仓库还会多一行「本仓未接入方法论」。

## 配置：`.harness.json`

```json
{
  "cardDir": "docs/tasks",
  "budgets": { "agentsLines": 200, "decisionsKB": 100, "activeCards": 12 },
  "checks": {
    "cardOnDone": "block",
    "foundation": "warn",
    "receipts":   "cite",
    "redGreen":   "warn",
    "testLock":   "warn"
  },
  "testLock": { "paths": ["docs/scenarios/**", ".harness/scenarios.lock.json"] },
  "mutation": { "command": "", "include": [], "exclude": [] },
  "optOut": false
}
```

| 键 | 取值 |
|---|---|
| `checks.cardOnDone` | `block`（Stop 时拦一次）· `warn` · `off` |
| `checks.foundation` | `warn` · `off` |
| `checks.receipts` | `cite`（引用了的回执才核对）· `require`（每条 `[已验证]` 都要带回执或写「人工：…」）· `off` |
| `checks.redGreen` | `warn` · `require` · `off` |
| `checks.testLock` | `block` · `warn` · `off` |
| `mutation.command` | 例如 `npx stryker run --mutate {files,}`；`{files}`、`{files,}` 会替换成改动文件列表 |

环境变量：

- `AI_LEDGER_FILE`：要读的外部活账本，默认 `~/.local/state/ai-ledger/events.jsonl`，由 [multi-ai](https://github.com/xiaodi007/multi-ai) 写入。
- `HARNESS_SESSION_ID`：写进回执的会话编号。
- `HARNESS_METHODOLOGY_DIR`：方法论文档所在目录（见下文）。

## 已知局限

- 字段校验挡得住空着不填，挡不住敷衍了事，抽查还得靠人。
- 测试锁只看得到 Edit、Write、MultiEdit；用 Bash（`sed -i`、重定向）改文件，它看不见。
- Stop 校验按文件修改时间判断哪些卡是最近改的，分不出是哪个会话改的。
- `project-methodology` 技能和 `/harness:init` 的一部分步骤会去读本地的方法论文档目录（`HARNESS_METHODOLOGY_DIR`）。这些文档**不在**本仓库里；没有它们插件照样能用，只是这两处能参考的东西少一些。

## 开发

```sh
sh scripts/test.sh
```

这条命令会跑每个脚本的 `--self-test`。接着 `scripts/mutation-check.mjs` 打约 210 处定点变异，每一处都必须恰好让一个自测变红，以此证明这些用例真能失败。本机有 `claude` CLI 时还会跑 `claude plugin validate`。所有临时文件都建在工作树里，跑完清理。

目录结构：

```
.claude-plugin/marketplace.json   # marketplace「ai-harness」
plugins/harness/
  .claude-plugin/plugin.json
  hooks/hooks.json
  commands/*.md                   # 斜杠命令
  skills/project-methodology/
  scripts/*.mjs、context-watch.py
  templates/                      # /harness:init 拷贝的地基文件
scripts/test.sh、mutation-check.mjs
docs/REFERENCE.md                 # 各版本行为的完整说明
```

## 许可证

[MIT](LICENSE)
