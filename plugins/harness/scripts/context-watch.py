#!/usr/bin/env python3
"""会话规模守望 —— Stop hook：读会话日志算峰值上下文，超阈值提示该写交接卡。

**为什么必须是外部机制**：三条交接判据里，压缩比会话能可靠自评，
**上下文规模它不能** —— 那是运行时信息，压根不在上下文里。
把两者都写成「提醒模型自觉」是无效的，第二条它办不到。
判据见方法论《项目记忆模型与工作流循环》§四「能不能让会话自己判断」。

阈值按**窗口百分比**，不写死绝对 token 数（换模型就漂）：
  45% → 提示「该考虑交接了」，只提一次
  70% → 强提示，**每次都提** —— 这是自动压缩开始丢东西的线，
        而丢了什么你不知道。风险不是成本，是不可见的信息损失。

窗口值的来源（刻意不把一个我不确定的数字写成「事实」）：
  1. settings.json 的 autoCompactWindow —— 用户设了它就是权威值
  2. 没设就用 DEFAULT_WINDOW 兜底，并在输出里**标明这是假设**
输出永远带「峰值 + 窗口 + 百分比 + 窗口来源」四样，读的人能自己反算 ——
尺子错了当场看得出来（静默失败模式目录 第 12 类：度量本身错了）。

⚠️ 解析型检查，按项目判据带兜底与负向验证：
  - 找不到日志 / 一条 usage 都没有 → 静默不提示（新会话，或非本项目会话）
  - 但 --self-test 会验「日志真的存在时算得出来」，
    防「永远静默」被误当成「一直没超」（第 2 类：检查器失效时不报告）
  - 本脚本**永不非零退出**：Stop hook 报错会打扰人，
    诊断走 systemMessage —— 可见，但不打断

写法上刻意用旧版兼容语法（不用 match、不用 3.10+ 类型写法）：
hook 运行时的 PATH 不一定是交互 shell 那个 python3。

用法：
  python3 plugins/harness/scripts/context-watch.py             # 从 stdin 读 hook 载荷
  python3 plugins/harness/scripts/context-watch.py --self-test # 七个场景负向验证
"""
import json
import os
import sys
from pathlib import Path

# 兜底窗口。来源：settings.json 的 autoCompactWindow 取值上限是 1000000。
# ⚠️ 这是**假设**不是实测，所以输出里一定要标来源 —— 别让它变成一个没人质疑的事实。
DEFAULT_WINDOW = 1000000

SOFT_RATIO = 0.45
HARD_RATIO = 0.70

PROJECTS = Path.home() / ".claude" / "projects"
# 每档只提一次用的印记。软档需要降噪；硬档刻意不用它（红线要一直响）。
STAMP_DIR = Path(os.environ.get("TMPDIR", "/tmp")) / "harness-context-watch"


def window_and_source():
    """窗口值 + 它是哪来的。settings 优先，否则明说是假设。"""
    candidates = (
        (Path(".claude/settings.local.json"), "项目 local settings"),
        (Path(".claude/settings.json"), "项目 settings"),
        (Path.home() / ".claude/settings.json", "用户 settings"),
    )
    for path, label in candidates:
        try:
            value = json.loads(path.read_text(encoding="utf-8")).get("autoCompactWindow")
        except Exception:
            continue
        if isinstance(value, int) and value > 0:
            return value, "autoCompactWindow @ " + label
    return DEFAULT_WINDOW, "假设值（未设 autoCompactWindow）"


def find_log(session_id):
    """按 session_id 找日志。不假设项目目录名怎么拼，直接全目录找。"""
    if not session_id or not PROJECTS.is_dir():
        return None
    for candidate in PROJECTS.glob("*/" + session_id + ".jsonl"):
        return candidate
    return None


def peak_context(log_path):
    """每轮上下文 = input + cache_creation + cache_read，取最大值。

    返回 (峰值, 采到的轮数, 模型名集合)。轮数为 0 时调用方不提示。
    取峰值而不是末值：压缩之后末值会掉下来，但「已经丢过东西」这件事仍然成立。
    """
    peak = 0
    rounds = 0
    models = set()
    with log_path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("type") != "assistant":
                continue
            message = record.get("message") or {}
            usage = message.get("usage")
            if not isinstance(usage, dict):
                continue
            total = (
                usage.get("input_tokens", 0)
                + usage.get("cache_creation_input_tokens", 0)
                + usage.get("cache_read_input_tokens", 0)
            )
            if total > 0:
                rounds += 1
                if total > peak:
                    peak = total
                if message.get("model"):
                    models.add(message["model"])
    return peak, rounds, models


def verdict(peak, window):
    """返回 'hard' / 'soft' / None。"""
    if peak >= window * HARD_RATIO:
        return "hard"
    if peak >= window * SOFT_RATIO:
        return "soft"
    return None


def message_for(level, peak, window, source, models):
    pct = peak * 100.0 / window
    who = "、".join(sorted(models)) or "未知模型"
    if level == "hard":
        head = "🔴 上下文已过窗口 70% —— 自动压缩从这里开始丢东西，而丢了什么你不知道"
        tail = "现在就写交接卡，别等压缩。"
    else:
        head = "⚠️ 上下文已过窗口 45%"
        tail = (
            "到阶段边界时自评一次压缩比："
            "下一阶段真正需要的 < 10% 当前上下文 ⇒ 立刻交接。"
        )
    body = "：峰值 {0:,} / 窗口 {1:,} = {2:.0f}%（{3}｜{4}）。".format(
        peak, window, pct, source, who
    )
    return head + body + tail


