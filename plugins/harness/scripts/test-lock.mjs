#!/usr/bin/env node
// 测试文件锁（PreToolUse，匹配 Edit / Write / MultiEdit）：实现会话不改断言。
// 只对 .harness.json 里配了 checks.testLock（block / warn）的仓生效；被锁路径是 testLock.paths 的 glob，
// 默认是冻结用例目录和它的锁文件（P1-1 §3）。最近改过的任务卡里写了「改测试：理由」就放行，放行和 warn 命中记进
// .harness/test-lock.jsonl，地基检查报近 7 天的次数。
// 依据：测试和规格冲突时，GPT-5 在仓库级任务上 76% 会改测试或绕过测试（arXiv 2510.20270）。
// 用法：--hook（读 stdin JSON）；--self-test。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { harnessRoot, sections, cardStatus } from './card-check.mjs';
import { harnessDir, sessionId } from './receipt.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_LOCK = ['docs/scenarios/**', '.harness/scenarios.lock.json'];
export const LOG_FILE = '.harness/test-lock.jsonl';
const WAIVER_LINE = /^\s*(?:[-*]\s*)?改测试\s*[:：]\s*(\S.*)$/;
const PLACEHOLDER = /^<[^>]*>$|^(?:…|\.\.\.)$/;
const WAIVER_HOURS = 6;
const STATS_DAYS = 7;
const TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// glob → 正则：** 跨目录（含零层），* 和 ? 不跨 /；其余字符照字面。
export function globRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}
export const matchesAny = (path, globs) => globs.some((glob) => globRegex(glob).test(path));

function readConfig(root) {
  try { return JSON.parse(readFileSync(resolve(root, '.harness.json'), 'utf8')); } catch { return null; }
}

// 文件可能还不存在（Write 新建），往上找到第一个存在的目录再找仓根。
function existingDir(path) {
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

// 卡目录顶层、近几小时改过的卡里第一条写了理由的「改测试：」；没有返回 null。
export function findWaiver(root, cardDir, now = Date.now()) {
  const base = resolve(root, cardDir);
  let names;
  try { names = readdirSync(base).sort(); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'README.md' || name.startsWith('_')) continue;
    const path = resolve(base, name);
    try {
      if (now - statSync(path).mtimeMs > WAIVER_HOURS * 3600000) continue;
      const text = readFileSync(path, 'utf8');
      if (cardStatus(text) === 'dropped') continue;
      for (const lines of sections(text).values()) {
        for (const line of lines) {
          const reason = line.match(WAIVER_LINE)?.[1]?.trim();
          if (reason && !PLACEHOLDER.test(reason)) return { card: relative(root, path), reason };
        }
      }
    } catch { /* 读不了的卡不算。 */ }
  }
  return null;
}

function log(root, entry) {
  try {
    harnessDir(root, '.');
    appendFileSync(resolve(root, LOG_FILE), JSON.stringify(entry) + '\n');
  } catch { /* 记不下不影响判定。 */ }
}

// 钩子判定：返回要输出的 JSON 对象，或 null（不管）。
export function lockDecision(input, now = Date.now()) {
  if (!TOOLS.has(input.tool_name)) return null;
  const raw = input.tool_input?.file_path;
  if (typeof raw !== 'string' || !raw) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const file = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const root = harnessRoot(existingDir(file));
  const config = root && readConfig(root);
  if (!config || config.optOut) return null;
  const mode = config.checks?.testLock;
  if (mode !== 'block' && mode !== 'warn') return null;
  const rel = relative(root, file).split(sep).join('/');
  if (rel.startsWith('../')) return null;
  const globs = Array.isArray(config.testLock?.paths) && config.testLock.paths.length ? config.testLock.paths : DEFAULT_LOCK;
  if (!matchesAny(rel, globs)) return null;
  const entry = { at: new Date(now).toISOString(), file: rel, tool: input.tool_name, session: input.session_id ?? sessionId(), mode };
  const waiver = findWaiver(root, config.cardDir || 'docs/tasks', now);
  if (waiver) {
    log(root, { ...entry, action: 'waived', card: waiver.card, reason: waiver.reason });
    return { systemMessage: `harness 测试锁：${rel} 是锁定的测试，按 ${waiver.card} 的「改测试：${waiver.reason.slice(0, 40)}」放行（计入地基检查）` };
  }
  const why = `${rel} 是锁定的测试（.harness.json testLock）。实现会话不改断言；要改测试请另开卡，或在当前任务卡里写一行「改测试：理由」（放行次数计入地基检查）。`;
  if (mode === 'warn') {
    log(root, { ...entry, action: 'warned' });
    return { systemMessage: `harness 测试锁（只提示）：${why}`, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `harness 测试锁提示：${why}` } };
  }
  log(root, { ...entry, action: 'blocked' });
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `harness 测试锁：${why}` } };
}

