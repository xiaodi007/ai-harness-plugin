#!/usr/bin/env node
// 变异测试信号（只做信号，不拦任何东西）：只对当前改动的源文件（相对基点 git diff，加上未跟踪的新文件）
// 调用项目自己配好的变异工具（.harness.json 的 mutation.command，插件不带变异引擎），
// 解析存活的变异体和变异分数，写成回执风格的 .harness/mutation/M-MMDD-HHMM-xxx.json；SessionStart 和简报显示最近一次。
// 依据：前沿 agent 写的测试约 88% 能在参考实现上通过，但变异分数最好的只有 55.5%（arXiv 2610.13065）；
// 也有研究认为变异测试比覆盖率强不了多少，所以先只当信号。
// 用法：node mutate.mjs [--base <ref>] [--dry-run]；--self-test。
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { harnessDir, sessionId, stamp } from './receipt.mjs';
import { matchesAny } from './test-lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const MUTATION_DIR = '.harness/mutation';
const KEEP = 8 * 1024 * 1024;
const TAIL = 4096;
const MAX_SURVIVORS = 50;
// 默认不拿去变异的：测试、文档、配置与锁文件。配了 mutation.include 就只认 include。
const NOT_SOURCE = /(^|\/)(tests?|__tests__|spec|docs?|\.harness)\/|(^|\/)(test_[^/]*|[^/]*_test\.[^/.]+|[^/]*\.(test|spec)\.[^/]+|conftest\.py)$|\.(md|markdown|txt|json|ya?ml|toml|lock|cfg|ini)$/i;

const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' });
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
const strip = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const lastMatch = (text, re) => [...text.matchAll(re)].at(-1);

export function score({ killed = 0, timeout = 0, survived = 0, noCoverage = 0 }) {
  const total = killed + timeout + survived + noCoverage;
  return total ? Math.round(((killed + timeout) / total) * 1000) / 10 : null;
}

// mutation-testing-elements 的 JSON 报告（Stryker 的 json reporter 等）。
function fromReport(report) {
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, errors: 0 };
  const survivors = [];
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    for (const m of entry.mutants ?? []) {
      const key = { Killed: 'killed', Timeout: 'timeout', Survived: 'survived', NoCoverage: 'noCoverage', CompileError: 'errors', RuntimeError: 'errors' }[m.status];
      if (key) counts[key]++;
      if (m.status === 'Survived' || m.status === 'NoCoverage') survivors.push({ file, line: m.location?.start?.line ?? null, what: `${m.mutatorName ?? ''}${m.replacement ? ` → ${m.replacement}` : ''}`.trim(), status: m.status });
    }
  }
  return { counts, survivors, parser: 'report' };
}

