#!/usr/bin/env node
// 任务卡交付校验：卡改成 done 时，必填项（契约、同类扫描、判定、证据等级、类别债节、别重做）不能空着。
// 有仓库上下文时（checkCardInRepo）另查：引用的不变量 ID 存在且没有新增第二处实现、[已验证] 引用的回执核对得上。
// 用法：node card-check.mjs <卡…>（CLI，红了退出 1）；--stop（Stop 钩子，读 stdin JSON）；--self-test。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readInvariants, checkInvariants } from './invariants.mjs';
import { verifyReceipt, writeReceipt, loadReceipt, RECEIPT_ID } from './receipt.mjs';
import { updateBaseline, SYSTEM_FILE } from './invariants.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LEVELS = ['已发现', '已设计', '已落地', '已验证', '未验证'];
const EVIDENCE_LINE = new RegExp(`^\\s*[-*]\\s*\\[(${LEVELS.join('|')})\\]\\s*(.+)$`);
const FIELD_LINE = /^\s*[-*]\s*(?:\*\*)?([^：:*]+?)(?:\*\*)?\s*[:：]\s*(.*)$/;
const STATUS_LINE = /^\s*[-*]\s*状态\s*[:：]\s*(\w+)/;
const EXEMPT_LINE = /^\s*(?:[-*]\s*)?校验豁免\s*[:：]\s*(\S.*)$/;
const RED_GREEN_NA = /^\s*(?:[-*]\s*)?红绿不适用\s*[:：]\s*(\S.*)$/;
// 模板占位：<…> 整段或只有省略号。
const PLACEHOLDER = /^<[^>]*>$|^(?:…|\.\.\.)$/;
const MIN_SCAN = 8;
const STOP_WINDOW_HOURS = 6;

// 去掉代码围栏和 HTML 注释后按「## 标题」分节；节外的行归到 ''。
export function sections(text) {
  const out = new Map([['', []]]);
  let current = '';
  let fenced = false;
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { current = heading[1]; if (!out.has(current)) out.set(current, []); continue; }
    out.get(current).push(line);
  }
  return out;
}

const filled = (value) => Boolean(value) && !PLACEHOLDER.test(value.trim());
const findSection = (map, word) => [...map.keys()].find((key) => key.includes(word));
function field(map, sectionWord, name) {
  const key = findSection(map, sectionWord);
  if (key === undefined) return undefined;
  for (const line of map.get(key)) {
    const match = line.match(FIELD_LINE);
    if (match && match[1].trim() === name) return match[2].trim();
  }
  return undefined;
}

export function cardStatus(text) {
  for (const line of sections(text).get('')) {
    const match = line.match(STATUS_LINE);
    if (match) return match[1];
  }
  return null;
}

export function exemption(text) {
  for (const lines of sections(text).values()) {
    for (const line of lines) {
      const match = line.match(EXEMPT_LINE);
      if (match && filled(match[1])) return match[1].trim();
    }
  }
  return null;
}

// 返回缺项列表；空列表就是通过。豁免另由 exemption() 判断，这里只管内容。
export function checkCard(text) {
  const map = sections(text);
  const problems = [];
  for (const name of ['验收剧本', '改什么', '保住什么']) {
    if (!filled(field(map, '契约', name))) problems.push(`契约·${name}`);
  }
  const scan = field(map, '同类扫描', '同类扫描');
  if (!filled(scan)) problems.push('同类扫描');
  else if (/^不适用/.test(scan) && !filled(scan.replace(/^不适用\s*[:：]?\s*/, ''))) problems.push('同类扫描（不适用却没写理由）');
  else if ([...scan].length < MIN_SCAN) problems.push(`同类扫描（少于 ${MIN_SCAN} 个字）`);
  const verdict = field(map, '同类扫描', '判定') ?? '';
  const root = verdict.includes('根因修复');
  const sample = verdict.includes('样例补丁');
  if (root === sample) problems.push('判定（根因修复 / 样例补丁 二选一）');
  const key = findSection(map, '证据');
  const levels = key === undefined ? [] : map.get(key).map((line) => line.match(EVIDENCE_LINE)).filter((m) => m && filled(m[2])).map((m) => m[1]);
  if (!levels.length) problems.push('证据（没有带等级的条目）');
  else if (!levels.includes('已验证') && !levels.includes('未验证')) problems.push('证据（没说验证到哪：要有 [已验证] 或 [未验证]）');
  if (findSection(map, '类别债') === undefined) problems.push('类别债（缺这一节）');
  for (const name of BRIEF) {
    if (!filled(field(map, '简报', name))) problems.push(`简报·${name}`);
  }
  if (!filled(field(map, '交接', '别重做'))) problems.push('交接·别重做');
  return problems;
}