// 地基检查用：近 7 天按「改测试」放行几次、warn 模式下命中几次（没拦）。
export function lockStats(root, now = Date.now()) {
  let text;
  try { text = readFileSync(resolve(root, LOG_FILE), 'utf8'); } catch { return { waived: 0, warned: 0, blocked: 0 }; }
  const since = now - STATS_DAYS * 24 * 3600000;
  const out = { waived: 0, warned: 0, blocked: 0 };
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (Date.parse(entry.at) >= since && entry.action in out) out[entry.action]++;
    } catch { /* 坏行跳过。 */ }
  }
  return out;
}

function selfTest() {
  const tmp = mkdtempSync(resolve(ROOT, '.harness-测试锁测试-'));
  let count = 0;
  const check = (name, test) => { test(); count++; console.log(`  ✓ ${name}`); };
  try {
    check('glob：** 跨目录含零层，* 不跨 /，点号照字面', () => {
      assert.ok(matchesAny('docs/scenarios/a.yaml', ['docs/scenarios/**']));
      assert.ok(matchesAny('docs/scenarios/x/y/a.yaml', ['docs/scenarios/**']));
      assert.ok(matchesAny('tests/a_test.py', ['**/*_test.py']));
      assert.ok(matchesAny('a_test.py', ['**/*_test.py']));
      assert.ok(!matchesAny('tests/sub/a.py', ['tests/*.py']));
      assert.ok(!matchesAny('.harness/scenariosXlock.json', ['.harness/scenarios.lock.json']));
      assert.ok(!matchesAny('docs/scenarios-old/a.yaml', ['docs/scenarios/**']));
      assert.ok(!matchesAny('old/docs/scenarios/a.yaml', ['docs/scenarios/**']), '从仓根锚定');
    });
    const repo = resolve(tmp, 'repo');
    const cards = resolve(repo, 'docs/tasks');
    mkdirSync(resolve(repo, 'docs/scenarios'), { recursive: true });
    mkdirSync(cards, { recursive: true });
    const edit = (path, extra = {}) => ({ tool_name: 'Edit', tool_input: { file_path: resolve(repo, path) }, cwd: repo, session_id: 's1', ...extra });
    check('未接入、没配 testLock、off 都不管', () => {
      assert.equal(lockDecision(edit('docs/scenarios/a.yaml')), null);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: {} }));
      assert.equal(lockDecision(edit('docs/scenarios/a.yaml')), null);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { testLock: 'off' } }));
      assert.equal(lockDecision(edit('docs/scenarios/a.yaml')), null);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ optOut: true, checks: { testLock: 'block' } }));
      assert.equal(lockDecision(edit('docs/scenarios/a.yaml')), null);
    });
    writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { testLock: 'block' } }));
    check('block：默认锁冻结用例目录和锁文件，拒绝并说明怎么办；别的路径、别的工具不管', () => {
      for (const path of ['docs/scenarios/a.yaml', 'docs/scenarios/deep/b.json', '.harness/scenarios.lock.json']) {
        const out = lockDecision(edit(path));
        assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', path);
        assert.match(out.hookSpecificOutput.permissionDecisionReason, /实现会话不改断言.*另开卡.*「改测试：理由」/);
      }
      assert.equal(lockDecision(edit('src/a.py')), null);
      assert.equal(lockDecision(edit('docs/scenarios/a.yaml', { tool_name: 'Read' })), null);
      assert.equal(lockDecision({ ...edit('x'), tool_input: {} }), null);
      assert.equal(lockDecision(edit('../outside/docs/scenarios/a.yaml')), null);
    });
    check('Write 新建、MultiEdit、相对路径也拦', () => {
      assert.equal(lockDecision(edit('docs/scenarios/new/c.yaml', { tool_name: 'Write' })).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(lockDecision(edit('docs/scenarios/a.yaml', { tool_name: 'MultiEdit' })).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(lockDecision({ ...edit('x'), tool_input: { file_path: 'docs/scenarios/a.yaml' } }).hookSpecificOutput.permissionDecision, 'deny');
    });
    check('自定义 paths 替换默认', () => {
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { testLock: 'block' }, testLock: { paths: ['tests/**/*_test.py'] } }));
      assert.equal(lockDecision(edit('docs/scenarios/a.yaml')), null);
      assert.equal(lockDecision(edit('tests/unit/a_test.py')).hookSpecificOutput.permissionDecision, 'deny');
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { testLock: 'block' } }));
    });
    check('warn：只提示不拦，模型和维护者都看得到', () => {
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { testLock: 'warn' } }));
      const out = lockDecision(edit('docs/scenarios/a.yaml'));
      assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
      assert.match(out.hookSpecificOutput.additionalContext, /实现会话不改断言/);
      assert.match(out.systemMessage, /只提示/);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ checks: { testLock: 'block' } }));
    });
    const now = Date.now();
    check('卡里写了「改测试：理由」就放行；占位、注释、旧卡、模板、dropped 不算', () => {
      const card = (extra) => `# 卡\n\n- 状态：active\n\n## 契约\n- 改什么：x\n${extra}\n`;
      writeFileSync(resolve(cards, '_模板.md'), card('- 改测试：模板里的不算'));
      writeFileSync(resolve(cards, '2026-11-13-a.md'), card('- 改测试：<理由>\n<!-- 改测试：注释里的不算 -->'));
      writeFileSync(resolve(cards, '2026-11-13-d.md'), card('- 改测试：丢弃的卡不算').replace('active', 'dropped'));
      const old = resolve(cards, '2026-11-01-old.md');
      writeFileSync(old, card('- 改测试：旧卡不算'));
      const past = new Date(now - (WAIVER_HOURS + 1) * 3600000);
      utimesSync(old, past, past);
      assert.equal(lockDecision(edit('docs/scenarios/a.yaml'), now).hookSpecificOutput.permissionDecision, 'deny');
      writeFileSync(resolve(cards, '2026-11-13-b.md'), card('- 改测试：规格 A-03 改了，期望跟着改，维护者 11-13 定'));
      const out = lockDecision(edit('docs/scenarios/a.yaml'), now);
      assert.equal(out.hookSpecificOutput, undefined);
      assert.match(out.systemMessage, /按 docs\/tasks\/2026-11-13-b\.md 的「改测试：规格 A-03/);
    });
    check('放行、warn、拦都记日志；统计只数近 7 天', () => {
      const stats = lockStats(repo, now);
      assert.equal(stats.waived, 1); assert.ok(stats.blocked >= 5); assert.equal(stats.warned, 1);
      appendFileSync(resolve(repo, LOG_FILE), JSON.stringify({ at: new Date(now - 8 * 24 * 3600000).toISOString(), action: 'waived' }) + '\n{bad\n');
      assert.equal(lockStats(repo, now).waived, 1);
      assert.match(readFileSync(resolve(repo, '.harness/.gitignore'), 'utf8'), /^\*$/m);
      assert.deepEqual(lockStats(resolve(tmp, 'none'), now), { waived: 0, warned: 0, blocked: 0 });
    });
    check('hook 入口：拦的时候输出 deny JSON；坏输入不抛错、零退出', () => {
      for (const name of readdirSync(cards)) rmSync(resolve(cards, name));
      const script = fileURLToPath(import.meta.url);
      const denied = spawnSync(process.execPath, [script, '--hook'], { input: JSON.stringify(edit('docs/scenarios/a.yaml')), encoding: 'utf8' });
      assert.equal(denied.status, 0); assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
      const bad = spawnSync(process.execPath, [script, '--hook'], { input: '{bad', encoding: 'utf8' });
      assert.equal(bad.status, 0); assert.match(bad.stdout, /读取失败/);
      const quiet = spawnSync(process.execPath, [script, '--hook'], { input: JSON.stringify(edit('src/a.py')), encoding: 'utf8' });
      assert.equal(quiet.status, 0); assert.equal(quiet.stdout, '');
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(`测试锁自测：${count} 项通过`);
}

const self = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (self && process.argv.includes('--self-test')) selfTest();
else if (self && process.argv.includes('--hook')) {
  // 生产钩子始终零退出：读不了就提示一句，不拦工具。
  try {
    const raw = readFileSync(0, 'utf8');
    const decision = lockDecision(raw.trim() ? JSON.parse(raw) : {});
    if (decision) process.stdout.write(JSON.stringify(decision) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ systemMessage: `harness 测试锁读取失败：${String(error.message ?? error).slice(0, 140)}` }) + '\n'); }
}
