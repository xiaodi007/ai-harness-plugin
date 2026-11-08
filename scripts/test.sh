#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
# 自测与 Claude 校验的临时写入全部限制在工作树。
TMPDIR=$(mktemp -d "$ROOT/.harness-test.XXXXXX")
export TMPDIR
trap 'rm -rf "$TMPDIR"' EXIT HUP INT TERM
node plugins/harness/scripts/session-start.mjs --self-test
node plugins/harness/scripts/card-check.mjs --self-test
node plugins/harness/scripts/foundation.mjs --self-test
node plugins/harness/scripts/init.mjs --self-test
node plugins/harness/scripts/invariants.mjs --self-test
node plugins/harness/scripts/receipt.mjs --self-test
node plugins/harness/scripts/briefs.mjs --self-test
# 每条用例都要能红：逐条打变异，对应脚本的自测必须失败。
node scripts/mutation-check.mjs
python3 plugins/harness/scripts/context-watch.py --self-test
if command -v claude >/dev/null 2>&1; then
  # 校验 CLI 的配置、缓存也隔离在工作树内。
  HOME="$TMPDIR/home"
  CLAUDE_CONFIG_DIR="$TMPDIR/claude"
  XDG_CACHE_HOME="$TMPDIR/cache"
  export HOME CLAUDE_CONFIG_DIR XDG_CACHE_HOME
  mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR" "$XDG_CACHE_HOME"
  claude plugin validate ./plugins/harness
  claude plugin validate .
else
  printf '%s\n' '跳过 Claude 插件格式校验：未找到 claude 命令'
fi