const BRIEF = ['行为变化', '决定者', '保住', '证据', '风险'];
const RULE_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;

// 同一条命令：命令行一样，且在仓里同一个子目录下跑。
const commandKey = (receipt) => JSON.stringify([receipt.cmd, relative(receipt.root ?? '', receipt.cwd ?? '')]);

// 红-绿：判定为根因修复的卡，证据里要有同一条命令的一对回执——改动前（或回退改动后）--expect-fail 跑红，当前 HEAD（或其祖先）跑绿。
// 只有「不带这次改动就失败」的测试，才证明它测到了这次修复。写「红绿不适用：理由」跳过。返回问题列表。
export function redGreen(text, root) {
  const map = sections(text);
  if (!(field(map, '同类扫描', '判定') ?? '').includes('根因修复')) return [];
  for (const lines of map.values()) if (lines.some((line) => filled(line.match(RED_GREEN_NA)?.[1] ?? ''))) return [];
  const key = findSection(map, '证据');
  const ids = [...new Set((key === undefined ? [] : map.get(key)).join('\n').match(RECEIPT_ID) ?? [])];
  const loaded = ids.map((id) => ({ id, receipt: loadReceipt(root, id) })).filter((item) => item.receipt);
  const reds = loaded.filter((item) => item.receipt.expectFail);
  const greens = loaded.filter((item) => !item.receipt.expectFail);
  const hint = '（根因修复要有同一条命令的一对回执：改动前 receipt.mjs --expect-fail 跑红、改完跑绿；跑不了写「红绿不适用：理由」）';
  if (!reds.length && !greens.length) return [`红绿：证据里没有回执${hint}`];
  if (!reds.length) return [`红绿：缺改动前跑红的 --expect-fail 回执${hint}`];
  if (!greens.length) return [`红绿：缺改完跑绿的回执${hint}`];
  const pairs = reds.flatMap((red) => greens.filter((green) => commandKey(green.receipt) === commandKey(red.receipt)).map((green) => [red, green]));
  if (!pairs.length) return [`红绿：红、绿回执跑的不是同一条命令${hint}`];
  let first = null;
  for (const [red, green] of pairs) {
    const problems = [...verifyReceipt(root, red.id, { red: true }), ...verifyReceipt(root, green.id)].map((why) => `红绿·${why}`);
    const r = red.receipt;
    const g = green.receipt;
    if (r.head && r.head === g.head && r.dirty === false && g.dirty === false) problems.push(`红绿：${red.id} 与 ${green.id} 跑在同一提交且都没有未提交改动，红不是这次改动造成的（环境或偶发）`);
    if (!problems.length) return [];
    first ??= problems;
  }
  return first;
}

// 内容检查之外，再对着仓库核对：不变量引用、单写者、回执、红绿。mode 取 .harness.json 的 checks.receipts（cite / require / off）。
// 红绿按 checks.redGreen：require 进问题列表，warn（默认）进 warnings（传了才收），off 不查。
export function checkCardInRepo(text, root, config = {}, warnings = null) {
  const problems = checkCard(text);
  if (!root) return problems;
  const map = sections(text);
  const rows = readInvariants(root);
  if (rows.length) {
    // 只认和表里 ID 同前缀的编号（如 INV-），别的编号（需求号、决策号）是自然语言，不当不变量查。
    const prefixes = new Set(rows.map((row) => row.ID.replace(/-\d+$/, '')));
    const cited = [...new Set((field(map, '同类扫描', '触碰的规则') ?? '').match(RULE_ID) ?? [])].filter((id) => prefixes.has(id.replace(/-\d+$/, '')));
    if (cited.length) problems.push(...checkInvariants(root, cited).problems.map((line) => `不变量·${line}`));
  }
  const mode = config.checks?.receipts ?? 'cite';
  if (mode !== 'off') {
    const key = findSection(map, '证据');
    const verified = key === undefined ? [] : map.get(key).map((line) => line.match(EVIDENCE_LINE)).filter((m) => m && m[1] === '已验证' && filled(m[2])).map((m) => m[2]);
    for (const line of verified) {
      const ids = line.match(RECEIPT_ID) ?? [];
      if (!ids.length && mode === 'require' && !/人工\s*[:：]/.test(line)) problems.push(`回执（[已验证] 没引用回执，也没写「人工：」：${line.slice(0, 30)}）`);
      // 同一行里写成红绿一对的校准回执当「改动前跑红」核对，不按「校准回执不能当证据」报。
      const greens = ids.map((id) => loadReceipt(root, id)).filter((r) => r && !r.expectFail).map(commandKey);
      for (const id of ids) {
        const own = loadReceipt(root, id);
        const red = Boolean(own?.expectFail) && greens.includes(commandKey(own));
        problems.push(...verifyReceipt(root, id, { red }).map((why) => `回执·${why}`));
      }
    }
  }
  const redGreenMode = config.checks?.redGreen ?? 'warn';
  if (redGreenMode !== 'off') {
    const found = redGreen(text, root);
    if (redGreenMode === 'require') problems.push(...found);
    else if (warnings) warnings.push(...found);
  }
  return problems;
}

