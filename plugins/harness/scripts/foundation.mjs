#!/usr/bin/env node
// 地基检查：仓库有没有接入方法论（.harness.json）、地基缺不缺、熵有没有超预算。只报警，不拦会话。
// SessionStart 调用 foundationWarnings()；--self-test 自测。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { cardStatus, exemption } from './card-check.mjs';
import { sectionTable, readInvariants, readBaseline, tableProblems, SYSTEM_FILE } from './invariants.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULTS = { cardDir: 'docs/tasks', budgets: { agentsLines: 200, decisionsKB: 100, activeCards: 12, cardKB: 30 } };
const CARD_HEAD = 4096;

const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' });
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });

// 有代码 = git 跟踪的文件里有非 Markdown、非点文件的；纯文档仓（资料目录）不算项目。
function hasCode(root) {
  const result = git(root, ['ls-files', '-z']);
  if (result.status !== 0) return false;
  return result.stdout.split('\0').some((path) => path && !/\.(md|markdown|txt)$/i.test(path) && !path.split('/').pop().startsWith('.'));
}

function readHead(path, limit = CARD_HEAD) {
  const text = readFileSync(path, 'utf8');
  return text.length > limit ? text.slice(0, limit) : text;
}

// 返回要报给维护者的告警行（可能为空）。非 git、optOut 不报。
export function foundationWarnings(cwd, now = new Date()) {
  const probe = git(cwd, ['rev-parse', '--show-toplevel']);
  if (probe.status !== 0 || !probe.stdout.trim()) return [];
  const root = probe.stdout.trim();
  const configPath = resolve(root, '.harness.json');
  if (!existsSync(configPath)) {
    return hasCode(root) ? ['本仓未接入方法论：运行 /harness:init（不打算接入就建 .harness.json 写 {"optOut": true}）'] : [];
  }
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch (error) { return [`.harness.json 读不了：${String(error.message).slice(0, 80)}`]; }
  if (config.optOut) return [];
  if (config.checks?.foundation === 'off') return [];
  const budgets = { ...DEFAULTS.budgets, ...(config.budgets ?? {}) };
  const cardDir = config.cardDir || DEFAULTS.cardDir;
  const warnings = [];
  const missing = ['AGENTS.md', 'DECISIONS.md', cardDir].filter((path) => !existsSync(resolve(root, path)));
  if (missing.length) warnings.push(`地基缺：${missing.join('、')}（/harness:init 补齐）`);
  const over = [];
  try {
    const lines = readFileSync(resolve(root, 'AGENTS.md'), 'utf8').split('\n').length;
    if (lines > budgets.agentsLines) over.push(`AGENTS.md ${lines} 行 / ${budgets.agentsLines}`);
  } catch { /* 缺文件已在上面报。 */ }
  try {
    const kb = Math.round(statSync(resolve(root, 'DECISIONS.md')).size / 1024);
    if (kb > budgets.decisionsKB) over.push(`DECISIONS ${kb}KB / ${budgets.decisionsKB}KB`);
  } catch { /* 同上。 */ }
  let names = [];
  try { names = readdirSync(resolve(root, cardDir)).filter((name) => name.endsWith('.md') && name !== 'README.md' && !name.startsWith('_')); } catch { /* 同上。 */ }
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let active = 0;
  let exempt = 0;
  const archivable = [];
  const big = [];
  for (const name of names) {
    const path = resolve(root, cardDir, name);
    let stat;
    try { stat = statSync(path); if (!stat.isFile()) continue; } catch { continue; }
    const status = cardStatus(readHead(path));
    if (status === 'active' || status === 'waiting') active++;
    const dated = name.match(/^(\d{4}-\d{2})-\d{2}-/);
    if ((status === 'done' || status === 'dropped') && dated && dated[1] < month) archivable.push(name);
    if (stat.size > budgets.cardKB * 1024) big.push(name);
    try { if (exemption(readFileSync(path, 'utf8'))) exempt++; } catch { /* 读不了不计。 */ }
  }
  if (active > budgets.activeCards) over.push(`进行中的卡 ${active} 张 / ${budgets.activeCards}`);
  if (over.length) warnings.push(`熵超预算：${over.join('；')}`);
  if (archivable.length) warnings.push(`有 ${archivable.length} 张上月及更早的 done/dropped 卡可归档到 ${cardDir}/archive/`);
  if (big.length) warnings.push(`${big.length} 张卡超过 ${budgets.cardKB}KB，拆卡或把结论回写事实源：${big.slice(0, 3).join('、')}${big.length > 3 ? ' 等' : ''}`);
  if (exempt) warnings.push(`交付校验豁免 ${exempt} 张卡`);
  warnings.push(...systemWarnings(root));
  return warnings;
}

