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
  ['「无」也算等你', "!/^无/.test(card.waiting.text)", 'true'],
  ['有待答就不说没有要做的（漏看待走查）', '!todo.length && !asks', '!asks'],
  ['有待走查就不说没有要做的（漏看待答）', '!todo.length && !asks', '!todo.length'],
  ['没有 git 不按文件时间筛', 'now - item.at < RECENT_DAYS * DAY', 'true'],
  ['没有卡目录不降级', "    if (!dir) return `回到现场\\n未找到任务卡目录", '    if (false) return `回到现场\\n未找到任务卡目录'],
  ['卡整份读', 'const CARD_READ_LIMIT = 256 * 1024;', 'const CARD_READ_LIMIT = 1024 * 1024;'],
  ['不截断到 6 张', 'const MAX_CARDS = 6;', 'const MAX_CARDS = 20;'],
  ['没有提交的仓照跑 git log', "git(root, ['rev-parse', '--verify', '-q', 'HEAD']).status === 0", 'true'],
  ['ledger-only 也带回到现场', 'ledgerOnly ? diagnostic + clip2(ledgerSection(file), 1600)', 'ledgerOnly ? diagnostic + sceneSection(cwd) + clip2(ledgerSection(file), 1600)'],
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
