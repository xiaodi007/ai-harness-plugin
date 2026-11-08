#!/usr/bin/env node
// 自测的变异检查：每条变异必须真打上，并让对应脚本的自测变红；否则说明那条用例一开始就是绿的。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '../plugins/harness/scripts');
const SESSION = [
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
  ['「无（说明）」也算等你', '[。.；;，,\\s（(]|$)/;', '[。.；;，,\\s]|$)/;'],
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
  ['不列停着的未完成', 'if (stale.length) lines.push(', 'if (false) lines.push('],
  ['done 的旧卡也算停着的未完成', '.some((line) => ACTIVE_RE.test(line))', '.some(() => true)'],
  ['近期卡也算停着的未完成', '.filter((path) => !recent.includes(path))', ''],
  ['先做不优先等你', 'const first = written[0];', 'const first = null;'],
  ['先做也取猜的等你', 'const first = written[0];', 'const first = askCards.find((card) => !card.asks.length) ?? written[0];'],
  ['摘要等你也数猜的', 'const written = askCards.filter((card) => card.asks.length);', 'const written = askCards;'],
  ['全文回答也数猜的', 'const asks = askCards.filter((card) => card.asks.length).length;', 'const asks = askCards.length;'],
  ['猜的等你不提先别答', 'if (askCards.length > asks) lines.push(', 'if (false) lines.push('],
  ['先做不看走查', ': todo.length ? `先做：', ': false ? `先做：'],
  ['先做不提关卡', ": stale.length ? '先做：", ": false ? '先做："],
  ['先做不提泳道超限', ': over ? `先做：实施泳道', ': false ? `先做：实施泳道'],
  ['WIP 数卡', 'lanesOpen = lanes(root, inGit, file, now);', 'lanesOpen = cards.map((card) => ({ text: card.name }));'],
  ['不数未合入提交的工作树', 'index > 0 && base && tree.head ?', 'false ?'],
  ['不数有未提交改动的工作树', 'const dirty = status.status === 0 ?', 'const dirty = false ?'],
  ['不数账本在跑的活', "if (job.status !== 'running') continue;", 'continue;'],
  ['lost 也算泳道', "if (job.status !== 'running') continue;", ''],
  ['工作树里的在跑另算一条', 'if (owner) owner.text +=', 'if (false) owner.text +='],
  ['工作树子目录不归并', 'cwd === path || cwd.startsWith(`${path}/`)', 'cwd === path'],
  ['猜的张数不报', '${guessed ? `；另有', '${false ? `；另有'],
  ['摘要不进 systemMessage', 'systemMessage: message,', "systemMessage: '',"],
  ['模型上下文不带转述要求', 'additionalContext: `${RELAY}\\n${message}\\n\\n${text}`', 'additionalContext: text'],
  ['ledger-only 也出 JSON', '  if (!summary.length) return text;\n', ''],
  ['lost 不按 12 小时', "(job.status === 'lost' ? LOST_HOURS * 3600000 : DAY)", 'DAY'],
  ['unknown 也按 12 小时', "job.status === 'lost' ? LOST_HOURS", "job.status !== 'running' ? LOST_HOURS"],
  ['地基告警不进摘要', "summary: warnings.length ? [`⚠ ${warnings.join('；')}`, ...summary] : summary", 'summary'],
  ['地基告警不进全文', 'diagnostic + foundation + clip2(found.text', 'diagnostic + clip2(found.text'],
  ['ledger-only 也查地基', 'const warnings = ledgerOnly ? [] : foundationSafe(cwd);', 'const warnings = foundationSafe(cwd);'],
];