const MAP_STALE_FILES = 30;
// 地图路径单元格：反引号或逗号、顿号、空格分隔的多个路径。
const mapPaths = (cell) => cell.replace(/`/g, '').split(/[,，、\s]+/).map((p) => p.trim().replace(/\/+$/, '')).filter((p) => p && p !== '—' && !p.startsWith('<'));

// 系统地图过期与不变量表健康；只对有代码的已接入仓报。
export function systemWarnings(root) {
  let text;
  try { text = readFileSync(resolve(root, SYSTEM_FILE), 'utf8'); } catch { return []; }
  if (!hasCode(root)) return [];
  const out = [];
  const rows = sectionTable(text, '系统地图');
  if (!rows.length) out.push('系统地图还没写（/harness:map 起草）');
  else {
    const paths = rows.flatMap((row) => mapPaths(row['路径'] ?? ''));
    const missing = paths.filter((path) => !existsSync(resolve(root, path)));
    if (missing.length) out.push(`地图里的路径不存在：${missing.slice(0, 4).join('、')}${missing.length > 4 ? ' 等' : ''}`);
    const listed = git(root, ['ls-files', '-z']);
    const tops = new Set(listed.status === 0 ? listed.stdout.split('\0').filter((file) => file.includes('/')).map((file) => file.split('/')[0]) : []);
    const uncovered = [...tops].filter((dir) => !dir.startsWith('.') && !/^(docs?|tests?|__tests__|node_modules|dist|build)$/i.test(dir))
      .filter((dir) => !paths.some((path) => path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`))).sort();
    if (uncovered.length) out.push(`地图没登记的顶层目录：${uncovered.slice(0, 5).join('、')}${uncovered.length > 5 ? ' 等' : ''}`);
    const sha = text.match(/^最后核对\s*[:：]\s*([0-9a-f]{7,40})\b/m)?.[1];
    if (sha) {
      const diff = git(root, ['diff', '--name-only', sha, 'HEAD']);
      if (diff.status !== 0) out.push(`地图「最后核对」的提交 ${sha} 找不到`);
      else {
        const changed = diff.stdout.split('\n').filter(Boolean).length;
        if (changed >= MAP_STALE_FILES) out.push(`地图核对（${sha.slice(0, 7)}）以来改了 ${changed} 个文件，可能过期`);
      }
    } else out.push('地图没写「最后核对：提交号」');
  }
  const invariants = readInvariants(root);
  const broken = tableProblems(root, invariants);
  if (broken.length) out.push(`不变量表：${broken.slice(0, 2).join('；')}${broken.length > 2 ? ` 等 ${broken.length} 处` : ''}`);
  const baseline = readBaseline(root);
  const noBase = invariants.filter((row) => row['指纹'] && !(row.ID in baseline)).map((row) => row.ID);
  if (noBase.length) out.push(`${noBase.length} 条不变量还没记基线：${noBase.slice(0, 4).join('、')}（invariants.mjs baseline）`);
  return out;
}

