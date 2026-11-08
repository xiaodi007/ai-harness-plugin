#!/usr/bin/env node
// 不变量表与单写者检查：docs/SYSTEM.md「不变量」表里每条规则只有一处权威实现；指纹正则扫到权威实现之外的新命中就报红。
// 存量命中记在 .harness/invariants-baseline.json，只许减少（棘轮）。指纹是网不是证明：换种写法的重复实现扫不到。
// 用法：node invariants.mjs check [ID…] | baseline [--accept-new ID] | consumers ID | list；--self-test。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SYSTEM_FILE = 'docs/SYSTEM.md';
export const BASELINE_FILE = '.harness/invariants-baseline.json';
export const MAX_INVARIANTS = 40;
const FILE_LIMIT = 1024 * 1024;
// 测试、文档、生成物不算「第二处实现」。
export const SKIP_PATH = /(^|\/)(tests?|__tests__|spec|docs|node_modules|dist|build|\.harness|\.git)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.[^/]+$|\.(md|markdown|txt|json|lock|svg|png|jpe?g|gif|pdf)$/i;

const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' });
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });

// 按未转义的 | 切表格行；单元格里的 \| 还原成 |，外层反引号去掉。
export function cells(line) {
  const parts = [];
  let current = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') { current += '|'; i++; continue; }
    if (body[i] === '|') { parts.push(current); current = ''; continue; }
    current += body[i];
  }
  parts.push(current);
  // 「—」「-」表示空。
  return parts.map((cell) => cell.trim().replace(/^`([^`]*)`$/, '$1').trim()).map((cell) => (/^[—-]$/.test(cell) ? '' : cell));
}

// 取某个「## 标题」节里的第一张表，按表头名返回行对象。
export function sectionTable(text, word) {
  const lines = text.split('\n');
  let inSection = false;
  let header = null;
  const rows = [];
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { if (inSection && header) break; inSection = heading[1].includes(word); continue; }
    if (!inSection) continue;
    if (!/^\s*\|/.test(line)) { if (header) break; continue; }
    const row = cells(line);
    if (!header) { header = row; continue; }
    if (row.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    rows.push(Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])));
  }
  return rows;
}

export function readInvariants(root) {
  let text;
  try { text = readFileSync(resolve(root, SYSTEM_FILE), 'utf8'); } catch { return []; }
  return sectionTable(text, '不变量').filter((row) => row.ID);
}

const authorityPath = (row) => (row['权威实现'] || '').split('#')[0].trim();
const authoritySymbol = (row) => (row['权威实现'] || '').split('#')[1]?.trim() || '';
// 例外列里用反引号括起来的路径不扫。
const exceptionPaths = (row) => [...(row['例外与到期'] || '').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());

export function tableProblems(root, rows) {
  const problems = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.ID)) problems.push(`${row.ID}：ID 重复`);
    seen.add(row.ID);
    const path = authorityPath(row);
    if (!path) { problems.push(`${row.ID}：没写权威实现`); continue; }
    let source = null;
    try { source = readFileSync(resolve(root, path), 'utf8'); } catch { problems.push(`${row.ID}：权威实现 ${path} 不存在`); }
    const symbol = authoritySymbol(row);
    if (source !== null && symbol && !source.includes(symbol)) problems.push(`${row.ID}：${path} 里找不到 ${symbol}`);
    if (row['指纹']) { try { new RegExp(row['指纹']); } catch { problems.push(`${row.ID}：指纹不是合法正则`); } }
  }
  if (rows.length > MAX_INVARIANTS) problems.push(`不变量 ${rows.length} 条，超过 ${MAX_INVARIANTS}：只留高价值的，其余是规则清单不是不变量`);
  return problems;
}

function sourceFiles(root) {
  const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listed.status === 0) return listed.stdout.split('\0').filter(Boolean);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(resolve(root, dir))) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = dir ? join(dir, name) : name;
      if (statSync(resolve(root, path)).isDirectory()) walk(path); else out.push(path);
    }
  };
  walk('');
  return out;
}

// 指纹命中：键用「文件:去空白的行文本」，挪行号不算新增。
export function fingerprintHits(root, row, files = sourceFiles(root)) {
  if (!row['指纹']) return [];
  let pattern;
  try { pattern = new RegExp(row['指纹']); } catch { return []; }
  const skip = new Set([authorityPath(row), ...exceptionPaths(row)]);
  const hits = [];
  for (const file of files) {
    if (SKIP_PATH.test(file) || skip.has(file) || [...skip].some((path) => path.endsWith('/') && file.startsWith(path))) continue;
    let text;
    try { if (statSync(resolve(root, file)).size > FILE_LIMIT) continue; text = readFileSync(resolve(root, file), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push({ key: `${file}:${line.trim()}`, file, line: index + 1 });
    });
  }
  return hits;
}

export function readBaseline(root) {
  try { return JSON.parse(readFileSync(resolve(root, BASELINE_FILE), 'utf8')); } catch { return {}; }
}
function writeBaseline(root, baseline) {
  const path = resolve(root, BASELINE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const ignore = resolve(dirname(path), '.gitignore');
  // 基线要进版本库（它是棘轮的刻度），回执等本机产物不进：.harness/.gitignore 只放过基线。
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n!invariants-baseline.json\n');
  writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
}

// 检查指定 ID（不给就全部）：表格问题 + 未登记 ID + 相对基线的新增命中。
export function checkInvariants(root, ids = null) {
  const rows = readInvariants(root);
  const known = new Set(rows.map((row) => row.ID));
  const problems = [];
  const unknown = (ids ?? []).filter((id) => !known.has(id));
  for (const id of unknown) problems.push(`${id}：不在 ${SYSTEM_FILE} 不变量表里`);
  const chosen = ids ? rows.filter((row) => ids.includes(row.ID)) : rows;
  problems.push(...tableProblems(root, chosen).filter((line) => ids === null || !line.startsWith('不变量 ')));
  const baseline = readBaseline(root);
  const files = chosen.some((row) => row['指纹']) ? sourceFiles(root) : [];
  const stock = [];
  for (const row of chosen) {
    const hits = fingerprintHits(root, row, files);
    const old = new Set(baseline[row.ID] ?? []);
    if (!(row.ID in baseline)) { if (hits.length) stock.push(`${row.ID}：还没有基线，现有 ${hits.length} 处命中（运行 baseline 记为存量）`); continue; }
    const fresh = hits.filter((hit) => !old.has(hit.key));
    for (const hit of fresh.slice(0, 5)) problems.push(`${row.ID}：权威实现之外新出现一处 ${hit.file}:${hit.line}（第二处实现？改去调权威实现，或在例外列登记）`);
    if (fresh.length > 5) problems.push(`${row.ID}：另有 ${fresh.length - 5} 处新命中`);
    const gone = [...old].filter((key) => !hits.some((hit) => hit.key === key)).length;
    if (gone) stock.push(`${row.ID}：存量少了 ${gone} 处，运行 baseline 把刻度往下拧`);
    else if (old.size) stock.push(`${row.ID}：存量 ${old.size} 处`);
  }
  return { problems, notes: stock };
}

// 基线：没有基线的 ID 记下当前命中；已有的只收缩；--accept-new 才允许某个 ID 变大。
export function updateBaseline(root, acceptNew = []) {
  const rows = readInvariants(root);
  const baseline = readBaseline(root);
  const files = sourceFiles(root);
  const next = {};
  const changes = [];
  for (const row of rows) {
    const keys = fingerprintHits(root, row, files).map((hit) => hit.key);
    if (!(row.ID in baseline) || acceptNew.includes(row.ID)) {
      next[row.ID] = [...new Set(keys)].sort();
      changes.push(`${row.ID}：${row.ID in baseline ? '放宽（--accept-new）' : '首次记录'} ${next[row.ID].length} 处`);
      continue;
    }
    const kept = baseline[row.ID].filter((key) => keys.includes(key));
    next[row.ID] = kept;
    if (kept.length !== baseline[row.ID].length) changes.push(`${row.ID}：${baseline[row.ID].length} → ${kept.length}`);
  }
  writeBaseline(root, next);
  return changes;
}

export function consumers(root, id) {
  const row = readInvariants(root).find((item) => item.ID === id);
  if (!row) return `${id}：不在不变量表里`;
  const command = row['消费者怎么查'];
  if (!command) return `${id}：没写消费者怎么查`;
  const result = spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const out = (result.stdout || '').trim();
  return `$ ${command}\n${out ? out.split('\n').slice(0, 200).join('\n') : '（没有输出）'}${result.status > 1 ? `\n（退出码 ${result.status}）` : ''}`;
}

function selfTest() {
  const tmp = mkdtempSync(resolve(ROOT, '.harness-不变量测试-'));
  let count = 0;
  const check = (name, test) => { test(); count++; console.log(`  ✓ ${name}`); };
  const put = (root, path, text) => { mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), text); };
  const table = (rows) => ['# 系统', '', '## 不变量', '', '| ID | 业务含义 | 权威实现 | 指纹 | 消费者怎么查 | 联动测试 | 例外与到期 |', '|---|---|---|---|---|---|---|', ...rows, '', '## 系统地图', '', '| 模块 | 路径 |', '|---|---|', '| x | src/ |'].join('\n');
  try {
    check('表格切分：转义竖线与反引号', () => {
      assert.deepEqual(cells('| A | `a\\|b` | c | — |'), ['A', 'a|b', 'c', '']);
    });
    check('只读不变量节的表，不读地图表；空表为空', () => {
      const text = table(['| INV-01 | 作废不算通过 | src/stage.py#stage | `voided` | `grep -rn stage src` | t | — |']);
      const rows = sectionTable(text, '不变量');
      assert.equal(rows.length, 1); assert.equal(rows[0]['指纹'], 'voided'); assert.equal(rows[0]['消费者怎么查'], 'grep -rn stage src');
      assert.deepEqual(sectionTable(table([]), '不变量'), []);
    });
    const repo = resolve(tmp, 'repo');
    put(repo, 'src/stage.py', 'def stage(o):\n    return o.status == "voided"\n');
    put(repo, 'src/old.py', 'if o.status == "voided":\n    pass\n');
    put(repo, 'tests/test_stage.py', 'assert o.status == "voided"\n');
    put(repo, 'docs/x.md', 'status == "voided"\n');
    const row = '| INV-01 | 作废不算通过 | src/stage.py#stage | `status == \\"voided\\"\\|status==\\"voided\\"` | `grep -rn stage src` | tests/test_stage.py | — |';
    put(repo, SYSTEM_FILE, table([row]));
    check('表格问题：ID 重复、权威实现不存在、符号找不到、坏正则、超 40 条', () => {
      const rows = [
        { ID: 'A', '权威实现': 'src/stage.py#stage', '指纹': 'x' }, { ID: 'A', '权威实现': 'src/stage.py#stage' },
        { ID: 'B', '权威实现': 'src/none.py#f' }, { ID: 'C', '权威实现': 'src/stage.py#nothere' }, { ID: 'D', '权威实现': 'src/stage.py', '指纹': '(' }, { ID: 'E' },
      ];
      const problems = tableProblems(repo, rows).join('\n');
      assert.match(problems, /A：ID 重复/); assert.match(problems, /B：权威实现 src\/none\.py 不存在/); assert.match(problems, /C：src\/stage\.py 里找不到 nothere/);
      assert.match(problems, /D：指纹不是合法正则/); assert.match(problems, /E：没写权威实现/);
      assert.match(tableProblems(repo, Array.from({ length: 41 }, (_, i) => ({ ID: `X${i}`, '权威实现': 'src/stage.py' }))).join('\n'), /超过 40/);
    });
    check('指纹只扫权威实现之外的源码，测试与文档不算', () => {
      const hits = fingerprintHits(repo, readInvariants(repo)[0]);
      assert.deepEqual(hits.map((hit) => hit.file), ['src/old.py']);
    });
    check('没有基线：不报红，提示记存量', () => {
      const out = checkInvariants(repo);
      assert.deepEqual(out.problems, []); assert.match(out.notes.join('\n'), /还没有基线，现有 1 处/);
    });
    check('记基线后：存量不红；新增一处就红，指出文件行号', () => {
      assert.match(updateBaseline(repo).join('\n'), /INV-01：首次记录 1 处/);
      assert.deepEqual(checkInvariants(repo).problems, []);
      put(repo, 'src/new.py', 'x = 1\nok = o.status=="voided"\n');
      const problems = checkInvariants(repo).problems.join('\n');
      assert.match(problems, /INV-01：权威实现之外新出现一处 src\/new\.py:2/);
    });
    check('挪行号不算新增', () => {
      rmSync(resolve(repo, 'src/new.py'));
      put(repo, 'src/old.py', '\n\n\nif o.status == "voided":\n    pass\n');
      assert.deepEqual(checkInvariants(repo).problems, []);
    });
    check('棘轮：存量消失后 baseline 只收缩；再加回来会红；--accept-new 才放宽', () => {
      put(repo, 'src/old.py', 'if stage(o):\n    pass\n');
      assert.match(checkInvariants(repo).notes.join('\n'), /存量少了 1 处/);
      assert.match(updateBaseline(repo).join('\n'), /INV-01：1 → 0/);
      put(repo, 'src/old.py', 'if o.status == "voided":\n    pass\n');
      assert.match(checkInvariants(repo).problems.join('\n'), /新出现一处 src\/old\.py/);
      updateBaseline(repo);
      assert.match(checkInvariants(repo).problems.join('\n'), /新出现一处/);
      assert.match(updateBaseline(repo, ['INV-01']).join('\n'), /放宽/);
      assert.deepEqual(checkInvariants(repo).problems, []);
    });
    check('例外列登记的路径不扫', () => {
      put(repo, SYSTEM_FILE, table([row.replace('| — |', '| `src/old.py` 迁移期，12 月底删 |')]));
      assert.equal(fingerprintHits(repo, readInvariants(repo)[0]).length, 0);
      put(repo, SYSTEM_FILE, table([row]));
    });
    check('按 ID 检查：未登记的 ID 报红，只查指定的', () => {
      const out = checkInvariants(repo, ['INV-01', 'INV-99']);
      assert.match(out.problems.join('\n'), /INV-99：不在 docs\/SYSTEM\.md/);
      assert.ok(!out.problems.some((line) => line.startsWith('INV-01')));
    });
    check('基线文件带 .gitignore：基线进库、其余本机产物不进', () => {
      assert.match(readFileSync(resolve(repo, '.harness/.gitignore'), 'utf8'), /!invariants-baseline\.json/);
    });
    check('消费者：运行表里的查询命令', () => {
      assert.match(consumers(repo, 'INV-01'), /src\/stage\.py:1:def stage/);
      assert.match(consumers(repo, 'INV-77'), /不在不变量表里/);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(`不变量自测：${count} 项通过`);
}

const self = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (self && process.argv.includes('--self-test')) selfTest();
else if (self) {
  const [command = 'check', ...rest] = process.argv.slice(2);
  const args = rest.filter((arg) => !arg.startsWith('--'));
  const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const root = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();
  if (command === 'check') {
    const { problems, notes } = checkInvariants(root, args.length ? args : null);
    for (const line of notes) console.log(`· ${line}`);
    for (const line of problems) console.log(`✗ ${line}`);
    console.log(problems.length ? `不变量检查：${problems.length} 处问题` : '不变量检查：通过');
    process.exit(problems.length ? 1 : 0);
  } else if (command === 'baseline') {
    const i = rest.indexOf('--accept-new');
    const changes = updateBaseline(root, i >= 0 ? rest.slice(i + 1).filter((arg) => !arg.startsWith('--')) : []);
    console.log(changes.length ? changes.join('\n') : '基线没有变化');
  } else if (command === 'consumers') {
    console.log(consumers(root, args[0] ?? ''));
  } else if (command === 'list') {
    for (const row of readInvariants(root)) console.log(`${row.ID}  ${row['业务含义']}  →  ${row['权威实现']}`);
  } else { console.error('用法：node invariants.mjs check [ID…] | baseline [--accept-new ID…] | consumers ID | list | --self-test'); process.exit(2); }
}
