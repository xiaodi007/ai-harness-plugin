# ai-harness-plugin · `harness`

[中文](README.zh-CN.md) · [Full reference (Chinese)](docs/REFERENCE.md) · [License: MIT](LICENSE)

**harness** is a [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that adds working discipline to long-running, multi-session AI development. It makes sure that:

- every new session **starts from where the last one left off**, not from scratch;
- work is not marked *done* without a contract, evidence and a handoff;
- a "green" test run is checked to be a real one: tests actually ran, they turned red before the fix, and nobody quietly rewrote the assertions;
- the human maintainer can see what changed **without reading diffs**.

This repository is also a plugin **marketplace** (`ai-harness`) with one plugin, `harness`.

> Language note: the hook output, templates and slash-command prompts are written in **Chinese**, because the plugin was built for Chinese-speaking maintainers. The mechanics are language-neutral.

## What it does

### Hooks (automatic)

| Hook | Script | What happens |
|---|---|---|
| **SessionStart** | `session-start.mjs`, `foundation.mjs` | Prints a "back to the scene" briefing. The maintainer sees a three-line summary: how many items are *waiting on you*, whether work in progress is over its limit, and the one thing to do first. The model gets the full text: active task cards with their last decision and what they wait on, WIP lanes, stalled cards, open agenda items, running or lost external jobs from the AI ledger, uncommitted changes, plus **foundation warnings**: missing files, entropy budgets, cards to archive, an outdated system map |
| **PreToolUse** (Edit / Write / MultiEdit) | `test-lock.mjs` | **Test lock.** Edits to frozen test paths are warned about or blocked unless a task card states `改测试：<reason>` ("changing tests: reason") |
| **Stop** | `card-check.mjs --stop` | **Delivery check.** A task card marked `done` must have a contract, a scan for similar cases, a verdict (root-cause fix or sample patch), graded evidence, class-debt and handoff sections. If anything is missing, the session gets one bounce to fill it in |
| **Stop** | `context-watch.py` | Reminds you to write a handoff card when context usage reaches 45% (soft, once) or 70% (hard, every time) |

### Slash commands

| Command | Purpose |
|---|---|
| `/harness:init [--card-dir DIR]` | Onboard a repo. Copies missing foundation files (`AGENTS.md`, `CLAUDE.md`, `PROJECT.md`, `DECISIONS.md`, `docs/SYSTEM.md`, card template, `.harness.json`) and **never overwrites** existing ones. Then drafts project instructions or runs a kickoff interview |
| `/harness:relay <card>` | Checks closing conditions, rewrites the card's handoff section and produces an opening prompt of at most 15 lines for the next session |
| `/harness:brief [--since DATE]` | Collects the five-line briefs of cards finished since you last looked into one page |
| `/harness:map` | Drafts or updates the one-page **system map** in `docs/SYSTEM.md` (modules, paths, owners, external deps) |
| `/harness:invariants [rule]` | Drafts **invariants**: each business rule gets exactly one authoritative implementation, plus a fingerprint regex that finds duplicate implementations elsewhere |
| `/harness:tour <flow> [--guess]` | Walks the maintainer through one business flow along the map, optionally asking them to guess first |

### CLI tools

These scripts live in `plugins/harness/scripts/` and run with `node`:

| Script | Use |
|---|---|
| `receipt.mjs [--expect-fail] -- <cmd>` | Runs a test command and writes an **execution receipt** (`.harness/receipts/R-….json`): real exit code, pass/fail/skip counts parsed from vitest, jest, pytest, unittest, cargo, node:test and `go test -v`, plus anomalies such as zero tests, mostly skipped, or exit 0 with failures. Pair a red receipt (before the fix) with a green one (after) to prove that the test covers the fix |
| `card-check.mjs <card…>` | Runs the delivery check by hand (exits 1 when something is missing) |
| `invariants.mjs check \| baseline \| consumers ID` | Checks the invariant table and scans for duplicate implementations against a baseline that is only allowed to shrink |
| `mutate.mjs [--base REF] [--dry-run]` | **Mutation signal** on changed files. It calls the engine you configure (Stryker, mutmut, cargo-mutants, …), records the score, and never blocks anything |
| `briefs.mjs [--mark]` | The script behind `/harness:brief` |

## Install

Requirements: Claude Code, Node.js ≥ 18 (tested on 22), Python 3, git.

```sh
claude plugin marketplace add xiaodi007/ai-harness-plugin
claude plugin install harness@ai-harness
```

Or from a local clone:

```sh
git clone https://github.com/xiaodi007/ai-harness-plugin.git
claude plugin marketplace add ./ai-harness-plugin
claude plugin install harness@ai-harness
```

To try it without installing, from the repo root:

```sh
claude --plugin-dir ./plugins/harness
```

## Quick start

1. Open Claude Code in your project and run `/harness:init`. It previews what it will create, waits for your OK, and only adds missing files.
2. Keep one **task card** per non-trivial change in the card directory (`docs/tasks/` by default; `docs/协作/任务` and `tasks/` are picked up as well). Start from `_模板.md`. A card has a contract, a scope scan, evidence, a brief and a handoff.
3. Run tests through receipts so that evidence can be checked:

   ```sh
   node <plugin>/scripts/receipt.mjs -- pnpm test
   ```

   Then cite them in the card, for example `- [已验证] 红绿：回执 R-…（改前红）→ R-…（改后绿）` ("verified, red→green: receipt R-… (red before) → R-… (green after)"). The SessionStart briefing prints the plugin's script directory.
4. When a session nears its context limit, run `/harness:relay docs/tasks/<card>.md` and paste the generated prompt into a new session.
5. Every now and then, run `/harness:brief` to see what got done.

In repos without `.harness.json`, the delivery check, test lock and foundation checks stay off. SessionStart still shows the ledger and uncommitted changes, plus a one-line "not onboarded" notice for git repos that contain code.

## Configuration: `.harness.json`

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

| Key | Values |
|---|---|
| `checks.cardOnDone` | `block` (bounce the Stop once) · `warn` · `off` |
| `checks.foundation` | `warn` · `off` |
| `checks.receipts` | `cite` (check receipts that are cited) · `require` (every `[已验证]`, i.e. "verified", line needs a receipt or `人工：…`, i.e. "manual: …") · `off` |
| `checks.redGreen` | `warn` · `require` · `off` |
| `checks.testLock` | `block` · `warn` · `off` |
| `mutation.command` | e.g. `npx stryker run --mutate {files,}`. `{files}` and `{files,}` expand to the changed files |

Environment variables:

- `AI_LEDGER_FILE`: the external-job ledger to read. Default: `~/.local/state/ai-ledger/events.jsonl`, written by [multi-ai](https://github.com/xiaodi007/multi-ai).
- `HARNESS_SESSION_ID`: session id recorded in receipts.
- `HARNESS_METHODOLOGY_DIR`: where the methodology documents live (see below).

## Known limits

- Fields can stop *empty* answers, not *lazy* ones. Spot-checks are still yours to do.
- The test lock only sees Edit, Write and MultiEdit. Edits made through Bash (`sed -i`, redirects) get past it.
- The Stop check decides which cards are recent by file modification time. It does not know which session changed them.
- The `project-methodology` skill and parts of `/harness:init` point to a local folder of methodology documents (`HARNESS_METHODOLOGY_DIR`). Those documents are **not** part of this repository. The plugin still works without them; those two features just have less to work with.

## Development

```sh
sh scripts/test.sh
```

This runs every script's `--self-test`. `scripts/mutation-check.mjs` then applies about 210 targeted mutations, and each one must turn exactly one self-test red, which shows the tests can fail. If the `claude` CLI is present, it also runs `claude plugin validate`. All temporary files stay inside the worktree.

Layout:

```
.claude-plugin/marketplace.json   # marketplace "ai-harness"
plugins/harness/
  .claude-plugin/plugin.json
  hooks/hooks.json
  commands/*.md                   # slash commands
  skills/project-methodology/
  scripts/*.mjs, context-watch.py
  templates/                      # files copied by /harness:init
scripts/test.sh, mutation-check.mjs
docs/REFERENCE.md                 # full per-version behaviour reference (Chinese)
```

## License

[MIT](LICENSE)
