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
  ['地基告警不进摘要', "...(warnings.length ? [`⚠ ${warnings.join('；')}`] : [])", '...[]'],
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

const INVARIANTS = [
  ['竖线转义不还原', "if (body[i] === '\\\\' && body[i + 1] === '|') { current += '|'; i++; continue; }", ''],
  ['破折号不当空', "map((cell) => (/^[—-]$/.test(cell) ? '' : cell))", 'map((cell) => cell)'],
  ['不查 ID 重复', "if (seen.has(row.ID)) problems.push(", 'if (false) problems.push('],
  ['不查权威实现文件', "catch { problems.push(`${row.ID}：权威实现 ${path} 不存在`); }", 'catch { }'],
  ['不查符号', 'if (source !== null && symbol && !source.includes(symbol))', 'if (false)'],
  ['不限 40 条', 'if (rows.length > MAX_INVARIANTS)', 'if (false)'],
  ['测试文档也扫', 'if (SKIP_PATH.test(file) || skip.has(file)', 'if (skip.has(file)'],
  ['权威实现也扫', "const skip = new Set([authorityPath(row), ...exceptionPaths(row)]);", 'const skip = new Set([...exceptionPaths(row)]);'],
  ['例外不排除', "const skip = new Set([authorityPath(row), ...exceptionPaths(row)]);", 'const skip = new Set([authorityPath(row)]);'],
  ['命中键带行号', 'key: `${file}:${line.trim()}`', 'key: `${file}:${index}:${line.trim()}`'],
  ['新增不报红', 'for (const hit of fresh.slice(0, 5)) problems.push(', 'for (const hit of fresh.slice(0, 0)) problems.push('],
  ['不报未登记 ID', 'for (const id of unknown) problems.push(', 'for (const id of []) problems.push('],
  ['基线可以变大', 'const kept = baseline[row.ID].filter((key) => keys.includes(key));', 'const kept = keys;'],
  ['不提示存量减少', 'if (gone) stock.push(', 'if (false) stock.push('],
  ['基线不留 gitignore', "if (!existsSync(ignore)) writeFileSync(ignore, '*\\n!.gitignore\\n!invariants-baseline.json\\n');\n  writeFileSync(path, JSON", 'writeFileSync(path, JSON'],
];

const RECEIPT = [
  ['vitest 不算 skipped', "skipped: part('skipped') + part('todo'), parser: 'vitest'", "skipped: 0, parser: 'vitest'"],
  ['jest 不认', "if ((m = [...text.matchAll(/^Tests:\\s+(.+total)\\s*$/gm)].at(-1)))", 'if (false)'],
  ['pytest 不算 failed', "failed: part('failed') + part('errors?')", 'failed: 0'],
  ['cargo 不求和', 'passed: sum.passed + Number(r[1])', 'passed: Number(r[1])'],
  ['unittest 不扣跳过', 'passed: Number(m[1]) - skipped - failed', 'passed: Number(m[1])'],
  ['go 不认', 'if (go.passed + go.failed + go.skipped) return', 'if (false) return'],
  ['不去 ANSI', "replace(/\\x1b\\[[0-9;]*[A-Za-z]/g, '')", "replace(/$^/g, '')"],
  ['0 用例不报', "if (total === 0) out.push('跑了 0 个用例');", ''],
  ['跳过过半不报', 'else if (counts.skipped * 2 > total)', 'else if (false)'],
  ['退出 0 有失败不报', 'if (exit === 0 && counts.failed > 0)', 'if (false)'],
  ['FAIL 行不报', "if (exit === 0 && !counts?.failed && /^\\s*(?:FAIL|FAILED)\\b/m.test(strip(output)))", 'if (false)'],
  ['校准回执可当证据', "if (receipt.expectFail) problems.push(", 'if (false) problems.push('],
  ['退出码非 0 也算通过', "else if (receipt.exit !== 0) problems.push(", 'else if (false) problems.push('],
  ['异常回执可当证据', 'if (receipt.anomalies?.length) problems.push(', 'if (false) problems.push('],
  ['不查 HEAD 祖先', "git(root, ['merge-base', '--is-ancestor', receipt.head, 'HEAD']).status !== 0", 'false'],
  ['启动失败记 0', 'finish(127, null, error)', 'finish(0, null, error)'],
  ['校准摘要不分', "receipt.exit !== 0 ? ' · 校准通过", "true ? ' · 校准通过"],
];

const BRIEFS = [
  ['不读简报字段', 'if (m && BRIEF_FIELDS.includes(m[1].trim()))', 'if (false)'],
  ['active 也算', "if (cardStatus(text) === 'done') out.push(", 'if (cardStatus(text)) out.push('],
  ['不看 archive', "if (rel === dir ? name === 'archive' : true) walk(path);", ''],
  ['模板也算', "|| name.startsWith('_') || stat.mtimeMs < since) continue;", '|| stat.mtimeMs < since) continue;'],
  ['不按时间过滤', '|| stat.mtimeMs < since) continue;', ') continue;'],
  ['不排序', 'return out.sort((a, b) => b.at - a.at);', 'return out;'],
  ['未接入也报', "if (!existsSync(resolve(root, '.harness.json'))) return 0;", ''],
  ['缺字段不标', "lines.push(`- ${field}：${b[field] || '⚠ 没写'}`)", "lines.push(`- ${field}：${b[field] || ''}`)"],
  ['标记不生效', 'writeFileSync(resolve(root, SEEN_FILE), String(now));', ''],
];

