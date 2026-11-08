#!/usr/bin/env node
// 任务卡交付校验：卡改成 done 时，必填项（契约、同类扫描、判定、证据等级、类别债节、别重做）不能空着。
// 用法：node card-check.mjs <卡…>（CLI，红了退出 1）；--stop（Stop 钩子，读 stdin JSON）；--self-test。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LEVELS = ['已发现', '已设计', '已落地', '已验证', '未验证'];
const EVIDENCE_LINE = new RegExp(`^\\s*[-*]\\s*\\[(${LEVELS.join('|')})\\]\\s*(.+)$`);
const FIELD_LINE = /^\s*[-*]\s*(?:\*\*)?([^：:*]+?)(?:\*\*)?\s*[:：]\s*(.*)$/;
const STATUS_LINE = /^\s*[-*]\s*状态\s*[:：]\s*(\w+)/;
const EXEMPT_LINE = /^\s*(?:[-*]\s*)?校验豁免\s*[:：]\s*(\S.*)$/;
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
  if (!filled(field(map, '交接', '别重做'))) problems.push('交接·别重做');
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
  for (const path of recentDoneCards(root, dir, now)) {
    const text = readFileSync(path, 'utf8');
    if (exemption(text)) continue;
    const problems = checkCard(text);
    if (problems.length) failing.push({ card: relative(root, path), problems });
  }
  if (!failing.length) return null;
  const describe = failing.map(({ card, problems }) => `${card}：缺 ${problems.join('、')}`).join('\n');
  const state = loadState(input.session_id);
  const fresh = failing.filter(({ card }) => !state.blocked.includes(card));
  if (mode === 'block' && !input.stop_hook_active && fresh.length) {
    saveState(input.session_id, { blocked: [...state.blocked, ...fresh.map(({ card }) => card)] });
    return { decision: 'block', reason: `任务卡改成 done，但必填项没写全（harness 交付校验，每张卡只拦一次）：\n${describe}\n补全这些项；确实不适用就在卡里写一行「校验豁免：理由」。模板见 ${dir}/_模板.md。` };
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
    '## 交接', '- 本段做了：导出', '- 别重做：不用前端拼 CSV，已试过会乱码', '- 等你：无',
  ].join('\n');
  const swap = (from, to) => { assert.ok(good.includes(from), from); return good.replace(from, to); };
  try {
    check('写全的卡通过', () => assert.deepEqual(checkCard(good), []));
    check('模板原样不通过，且列出全部缺项', () => {
      const template = readFileSync(resolve(ROOT, 'plugins/harness/templates/docs/tasks/_模板.md'), 'utf8');
      const problems = checkCard(template);
      for (const item of ['契约·验收剧本', '契约·改什么', '契约·保住什么', '同类扫描', '判定', '证据', '交接·别重做']) assert.ok(problems.some((p) => p.startsWith(item)), `${item} 未报：${problems}`);
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
      assert.equal(stopDecision(input({ session_id: 'clean' })), null);
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
    const problems = why ? [] : checkCard(text);
    if (problems.length) red = true;
    console.log(problems.length ? `✗ ${file}：缺 ${problems.join('、')}` : `✓ ${file}${why ? `（豁免：${why}）` : ''}`);
  }
  process.exit(red ? 1 : 0);
}
