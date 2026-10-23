#!/usr/bin/env node
// 「回到现场」自测的变异检查：每条变异必须真打上，并让自测变红；否则说明那条用例一开始就是绿的。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/harness/scripts/session-start.mjs');
// 变异件放在原脚本旁边，脚本里按自身位置算出的仓根不变。
const MUTANT = resolve(dirname(SCRIPT), '.mutant-session-start.mjs');
const MUTATIONS = [
  ['done 卡也算活跃', '(active|waiting)\\b/', '(active|waiting|done)\\b/'],
  ['近期窗口放到 30 天', '`--since=${RECENT_DAYS}.days`', '`--since=30.days`'],
  ['忽略未提交的卡', 'if (line.length > 3) add(', 'if (false) add('],
  ['已定取第一条', 'decided.findLast((item)', 'decided.find((item)'],
  ['已定不优先带原话或日期的', 'decided.findLast((item) => /「/.test(item.text) || dateIn(item.text)) ?? ', ''],
  ['没有已定节不退到原话', 'decided.at(-1) ?? quoted;', 'decided.at(-1);'],
  ['有实义的前缀也换成原话', 'label.length > 3', 'label.length > 999'],
  ['提交从头数', '`--since=${since}`', '`--since=2000-01-01`'],
  ['更早的交接也当交接', '++handoffs === 1', 'true'],
  ['围栏里的也读', '    if (fenced) return;\n', ''],
  ['已定的议程也列', '!CLOSED_RE.test(cells.at(-1))', 'true'],
  ['议程表头当一行', "/^\\|/.test(before) && ", ''],
  ['已勾也算未勾', '/^\\s*[-*]\\s+\\[ \\]\\s+(.*)$/', '/^\\s*[-*]\\s+\\[[ x]\\]\\s+(.*)$/'],
  ['「无」也算等你', 'card.waiting && !NONE_RE.test(card.waiting.text)', 'card.waiting'],
  ['有待答就不说没有要做的（漏看待走查）', '!todo.length && !asks', '!asks'],
  ['有待走查就不说没有要做的（漏看待答）', '!todo.length && !asks', '!todo.length'],
  ['没有 git 不按文件时间筛', 'now - item.at < RECENT_DAYS * DAY', 'true'],
  ['没有卡目录不降级', '    if (!dir) return { text:', '    if (false) return { text:'],
  ['卡整份读', 'const CARD_READ_LIMIT = 256 * 1024;', 'const CARD_READ_LIMIT = 1024 * 1024;'],
  ['不截断到 6 张', 'const MAX_CARDS = 6;', 'const MAX_CARDS = 20;'],
  ['没有提交的仓照跑 git log', "git(root, ['rev-parse', '--verify', '-q', 'HEAD']).status === 0", 'true'],
  ['ledger-only 也带回到现场', 'ledgerOnly ? diagnostic + clip2(ledgerSection(file), 1600)', 'ledgerOnly ? diagnostic + sceneSection(cwd) + clip2(ledgerSection(file), 1600)'],
  ['维护者定不优先于猜的', 'if (marked) card.decision', 'if (false) card.decision'],
  ['写明的已定也标猜', '{ ...marked, guess: false }', '{ ...marked, guess: true }'],
  ['取第一条维护者定', 'if (mark && plain(mark[3])) marked =', 'if (mark && plain(mark[3]) && !marked) marked ='],
  ['等你不限交接节', 'const ask = inHandoff && line.match(ASK_LINE);', 'const ask = line.match(ASK_LINE);'],
  ['「等你：无」也算一条', 'if (NONE_RE.test(plain(ask[1]))) card.askNone', 'if (false) card.askNone'],
  ['写了等你仍退到猜', 'if (!card.asks.length && card.waiting', 'if (card.waiting'],
  ['猜的等你不标', '`等你（猜）：', '`等你：'],
  ['猜的已定不标', "${card.decision.guess ? '（猜）' : ''}", ''],
  ['不按等你排序', 'cards.sort((a, b) => rank(b) - rank(a));', ''],
  ['猜的与写明的同排', "card.guessedAsk ? 1 : 0", "card.guessedAsk ? 2 : 0"],
  ['WIP 上限放到 20', 'const LANES = 3;', 'const LANES = 20;'],
  ['不列可能该关', 'if (stale.length) lines.push(', 'if (false) lines.push('],
  ['done 的旧卡也算可能该关', '.some((line) => ACTIVE_RE.test(line))', '.some(() => true)'],
  ['近期卡也算可能该关', '.filter((path) => !recent.includes(path))', ''],
  ['先做不优先等你', 'const first = askCards[0];', 'const first = null;'],
  ['先做不看走查', ': todo.length ? `先做：', ': false ? `先做：'],
  ['先做不提关卡', ": over || stale.length ? '先做：", ": false ? '先做："],
  ['猜的张数不报', '${guessed ? `，其中', '${false ? `，其中'],
  ['摘要不进 systemMessage', 'systemMessage: message,', "systemMessage: '',"],
  ['模型上下文不带转述要求', 'additionalContext: `${RELAY}\\n${message}\\n\\n${text}`', 'additionalContext: text'],
  ['ledger-only 也出 JSON', '  if (!summary.length) return text;\n', ''],
  ['lost 不按 12 小时', "(job.status === 'lost' ? LOST_HOURS * 3600000 : DAY)", 'DAY'],
  ['unknown 也按 12 小时', "job.status === 'lost' ? LOST_HOURS", "job.status !== 'running' ? LOST_HOURS"],
];

const source = readFileSync(SCRIPT, 'utf8');
const problems = [];
try {
  for (const [name, from, to] of MUTATIONS) {
    // 只替换一处并确认打上，免得变异没生效被当成「红了」或「没红」。
    if (source.split(from).length !== 2) { problems.push(`${name}：变异点应恰好出现一次`); continue; }
    writeFileSync(MUTANT, source.replace(from, to));
    const result = spawnSync(process.execPath, [MUTANT, '--self-test'], { encoding: 'utf8', timeout: 60000 });
    if (result.status === 0) problems.push(`${name}：变异后自测仍然全绿`);
    else console.log(`  ✓ 能红：${name}`);
  }
} finally { rmSync(MUTANT, { force: true }); }
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`变异检查：${MUTATIONS.length} 条变异都让自测变红`);