CARD.push(
  ['简报不查', 'for (const name of BRIEF) {', 'for (const name of []) {'],
  ['不查引用的不变量', 'if (cited.length) problems.push(...checkInvariants(', 'if (false) problems.push(...checkInvariants('],
  ['任意编号都当不变量', ".filter((id) => prefixes.has(id.replace(/-\\d+$/, '')))", ''],
  ['回执不核对', 'problems.push(...verifyReceipt(root, id, { red }).map(', '[].push(...verifyReceipt(root, id, { red }).map('],
  ['require 不要求回执', "if (!ids.length && mode === 'require' && !/人工\\s*[:：]/.test(line))", 'if (false)'],
  ['人工不算', "&& !/人工\\s*[:：]/.test(line))", ')'],
  ['off 也查回执', "if (mode !== 'off') {", 'if (true) {'],
  ['Stop 不查仓库上下文', 'const problems = checkCardInRepo(text, root, config, warnings);', 'const problems = checkCard(text);'],
);

FOUNDATION.push(
  ['不报地图空', "if (!rows.length) out.push('系统地图还没写", "if (false) out.push('系统地图还没写"],
  ['不报地图路径不存在', 'if (missing.length) out.push(`地图里的路径不存在', 'if (false) out.push(`地图里的路径不存在'],
  ['docs 也要登记', "!/^(docs?|tests?|__tests__|node_modules|dist|build)$/i.test(dir)", 'true'],
  ['不报没登记的目录', 'if (uncovered.length) out.push(', 'if (false) out.push('],
  ['不报改动过多', 'if (changed >= MAP_STALE_FILES) out.push(', 'if (false) out.push('],
  ['不报提交号找不到', "if (diff.status !== 0) out.push(`地图「最后核对」", "if (false) out.push(`地图「最后核对」"],
  ['不报没写最后核对', "} else out.push('地图没写「最后核对：提交号」');", '}'],
  ['不报不变量表问题', 'if (broken.length) out.push(`不变量表', 'if (false) out.push(`不变量表'],
  ['不报没基线', 'if (noBase.length) out.push(', 'if (false) out.push('],
  ['没代码也报地图', "  if (!hasCode(root)) return [];\n  const out = [];", '  const out = [];'],
);

SESSION.push(
  ['不报待看简报', '...(briefs ? [`ℹ 上次看简报以来 ${briefs} 张卡完成：/harness:brief`] : [])];\n  return', '];\n  return'],
  ['不给工具目录', 'if (linked) notes.push(`harness 工具', 'if (false) notes.push(`harness 工具'],
  ['optOut 也算接入', 'if (config.optOut) return null;\n    let mutation = null;', 'let mutation = null;'],
);

// 0.8.0：测试锁、红绿回执、变异信号。
RECEIPT.push(
  ['不记会话', 'session: sessionId(),', 'session: null,'],
  ['会话不优先 HARNESS_SESSION_ID', 'env.HARNESS_SESSION_ID || env.CLAUDE_CODE_SESSION_ID', 'env.CLAUDE_CODE_SESSION_ID || env.HARNESS_SESSION_ID'],
  ['红回执不要求 expect-fail', 'if (!receipt.expectFail) problems.push(`${id}：不是 --expect-fail', 'if (false) problems.push(`${id}：不是 --expect-fail'],
  ['红回执退出 0 也算', 'else if (receipt.exit === 0) problems.push(`${id}：预期失败却退出 0', 'else if (false) problems.push(`${id}：预期失败却退出 0'],
  ['红回执不看失败用例', 'else if (receipt.counts && !receipt.counts.failed)', 'else if (false)'],
);

CARD.push(
  ['红绿不只管根因修复', "  if (!(field(map, '同类扫描', '判定') ?? '').includes('根因修复')) return [];\n", ''],
  ['红绿不认不适用', "if (lines.some((line) => filled(line.match(RED_GREEN_NA)?.[1] ?? ''))) return [];", 'if (false) return [];'],
  ['红绿不认占位', "filled(line.match(RED_GREEN_NA)?.[1] ?? '')", "Boolean(line.match(RED_GREEN_NA))"],
  ['红绿不要求同一条命令', '.filter((green) => commandKey(green.receipt) === commandKey(red.receipt))', ''],
  ['红回执不当红核对', 'verifyReceipt(root, red.id, { red: true })', 'verifyReceipt(root, red.id)'],
  ['同一提交都干净不报', 'if (r.head && r.head === g.head && r.dirty === false && g.dirty === false)', 'if (false)'],
  ['多对只看第一对', '    if (!problems.length) return [];\n    first ??= problems;', '    return problems;'],
  ['红绿 warn 也拦', "if (redGreenMode === 'require') problems.push(...found);", 'problems.push(...found);'],
  ['红绿 off 也查', "if (redGreenMode !== 'off') {", 'if (true) {'],
  ['红绿默认 require', "config.checks?.redGreen ?? 'warn'", "config.checks?.redGreen ?? 'require'"],
  ['同行红绿也按校准报', 'const red = Boolean(own?.expectFail) && greens.includes(commandKey(own));', 'const red = false;'],
  ['同行没有绿也按红核对', 'const red = Boolean(own?.expectFail) && greens.includes(commandKey(own));', 'const red = Boolean(own?.expectFail);'],
  ['红绿提示每轮都响', '.filter(({ card }) => !(state.warned ?? []).includes(card))', ''],
  ['红绿 warn 不提示', 'if (!freshNotes.length) return null;', 'return null;'],
);