function selfTest() {
  const tmp = mkdtempSync(resolve(ROOT, '.harness-地基测试-'));
  let count = 0;
  const check = (name, test) => { test(); count++; console.log(`  ✓ ${name}`); };
  const repo = (name) => {
    const dir = resolve(tmp, name);
    mkdirSync(dir, { recursive: true });
    assert.equal(git(dir, ['init', '-q']).status, 0);
    return dir;
  };
  const track = (dir, path, text) => {
    mkdirSync(dirname(resolve(dir, path)), { recursive: true });
    writeFileSync(resolve(dir, path), text);
    assert.equal(git(dir, ['add', '--', path]).status, 0);
  };
  const card = (status) => `# 卡\n\n- 状态：${status}\n`;
  try {
    check('非 git 目录不报', () => {
      // 临时目录在本工作树里，git 会认到外层仓；用文件系统根代表真正的非 git 目录。
      assert.deepEqual(foundationWarnings('/'), []);
    });
    check('有代码没接入：报未接入', () => {
      const dir = repo('code');
      track(dir, 'src/a.py', 'x = 1\n');
      assert.match(foundationWarnings(dir).join('\n'), /本仓未接入方法论/);
    });
    check('纯文档仓没接入：不报', () => {
      const dir = repo('docs-only');
      track(dir, 'notes.md', '# 笔记\n');
      track(dir, '.gitignore', 'x\n');
      assert.deepEqual(foundationWarnings(dir), []);
    });
    check('optOut 与 foundation:off 不报', () => {
      const dir = repo('opt');
      track(dir, 'src/a.py', 'x = 1\n');
      writeFileSync(resolve(dir, '.harness.json'), '{"optOut": true}');
      assert.deepEqual(foundationWarnings(dir), []);
      writeFileSync(resolve(dir, '.harness.json'), '{"checks": {"foundation": "off"}}');
      assert.deepEqual(foundationWarnings(dir), []);
    });
    check('坏 .harness.json 报读不了', () => {
      const dir = repo('broken');
      writeFileSync(resolve(dir, '.harness.json'), '{bad');
      assert.match(foundationWarnings(dir)[0], /读不了/);
    });
    check('接入但缺文件：报地基缺，列全', () => {
      const dir = repo('missing');
      writeFileSync(resolve(dir, '.harness.json'), '{}');
      assert.match(foundationWarnings(dir)[0], /地基缺：AGENTS\.md、DECISIONS\.md、docs\/tasks/);
    });
    const full = repo('full');
    writeFileSync(resolve(full, '.harness.json'), JSON.stringify({ budgets: { agentsLines: 5, decisionsKB: 1, activeCards: 2, cardKB: 1 } }));
    writeFileSync(resolve(full, 'AGENTS.md'), 'a\nb\n');
    writeFileSync(resolve(full, 'DECISIONS.md'), 'd\n');
    mkdirSync(resolve(full, 'docs/tasks'), { recursive: true });
    check('地基齐、未超预算：不报', () => assert.deepEqual(foundationWarnings(full), []));
    check('AGENTS 行数、DECISIONS 体积、进行中卡数超预算', () => {
      writeFileSync(resolve(full, 'AGENTS.md'), 'x\n'.repeat(10));
      writeFileSync(resolve(full, 'DECISIONS.md'), 'y'.repeat(3000));
      for (const name of ['2026-11-01-a.md', '2026-11-02-b.md', '2026-11-03-c.md']) writeFileSync(resolve(full, 'docs/tasks', name), card('active'));
      const line = foundationWarnings(full, new Date(2026, 10, 8)).join('\n');
      assert.match(line, /熵超预算：AGENTS\.md 11 行 \/ 5；DECISIONS 3KB \/ 1KB；进行中的卡 3 张 \/ 2/);
    });
    check('模板、README、done 卡不算进行中', () => {
      writeFileSync(resolve(full, 'docs/tasks/2026-11-03-c.md'), card('done'));
      writeFileSync(resolve(full, 'docs/tasks/_模板.md'), card('active'));
      writeFileSync(resolve(full, 'docs/tasks/README.md'), card('active'));
      assert.doesNotMatch(foundationWarnings(full, new Date(2026, 10, 8)).join('\n'), /进行中的卡/);
    });
    check('上月 done/dropped 提示归档，本月与 active 不提示', () => {
      writeFileSync(resolve(full, 'docs/tasks/2026-10-30-old.md'), card('dropped'));
      writeFileSync(resolve(full, 'docs/tasks/2026-10-31-live.md'), card('waiting'));
      const line = foundationWarnings(full, new Date(2026, 10, 8)).join('\n');
      assert.match(line, /有 1 张上月及更早的 done\/dropped 卡可归档/);
    });
    check('大卡与豁免计数', () => {
      writeFileSync(resolve(full, 'docs/tasks/2026-11-05-big.md'), card('active') + 'z'.repeat(2000));
      writeFileSync(resolve(full, 'docs/tasks/2026-11-06-ex.md'), card('done') + '\n校验豁免：演示\n');
      const line = foundationWarnings(full, new Date(2026, 10, 8)).join('\n');
      assert.match(line, /1 张卡超过 1KB/); assert.match(line, /交付校验豁免 1 张卡/);
    });
    const sys = repo('system');
    const commit = (msg) => { assert.equal(git(sys, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg]).status, 0); return git(sys, ['rev-parse', 'HEAD']).stdout.trim(); };
    track(sys, 'server/app.py', 'def stage(o):\n    return o.status == "voided"\n');
    track(sys, 'web/page.tsx', 'x\n');
    track(sys, 'docs/a.md', 'x\n');
    writeFileSync(resolve(sys, '.harness.json'), '{}');
    writeFileSync(resolve(sys, 'AGENTS.md'), 'a\n'); writeFileSync(resolve(sys, 'DECISIONS.md'), 'd\n');
    mkdirSync(resolve(sys, 'docs/tasks'), { recursive: true });
    const head = commit('init');
    const system = (mapRows, extra = '', invRows = []) => writeFileSync(resolve(sys, SYSTEM_FILE), ['## 不变量', '', '| ID | 业务含义 | 权威实现 | 指纹 | 消费者怎么查 | 联动测试 | 例外与到期 |', '|---|---|---|---|---|---|---|', ...invRows, '', '## 系统地图', '', extra, '', '| 模块 | 路径 | 职责 | 决定者 | 外部依赖 |', '|---|---|---|---|---|', ...mapRows, ''].join('\n'));
    check('没有 SYSTEM.md 不报地图', () => assert.doesNotMatch(foundationWarnings(sys).join('\n'), /地图/));
    check('纯文档仓接入了也不报地图', () => {
      const docs = repo('docs-linked');
      track(docs, 'notes.md', '# x\n');
      writeFileSync(resolve(docs, '.harness.json'), '{}');
      writeFileSync(resolve(docs, 'AGENTS.md'), 'a\n'); writeFileSync(resolve(docs, 'DECISIONS.md'), 'd\n');
      mkdirSync(resolve(docs, 'docs/tasks'), { recursive: true });
      writeFileSync(resolve(docs, SYSTEM_FILE), '## 系统地图\n');
      assert.deepEqual(foundationWarnings(docs), []);
    });
    check('地图空：提示起草', () => {
      system([], `最后核对：${head}`);
      assert.match(foundationWarnings(sys).join('\n'), /系统地图还没写/);
    });
    check('地图齐全且新：不报', () => {
      system(['| 服务 | `server/` | 业务 | — | — |', '| 前端 | web | 页面 | — | — |'], `最后核对：${head}`);
      assert.deepEqual(foundationWarnings(sys), []);
    });
    check('路径不存在、顶层目录没登记、没写最后核对', () => {
      system(['| 服务 | `server/`、`worker/` | 业务 | — | — |']);
      const line = foundationWarnings(sys).join('\n');
      assert.match(line, /地图里的路径不存在：worker/); assert.match(line, /地图没登记的顶层目录：web/); assert.match(line, /没写「最后核对/);
      assert.doesNotMatch(line, /没登记的顶层目录：.*docs/);
    });
    check('核对以来改动过多、提交号找不到', () => {
      for (let i = 0; i < 30; i++) track(sys, `server/m${i}.py`, `x = ${i}\n`);
      commit('many');
      system(['| 服务 | server | 业务 | — | — |', '| 前端 | web | 页面 | — | — |'], `最后核对：${head}`);
      assert.match(foundationWarnings(sys).join('\n'), /以来改了 30 个文件，可能过期/);
      system(['| 服务 | server | 业务 | — | — |', '| 前端 | web | 页面 | — | — |'], '最后核对：deadbeef');
      assert.match(foundationWarnings(sys).join('\n'), /deadbeef 找不到/);
    });
    check('不变量表有问题、没记基线都报', () => {
      const now = git(sys, ['rev-parse', 'HEAD']).stdout.trim();
      system(['| 服务 | server | 业务 | — | — |', '| 前端 | web | 页面 | — | — |'], `最后核对：${now}`, ['| INV-01 | 作废 | server/app.py#stage | `voided` | — | — | — |', '| INV-02 | 坏 | server/none.py#f | — | — | — | — |']);
      const line = foundationWarnings(sys).join('\n');
      assert.match(line, /不变量表：INV-02：权威实现 server\/none\.py 不存在/); assert.match(line, /1 条不变量还没记基线：INV-01/);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(`地基检查自测：${count} 项通过`);
}

const self = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (self && process.argv.includes('--self-test')) selfTest();
else if (self) console.log(foundationWarnings(process.cwd()).join('\n') || '地基正常');
