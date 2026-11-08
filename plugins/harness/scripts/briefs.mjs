#!/usr/bin/env node
// 变更简报汇总：把一段时间内 done 卡的「简报」五行汇成一页，维护者读这一页而不读 diff。
// 「上次看过」记在 .harness/brief-seen（本机）；SessionStart 用 pendingBriefs 报「上次以来 N 张卡完成」。
// 用法：node briefs.mjs [--since YYYY-MM-DD] [--mark]；--self-test。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { sections, cardStatus } from './card-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const BRIEF_FIELDS = ['行为变化', '决定者', '保住', '证据', '风险'];
const SEEN_FILE = '.harness/brief-seen';
const DEFAULT_DAYS = 7;
const DAY = 24 * 3600 * 1000;

const FIELD_LINE = /^\s*[-*]\s*(?:\*\*)?([^：:*]+?)(?:\*\*)?\s*[:：]\s*(.*)$/;
export function brief(text) {
  const map = sections(text);
  const key = [...map.keys()].find((name) => name.includes('简报'));
  if (key === undefined) return null;
  const out = {};
  for (const line of map.get(key)) {
    const m = line.match(FIELD_LINE);
    if (m && BRIEF_FIELDS.includes(m[1].trim())) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function config(root) { try { return JSON.parse(readFileSync(resolve(root, '.harness.json'), 'utf8')); } catch { return {}; } }

// 卡目录顶层和 archive 下的 done 卡，按修改时间过滤。
function doneCards(root, since) {
  const dir = config(root).cardDir || 'docs/tasks';
  const out = [];
  const walk = (rel) => {
    let names;
    try { names = readdirSync(resolve(root, rel)); } catch { return; }
    for (const name of names) {
      const path = join(rel, name);
      let stat;
      try { stat = statSync(resolve(root, path)); } catch { continue; }
      if (stat.isDirectory()) { if (rel === dir ? name === 'archive' : true) walk(path); continue; }
      if (!name.endsWith('.md') || name === 'README.md' || name.startsWith('_') || stat.mtimeMs < since) continue;
      const text = readFileSync(resolve(root, path), 'utf8');
      if (cardStatus(text) === 'done') out.push({ path, at: stat.mtimeMs, text });
    }
  };
  walk(dir);
  return out.sort((a, b) => b.at - a.at);
}

export function seenAt(root, now = Date.now()) {
  try { return Number(readFileSync(resolve(root, SEEN_FILE), 'utf8').trim()) || now - DEFAULT_DAYS * DAY; } catch { return now - DEFAULT_DAYS * DAY; }
}
export function markSeen(root, now = Date.now()) {
  mkdirSync(resolve(root, '.harness'), { recursive: true });
  const ignore = resolve(root, '.harness/.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n!invariants-baseline.json\n');
  writeFileSync(resolve(root, SEEN_FILE), String(now));
}

export function pendingBriefs(root, now = Date.now()) {
  if (!existsSync(resolve(root, '.harness.json'))) return 0;
  return doneCards(root, seenAt(root, now)).length;
}

export function render(root, since) {
  const cards = doneCards(root, since);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const lines = [`# 变更简报（${day(since)} 以来，${cards.length} 张卡完成）`, ''];
  if (!cards.length) lines.push('这段时间没有完成的卡。');
  for (const card of cards) {
    const title = card.text.match(/^#\s+(.+)$/m)?.[1] ?? basename(card.path, '.md');
    const b = brief(card.text);
    lines.push(`## ${title}`, `（${card.path}，${day(card.at)}）`);
    if (!b || !Object.keys(b).length) lines.push('- ⚠ 这张卡没写简报');
    else for (const field of BRIEF_FIELDS) lines.push(`- ${field}：${b[field] || '⚠ 没写'}`);
    lines.push('');
  }
  return lines.join('\n');
}

function selfTest() {
  const tmp = mkdtempSync(resolve(ROOT, '.harness-简报测试-'));
  let count = 0;
  const check = (name, test) => { test(); count++; console.log(`  ✓ ${name}`); };
  const card = (title, status, briefText) => `# ${title}\n\n- 状态：${status}\n\n## 简报\n\n${briefText}\n\n## 交接\n- 别重做：x\n`;
  const full = '- 行为变化：导出按钮能用了\n- 决定者：INV-02\n- 保住：列表筛选不变\n- 证据：回执 R-1108-1530-a3f\n- 风险：无';
  try {
    check('读简报五行；没有简报节返回 null', () => {
      assert.deepEqual(brief(card('a', 'done', full)), { 行为变化: '导出按钮能用了', 决定者: 'INV-02', 保住: '列表筛选不变', 证据: '回执 R-1108-1530-a3f', 风险: '无' });
      assert.equal(brief('# x\n- 状态：done\n'), null);
    });
    const repo = resolve(tmp, 'repo');
    const dir = resolve(repo, 'docs/tasks');
    mkdirSync(resolve(dir, 'archive/2026-10'), { recursive: true });
    const now = Date.now();
    const put = (path, text, at) => { writeFileSync(resolve(repo, path), text); const t = new Date(at); utimesSync(resolve(repo, path), t, t); };
    put('docs/tasks/2026-11-08-导出.md', card('导出', 'done', full), now - 3600000);
    put('docs/tasks/2026-11-08-没简报.md', '# 没简报\n\n- 状态：done\n', now - 1800000);
    put('docs/tasks/2026-11-08-在做.md', card('在做', 'active', full), now - 3600000);
    put('docs/tasks/2026-10-01-很早.md', card('很早', 'done', full), now - 30 * DAY);
    put('docs/tasks/archive/2026-10/2026-11-07-归档.md', card('归档', 'done', full.replace('- 风险：无', '')), now - DAY);
    put('docs/tasks/_模板.md', card('模板', 'done', full), now);
    check('未接入（无 .harness.json）不报', () => assert.equal(pendingBriefs(repo, now), 0));
    writeFileSync(resolve(repo, '.harness.json'), '{}');
    check('没看过：默认近 7 天的 done 卡，含 archive，不含 active、模板、更早的', () => {
      assert.equal(pendingBriefs(repo, now), 3);
    });
    check('汇总页：新的在前，缺的字段和没写简报都标出来', () => {
      const page = render(repo, now - 7 * DAY);
      assert.match(page, /^# 变更简报（\d{4}-\d{2}-\d{2} 以来，3 张卡完成）/);
      assert.ok(page.indexOf('## 没简报') < page.indexOf('## 导出'), '新的在前');
      assert.match(page, /## 没简报\n.*\n- ⚠ 这张卡没写简报/);
      assert.match(page, /## 归档[\s\S]*- 风险：⚠ 没写/);
      assert.doesNotMatch(page, /在做|很早|模板/);
    });
    check('标记看过后清零，之后新完成的才算', () => {
      markSeen(repo, now);
      assert.equal(pendingBriefs(repo, now), 0);
      put('docs/tasks/2026-11-08-新.md', card('新', 'done', full), now + 1000);
      assert.equal(pendingBriefs(repo, now + 2000), 1);
      assert.match(readFileSync(resolve(repo, '.harness/.gitignore'), 'utf8'), /^\*$/m);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(`简报自测：${count} 项通过`);
}

const self = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (self && process.argv.includes('--self-test')) selfTest();
else if (self) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const root = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();
  const i = process.argv.indexOf('--since');
  const since = i > 0 ? Date.parse(process.argv[i + 1]) : seenAt(root);
  console.log(render(root, Number.isNaN(since) ? seenAt(root) : since));
  if (process.argv.includes('--mark')) markSeen(root);
}
