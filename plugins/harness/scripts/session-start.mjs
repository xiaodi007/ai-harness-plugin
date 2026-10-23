#!/usr/bin/env node
// 第二份账本读者；兼容边界和与 Keel 实现的漂移风险见 README。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BOUNDARY = '只看得见经 multi-ai 记账的活；直接敲 codex 或别的机器上的活看不见';
const DAY = 24 * 60 * 60 * 1000;
const clean = (value) => String(value ?? '').replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ');
const clip = (value, limit) => {
  const text = clean(value);
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};
const clip2 = (text, limit) => (text.length > limit ? text.slice(0, limit - 1) + '…' : text);
const failure = (part, error) => `harness：${part}读取失败：${clip(error.message ?? error, 140)}`;
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const age = (at, now) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60000));
  if (!Number.isFinite(minutes)) return '未知时间';
  return minutes < 120 ? `${minutes}分钟前` : `${Math.round(minutes / 60)}小时前`;
};

function ledgerSection(file, now = Date.now()) {
  let body;
  try {
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return `在跑的外部活\n账本不存在\n${BOUNDARY}`;
      throw error;
    }
    const latest = new Map();
    for (const line of raw.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event && event.id && ['start', 'finish'].includes(event.event)) latest.set(event.id, event);
      } catch { /* 坏行不影响其余事件。 */ }
    }
    const jobs = [...latest.values()].filter((event) => event.event === 'start')
      // 与 Keel ai-ledger.mjs 的 fold 同判据：别的机器或没有 pid 的活本机判不了死活，记 unknown。
      .map((event) => ({ ...event, status: event.host !== hostname() || !Number.isInteger(event.pid) ? 'unknown' : alive(event.pid) ? 'running' : 'lost' }))
      .filter((job) => job.status === 'running' || now - Date.parse(job.at) < DAY)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    body = jobs.length ? jobs.slice(0, 15).map((job) => {
      const full = `${job.status} ${clean(job.id)}｜${clean(job.what)}｜${clean(job.cwd)}${job.card ? `｜卡 ${clean(job.card)}` : ''}｜开始于${age(job.at, now)}`;
      if (full.length <= 200) return full;
      // 限制不受信任的字段长度，保留状态、路径、卡和时间各字段。
      return `${job.status} ${clip(job.id, 32)}｜${clip(job.what, 30)}｜${clip(job.cwd, 80)}${job.card ? `｜卡 ${clip(job.card, 50)}` : ''}｜开始于${age(job.at, now)}`;
    }).map((line) => clip(line, 200)).join('\n') : '账本里没有在跑的活';
    if (jobs.length > 15) body += `\n另有 ${jobs.length - 15} 条`;
  } catch (error) { body = failure('账本', error); }
  return `在跑的外部活\n${body}\n${BOUNDARY}`;
}

const gitEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  // status 不刷新索引，保持 Git 元数据只读。
  GIT_OPTIONAL_LOCKS: '0',
});
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: gitEnvironment(), encoding: 'utf8', timeout: 2500, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
function gitSection(cwd) {
  try {
    const probe = git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (probe.status !== 0) {
      if (probe.stderr.includes('not a git repository')) return '未提交改动\n非 git 目录，跳过';
      throw new Error(probe.stderr || `git 退出 ${probe.status}`);
    }
    if (probe.stdout.trim() !== 'true') return '未提交改动\n非 git 目录，跳过';
    // 中文路径原样输出，默认的八进制转义模型读不懂。
    const status = git(cwd, ['-c', 'core.quotePath=false', 'status', '--short']);
    if (status.status !== 0) throw new Error(status.stderr || `git 退出 ${status.status}`);
    const lines = status.stdout.split('\n').filter(Boolean);
    return ['未提交改动', `共 ${lines.length} 条`, ...lines.slice(0, 15).map((line) => clip(line, 110)),
      ...(lines.length > 15 ? [`另有 ${lines.length - 15} 条`] : []), '未知修改视为他人工作，别清'].join('\n');
  } catch (error) { return `未提交改动\n${failure('未提交改动', error)}`; }
}

function render(raw, { file = process.env.AI_LEDGER_FILE || resolve(homedir(), '.local/state/ai-ledger/events.jsonl'), ledgerOnly = false } = {}) {
  let cwd = process.cwd();
  let diagnostic = '';
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('stdin 应为 JSON 对象');
    if (input.cwd !== undefined) {
      if (typeof input.cwd !== 'string' || !input.cwd) throw new Error('cwd 应为非空字符串');
      cwd = input.cwd;
    }
  } catch (error) { diagnostic = failure('输入', error) + '\n'; }
  // 两段分开限长，账本段再长也挤不掉未提交改动段。
  const output = diagnostic + clip2(ledgerSection(file), 1600) + (ledgerOnly ? '' : '\n\n' + clip2(gitSection(cwd), 1250));
  return output.slice(0, 2999) + '\n';
}