function readConfig(root) {
  try { return JSON.parse(readFileSync(resolve(root, '.harness.json'), 'utf8')); } catch { return null; }
}

function gitRoot(cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', env: { ...env, GIT_OPTIONAL_LOCKS: '0' } });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

// 从 cwd 往上找 .harness.json，最远到 git 仓根（没有 git 就到文件系统根）；找不到返回 null。
export function harnessRoot(cwd) {
  const stop = gitRoot(cwd);
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(resolve(dir, '.harness.json'))) return dir;
    if (dir === stop || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

// 近几小时改过、且状态是 done 的卡；只看卡目录顶层，archive 里的不管。
export function recentDoneCards(root, dir, now = Date.now(), hours = STOP_WINDOW_HOURS) {
  const base = resolve(root, dir);
  let names;
  try { names = readdirSync(base); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md') || name === 'README.md' || name.startsWith('_')) continue;
    const path = resolve(base, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || now - stat.mtimeMs > hours * 3600000) continue;
      if (cardStatus(readFileSync(path, 'utf8')) === 'done') out.push(path);
    } catch { /* 读不了的卡跳过，不拦会话。 */ }
  }
  return out;
}

const stateFile = (session) => resolve(process.env.TMPDIR || tmpdir(), 'harness-card-check', `${String(session || 'unknown').replace(/[^\w.-]/g, '_')}.json`);
function loadState(session) { try { return JSON.parse(readFileSync(stateFile(session), 'utf8')); } catch { return { blocked: [] }; } }
function saveState(session, state) {
  const file = stateFile(session);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

// Stop 钩子：只对接入了的仓（有 .harness.json）生效；同一张卡每会话只拦一次；stop_hook_active 时只提示。
export function stopDecision(input, now = Date.now()) {
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const root = harnessRoot(cwd);
  const config = root && readConfig(root);
  if (!config || config.optOut) return null;
  const mode = config.checks?.cardOnDone ?? 'block';
  if (mode === 'off') return null;
  const dir = config.cardDir || 'docs/tasks';
  const failing = [];
  const notes = [];
  for (const path of recentDoneCards(root, dir, now)) {
    const text = readFileSync(path, 'utf8');
    if (exemption(text)) continue;
    const warnings = [];
    const problems = checkCardInRepo(text, root, config, warnings);
    if (problems.length) failing.push({ card: relative(root, path), problems });
    else if (warnings.length) notes.push({ card: relative(root, path), warnings });
  }
  const state = loadState(input.session_id);
  // 只提示不拦的（红绿 warn）：同一张卡每会话提示一次，免得每轮 Stop 都响。
  const freshNotes = notes.filter(({ card }) => !(state.warned ?? []).includes(card));
  if (!failing.length) {
    if (!freshNotes.length) return null;
    saveState(input.session_id, { ...state, warned: [...(state.warned ?? []), ...freshNotes.map(({ card }) => card)] });
    return { systemMessage: `harness 交付提示（不拦）：${freshNotes.map(({ card, warnings }) => `${card}：${warnings.join('、')}`).join('；')}` };
  }
  const describe = failing.map(({ card, problems }) => `${card}：缺 ${problems.join('、')}`).join('\n');
  const fresh = failing.filter(({ card }) => !state.blocked.includes(card));
  if (mode === 'block' && !input.stop_hook_active && fresh.length) {
    saveState(input.session_id, { ...state, blocked: [...state.blocked, ...fresh.map(({ card }) => card)] });
    return { decision: 'block', reason: `任务卡改成 done，但交付校验没过（harness，每张卡只拦一次）：\n${describe}\n必填项补全；不变量新命中改去调权威实现或在例外列登记；回执对不上就重跑 receipt。确实不适用就在卡里写一行「校验豁免：理由」。模板见 ${dir}/_模板.md。` };
  }
  return { systemMessage: `harness 交付校验：${describe.replace(/\n/g, '；')}` };
}

function selfTest() {
  const tmp = mkdtempSync(resolve(ROOT, '.harness-卡片测试-'));
  process.env.TMPDIR = tmp;
  let count = 0;
  const check = (name, test) => { test(); count++; console.log(`  ✓ ${name}`); };
  const good = [
    '# 某任务', '', '- 状态：done', '- 目标：让用户能导出', '',
    '## 契约', '- 验收剧本：点导出得到 CSV；无权限时提示；空表导出只有表头', '- 改什么：导出按钮', '- 保住什么：无（新功能，没有旧行为）', '- 不做什么：Excel', '',
    '## 影响面与同类扫描', '- 触碰的规则：权限 R-3', '- 同类扫描：搜了 export、download 两个词，另两处列表页已有同样权限判断', '- 判定：根因修复', '',
    '## 证据', '- [已落地] 导出按钮 —— 提交 abc123', '- [已验证] 无权限提示 —— pnpm test exit 0，12 用例 0 skip', '',
    '## 类别债', '无', '',
    '## 简报', '- 行为变化：能导出 CSV 了', '- 决定者：权限 R-3', '- 保住：列表筛选不变', '- 证据：pnpm test exit 0', '- 风险：无', '',
    '## 交接', '- 本段做了：导出', '- 别重做：不用前端拼 CSV，已试过会乱码', '- 等你：无',
  ].join('\n');
  const swap = (from, to) => { assert.ok(good.includes(from), from); return good.replace(from, to); };
  try {
    check('写全的卡通过', () => assert.deepEqual(checkCard(good), []));
    check('模板原样不通过，且列出全部缺项', () => {
      const template = readFileSync(resolve(ROOT, 'plugins/harness/templates/docs/tasks/_模板.md'), 'utf8');
      const problems = checkCard(template);
      for (const item of ['契约·验收剧本', '契约·改什么', '契约·保住什么', '同类扫描', '判定', '证据', '简报·行为变化', '简报·风险', '交接·别重做']) assert.ok(problems.some((p) => p.startsWith(item)), `${item} 未报：${problems}`);
      assert.ok(!problems.some((p) => p.startsWith('类别债')), '模板有类别债节');
    });
    check('契约三项各自判空与占位', () => {
      assert.deepEqual(checkCard(swap('- 验收剧本：点导出得到 CSV；无权限时提示；空表导出只有表头', '- 验收剧本：')), ['契约·验收剧本']);
      assert.deepEqual(checkCard(swap('- 改什么：导出按钮', '- 改什么：<>')), ['契约·改什么']);
      assert.deepEqual(checkCard(swap('- 保住什么：无（新功能，没有旧行为）', '- 保住什么：<必须不变的行为>')), ['契约·保住什么']);
    });
    check('同类扫描：空、不适用无理由、太短都红；不适用加理由通过', () => {
      const scan = '- 同类扫描：搜了 export、download 两个词，另两处列表页已有同样权限判断';
      assert.deepEqual(checkCard(swap(scan, '- 同类扫描：')), ['同类扫描']);
      assert.deepEqual(checkCard(swap(scan, '- 同类扫描：不适用')), ['同类扫描（不适用却没写理由）']);
      assert.deepEqual(checkCard(swap(scan, '- 同类扫描：已扫无')), [`同类扫描（少于 ${MIN_SCAN} 个字）`]);
      assert.deepEqual(checkCard(swap(scan, '- 同类扫描：不适用：纯新增页面，没有既有同类实现')), []);
    });
    check('判定必须二选一', () => {
      assert.deepEqual(checkCard(swap('- 判定：根因修复', '- 判定：根因修复 或 样例补丁')), ['判定（根因修复 / 样例补丁 二选一）']);
      assert.deepEqual(checkCard(swap('- 判定：根因修复', '- 判定：')), ['判定（根因修复 / 样例补丁 二选一）']);
      assert.deepEqual(checkCard(swap('- 判定：根因修复', '- 判定：样例补丁，类别债已登记')), []);
    });
    check('证据：没有等级、只有已落地都红；未验证算说清了', () => {
      const evidence = '- [已落地] 导出按钮 —— 提交 abc123\n- [已验证] 无权限提示 —— pnpm test exit 0，12 用例 0 skip';
      assert.deepEqual(checkCard(swap(evidence, '- 做完了，测试全绿')), ['证据（没有带等级的条目）']);
      assert.deepEqual(checkCard(swap(evidence, '- [已落地] 导出按钮 —— 提交 abc123')), ['证据（没说验证到哪：要有 [已验证] 或 [未验证]）']);
      assert.deepEqual(checkCard(swap(evidence, '- [已落地] 导出按钮 —— 提交 abc123\n- [未验证] 真库导出 —— 本机没库')), []);
      assert.deepEqual(checkCard(swap(evidence, '- [已验证] <>')), ['证据（没有带等级的条目）']);
    });
    check('注释与代码围栏里的不算', () => {
      const evidence = '- [已落地] 导出按钮 —— 提交 abc123\n- [已验证] 无权限提示 —— pnpm test exit 0，12 用例 0 skip';
      assert.deepEqual(checkCard(swap(evidence, '<!--\n- [已验证] 写在多行注释里\n-->')), ['证据（没有带等级的条目）']);
      assert.deepEqual(checkCard(swap(evidence, '```\n- [已验证] 写在围栏里\n```')), ['证据（没有带等级的条目）']);
    });
    check('缺类别债节、缺别重做都红', () => {
      assert.deepEqual(checkCard(swap('## 类别债\n无\n', '')), ['类别债（缺这一节）']);
      assert.deepEqual(checkCard(swap('- 别重做：不用前端拼 CSV，已试过会乱码', '- 别重做：')), ['交接·别重做']);
    });
    check('状态与豁免读取', () => {
      assert.equal(cardStatus(good), 'done');
      assert.equal(cardStatus(swap('- 状态：done', '- 状态：active')), 'active');
      assert.equal(exemption(good), null);
      assert.equal(exemption(good + '\n校验豁免：一次性脚本，无同类'), '一次性脚本，无同类');
      assert.equal(exemption(good + '\n校验豁免：<理由>'), null);
      assert.equal(exemption(good + '\n<!-- 校验豁免：注释里的不算 -->'), null);
    });
    check('简报五行各自必填，风险写「无」算填了', () => {
      assert.deepEqual(checkCard(swap('- 风险：无', '- 风险：')), ['简报·风险']);
      assert.deepEqual(checkCard(swap('- 行为变化：能导出 CSV 了', '- 行为变化：<用户能感知的变化>')), ['简报·行为变化']);
      assert.deepEqual(checkCard(swap('## 简报', '## 摘要')), ['简报·行为变化', '简报·决定者', '简报·保住', '简报·证据', '简报·风险']);
    });
    // 仓库上下文：不变量表 + 基线 + 回执，都在临时目录里，不需要 git。
    const ctx = resolve(tmp, 'ctx');
    mkdirSync(resolve(ctx, 'src'), { recursive: true });
    mkdirSync(resolve(ctx, 'docs'), { recursive: true });
    writeFileSync(resolve(ctx, 'src/stage.py'), 'def stage(o):\n    return o.status == "voided"\n');
    writeFileSync(resolve(ctx, SYSTEM_FILE), '## 不变量\n\n| ID | 业务含义 | 权威实现 | 指纹 | 消费者怎么查 | 联动测试 | 例外与到期 |\n|---|---|---|---|---|---|---|\n| INV-01 | 作废不算通过 | src/stage.py#stage | `status == \\"voided\\"` | — | — | — |\n');
    updateBaseline(ctx);
    const rule = '- 触碰的规则：权限 R-3';
    check('引用的不变量：存在就过，不存在报红；没有不变量表时不查', () => {
      assert.deepEqual(checkCardInRepo(swap(rule, '- 触碰的规则：INV-01'), ctx), []);
      assert.match(checkCardInRepo(swap(rule, '- 触碰的规则：INV-01、INV-09'), ctx).join(), /不变量·INV-09：不在/);
      assert.deepEqual(checkCardInRepo(swap(rule, '- 触碰的规则：INV-09'), resolve(tmp, 'repo-none')), []);
    });
    check('引用的不变量有新增第二处实现：报红', () => {
      writeFileSync(resolve(ctx, 'src/copy.py'), 'if o.status == "voided": pass\n');
      assert.match(checkCardInRepo(swap(rule, '- 触碰的规则：INV-01'), ctx).join(), /不变量·INV-01：权威实现之外新出现一处 src\/copy\.py:1/);
      rmSync(resolve(ctx, 'src/copy.py'));
    });
    const evidence = '- [已验证] 无权限提示 —— pnpm test exit 0，12 用例 0 skip';
    const receipt = (id, extra = {}) => writeReceipt(ctx, { id, exit: 0, counts: { passed: 3, failed: 0, skipped: 0 }, anomalies: [], head: null, ...extra });
    check('回执 cite：引用了就核对，存在且通过就过，找不到、失败、异常都红；没引用不管', () => {
      receipt('R-1108-1530-a3f');
      receipt('R-1108-1531-bad', { exit: 2 });
      receipt('R-1108-1532-e00', { anomalies: ['跑了 0 个用例'] });
      assert.deepEqual(checkCardInRepo(swap(evidence, '- [已验证] 无权限提示 —— 回执 R-1108-1530-a3f'), ctx), []);
      assert.match(checkCardInRepo(swap(evidence, '- [已验证] x —— 回执 R-1108-1599-fff'), ctx).join(), /回执·R-1108-1599-fff：找不到回执/);
      assert.match(checkCardInRepo(swap(evidence, '- [已验证] x —— 回执 R-1108-1531-bad'), ctx).join(), /退出码 2/);
      assert.match(checkCardInRepo(swap(evidence, '- [已验证] x —— 回执 R-1108-1532-e00'), ctx).join(), /跑了 0 个用例/);
      assert.deepEqual(checkCardInRepo(good, ctx), []);
      assert.deepEqual(checkCardInRepo(swap(evidence, '- [已落地] x —— 回执 R-1108-1599-fff\n- [未验证] y —— 没环境'), ctx), []);
    });
    check('回执 require：[已验证] 要么带回执、要么写「人工：」；off 不查', () => {
      const strict = { checks: { receipts: 'require' } };
      assert.match(checkCardInRepo(good, ctx, strict).join(), /没引用回执，也没写「人工：」/);
      assert.deepEqual(checkCardInRepo(swap(evidence, '- [已验证] 页面导出 —— 人工：浏览器走查，截图在卡里'), ctx, strict), []);
      assert.deepEqual(checkCardInRepo(swap(evidence, '- [已验证] x —— 回执 R-1108-1530-a3f'), ctx, strict), []);
      assert.deepEqual(checkCardInRepo(swap(evidence, '- [已验证] x —— 回执 R-1108-1599-fff'), ctx, { checks: { receipts: 'off' } }), []);
    });
    // 红绿：回执直接写进 ctx（不是 git 仓，HEAD 祖先不查），cmd、cwd 决定是不是同一条命令。
    const rg = (id, extra = {}) => writeReceipt(ctx, { id, cmd: ['pytest', 'tests/test_x.py'], cwd: ctx, root: ctx, exit: 0, counts: { passed: 3, failed: 0, skipped: 0 }, anomalies: [], head: null, expectFail: false, ...extra });
    rg('R-1109-0900-0a1', { expectFail: true, exit: 1, counts: { passed: 2, failed: 1, skipped: 0 } });
    rg('R-1109-0910-0b1');
    rg('R-1109-0920-0c1', { cmd: ['pytest'] });
    rg('R-1109-0930-0d1', { expectFail: true, exit: 0 });
    rg('R-1109-0940-0e1', { expectFail: true, exit: 1, counts: { passed: 2, failed: 1, skipped: 0 }, head: 'a'.repeat(40), dirty: false });
    rg('R-1109-0950-0f1', { head: 'a'.repeat(40), dirty: false });
    const cite = (line) => swap(evidence, `- [已验证] 修好了 —— ${line}`);
    check('红绿：只管根因修复；没回执、只有绿、只有红、命令不同都报', () => {
      assert.deepEqual(redGreen(swap('- 判定：根因修复', '- 判定：样例补丁，类别债已登记'), ctx), []);
      assert.match(redGreen(good, ctx).join(), /证据里没有回执/);
      assert.match(redGreen(cite('回执 R-1109-0910-0b1'), ctx).join(), /缺改动前跑红/);
      assert.match(redGreen(cite('回执 R-1109-0900-0a1'), ctx).join(), /缺改完跑绿/);
      assert.match(redGreen(cite('红 R-1109-0900-0a1 → 绿 R-1109-0920-0c1'), ctx).join(), /不是同一条命令/);
    });
    check('红绿：同一条命令一红一绿就过；红没红、同一提交都干净时报', () => {
      assert.deepEqual(redGreen(cite('红 R-1109-0900-0a1 → 绿 R-1109-0910-0b1'), ctx), []);
      assert.match(redGreen(cite('红 R-1109-0930-0d1 → 绿 R-1109-0910-0b1'), ctx).join(), /红绿·R-1109-0930-0d1：预期失败却退出 0/);
      assert.match(redGreen(cite('红 R-1109-0940-0e1 → 绿 R-1109-0950-0f1'), ctx).join(), /同一提交且都没有未提交改动/);
      assert.deepEqual(redGreen(cite('红 R-1109-0930-0d1、R-1109-0900-0a1 → 绿 R-1109-0910-0b1'), ctx), [], '多对里有一对站得住就算');
      assert.deepEqual(redGreen(good + '\n红绿不适用：只改了文案，没有能跑的测试', ctx), []);
      assert.match(redGreen(good + '\n红绿不适用：<理由>', ctx).join(), /证据里没有回执/);
    });
    check('红绿模式：默认 warn 只进提示；require 进缺项；off 不查', () => {
      const warnings = [];
      assert.deepEqual(checkCardInRepo(good, ctx, {}, warnings), []);
      assert.match(warnings.join(), /证据里没有回执/);
      assert.match(checkCardInRepo(good, ctx, { checks: { redGreen: 'require' } }).join(), /红绿：证据里没有回执/);
      const off = [];
      assert.deepEqual(checkCardInRepo(good, ctx, { checks: { redGreen: 'off' } }, off), []); assert.deepEqual(off, []);
    });
    check('[已验证] 同一行写成红绿一对时，红的那张不按校准回执报；单独引用照报', () => {
      assert.deepEqual(checkCardInRepo(cite('红 R-1109-0900-0a1 → 绿 R-1109-0910-0b1'), ctx, { checks: { redGreen: 'require' } }), []);
      assert.match(checkCardInRepo(cite('回执 R-1109-0900-0a1'), ctx).join(), /校准回执/);
      assert.match(checkCardInRepo(cite('红 R-1109-0930-0d1 → 绿 R-1109-0910-0b1'), ctx).join(), /回执·R-1109-0930-0d1：预期失败却退出 0/);
    });
    // Stop 钩子：在临时目录里搭仓（不需要 git，退回 cwd）。
    const repo = resolve(tmp, 'repo');
    const cards = resolve(repo, 'docs/tasks');
    mkdirSync(cards, { recursive: true });
    const bad = swap('- 同类扫描：搜了 export、download 两个词，另两处列表页已有同样权限判断', '- 同类扫描：');
    const input = (extra = {}) => ({ cwd: repo, session_id: `s-${count}`, ...extra });
    check('未接入（无 .harness.json）不管', () => {
      writeFileSync(resolve(cards, '2026-11-08-坏卡.md'), bad);
      assert.equal(stopDecision(input()), null);
    });
    writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ cardDir: 'docs/tasks', checks: { cardOnDone: 'block' } }));
    check('done 且缺项：拦一次，同会话第二次只提示', () => {
      const first = stopDecision(input({ session_id: 'once' }));
      assert.equal(first.decision, 'block'); assert.match(first.reason, /2026-11-08-坏卡\.md：缺 同类扫描/);
      const second = stopDecision(input({ session_id: 'once' }));
      assert.equal(second.decision, undefined); assert.match(second.systemMessage, /缺 同类扫描/);
    });
    check('stop_hook_active 时不拦', () => {
      const out = stopDecision(input({ session_id: 'active', stop_hook_active: true }));
      assert.equal(out.decision, undefined); assert.match(out.systemMessage, /坏卡/);
    });
    check('warn 模式只提示，off 不管，optOut 不管', () => {
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { cardOnDone: 'warn' } }));
      assert.equal(stopDecision(input({ session_id: 'warn' })).decision, undefined);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { cardOnDone: 'off' } }));
      assert.equal(stopDecision(input({ session_id: 'off' })), null);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ optOut: true }));
      assert.equal(stopDecision(input({ session_id: 'opt' })), null);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { cardOnDone: 'block' } }));
    });
    check('豁免、active、过期、模板与 README、写全的卡都不拦', () => {
      writeFileSync(resolve(cards, '2026-11-08-坏卡.md'), bad + '\n校验豁免：演示卡');
      writeFileSync(resolve(cards, '2026-11-08-在做.md'), bad.replace('- 状态：done', '- 状态：active'));
      writeFileSync(resolve(cards, '2026-11-08-好卡.md'), good);
      writeFileSync(resolve(cards, '_模板.md'), bad);
      writeFileSync(resolve(cards, 'README.md'), bad);
      const old = resolve(cards, '2026-10-01-旧卡.md');
      writeFileSync(old, bad);
      const past = new Date(Date.now() - (STOP_WINDOW_HOURS + 1) * 3600000);
      utimesSync(old, past, past);
      // 好卡是根因修复却没有红绿回执：默认 warn，只提示、不拦，同会话只提示一次。
      const out = stopDecision(input({ session_id: 'clean' }));
      assert.equal(out.decision, undefined); assert.match(out.systemMessage, /不拦）：docs\/tasks\/2026-11-08-好卡\.md：红绿/);
      assert.doesNotMatch(out.systemMessage, /坏卡|在做|模板|README|旧卡/);
      assert.equal(stopDecision(input({ session_id: 'clean' })), null);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { cardOnDone: 'block', redGreen: 'off' } }));
      assert.equal(stopDecision(input({ session_id: 'clean-off' })), null);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { cardOnDone: 'block' } }));
      writeFileSync(resolve(cards, '2026-11-08-好卡.md'), good + '\n红绿不适用：演示卡，没有测试命令');
      assert.equal(stopDecision(input({ session_id: 'clean-na' })), null);
    });
    check('archive 子目录不扫', () => {
      mkdirSync(resolve(cards, 'archive/2026-10'), { recursive: true });
      writeFileSync(resolve(cards, 'archive/2026-10/x.md'), bad);
      assert.equal(stopDecision(input({ session_id: 'arch' })), null);
    });
    check('自定义卡目录', () => {
      const other = resolve(repo, 'docs/协作/任务');
      mkdirSync(other, { recursive: true });
      writeFileSync(resolve(other, '2026-11-08-坏.md'), bad);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ cardDir: 'docs/协作/任务' }));
      assert.equal(stopDecision(input({ session_id: 'dir' })).decision, 'block');
    });
    check('Stop 也核对仓库上下文：内容写全但引用的回执不存在，照样拦', () => {
      const fake = swap('- [已验证] 无权限提示 —— pnpm test exit 0，12 用例 0 skip', '- [已验证] 无权限提示 —— 回执 R-0101-0000-fff');
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ cardDir: 'docs/tasks' }));
      for (const name of readdirSync(cards)) if (name.endsWith('.md')) rmSync(resolve(cards, name));
      writeFileSync(resolve(cards, '2026-11-08-假回执.md'), fake);
      const out = stopDecision(input({ session_id: 'ctx' }));
      assert.equal(out.decision, 'block'); assert.match(out.reason, /回执·R-0101-0000-fff：找不到回执/);
      rmSync(resolve(cards, '2026-11-08-假回执.md'));
    });
    check('hook 入口：坏输入不抛错、零退出', () => {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stop'], { input: '{bad', encoding: 'utf8' });
      assert.equal(result.status, 0); assert.match(result.stdout, /读取失败|^$/);
    });
    check('CLI：红了退出 1 并列缺项，通过退出 0', () => {
      const badFile = resolve(tmp, 'bad.md');
      const goodFile = resolve(tmp, 'good.md');
      writeFileSync(badFile, bad); writeFileSync(goodFile, good);
      const red = spawnSync(process.execPath, [fileURLToPath(import.meta.url), badFile], { encoding: 'utf8' });
      assert.equal(red.status, 1); assert.match(red.stdout, /缺 同类扫描/);
      const green = spawnSync(process.execPath, [fileURLToPath(import.meta.url), goodFile], { encoding: 'utf8' });
      assert.equal(green.status, 0, green.stdout);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(`card-check 自测：${count} 项通过`);
}

const self = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (self && process.argv.includes('--self-test')) {
  selfTest();
} else if (self && process.argv.includes('--stop')) {
  // 生产钩子始终零退出：读不了就提示一句，不拦会话。
  try {
    const raw = readFileSync(0, 'utf8');
    const decision = stopDecision(raw.trim() ? JSON.parse(raw) : {});
    if (decision) process.stdout.write(JSON.stringify(decision) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ systemMessage: `harness 交付校验读取失败：${String(error.message ?? error).slice(0, 140)}` }) + '\n'); }
} else if (self) {
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (!files.length) { console.error('用法：node card-check.mjs <任务卡.md…> | --stop | --self-test'); process.exit(2); }
  let red = false;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const why = exemption(text);
    const root = harnessRoot(dirname(resolve(file)));
    const warnings = [];
    const problems = why ? [] : checkCardInRepo(text, root, root ? readConfig(root) ?? {} : {}, warnings);
    if (problems.length) red = true;
    console.log(problems.length ? `✗ ${file}：缺 ${problems.join('、')}` : `✓ ${file}${why ? `（豁免：${why}）` : ''}`);
    for (const line of problems.length ? [] : warnings) console.log(`  ⚠ ${line}（只提示，不算红）`);
  }
  process.exit(red ? 1 : 0);
}