// 认 Stryker 文本表、mutmut、cargo-mutants；都认不出返回 null（记「未解析」，不猜）。
export function parseMutation(raw, report = null) {
  if (report) return fromReport(report);
  const text = strip(raw);
  let m;
  // cargo-mutants：42 mutants tested in 1m: 5 missed, 30 caught, 5 unviable, 2 timeouts
  if ((m = lastMatch(text, /\d+ mutants? tested[^:\n]*:\s*([^\n]+)/g))) {
    const part = (word) => Number(m[1].match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
    const survivors = [...text.matchAll(/^MISSED\s+(\S+?):(\d+)(?::\d+)?:\s*(.+?)(?:\s+in\s+[\d.]+s\b.*)?$/gm)].map((s) => ({ file: s[1], line: Number(s[2]), what: s[3], status: 'Survived' }));
    return { counts: { killed: part('caught'), timeout: part('timeouts?'), survived: part('missed'), noCoverage: 0, errors: part('unviable') }, survivors, parser: 'cargo-mutants' };
  }
  // Stryker clear-text：All files 行最后 5 个数是 killed、timeout、survived、no cov、errors（新旧版前面分数列数不同）。
  if ((m = lastMatch(text, /^\s*All files\s*\|([^\n]+)/gm))) {
    const nums = m[1].split('|').map((cell) => cell.trim()).filter((cell) => /^\d+(?:\.\d+)?$/.test(cell)).map(Number);
    if (nums.length >= 6) {
      const [killed, timeout, survived, noCoverage, errors] = nums.slice(-5);
      const survivors = [...text.matchAll(/\[(Survived|NoCoverage)\]\s+(\S+)\s*\n\s*(\S+?):(\d+):\d+/g)].map((s) => ({ file: s[3], line: Number(s[4]), what: s[2], status: s[1] }));
      return { counts: { killed, timeout, survived, noCoverage, errors }, survivors, parser: 'stryker' };
    }
  }
  // mutmut：进度行 🎉 杀死 ⏰ 超时 🤔 可疑 🙁 存活 🔇 跳过（3.x 另有 🫥 没测试覆盖）；3.x 的 results 每行「名字: survived」。
  if (/🎉\s*\d+/.test(text)) {
    const count = (emoji) => Number(lastMatch(text, new RegExp(`${emoji}\\s*(\\d+)`, 'gu'))?.[1] ?? 0);
    const survivors = [...text.matchAll(/^\s*(\S+):\s*survived\s*$/gm)].map((s) => ({ file: null, line: null, what: s[1], status: 'Survived' }));
    return { counts: { killed: count('🎉'), timeout: count('⏰'), survived: count('🙁') + count('🤔'), noCoverage: count('🫥'), errors: 0 }, survivors, parser: 'mutmut' };
  }
  return null;
}

// 基点：--base，其次 mutation.base，其次和 main/master 的分叉点；就在主干上时为 HEAD（只看未提交改动）。
export function resolveBase(root, explicit, config = {}) {
  if (explicit) return explicit;
  if (config.mutation?.base) return config.mutation.base;
  for (const branch of ['main', 'master', 'origin/main', 'origin/master']) {
    const merge = git(root, ['merge-base', 'HEAD', branch]);
    if (merge.status === 0 && merge.stdout.trim()) return merge.stdout.trim();
  }
  return 'HEAD';
}

export function changedFiles(root, base, config = {}) {
  const diff = git(root, ['diff', '--name-only', '--diff-filter=ACMR', base]);
  if (diff.status !== 0) throw new Error(`git diff ${base} 失败：${diff.stderr.trim().slice(0, 120)}`);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  const all = [...new Set([...diff.stdout.split('\n'), ...(untracked.status === 0 ? untracked.stdout.split('\n') : [])].filter(Boolean))].sort();
  const include = config.mutation?.include;
  const exclude = config.mutation?.exclude ?? [];
  return all.filter((file) => existsSync(resolve(root, file)))
    .filter((file) => (Array.isArray(include) && include.length ? matchesAny(file, include) : !NOT_SOURCE.test(file)))
    .filter((file) => !matchesAny(file, exclude));
}

const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
// {files} 换成空格分隔的各自加引号的路径，{files,} 换成逗号连起来的一个参数；另外总设 HARNESS_MUTATE_FILES（换行分隔）。
export function buildCommand(template, files) {
  return template.replaceAll('{files,}', quote(files.join(','))).replaceAll('{files}', files.map(quote).join(' '));
}

function execute(command, cwd, files, quiet) {
  return new Promise((done) => {
    let body = '';
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HARNESS_MUTATE_FILES: files.join('\n') } });
    const take = (stream, sink) => stream.on('data', (chunk) => {
      if (!quiet) sink.write(chunk);
      body += chunk.toString();
      if (body.length > KEEP) body = body.slice(-KEEP);
    });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);
    child.on('error', (error) => done({ exit: 127, body: body + String(error.message ?? error) }));
    child.on('close', (code) => done({ exit: code ?? 128, body }));
  });
}