const TEST_LOCK = [
  ['工具不限', 'if (!TOOLS.has(input.tool_name)) return null;', ''],
  ['** 只认一层', "if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';", "out += '[^/]*';"],
  ['* 跨目录', "else if (c === '*') out += '[^/]*';", "else if (c === '*') out += '.*';"],
  ['glob 不锚定', 'return new RegExp(`^${out}$`);', 'return new RegExp(out);'],
  ['optOut 也管', 'if (!config || config.optOut) return null;', 'if (!config) return null;'],
  ['没配 testLock 也管', "if (mode !== 'block' && mode !== 'warn') return null;", ''],
  ['自定义 paths 不生效', 'config.testLock.paths : DEFAULT_LOCK', 'DEFAULT_LOCK : DEFAULT_LOCK'],
  ['不认放行', '  if (waiver) {', '  if (false) {'],
  ['占位也算放行', 'if (reason && !PLACEHOLDER.test(reason))', 'if (reason)'],
  ['旧卡也算放行', 'if (now - statSync(path).mtimeMs > WAIVER_HOURS * 3600000) continue;', ''],
  ['模板也算放行', "|| name.startsWith('_')) continue;", ') continue;'],
  ['dropped 也算放行', "if (cardStatus(text) === 'dropped') continue;", ''],
  ['warn 也拦', "if (mode === 'warn') {", 'if (false) {'],
  ['放行不记日志', "log(root, { ...entry, action: 'waived'", "({ ...entry, action: 'waived'"],
  ['统计不限 7 天', 'if (Date.parse(entry.at) >= since && entry.action in out)', 'if (entry.action in out)'],
];

const MUTATE = [
  ['Stryker 取前 5 列', 'nums.slice(-5)', 'nums.slice(0, 5)'],
  ['mutmut 可疑不算存活', "survived: count('🙁') + count('🤔')", "survived: count('🙁')"],
  ['cargo 超时不算杀死', "timeout: part('timeouts?')", 'timeout: 0'],
  ['分数不算超时', '((killed + timeout) / total)', '(killed / total)'],
  ['报告不优先', '  if (report) return fromReport(report);\n', ''],
  ['测试文件也交给工具', '!NOT_SOURCE.test(file)', 'true'],
  ['不含未跟踪文件', "...(untracked.status === 0 ? untracked.stdout.split('\\n') : [])", '...[]'],
  ['不按分叉点', "for (const branch of ['main', 'master', 'origin/main', 'origin/master'])", 'for (const branch of [])'],
  ['{files,} 不连成一个参数', "replaceAll('{files,}', quote(files.join(',')))", "replaceAll('{files,}', files.map(quote).join(','))"],
  ['不传 HARNESS_MUTATE_FILES', "HARNESS_MUTATE_FILES: files.join('\\n')", "HARNESS_MUTATE_FILES: ''"],
  ['不删旧报告', '  if (reportPath) rmSync(reportPath, { force: true });\n', ''],
  ['最近一次取第一个', 'if (!best || String(record.endedAt) > String(best.endedAt)) best = record;', 'if (!best) best = record;'],
  ['没改动也写记录', "  if (!files.length) return { skipped:", "  if (false) return { skipped:"],
];

FOUNDATION.push(
  ['不报测试锁放行', 'if (lock.waived) warnings.push(', 'if (false) warnings.push('],
  ['不报测试锁 warn 命中', 'if (lock.warned) warnings.push(', 'if (false) warnings.push('],
);
SESSION.push(['不显示变异信号', 'if (linked?.mutation) notes.push(', 'if (false) notes.push(']);
BRIEFS.push(['简报不带变异信号', "if (mutation) lines.push('---'", "if (false) lines.push('---'"]);

const TARGETS = [['session-start.mjs', SESSION], ['card-check.mjs', CARD], ['foundation.mjs', FOUNDATION], ['init.mjs', INIT],
  ['invariants.mjs', INVARIANTS], ['receipt.mjs', RECEIPT], ['briefs.mjs', BRIEFS], ['test-lock.mjs', TEST_LOCK], ['mutate.mjs', MUTATE]];

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