const CARD = [
  ['占位当作已填', "const filled = (value) => Boolean(value) && !PLACEHOLDER.test(value.trim());", 'const filled = (value) => Boolean(value);'],
  ['不查保住什么', "['验收剧本', '改什么', '保住什么']", "['验收剧本', '改什么']"],
  ['不适用不要理由', "else if (/^不适用/.test(scan) && ", 'else if (false && '],
  ['同类扫描不限字数', 'else if ([...scan].length < MIN_SCAN)', 'else if (false)'],
  ['判定两个都写也算', 'if (root === sample)', 'if (!root && !sample)'],
  ['证据不看等级', "if (!levels.length) problems.push('证据（没有带等级的条目）');", ''],
  ['只有已落地也算', "else if (!levels.includes('已验证') && !levels.includes('未验证'))", 'else if (false)'],
  ['不查类别债节', "if (findSection(map, '类别债') === undefined)", 'if (false)'],
  ['不查别重做', "if (!filled(field(map, '交接', '别重做')))", 'if (false)'],
  ['围栏里的也算', "if (fenced) continue;", ''],
  ['注释里的也算', ".replace(/<!--[\\s\\S]*?-->/g, '')", ''],
  ['豁免不看理由', 'if (match && filled(match[1])) return match[1].trim();', 'if (match) return match[1].trim();'],
  ['豁免的卡也拦', 'if (exemption(text)) continue;', ''],
  ['未接入也拦', 'if (!config || config.optOut) return null;', 'if (false) return null;'],
  ['off 也管', "if (mode === 'off') return null;", ''],
  ['每次都拦', '.filter(({ card }) => !state.blocked.includes(card))', ''],
  ['stop_hook_active 也拦', "if (mode === 'block' && !input.stop_hook_active && fresh.length)", "if (mode === 'block' && fresh.length)"],
  ['warn 也拦', "if (mode === 'block' && !input.stop_hook_active", "if (!input.stop_hook_active"],
  ['旧卡也扫', 'now - stat.mtimeMs > hours * 3600000', 'false'],
  ['模板也扫', "|| name.startsWith('_')) continue;", ') continue;'],
  ['active 也扫', "=== 'done') out.push(path);", "!== null) out.push(path);"],
];

const FOUNDATION = [
  ['纯文档仓也报未接入', "!/\\.(md|markdown|txt)$/i.test(path) && ", ''],
  ['没代码也报', "return hasCode(root) ? ['本仓未接入", "return true ? ['本仓未接入"],
  ['optOut 也报', 'if (config.optOut) return [];', ''],
  ['不报缺文件', "if (missing.length) warnings.push(", 'if (false) warnings.push('],
  ['不查 AGENTS 行数', 'if (lines > budgets.agentsLines)', 'if (false)'],
  ['不查 DECISIONS 体积', 'if (kb > budgets.decisionsKB)', 'if (false)'],
  ['done 也算进行中', "if (status === 'active' || status === 'waiting') active++;", 'if (status) active++;'],
  ['本月的也提示归档', 'dated[1] < month', 'dated[1] <= month'],
  ['不报大卡', 'if (big.length) warnings.push(', 'if (false) warnings.push('],
  ['不数豁免', 'if (exempt) warnings.push(', 'if (false) warnings.push('],
];

const INIT = [
  ['覆盖已有文件', 'if (existsSync(path)) { kept.push(target); continue; }', ''],
  ['不沿用已有卡目录', 'cardDir || existingCardDir(root) || CARD_DEFAULT', 'cardDir || CARD_DEFAULT'],
  ['dry-run 也写', 'if (!dryRun) { mkdirSync', 'if (true) { mkdirSync'],
  ['不提示 CLAUDE.md', "if (!/^@AGENTS\\.md\\s*$/m.test(text)) advice.push(", 'if (false) advice.push('],
  ['不带出熵建议', "if (!dryRun) advice.push(...foundationWarnings(root)", 'if (false) advice.push(...foundationWarnings(root)'],
];

const TARGETS = [['session-start.mjs', SESSION], ['card-check.mjs', CARD], ['foundation.mjs', FOUNDATION], ['init.mjs', INIT]];

const problems = [];
let total = 0;
for (const [file, mutations] of TARGETS) {
  const script = resolve(SCRIPTS, file);
  // 变异件放在原脚本旁边，脚本里按自身位置算出的仓根、相对 import 都不变；原脚本不动，中途被杀也不留脏。
  const mutant = resolve(SCRIPTS, `.mutant-${file}`);
  const source = readFileSync(script, 'utf8');
  try {
    for (const [name, from, to] of mutations) {
      total++;
      // 只替换一处并确认打上，免得变异没生效被当成「红了」或「没红」。
      if (source.split(from).length !== 2) { problems.push(`${file}·${name}：变异点应恰好出现一次`); continue; }
      writeFileSync(mutant, source.replace(from, to));
      const result = spawnSync(process.execPath, [mutant, '--self-test'], { encoding: 'utf8', timeout: 60000 });
      if (result.status === 0) problems.push(`${file}·${name}：变异后自测仍然全绿`);
      else console.log(`  ✓ 能红：${file}·${name}`);
    }
  } finally { rmSync(mutant, { force: true }); }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`变异检查：${total} 条变异都让自测变红`);
