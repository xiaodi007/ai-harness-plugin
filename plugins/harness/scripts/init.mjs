#!/usr/bin/env node
// 接入器的落盘部分：把 templates/ 里缺的地基文件拷进仓库，已有的一律不覆盖，只报差异建议。
// 用法：node init.mjs [--root DIR] [--card-dir DIR] [--dry-run]；--self-test 自测。
// 起草 AGENTS.md、立项对话由 /harness:init 命令里的模型做，本脚本不碰内容。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { foundationWarnings } from './foundation.mjs';
import { checkCard } from './card-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const TEMPLATES = resolve(HERE, '../templates');
const CARD_DEFAULT = 'docs/tasks';

function list(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? list(path, base) : [relative(base, path)];
  }).sort();
}

const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' });
export function targetRoot(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', env: gitEnv() });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : resolve(cwd);
}

// 已有任务卡目录（keel 式）就沿用，不另起 docs/tasks。
export function existingCardDir(root) {
  for (const dir of ['docs/tasks', 'docs/协作/任务', 'tasks']) {
    try { if (statSync(resolve(root, dir)).isDirectory()) return dir; } catch { /* 下一个。 */ }
  }
  return null;
}

// 返回 { created, kept, advice }；dryRun 时不写。
export function init(root, { cardDir, dryRun = false } = {}) {
  const dir = cardDir || existingCardDir(root) || CARD_DEFAULT;
  const created = [];
  const kept = [];
  const advice = [];
  for (const template of list(TEMPLATES)) {
    const target = template.startsWith('docs/tasks/') ? join(dir, template.slice('docs/tasks/'.length)) : template;
    const path = resolve(root, target);
    if (existsSync(path)) { kept.push(target); continue; }
    let text = readFileSync(resolve(TEMPLATES, template), 'utf8');
    if (template === '.harness.json') text = text.replace(`"cardDir": "${CARD_DEFAULT}"`, `"cardDir": ${JSON.stringify(dir)}`);
    if (!dryRun) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
    created.push(target);
  }
  // 已有文件只给建议：内容由维护者决定。
  if (kept.includes('CLAUDE.md')) {
    const text = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8');
    if (!/^@AGENTS\.md\s*$/m.test(text)) advice.push('CLAUDE.md 已存在但没引用 AGENTS.md：建议顶部加一行 @AGENTS.md，项目指令只留一份');
  }
  if (kept.includes('AGENTS.md')) {
    const lines = readFileSync(resolve(root, 'AGENTS.md'), 'utf8').split('\n').length;
    if (lines > 200) advice.push(`AGENTS.md 已存在，${lines} 行，超过 200 行：把案例与长文移出常驻指令`);
  }
  if (!dryRun) advice.push(...foundationWarnings(root).filter((line) => !line.startsWith('本仓未接入')));
  return { root, cardDir: dir, created, kept, advice };
}

function report({ root, cardDir, created, kept, advice }, dryRun) {
  const lines = [`${dryRun ? '预演（未写入）' : '接入'}：${root}`, `任务卡目录：${cardDir}`];
  lines.push(created.length ? `${dryRun ? '将新建' : '新建'}：${created.join('、')}` : '没有要新建的文件');
  if (kept.length) lines.push(`已有，未改：${kept.join('、')}`);
  for (const item of advice) lines.push(`建议：${item}`);
  return lines.join('\n');
}

function selfTest() {
  const tmp = mkdtempSync(resolve(ROOT, '.harness-接入测试-'));
  let count = 0;
  const check = (name, test) => { test(); count++; console.log(`  ✓ ${name}`); };
  try {
    check('新仓：模板全部生成，cardDir 为 docs/tasks', () => {
      const root = resolve(tmp, 'new');
      mkdirSync(root);
      const out = init(root);
      for (const file of ['AGENTS.md', 'CLAUDE.md', 'PROJECT.md', 'DECISIONS.md', '.harness.json', 'docs/SYSTEM.md', 'docs/tasks/README.md', 'docs/tasks/_模板.md']) {
        assert.ok(out.created.includes(file), `${file} 未生成`); assert.ok(existsSync(resolve(root, file)));
      }
      assert.equal(JSON.parse(readFileSync(resolve(root, '.harness.json'), 'utf8')).cardDir, 'docs/tasks');
      assert.equal(readFileSync(resolve(root, 'CLAUDE.md'), 'utf8').trim(), '@AGENTS.md');
      assert.deepEqual(out.kept, []);
    });
    check('重复运行不覆盖、全部报已有', () => {
      const root = resolve(tmp, 'new');
      writeFileSync(resolve(root, 'AGENTS.md'), '我改过的\n');
      const out = init(root);
      assert.deepEqual(out.created, []); assert.ok(out.kept.includes('AGENTS.md'));
      assert.equal(readFileSync(resolve(root, 'AGENTS.md'), 'utf8'), '我改过的\n');
    });
    check('存量仓：沿用已有卡目录，已有 CLAUDE.md 不动只给建议，DECISIONS 超预算给建议', () => {
      const root = resolve(tmp, 'old');
      mkdirSync(resolve(root, 'docs/协作/任务'), { recursive: true });
      assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, env: gitEnv() }).status, 0);
      writeFileSync(resolve(root, 'CLAUDE.md'), '# 老指令\n');
      writeFileSync(resolve(root, 'DECISIONS.md'), 'x'.repeat(200 * 1024));
      const out = init(root);
      assert.equal(out.cardDir, 'docs/协作/任务');
      assert.ok(out.created.includes('docs/协作/任务/_模板.md')); assert.ok(!existsSync(resolve(root, 'docs/tasks')));
      assert.equal(JSON.parse(readFileSync(resolve(root, '.harness.json'), 'utf8')).cardDir, 'docs/协作/任务');
      assert.equal(readFileSync(resolve(root, 'CLAUDE.md'), 'utf8'), '# 老指令\n');
      assert.ok(out.advice.some((line) => /CLAUDE\.md 已存在但没引用/.test(line)), out.advice);
      assert.ok(out.advice.some((line) => /DECISIONS 200KB \/ 100KB/.test(line)), out.advice);
      assert.ok(!out.advice.some((line) => /未接入/.test(line)));
    });
    check('dry-run 不写盘', () => {
      const root = resolve(tmp, 'dry');
      mkdirSync(root);
      const out = init(root, { dryRun: true });
      assert.ok(out.created.length > 5); assert.deepEqual(readdirSync(root), []);
      assert.match(report(out, true), /^预演（未写入）/);
    });
    check('--card-dir 覆盖', () => {
      const root = resolve(tmp, 'custom');
      mkdirSync(root);
      const out = init(root, { cardDir: 'work/cards' });
      assert.ok(existsSync(resolve(root, 'work/cards/_模板.md')));
      assert.equal(out.cardDir, 'work/cards');
    });
    check('生成的模板卡不能直接通过交付校验（防止空卡改 done 就过）', () => {
      assert.ok(checkCard(readFileSync(resolve(tmp, 'new/docs/tasks/_模板.md'), 'utf8')).length >= 5);
    });
    check('生成的 AGENTS.md 不超过 200 行', () => {
      assert.ok(readFileSync(resolve(TEMPLATES, 'AGENTS.md'), 'utf8').split('\n').length <= 200);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(`接入器自测：${count} 项通过`);
}

const self = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (self && process.argv.includes('--self-test')) selfTest();
else if (self) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const dryRun = process.argv.includes('--dry-run');
  const root = targetRoot(arg('--root') ?? process.cwd());
  console.log(report(init(root, { cardDir: arg('--card-dir'), dryRun }), dryRun));
}