def stamp_path(session_id, level):
    return STAMP_DIR / (session_id + "." + level)


def already_warned(session_id, level):
    try:
        return stamp_path(session_id, level).exists()
    except Exception:
        return False


def mark_warned(session_id, level):
    try:
        STAMP_DIR.mkdir(parents=True, exist_ok=True)
        stamp_path(session_id, level).write_text("1", encoding="utf-8")
    except Exception:
        pass  # 印记只是降噪，写不上就多提示一次，不该因此失败


def run(raw_stdin):
    try:
        hook_input = json.loads(raw_stdin) if raw_stdin.strip() else {}
    except Exception:
        return {}
    session_id = hook_input.get("session_id") or ""
    log_path = find_log(session_id)
    if log_path is None:
        return {}  # 没日志就没得算 —— 静默，别在每次停止时吵人
    peak, rounds, models = peak_context(log_path)
    if rounds == 0:
        return {}  # 新会话还没有 usage 记录
    window, source = window_and_source()
    level = verdict(peak, window)
    if level is None:
        return {}
    if level == "soft":
        if already_warned(session_id, "soft"):
            return {}
        mark_warned(session_id, "soft")
    return {"systemMessage": message_for(level, peak, window, source, models)}


def self_test():
    """七个场景，每个都必须落在预期那一档 —— 没做过负向验证的守卫等于没有守卫。"""
    import tempfile

    global PROJECTS, STAMP_DIR

    def fake_log(directory, session_id, ctx_values):
        path = directory / (session_id + ".jsonl")
        with path.open("w", encoding="utf-8") as handle:
            for value in ctx_values:
                handle.write(json.dumps({
                    "type": "assistant",
                    "message": {
                        "model": "test-model",
                        "usage": {
                            "input_tokens": 2,
                            "cache_creation_input_tokens": 0,
                            "cache_read_input_tokens": value - 2,
                        },
                    },
                }) + "\n")
        return path

    def level_of(out):
        text = out.get("systemMessage", "")
        if text.startswith("🔴"):
            return "hard"
        if text.startswith("⚠️"):
            return "soft"
        return None

    window = DEFAULT_WINDOW
    cases = (
        ("远低于阈值", [int(window * 0.10)], None),
        ("刚过 45%", [int(window * 0.46)], "soft"),
        ("刚过 70%", [int(window * 0.71)], "hard"),
        ("取峰值不取末值", [int(window * 0.72), int(window * 0.20)], "hard"),
        ("日志里没有 usage", [], None),
    )

    real_projects, real_stamp = PROJECTS, STAMP_DIR
    failed = 0
    for name, values, expect in cases:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "proj").mkdir()
            PROJECTS = root
            STAMP_DIR = root / "stamp"
            fake_log(root / "proj", "sess", values)
            out = run(json.dumps({"session_id": "sess"}))
            got = level_of(out)
            if got == expect:
                print("  ✓ {0}：判为 {1}".format(name, got or "不提示"))
                if out.get("systemMessage"):
                    print("    " + out["systemMessage"])
            else:
                failed += 1
                print("  ✗ {0}：期待 {1}，实得 {2}".format(name, expect, got),
                      file=sys.stderr)

    # 场景六：软档只提一次（印记生效）
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "proj").mkdir()
        PROJECTS = root
        STAMP_DIR = root / "stamp"
        fake_log(root / "proj", "sess", [int(window * 0.46)])
        first = run(json.dumps({"session_id": "sess"}))
        second = run(json.dumps({"session_id": "sess"}))
        if first.get("systemMessage") and not second.get("systemMessage"):
            print("  ✓ 软档只提一次：第二次静默")
        else:
            failed += 1
            print("  ✗ 软档降噪失效：第二次仍提示", file=sys.stderr)

    # 场景七：硬档每次都提（红线不降噪）
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "proj").mkdir()
        PROJECTS = root
        STAMP_DIR = root / "stamp"
        fake_log(root / "proj", "sess", [int(window * 0.71)])
        first = run(json.dumps({"session_id": "sess"}))
        second = run(json.dumps({"session_id": "sess"}))
        if first.get("systemMessage") and second.get("systemMessage"):
            print("  ✓ 硬档每次都提：第二次仍然提示")
        else:
            failed += 1
            print("  ✗ 硬档被降噪了 —— 红线必须一直响", file=sys.stderr)

    PROJECTS, STAMP_DIR = real_projects, real_stamp

    # 场景八：找不到会话 → 静默且不炸
    if run(json.dumps({"session_id": "这个会话不存在"})) == {}:
        print("  ✓ 找不到日志：静默且不炸")
    else:
        failed += 1
        print("  ✗ 找不到日志时不该有输出", file=sys.stderr)

    return 1 if failed else 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    try:
        sys.stdout.write(json.dumps(run(sys.stdin.read()), ensure_ascii=False))
    except Exception as exc:  # 永不非零退出：Stop hook 报错会打扰人
        sys.stdout.write(json.dumps(
            {"systemMessage": "会话规模守望脚本自己出错了：{0}".format(exc)},
            ensure_ascii=False,
        ))
