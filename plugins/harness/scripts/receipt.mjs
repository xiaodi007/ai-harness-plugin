#!/usr/bin/env node
// 可信执行回执：由本脚本自己起子进程、拿真实退出码、解析通过/失败/跳过数，写进 .harness/receipts/ 并打印一行可贴进任务卡的摘要。
// 用法：node receipt.mjs [--expect-fail] -- <命令…>；退出码透传（--expect-fail 时反转）。verifyReceipt 供 card-check 核对引用。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const RECEIPT_DIR = '.harness/receipts';
export const RECEIPT_ID = /\bR-\d{4}-\d{4}-[0-9a-f]{3}\b/g;
const KEEP = 8 * 1024 * 1024;
const TAIL = 4096;

const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' });
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
const strip = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// 常见测试框架的摘要行；认不出返回 null（回执里标「未解析」，不猜）。
export function parseCounts(raw) {
  const text = strip(raw);
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : 0; };
  let m;
  // vitest：Tests  1 failed | 11 passed | 2 skipped (14)
  const vitest = [...text.matchAll(/^\s*Tests\s+((?:\d+ \w+(?: \| )?)+)\s*\(\d+\)/gm)].at(-1);
  if (vitest) {
    const part = (word) => Number(vitest[1].match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
    return { passed: part('passed'), failed: part('failed'), skipped: part('skipped') + part('todo'), parser: 'vitest' };
  }
  // jest：Tests:       1 failed, 2 skipped, 10 passed, 13 total
  if ((m = [...text.matchAll(/^Tests:\s+(.+total)\s*$/gm)].at(-1))) {
    const part = (word) => Number(m[1].match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
    return { passed: part('passed'), failed: part('failed'), skipped: part('skipped') + part('todo'), parser: 'jest' };
  }
  // pytest：=== 10 passed, 2 skipped, 1 failed in 0.52s ===（也有只剩「no tests ran」）
  if ((m = [...text.matchAll(/^=+ (.*?(?:passed|failed|skipped|error|errors|no tests ran).*?) in [\d.]+s.*=+\s*$/gm)].at(-1))) {
    const part = (word) => Number(m[1].match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
    return { passed: part('passed'), failed: part('failed') + part('errors?'), skipped: part('skipped') + part('xfailed') + part('deselected'), parser: 'pytest' };
  }
  // cargo test：每个测试二进制一行 test result，求和。
  const cargo = [...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
  if (cargo.length) return cargo.reduce((sum, r) => ({ ...sum, passed: sum.passed + Number(r[1]), failed: sum.failed + Number(r[2]), skipped: sum.skipped + Number(r[3]) }), { passed: 0, failed: 0, skipped: 0, parser: 'cargo' });
  // unittest：Ran 5 tests in 0.01s / OK (skipped=1) 或 FAILED (failures=1, errors=1, skipped=1)
  if ((m = [...text.matchAll(/^Ran (\d+) tests? in [\d.]+s\s*\n+\s*(OK|FAILED)(?: \(([^)]*)\))?/gm)].at(-1))) {
    const part = (word) => Number(m[3]?.match(new RegExp(`${word}=(\\d+)`))?.[1] ?? 0);
    const skipped = part('skipped') + part('expected failures');
    const failed = part('failures') + part('errors') + part('unexpected successes');
    return { passed: Number(m[1]) - skipped - failed, failed, skipped, parser: 'unittest' };
  }
  // node:test（TAP 摘要）
  if (/^# (?:pass|tests) \d+/m.test(text)) return { passed: num(/^# pass (\d+)/m), failed: num(/^# fail (\d+)/m), skipped: num(/^# skipped (\d+)/m) + num(/^# todo (\d+)/m), parser: 'node-test' };
  // go test -v：逐条 --- PASS/FAIL/SKIP
  const go = { passed: (text.match(/^\s*--- PASS:/gm) ?? []).length, failed: (text.match(/^\s*--- FAIL:/gm) ?? []).length, skipped: (text.match(/^\s*--- SKIP:/gm) ?? []).length };
  if (go.passed + go.failed + go.skipped) return { ...go, parser: 'go' };
  return null;
}

export function anomalies(exit, counts, output) {
  const out = [];
  if (counts) {
    const total = counts.passed + counts.failed + counts.skipped;
    if (total === 0) out.push('跑了 0 个用例');
    else if (counts.skipped * 2 > total) out.push(`跳过过半（${counts.skipped}/${total}）`);
    if (exit === 0 && counts.failed > 0) out.push(`退出码 0 但有 ${counts.failed} 个失败`);
    if (counts.passed === 0 && counts.failed === 0 && total > 0) out.push('全部跳过');
  }
  if (exit === 0 && !counts?.failed && /^\s*(?:FAIL|FAILED)\b/m.test(strip(output))) out.push('退出码 0 但输出里有 FAIL 行');
  return out;
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

export function summaryLine(receipt) {
  const c = receipt.counts;
  const counts = c ? `${c.passed} 通过 ${c.skipped} 跳过 ${c.failed} 失败` : '用例数未解析';
  const head = receipt.head ? `HEAD ${receipt.head.slice(0, 7)}${receipt.dirty ? '+改动' : ''}` : '无 git';
  const flag = receipt.anomalies.length ? ` · ⚠ ${receipt.anomalies.join('；')}` : '';
  const calib = receipt.expectFail ? (receipt.exit !== 0 ? ' · 校准通过：门禁确实会红' : ' · ✗ 校准失败：预期失败却退出 0') : '';
  return `回执 ${receipt.id}: exit ${receipt.exit} · ${counts} · ${head} · ${Math.round(receipt.durationMs / 1000)}s${flag}${calib}`;
}

function repoRoot(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : cwd;
}

export function writeReceipt(root, receipt) {
  const dir = resolve(root, RECEIPT_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = resolve(root, '.harness/.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n!invariants-baseline.json\n');
  writeFileSync(resolve(dir, `${receipt.id}.json`), JSON.stringify(receipt, null, 2) + '\n');
}

// 跑命令：输出原样转给终端，同时留尾部和用于解析的正文。
export function run(argv, { cwd = process.cwd(), expectFail = false, quiet = false } = {}) {
  return new Promise((done) => {
    const root = repoRoot(cwd);
    const started = new Date();
    let body = '';
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['inherit', 'pipe', 'pipe'] });
    const take = (stream, sink) => stream.on('data', (chunk) => {
      if (!quiet) sink.write(chunk);
      body += chunk.toString();
      if (body.length > KEEP) body = body.slice(-KEEP);
    });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);
    const finish = (exit, signal, error) => {
      const ended = new Date();
      const head = git(root, ['rev-parse', 'HEAD']);
      const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
      const counts = error ? null : parseCounts(body);
      const receipt = {
        id: `R-${stamp(started)}-${randomBytes(2).toString('hex').slice(0, 3)}`,
        cmd: argv, cwd, root,
        head: head.status === 0 ? head.stdout.trim() : null,
        dirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
        startedAt: started.toISOString(), endedAt: ended.toISOString(), durationMs: ended - started,
        exit, signal: signal ?? null, error: error ? String(error.message ?? error) : null,
        counts, anomalies: error ? [`命令没能启动：${error.code ?? error.message}`] : anomalies(exit, counts, body), expectFail,
        runtime: { node: process.version, platform: process.platform },
        tail: strip(body).slice(-TAIL),
      };
      writeReceipt(root, receipt);
      done(receipt);
    };
    let settled = false;
    child.on('error', (error) => { if (!settled) { settled = true; finish(127, null, error); } });
    child.on('close', (code, signal) => { if (!settled) { settled = true; finish(code ?? 128, signal); } });
  });
}

// 核对任务卡引用的回执：存在、退出 0、不是校准回执、跑了用例、没有异常、HEAD 是当前 HEAD 或其祖先。
export function verifyReceipt(root, id) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(resolve(root, RECEIPT_DIR, `${id}.json`), 'utf8')); } catch { return [`${id}：找不到回执（${RECEIPT_DIR}/${id}.json）`]; }
  const problems = [];
  if (receipt.expectFail) problems.push(`${id}：这是校准回执（--expect-fail），不能当通过的证据`);
  else if (receipt.exit !== 0) problems.push(`${id}：退出码 ${receipt.exit}，不是通过`);
  if (receipt.anomalies?.length) problems.push(`${id}：回执有异常：${receipt.anomalies.join('；')}`);
  if (receipt.head) {
    const now = git(root, ['rev-parse', 'HEAD']);
    if (now.status === 0 && now.stdout.trim() !== receipt.head && git(root, ['merge-base', '--is-ancestor', receipt.head, 'HEAD']).status !== 0) {
      problems.push(`${id}：回执跑在 ${receipt.head.slice(0, 7)}，不是当前 HEAD 的祖先（换了分支或历史被改写）`);
    }
  }
  return problems;
}