function selfTest() {
  // 临时文件仅在本工作树内；借现有工作树验证 status，不创建或修改 Git 元数据。
  const tmp = mkdtempSync(resolve(ROOT, '.harness-会话测试-'));
  const file = resolve(tmp, 'events.jsonl');
  const now = Date.now();
  const start = (id, extra = {}) => ({ event: 'start', id, at: new Date(now - 60000).toISOString(), what: `任务-${id}`, cwd: '/example', pid: process.pid, host: hostname(), card: 'card.md', ...extra });
  const write = (events) => writeFileSync(file, events.map((event) => typeof event === 'string' ? event : JSON.stringify(event)).join('\n'));
  const show = () => ledgerSection(file, now);
  let count = 0;
  const check = (name, test) => { test(); count++; console.log(`  ✓ ${name}`); };
  try {
    // 经 kill(0) 确认确实不存在，不依赖本机 PID 上限。
    let dead = 2147483647;
    while (alive(dead)) dead--;
    check('running（本进程、超过 24 小时仍报）', () => {
      write([start('alive', { at: new Date(now - 2 * DAY).toISOString() })]);
      assert.match(show(), /running alive/); assert.doesNotMatch(show(), /lost alive/);
    });
    check('lost（死 PID，24 小时内）', () => {
      write([start('dead', { pid: dead })]);
      assert.match(show(), /lost dead/); assert.doesNotMatch(show(), /running dead/);
    });
    check('24 小时外及恰好 24 小时的 lost 不报', () => {
      write([start('stale', { pid: dead, at: new Date(now - 2 * DAY).toISOString() }), start('edge', { pid: dead, at: new Date(now - DAY).toISOString() }), start('visible')]);
      assert.doesNotMatch(show(), /stale|edge/); assert.match(show(), /running visible/);
    });
    check('finish 不报，按最后事件折叠', () => {
      write([start('done'), { event: 'finish', id: 'done' }, start('again'), { event: 'finish', id: 'again' }, start('again')]);
      assert.doesNotMatch(show(), /done/); assert.match(show(), /running again/);
    });
    check('坏行和非事件跳过', () => {
      write(['{bad', 'null', '42', '{}', start('valid')]);
      assert.match(show(), /running valid/); assert.doesNotMatch(show(), /读取失败|bad/);
    });
    check('账本不存在', () => {
      const out = ledgerSection(resolve(tmp, 'absent'));
      assert.match(out, /账本不存在/); assert.doesNotMatch(out, /账本里没有在跑的活|running/); assert.ok(out.includes(BOUNDARY));
    });
    check('非 git 目录降级（忽略 GIT_* 污染）', () => {
      // 真正的非 git 目录只读选用文件系统根，不在那里写文件。
      const saved = process.env.GIT_DIR;
      process.env.GIT_DIR = resolve(ROOT, '.git');
      try {
        const out = gitSection('/');
        assert.match(out, /非 git 目录，跳过/); assert.doesNotMatch(out, /共 \d+ 条|读取失败/);
      } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
    });
    check('git 工作树含一条新建的未提交改动', () => {
      writeFileSync(resolve(tmp, 'uncommitted.txt'), 'fixture\n');
      const result = git(ROOT, ['status', '--short']);
      assert.equal(result.status, 0);
      // 负向对照：默认 status 会把中文目录名转义，证明夹具真能触发转义。
      assert.ok(!result.stdout.includes(basename(tmp)) && /\\\d{3}/.test(result.stdout));
      const out = gitSection(ROOT);
      assert.match(out, /共 [1-9]\d* 条/); assert.doesNotMatch(out, /非 git 目录|读取失败/);
      assert.ok(out.includes(basename(tmp)), '中文路径要原样输出'); assert.doesNotMatch(out, /\\\d{3}/); assert.ok(out.includes('未知修改视为他人工作，别清'));
    });
    check('超过 15 条截断', () => {
      write(Array.from({ length: 17 }, (_, i) => start(`job-${i}`)));
      assert.match(show(), /另有 2 条/); assert.match(show(), /running job-14｜/); assert.doesNotMatch(show(), /running job-15｜/);
    });
    check('跨主机判 unknown、空账本与异常可见、ledger-only 和长度上限', () => {
      write([start('remote', { host: hostname() + '-other' })]);
      assert.match(show(), /unknown remote/); assert.doesNotMatch(show(), /(running|lost) remote/);
      write([]); assert.match(show(), /账本里没有在跑的活/); assert.doesNotMatch(show(), /账本不存在/);
      assert.match(ledgerSection(tmp), /harness：账本读取失败/);
      write(Array.from({ length: 17 }, (_, i) => start('x'.repeat(100) + i, { what: '文'.repeat(300), cwd: '/'.repeat(300), card: '卡'.repeat(300) })));
      const out = render(JSON.stringify({ cwd: tmp }), { file });
      assert.ok(out.length <= 3000); assert.match(out, /未知修改视为他人工作，别清/);
      assert.doesNotMatch(render('{}', { file, ledgerOnly: true }), /未提交改动/);
      assert.match(render('{bad', { file }), /harness：输入读取失败/);
      assert.match(gitSection(resolve(tmp, 'missing')), /harness：未提交改动读取失败/);
    });
    console.log(`session-start：${count} 个场景通过（均含负向断言）`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv.includes('--self-test')) {
  // 测试失败应可被测试入口发现；生产 hook 的异常始终以零退出。
  selfTest();
} else {
  try { process.stdout.write(render(readFileSync(0, 'utf8'), { ledgerOnly: process.argv.includes('--ledger-only') })); }
  catch (error) { process.stdout.write(failure('输入', error) + '\n'); }
}