// 跑一次：返回记录（已写盘）；没有改动的源文件返回 { skipped }，不写记录。
export async function mutate(root, { base: explicit = null, dryRun = false, quiet = false } = {}) {
  let config;
  try { config = JSON.parse(readFileSync(resolve(root, '.harness.json'), 'utf8')); } catch { throw new Error('没有 .harness.json（先 /harness:init）'); }
  const template = config.mutation?.command;
  if (typeof template !== 'string' || !template.trim()) throw new Error('.harness.json 没配 mutation.command（例：npx stryker run --mutate {files,}、mutmut run --paths-to-mutate {files,}、cargo mutants --in-diff 之类；插件不带变异引擎）');
  const base = resolveBase(root, explicit, config);
  const files = changedFiles(root, base, config);
  if (!files.length) return { skipped: `相对 ${base.slice(0, 12)} 没有改动的源文件` };
  const command = buildCommand(template, files);
  if (dryRun) return { dryRun: true, base, files, command };
  const reportPath = config.mutation?.report ? resolve(root, config.mutation.report) : null;
  if (reportPath) rmSync(reportPath, { force: true });
  const started = new Date();
  const { exit, body } = await execute(command, root, files, quiet);
  const ended = new Date();
  let report = null;
  if (reportPath) { try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* 没生成就退回解析文本。 */ } }
  const parsed = parseMutation(body, report);
  const head = git(root, ['rev-parse', 'HEAD']);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
  const record = {
    id: `M-${stamp(started)}-${randomBytes(2).toString('hex').slice(0, 3)}`, kind: 'mutation',
    base, files, cmd: command, root,
    head: head.status === 0 ? head.stdout.trim() : null,
    dirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
    session: sessionId(),
    startedAt: started.toISOString(), endedAt: ended.toISOString(), durationMs: ended - started,
    exit, parser: parsed?.parser ?? null, counts: parsed?.counts ?? null, score: parsed ? score(parsed.counts) : null,
    survivorsTotal: parsed ? parsed.survivors.length : null, survivors: parsed ? parsed.survivors.slice(0, MAX_SURVIVORS) : [],
    tail: strip(body).slice(-TAIL),
  };
  writeFileSync(resolve(harnessDir(root, 'mutation'), `${record.id}.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function latestMutation(root) {
  let names;
  try { names = readdirSync(resolve(root, MUTATION_DIR)).filter((name) => /^M-.+\.json$/.test(name)); } catch { return null; }
  let best = null;
  for (const name of names) {
    try {
      const record = JSON.parse(readFileSync(resolve(root, MUTATION_DIR, name), 'utf8'));
      if (!best || String(record.endedAt) > String(best.endedAt)) best = record;
    } catch { /* 坏文件跳过。 */ }
  }
  return best;
}

export function mutationLine(record) {
  const day = String(record.endedAt ?? '').slice(5, 10);
  const scope = `${record.files?.length ?? 0} 个改动文件`;
  if (!record.counts) return `变异信号 ${record.id}（${day}，${scope}）：输出没解析出来（exit ${record.exit}），看记录里的 tail`;
  const c = record.counts;
  const survived = c.survived + c.noCoverage;
  return `变异信号 ${record.id}（${day}，${scope}）：分数 ${record.score ?? '—'}%，存活 ${survived}，杀死 ${c.killed + c.timeout}`;
}

async function selfTest() {
  const tmp = mkdtempSync(resolve(ROOT, '.harness-变异测试-'));
  let count = 0;
  const check = async (name, test) => { await test(); count++; console.log(`  ✓ ${name}`); };
  try {
    await check('解析 Stryker 文本表（新旧两种列数）、存活清单', () => {
      const v6 = 'File       | % score | # killed | # timeout | # survived | # no cov | # errors |\n-----\nAll files  |   55.50 |      111 |         0 |         89 |        0 |        0 |\n';
      assert.deepEqual(parseMutation(v6).counts, { killed: 111, timeout: 0, survived: 89, noCoverage: 0, errors: 0 });
      const v8 = '\x1b[32m[Survived] ArithmeticOperator\x1b[0m\nsrc/math.js:3:12\n-   a + b\n+   a - b\n#2. [NoCoverage] BlockStatement\nsrc/util.js:9:1\nAll files |  50.00 |  60.00 |  2 |  1 |  2 |  1 |  0 |\n';
      const p = parseMutation(v8);
      assert.deepEqual(p.counts, { killed: 2, timeout: 1, survived: 2, noCoverage: 1, errors: 0 });
      assert.deepEqual(p.survivors.map((s) => [s.file, s.line, s.status]), [['src/math.js', 3, 'Survived'], ['src/util.js', 9, 'NoCoverage']]);
      assert.equal(score(p.counts), 50);
    });
    await check('解析 mutmut（取最后一行进度）、cargo-mutants、JSON 报告；认不出返回 null', () => {
      const mm = parseMutation('⠋ 3/12  🎉 1  ⏰ 0  🤔 0  🙁 1  🔇 0\n⠋ 12/12  🎉 8  ⏰ 1  🤔 1  🙁 2  🔇 0\n    app.x_f__mutmut_3: survived\n    app.x_f__mutmut_4: killed\n');
      assert.deepEqual(mm.counts, { killed: 8, timeout: 1, survived: 3, noCoverage: 0, errors: 0 });
      assert.deepEqual(mm.survivors.map((s) => s.what), ['app.x_f__mutmut_3']);
      const cargo = parseMutation('MISSED   src/lib.rs:12:5: replace add -> i32 with 0 in 0.5s build + 0.3s test\n42 mutants tested in 1m 3s: 5 missed, 30 caught, 5 unviable, 2 timeouts\n');
      assert.deepEqual(cargo.counts, { killed: 30, timeout: 2, survived: 5, noCoverage: 0, errors: 5 });
      assert.deepEqual(cargo.survivors[0], { file: 'src/lib.rs', line: 12, what: 'replace add -> i32 with 0', status: 'Survived' });
      const report = { files: { 'src/a.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived', mutatorName: 'EqualityOperator', replacement: '!==', location: { start: { line: 4 } } }, { status: 'Timeout' }, { status: 'CompileError' }] } } };
      const r = parseMutation('无关文本', report);
      assert.deepEqual(r.counts, { killed: 1, timeout: 1, survived: 1, noCoverage: 0, errors: 1 });
      assert.deepEqual(r.survivors, [{ file: 'src/a.ts', line: 4, what: 'EqualityOperator → !==', status: 'Survived' }]);
      assert.equal(parseMutation('build ok\n'), null);
      assert.equal(score({ killed: 0, survived: 0 }), null);
    });
    await check('命令占位：{files} 逐个加引号，{files,} 连成一个参数', () => {
      assert.equal(buildCommand('tool {files}', ['a.py', "it's.py"]), "tool 'a.py' 'it'\\''s.py'");
      assert.equal(buildCommand('stryker run --mutate {files,}', ['a.js', 'b.js']), "stryker run --mutate 'a.js,b.js'");
      assert.equal(buildCommand('cargo mutants', ['a.rs']), 'cargo mutants');
    });
    // 独立小仓：main 上一次提交，分支上改源文件、测试、文档，再加一个未跟踪文件、删一个文件。
    const repo = resolve(tmp, 'repo');
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    mkdirSync(resolve(repo, 'tests'), { recursive: true });
    const env = { ...gitEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const g = (...args) => assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env }).status, 0, args.join(' '));
    for (const file of ['src/a.py', 'src/b.py', 'src/gone.py', 'tests/test_a.py', 'README.md']) writeFileSync(resolve(repo, file), 'x = 1\n');
    g('init', '-q', '-b', 'main'); g('add', '.'); g('commit', '-q', '-m', 'init');
    g('checkout', '-q', '-b', 'feature');
    writeFileSync(resolve(repo, 'src/a.py'), 'x = 2\n'); g('commit', '-q', '-am', 'change a');
    writeFileSync(resolve(repo, 'tests/test_a.py'), 'x = 2\n');
    writeFileSync(resolve(repo, 'README.md'), 'y\n');
    writeFileSync(resolve(repo, 'src/new.py'), 'z = 1\n');
    rmSync(resolve(repo, 'src/gone.py'));
    await check('改动文件：相对 main 分叉点，含已提交、未提交、未跟踪；去掉测试、文档、删掉的', () => {
      const base = resolveBase(repo, null, {});
      assert.notEqual(base, 'HEAD');
      assert.deepEqual(changedFiles(repo, base), ['src/a.py', 'src/new.py']);
      assert.deepEqual(changedFiles(repo, 'HEAD'), ['src/new.py'], 'HEAD 为基点只看未提交与未跟踪');
      assert.deepEqual(changedFiles(repo, base, { mutation: { include: ['tests/**'] } }), ['tests/test_a.py']);
      assert.deepEqual(changedFiles(repo, base, { mutation: { exclude: ['src/new.py'] } }), ['src/a.py']);
      assert.equal(resolveBase(repo, 'v1', { mutation: { base: 'v0' } }), 'v1');
      assert.equal(resolveBase(repo, null, { mutation: { base: 'v0' } }), 'v0');
    });
    const tool = resolve(tmp, 'fake-stryker.sh');
    writeFileSync(tool, '#!/bin/sh\necho "files:$HARNESS_MUTATE_FILES" | tr "\\n" " "\necho\necho "args:$*"\nprintf "[Survived] ArithmeticOperator\\nsrc/a.py:1:5\\n"\necho "All files |  75.00 |  3 |  0 |  1 |  0 |  0 |"\nexit 1\n');
    chmodSync(tool, 0o755);
    await check('没配 mutation.command、没有 .harness.json 都报错；没有改动不写记录', async () => {
      await assert.rejects(mutate(repo, { quiet: true }), /没有 \.harness\.json/);
      writeFileSync(resolve(repo, '.harness.json'), '{}');
      await assert.rejects(mutate(repo, { quiet: true }), /没配 mutation\.command/);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ mutation: { command: `${tool} --mutate {files,}`, include: ['nothing/**'] } }));
      assert.match((await mutate(repo, { quiet: true })).skipped, /没有改动的源文件/);
      assert.equal(latestMutation(repo), null);
    });
    await check('跑一次：只把改动文件交给工具，记分数和存活清单，工具退出非 0 也照记；dry-run 不跑', async () => {
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ mutation: { command: `${tool} --mutate {files,}` } }));
      const dry = await mutate(repo, { quiet: true, dryRun: true });
      assert.equal(dry.command, `${tool} --mutate 'src/a.py,src/new.py'`);
      assert.equal(latestMutation(repo), null);
      const record = await mutate(repo, { quiet: true });
      assert.match(record.id, /^M-\d{4}-\d{4}-[0-9a-f]{3}$/);
      assert.equal(record.exit, 1); assert.equal(record.parser, 'stryker'); assert.equal(record.score, 75);
      assert.deepEqual(record.files, ['src/a.py', 'src/new.py']);
      assert.match(record.tail, /files:src\/a\.py src\/new\.py/); assert.match(record.tail, /args:--mutate src\/a\.py,src\/new\.py/);
      assert.deepEqual(record.survivors, [{ file: 'src/a.py', line: 1, what: 'ArithmeticOperator', status: 'Survived' }]);
      assert.ok(existsSync(resolve(repo, MUTATION_DIR, `${record.id}.json`)));
      assert.match(readFileSync(resolve(repo, '.harness/.gitignore'), 'utf8'), /^\*$/m);
      assert.equal(latestMutation(repo).id, record.id);
      assert.match(mutationLine(record), /^变异信号 M-\S+（\d{2}-\d{2}，2 个改动文件）：分数 75%，存活 1，杀死 3$/);
    });
    await check('最近一次按结束时间取；输出认不出时记未解析并照样能显示', async () => {
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ mutation: { command: 'echo nothing useful' } }));
      const record = await mutate(repo, { quiet: true });
      assert.equal(record.counts, null); assert.equal(record.score, null);
      assert.equal(latestMutation(repo).id, record.id);
      assert.match(mutationLine(record), /输出没解析出来（exit 0）/);
      writeFileSync(resolve(repo, MUTATION_DIR, 'M-0101-0000-bad.json'), '{bad');
      // 文件名排在两头的旧记录：不论目录读出来什么顺序，都得按结束时间取。
      for (const id of ['M-0000-0000-aaa', 'M-9999-9999-fff']) writeFileSync(resolve(repo, MUTATION_DIR, `${id}.json`), JSON.stringify({ id, endedAt: '2000-01-01T00:00:00.000Z' }));
      assert.equal(latestMutation(repo).id, record.id);
    });
    await check('报告文件优先于文本；跑之前删掉旧报告，免得读到上一次的', async () => {
      const report = resolve(repo, 'reports/m.json');
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, JSON.stringify({ files: { old: { mutants: [{ status: 'Survived' }] } } }));
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ mutation: { command: 'echo no report', report: 'reports/m.json' } }));
      assert.equal((await mutate(repo, { quiet: true })).counts, null);
      const json = JSON.stringify({ files: { 'src/a.py': { mutants: [{ status: 'Killed' }, { status: 'Killed' }, { status: 'Survived' }, { status: 'NoCoverage' }] } } });
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ mutation: { command: `echo '${json}' > reports/m.json`, report: 'reports/m.json' } }));
      const record = await mutate(repo, { quiet: true });
      assert.equal(record.parser, 'report'); assert.equal(record.score, 50);
    });
    await check('CLI：配错退出 2；跑完不论分数高低退出 0', () => {
      const script = fileURLToPath(import.meta.url);
      writeFileSync(resolve(repo, '.harness.json'), '{}');
      const bad = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' });
      assert.equal(bad.status, 2); assert.match(bad.stderr, /mutation\.command/);
      writeFileSync(resolve(repo, '.harness.json'), JSON.stringify({ mutation: { command: `${tool} {files}` } }));
      const ok = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' });
      assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /变异信号 M-\S+.*分数 75%.*只是信号，不拦/);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log(`变异信号自测：${count} 项通过`);
}

const self = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (self && process.argv.includes('--self-test')) {
  await selfTest();
} else if (self) {
  const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const root = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();
  const at = process.argv.indexOf('--base');
  try {
    const result = await mutate(root, { base: at > 0 ? process.argv[at + 1] : null, dryRun: process.argv.includes('--dry-run') });
    if (result.skipped) console.log(`变异信号：${result.skipped}，不跑`);
    else if (result.dryRun) console.log(`基点 ${result.base}\n文件：${result.files.join('、')}\n命令：${result.command}`);
    else {
      console.log(`\n${mutationLine(result)}（只是信号，不拦；记录 ${MUTATION_DIR}/${result.id}.json）`);
      for (const s of result.survivors.slice(0, 10)) console.log(`  存活 ${s.file ?? ''}${s.line ? `:${s.line}` : ''} ${s.what}`);
    }
  } catch (error) { console.error(`变异信号：${error.message ?? error}`); process.exit(2); }
}