async function selfTest() {
  const tmp = mkdtempSync(resolve(ROOT, '.harness-回执测试-'));
  let count = 0;
  const check = async (name, test) => { await test(); count++; console.log(`  ✓ ${name}`); };
  try {
    await check('解析 vitest / jest / pytest / cargo / node:test / go，认不出返回 null', () => {
      assert.deepEqual(parseCounts(' Test Files  2 passed (2)\n      Tests  1 failed | 11 passed | 2 skipped (14)\n'), { passed: 11, failed: 1, skipped: 2, parser: 'vitest' });
      assert.deepEqual(parseCounts('Tests:       1 failed, 2 skipped, 10 passed, 13 total\n'), { passed: 10, failed: 1, skipped: 2, parser: 'jest' });
      assert.deepEqual(parseCounts('===== 10 passed, 2 skipped, 1 failed in 0.52s =====\n'), { passed: 10, failed: 1, skipped: 2, parser: 'pytest' });
      assert.deepEqual(parseCounts('======= no tests ran in 0.01s =======\n'), { passed: 0, failed: 0, skipped: 0, parser: 'pytest' });
      assert.deepEqual(parseCounts('test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured\ntest result: ok. 2 passed; 1 failed; 0 ignored;\n'), { passed: 5, failed: 1, skipped: 1, parser: 'cargo' });
      assert.deepEqual(parseCounts('# tests 4\n# pass 3\n# fail 0\n# skipped 1\n'), { passed: 3, failed: 0, skipped: 1, parser: 'node-test' });
      assert.deepEqual(parseCounts('--- PASS: TestA\n--- SKIP: TestB\n'), { passed: 1, failed: 0, skipped: 1, parser: 'go' });
      assert.deepEqual(parseCounts('...s\n----\nRan 4 tests in 0.002s\n\nOK (skipped=1)\n'), { passed: 3, failed: 0, skipped: 1, parser: 'unittest' });
      assert.deepEqual(parseCounts('Ran 5 tests in 0.1s\n\nFAILED (failures=1, errors=1)\n'), { passed: 3, failed: 2, skipped: 0, parser: 'unittest' });
      assert.deepEqual(parseCounts('Ran 0 tests in 0.000s\n\nOK\n'), { passed: 0, failed: 0, skipped: 0, parser: 'unittest' });
      assert.equal(parseCounts('build ok\n'), null);
      assert.deepEqual(parseCounts('\x1b[32m      Tests  3 passed (3)\x1b[0m\n'), { passed: 3, failed: 0, skipped: 0, parser: 'vitest' });
    });
    await check('异常：0 用例、跳过过半、全部跳过、退出 0 却有失败、退出 0 却有 FAIL 行', () => {
      assert.deepEqual(anomalies(0, { passed: 0, failed: 0, skipped: 0 }, ''), ['跑了 0 个用例']);
      assert.deepEqual(anomalies(0, { passed: 1, failed: 0, skipped: 3 }, ''), ['跳过过半（3/4）']);
      assert.deepEqual(anomalies(0, { passed: 0, failed: 0, skipped: 2 }, ''), ['跳过过半（2/2）', '全部跳过']);
      assert.deepEqual(anomalies(0, { passed: 5, failed: 1, skipped: 0 }, ''), ['退出码 0 但有 1 个失败']);
      assert.deepEqual(anomalies(0, null, 'x\nFAIL src/a.test.ts\n'), ['退出码 0 但输出里有 FAIL 行']);
      assert.deepEqual(anomalies(1, { passed: 5, failed: 1, skipped: 0 }, 'FAIL x'), []);
      assert.deepEqual(anomalies(0, { passed: 5, failed: 0, skipped: 1 }, '0 failed'), []);
    });
    // 独立小仓，回执写在它自己的 .harness 里，不落到本工作树。
    const repo = resolve(tmp, 'repo');
    mkdirSync(repo);
    const env = { ...gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const args of [['init', '-q'], ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
      assert.equal(spawnSync('git', args, { cwd: repo, env }).status, 0);
    }
    const sh = (script) => ['sh', '-c', script];
    let pass;
    await check('跑命令：真实退出码、解析用例数、写回执、摘要行', async () => {
      pass = await run(sh('echo "# tests 2"; echo "# pass 2"; exit 0'), { cwd: repo, quiet: true });
      assert.equal(pass.exit, 0); assert.deepEqual(pass.counts, { passed: 2, failed: 0, skipped: 0, parser: 'node-test' });
      assert.match(pass.id, /^R-\d{4}-\d{4}-[0-9a-f]{3}$/);
      const root = pass.root;
      assert.equal(root, repo);
      assert.ok(existsSync(resolve(root, RECEIPT_DIR, `${pass.id}.json`)));
      assert.match(summaryLine(pass), /^回执 R-\S+: exit 0 · 2 通过 0 跳过 0 失败 · HEAD [0-9a-f]{7}/);
      assert.deepEqual(verifyReceipt(root, pass.id), []);
    });
    await check('失败命令：退出码透传，核对报不是通过', async () => {
      const fail = await run(sh('exit 3'), { cwd: repo, quiet: true });
      assert.equal(fail.exit, 3); assert.match(verifyReceipt(fail.root, fail.id).join(), /退出码 3，不是通过/);
      rmSync(resolve(fail.root, RECEIPT_DIR, `${fail.id}.json`));
    });
    await check('校准回执：预期失败、摘要说校准通过；不能当通过证据', async () => {
      const calib = await run(sh('exit 1'), { cwd: repo, quiet: true, expectFail: true });
      assert.match(summaryLine(calib), /校准通过/);
      assert.match(verifyReceipt(calib.root, calib.id).join(), /校准回执/);
      const bad = await run(sh('exit 0'), { cwd: repo, quiet: true, expectFail: true });
      assert.match(summaryLine(bad), /校准失败/);
      for (const r of [calib, bad]) rmSync(resolve(r.root, RECEIPT_DIR, `${r.id}.json`));
    });
    await check('有异常的回执不能当证据；找不到的回执报找不到', async () => {
      const empty = await run(sh('echo "# tests 0"; echo "# pass 0"'), { cwd: repo, quiet: true });
      assert.match(verifyReceipt(empty.root, empty.id).join(), /跑了 0 个用例/);
      assert.match(verifyReceipt(empty.root, 'R-0101-0000-abc').join(), /找不到回执/);
      rmSync(resolve(empty.root, RECEIPT_DIR, `${empty.id}.json`));
    });
    await check('命令不存在：记 127 和启动失败', async () => {
      const missing = await run(['harness-no-such-command-xyz'], { cwd: repo, quiet: true });
      assert.equal(missing.exit, 127); assert.match(missing.anomalies.join(), /没能启动/);
      rmSync(resolve(missing.root, RECEIPT_DIR, `${missing.id}.json`));
    });
    await check('HEAD 不是当前祖先就报', () => {
      const root = pass.root;
      const file = resolve(root, RECEIPT_DIR, `${pass.id}.json`);
      const data = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...data, head: '0123456789abcdef0123456789abcdef01234567' }));
      assert.match(verifyReceipt(root, pass.id).join(), /不是当前 HEAD 的祖先/);
      rmSync(file);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(`回执自测：${count} 项通过`);
}

const self = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (self && process.argv.includes('--self-test')) {
  await selfTest();
} else if (self) {
  const dash = process.argv.indexOf('--');
  const argv = dash >= 0 ? process.argv.slice(dash + 1) : [];
  if (!argv.length) { console.error('用法：node receipt.mjs [--expect-fail] -- <命令…>'); process.exit(2); }
  const expectFail = process.argv.slice(2, dash).includes('--expect-fail');
  const receipt = await run(argv, { expectFail });
  console.log(`\n${summaryLine(receipt)}`);
  process.exit(expectFail ? (receipt.exit !== 0 ? 0 : 1) : receipt.exit);
}
