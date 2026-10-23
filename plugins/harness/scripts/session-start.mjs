#!/usr/bin/env node
// 开会话的「回到现场」：任务卡摘要、第二份账本读者、未提交改动；兼容边界和漂移风险见 README。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, openSync, readSync, closeSync, statSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BOUNDARY = '只看得见经 multi-ai 记账的活；直接敲 codex 或别的机器上的活看不见';
const DAY = 24 * 60 * 60 * 1000;
const OUTPUT_LIMIT = 4800;
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

// 回到现场：只从任务卡里摘几行，不整份读卡；卡片格式对不上的项目降级为一行说明。
const CARD_DIRS = ['docs/协作/任务', 'docs/tasks', 'tasks'];
const RECENT_DAYS = 3;
const MAX_CARDS = 6;
const CARD_READ_LIMIT = 256 * 1024;
const ACTIVE_RE = /^[-*]\s*状态\s*[:：]\s*(active|waiting)\b/;
const DECIDED_HEADING = /已定|答复|裁决/;
const WAIT_RE = /^[-*]\s*(?:\*\*)?(?:仍需拍板|待维护者定|待维护者拍板|等维护者|需要维护者决定|等你)(?:\*\*)?\s*[:：]\s*(.*)$/;
const TODO_RE = /(?:待|等)(?:维护者|你)[^，。；：:]{0,6}(?:走查|过目|验收|手验|看)/;
const CLOSED_RE = /^(?:已定|已完成|完成|done|不做|搁置|已收口|收口|已撤|取消|✅|☑)/i;
const plain = (text) => clean(text).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '').trim();
// 只有标签的前缀（「第三轮拍板（10-23）：」）换成原话本身；有实义的前缀保留到第一段原话结束。
const gist = (text) => {
  const at = text.indexOf('「');
  if (at < 0) return text;
  const label = text.slice(0, at).replace(/（[^）]*）|\([^)]*\)|原话|第.轮|拍板|[:：。，\s]/g, '');
  const end = text.indexOf('」', at);
  return label.length > 3 ? (end < 0 ? text : text.slice(0, end + 1)) : text.slice(at + 1, end < 0 ? undefined : end);
};
const dateIn = (text) => text.match(/(?:20\d\d-)?(\d{1,2})-(\d{1,2})/);

function readHead(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(CARD_READ_LIMIT);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, CARD_READ_LIMIT, 0));
  } finally { closeSync(fd); }
}

function parseCard(text) {
  const card = { status: '', decision: null, waiting: null, agenda: [], unchecked: [], todo: [] };
  let heading = '';
  let inHandoff = false;
  let handoffs = 0;
  let fenced = false;
  let previous = '';
  let quoted = null;
  const decided = [];
  text.split('\n').forEach((line, index) => {
    const before = previous;
    previous = line;
    if (/^\s*```/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const head = line.match(/^(#{1,4})\s+(.*)$/);
    if (head) {
      heading = head[2];
      // 只认第一个交接节：Keel 的卡新交接写在前面，后面的「更早的交接」常是下一级标题。
      if (/交接/.test(heading)) inHandoff = ++handoffs === 1;
      else if (head[1] === '##') inHandoff = false;
      return;
    }
    if (index < 30 && !card.status) card.status = line.match(ACTIVE_RE)?.[1] ?? '';
    const wait = line.match(WAIT_RE);
    if (wait && plain(wait[1]) && (inHandoff ? !card.waiting?.handoff : !card.waiting)) card.waiting = { text: plain(wait[1]), handoff: inHandoff };
    const bullet = line.match(/^ ?(?:[-*]|\d+\.)\s+(.*)$/);
    // 已定节里的条目或段落都算；带原话或日期的优先，免得取到「见某卡」这类指引句。
    if (DECIDED_HEADING.test(heading) && !/待|要维护者/.test(heading) && (bullet || /^[^\s|>#]/.test(line))) decided.push({ text: bullet ? bullet[1] : line, heading });
    if (bullet && /原话[:：]?\s*「/.test(line)) quoted = { text: bullet[1], heading };
    const box = line.match(/^\s*[-*]\s+\[ \]\s+(.*)$/);
    if (box) card.unchecked.push(plain(box[1]));
    if ((inHandoff || box) && TODO_RE.test(line)) card.todo.push(plain(line.replace(/^\s*[-*]\s+(\[ \]\s+)?/, '')));
    // 议程表：表头行（上一行不是表格）和分隔行跳过，最后一格是状态。
    if (/议程/.test(heading) && /^\|/.test(line) && /^\|/.test(before) && !/^\|[\s:|-]*$/.test(line)) {
      const cells = line.split('|').slice(1, -1).map(plain);
      if (cells.length >= 2 && cells[0] && !CLOSED_RE.test(cells.at(-1))) card.agenda.push(cells[0]);
    }
  });
  // 没有「已定/答复/裁决」节的卡，退到最后一条带原话的条目。
  const decision = decided.findLast((item) => /「/.test(item.text) || dateIn(item.text)) ?? decided.at(-1) ?? quoted;
  if (decision) {
    const date = dateIn(decision.text) ?? dateIn(decision.heading);
    card.decision = { text: gist(plain(decision.text)), date: date ? [Number(date[1]), Number(date[2])] : null };
  }
  return card;
}

function cardDir(root) {
  for (const dir of CARD_DIRS) {
    try { if (statSync(resolve(root, dir)).isDirectory()) return dir; } catch { /* 试下一个候选。 */ }
  }
  return null;
}

// 近期改过的卡，新的在前：有 git 时按未提交改动和近几天的提交，没有 git 时按文件修改时间。
function recentCards(root, dir, inGit, now) {
  const order = [];
  const add = (path) => { if (path.endsWith('.md') && basename(path) !== 'README.md' && !order.includes(path)) order.push(path); };
  if (inGit) {
    const status = git(root, ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall', '--', dir]);
    if (status.status !== 0) throw new Error(status.stderr || `git 退出 ${status.status}`);
    for (const line of status.stdout.split('\n')) if (line.length > 3) add(line.slice(3).replace(/^.* -> /, ''));
    // 刚 init 还没有提交的仓，git log 会报错，只看未提交改动。
    if (git(root, ['rev-parse', '--verify', '-q', 'HEAD']).status === 0) {
      const log = git(root, ['-c', 'core.quotePath=false', 'log', `--since=${RECENT_DAYS}.days`, '--format=', '--name-only', '--', dir]);
      if (log.status !== 0) throw new Error(log.stderr || `git 退出 ${log.status}`);
      for (const line of log.stdout.split('\n')) if (line) add(line);
    }
  } else {
    readdirSync(resolve(root, dir)).filter((name) => name.endsWith('.md'))
      .map((name) => ({ path: `${dir}/${name}`, at: statSync(resolve(root, dir, name)).mtimeMs }))
      .filter((item) => now - item.at < RECENT_DAYS * DAY).sort((a, b) => b.at - a.at).forEach((item) => add(item.path));
  }
  return order.filter((path) => existsSync(resolve(root, path)));
}

function commitsSince(root, path, [month, day], now) {
  const year = basename(path).match(/^(20\d\d)-/)?.[1] ?? new Date(now).getFullYear();
  const since = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00`;
  const log = git(root, ['log', `--since=${since}`, '--format=%h', '--', path]);
  return log.status === 0 ? log.stdout.split('\n').filter(Boolean).length : null;
}

function sceneSection(cwd, now = Date.now()) {
  try {
    const probe = git(cwd, ['rev-parse', '--show-toplevel']);
    const inGit = probe.status === 0 && Boolean(probe.stdout.trim());
    const root = inGit ? probe.stdout.trim() : cwd;
    const dir = cardDir(root);
    if (!dir) return `回到现场\n未找到任务卡目录（找过 ${CARD_DIRS.join('、')}），跳过`;
    const cards = [];
    for (const path of recentCards(root, dir, inGit, now)) {
      const card = parseCard(readHead(resolve(root, path)));
      if (card.status) cards.push({ ...card, path, name: basename(path, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '') });
    }
    const shown = cards.slice(0, MAX_CARDS);
    const lines = ['回到现场', `活跃卡 ${cards.length} 张（状态 active/waiting，近 ${RECENT_DAYS} 天${inGit ? '有提交或未提交' : '文件改过'}）`];
    for (const card of shown) {
      const decision = card.decision
        ? `上次定「${clip(card.decision.text, 46)}」${card.decision.date ? `(${card.decision.date.join('-')})` : '(没写日期)'}`
        : '卡里没找到已定';
      const commits = inGit && card.decision?.date ? commitsSince(root, card.path, card.decision.date, now) : null;
      const after = commits === null ? '' : `；之后 ${commits} 个提交动过本卡`;
      lines.push(clip2(`· ${clip(card.name, 18)}［${card.status}］：${decision}${after}；等你：${card.waiting ? clip(card.waiting.text, 50) : '卡里没写'}`, 220));
    }
    if (cards.length > MAX_CARDS) lines.push(clip2(`另有 ${cards.length - MAX_CARDS} 张：${cards.slice(MAX_CARDS).map((card) => clip(card.name, 14)).join('、')}`, 240));
    lines.push('议程未收口');
    const open = shown.filter((card) => card.agenda.length || card.unchecked.length);
    if (!open.length) lines.push('活跃卡里没有未收口的议程项或未勾项');
    for (const card of open) {
      const parts = [];
      if (card.agenda.length) parts.push(`议程 ${card.agenda.slice(0, 6).map((id) => clip(id, 12)).join('、')}${card.agenda.length > 6 ? ` 等 ${card.agenda.length} 项` : ''} 未定`);
      if (card.unchecked.length) parts.push(`未勾 ${card.unchecked.length} 项（${clip(card.unchecked[0], 30)}${card.unchecked.length > 1 ? ' 等' : ''}）`);
      lines.push(clip2(`· ${clip(card.name, 18)}：${parts.join('；')}`, 200));
    }
    lines.push('你现在可以做');
    const todo = shown.flatMap((card) => card.todo.map((line) => `· ${clip(card.name, 18)}：${clip(line, 70)}`));
    const asks = shown.filter((card) => card.waiting && !/^无/.test(card.waiting.text)).length;
    lines.push(...todo.slice(0, 3));
    if (asks) lines.push(`· 回答 ${asks} 张卡的「等你」`);
    if (!todo.length && !asks) lines.push('没有要你做的');
    lines.push('只认卡里写下的：交接节的「仍需拍板/待维护者定」「待维护者走查/看」；卡没更新就会过期');
    return lines.join('\n');
  } catch (error) { return `回到现场\n${failure('任务卡', error)}`; }
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
  // 三段分开限长，哪段再长也挤不掉别的段。
  const output = ledgerOnly ? diagnostic + clip2(ledgerSection(file), 1600)
    : diagnostic + clip2(sceneSection(cwd), 1800) + '\n\n' + clip2(ledgerSection(file), 1600) + '\n\n' + clip2(gitSection(cwd), 1250);
  return output.slice(0, OUTPUT_LIMIT - 1) + '\n';
}

function selfTest() {
  // 临时文件仅在本工作树内；借现有工作树验证 status，不改本仓 Git 元数据；回到现场的小仓建在临时目录里。
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
    // 回到现场：在临时目录里建独立的小仓，提交时间可控；不碰本仓 Git 元数据。
    const ymd = (at) => { const d = new Date(at); return `${d.getMonth() + 1}-${d.getDate()}`; };
    const makeRepo = (name) => {
      const root = resolve(tmp, name);
      mkdirSync(resolve(root, 'docs/协作/任务'), { recursive: true });
      const run = (args, at = now) => {
        const iso = new Date(at).toISOString();
        const env = { ...gitEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
        const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      };
      run(['init', '-q']);
      const put = (file, text, at) => {
        writeFileSync(resolve(root, 'docs/协作/任务', file), text);
        if (at !== undefined) { run(['add', '-A']); run(['commit', '-q', '-m', file], at); }
      };
      return { root, put };
    };
    const active = (status, body) => `# 卡\n\n- 状态：${status}\n- 最后更新：x\n\n${body}\n`;
    const decided = `## 已定（原话）\n\n- 「旧决定」（${ymd(now - 4 * DAY)}）\n- 「新决定照推荐」（${ymd(now - 2 * DAY)}）\n- 见讨论卡的追认\n`;
    const agenda = '## 议程\n\n| 环 | 内容 | 状态 |\n| -- | -- | -- |\n| H1 | 甲 | 已定（无 A 档） |\n| H2 | 乙 | 讨论中 |\n\n- [ ] 第二轮派活\n- [x] 第一轮\n';
    const handoff = '## 交接\n\n- 仍需拍板：要不要推送\n- 待维护者走查：new 环境 abc123 两处改动\n\n### 更早的交接\n\n- 仍需拍板：旧问题\n- 待维护者走查：旧环境 old999\n';
    const big = makeRepo('repo');
    // 提交按时间先后：git log --since 遇到更早的提交就停止回溯。
    big.put('2026-01-04-丁.md', active('active', '- 仍需拍板：丁的问题'), now - 10 * DAY);
    big.put('2026-01-01-甲.md', active('active', 'v1'), now - 5 * DAY);
    big.put('2026-01-01-甲.md', active('active', decided + agenda + handoff), now - DAY);
    big.put('2026-01-01-甲.md', active('active', decided + agenda + handoff + '\n补一句\n'), now - 3600000);
    big.put('2026-01-02-乙.md', active('waiting', `- 结论。原话：「只做启动预热」（${ymd(now - DAY)}）\n\n\`\`\`\n- 仍需拍板：围栏里\n\`\`\`\n`), now - 3600000);
    big.put('2026-01-03-丙.md', active('done', '- 仍需拍板：丙的问题'), now - 3600000);
    big.put('README.md', active('active', ''), now - 3600000);
    big.put('2026-01-05-戊.md', active('active', ''));
    const scene = () => sceneSection(big.root, now);
    check('回到现场：只列近期改过的 active/waiting 卡（含未提交）', () => {
      const out = scene();
      assert.match(out, /活跃卡 3 张/); assert.match(out, /· 甲［active］/); assert.match(out, /· 乙［waiting］/); assert.match(out, /· 戊［active］/);
      assert.doesNotMatch(out, /丙|丁|README/);
    });
    check('回到现场：上次定取已定节最后一条带原话的，没有已定节退到原话', () => {
      const out = scene();
      assert.ok(out.includes(`上次定「新决定照推荐」(${ymd(now - 2 * DAY)})`), out);
      assert.doesNotMatch(out, /旧决定|追认/); assert.ok(out.includes('上次定「只做启动预热」'), out);
      assert.match(out, /· 戊［active］：卡里没找到已定/);
      assert.equal(parseCard('## 已定\n\n- 会话记录延长保留。原话：「延长吧」。已改设置（10-23）\n').decision.text, '会话记录延长保留。原话：「延长吧」');
      assert.deepEqual(parseCard('## 维护者裁决（10-21 晚）\n\n第三轮拍板：「索引按推荐删」，其余不做\n').decision, { text: '索引按推荐删', date: [10, 21] });
    });
    check('回到现场：之后的提交只数决定日起动过本卡的', () => {
      assert.match(scene(), /· 甲［active］：[^\n]*之后 2 个提交动过本卡/); assert.doesNotMatch(scene(), /之后 3 个提交/);
    });
    check('回到现场：等你只认第一个交接节，围栏里的不算', () => {
      const out = scene();
      assert.match(out, /甲[^\n]*等你：要不要推送/); assert.doesNotMatch(out, /旧问题|围栏里/); assert.match(out, /乙[^\n]*等你：卡里没写/);
    });
    check('回到现场：议程只列没收口的行和未勾项', () => {
      const out = scene();
      assert.match(out, /· 甲：议程 H2 未定；未勾 1 项（第二轮派活）/); assert.doesNotMatch(out, /H1|环 |第一轮/);
    });
    check('回到现场：你现在可以做列待走查行与待答张数，都没有时说没有', () => {
      const out = scene();
      assert.match(out, /你现在可以做\n· 甲：待维护者走查：new 环境 abc123/); assert.match(out, /· 回答 1 张卡的「等你」/); assert.doesNotMatch(out, /没有要你做的|old999/);
      const calm = makeRepo('calm');
      calm.put('2026-01-01-静.md', active('active', '## 交接\n\n- 仍需拍板：无。\n'), now - 3600000);
      calm.put('2026-01-02-别的格式.md', '# 没有状态行的卡\n\n- 仍需拍板：别的格式\n', now - 3600000);
      const quiet = sceneSection(calm.root, now);
      assert.match(quiet, /活跃卡 1 张/); assert.match(quiet, /没有要你做的/); assert.doesNotMatch(quiet, /回答 \d+ 张|别的格式/);
      calm.put('2026-01-03-看.md', active('active', '## 交接\n\n- 待维护者看：静态页 mock.html\n'));
      const look = sceneSection(calm.root, now);
      assert.match(look, /· 看：待维护者看：静态页 mock\.html/); assert.doesNotMatch(look, /没有要你做的|回答 \d+ 张/);
      calm.put('2026-01-03-看.md', active('active', '## 交接\n\n- 仍需拍板：要定\n'));
      const ask = sceneSection(calm.root, now);
      assert.match(ask, /· 回答 1 张卡的「等你」/); assert.doesNotMatch(ask, /没有要你做的|mock\.html/);
    });
    check('回到现场降级：没有卡目录、没有 git 时按文件时间', () => {
      const none = sceneSection('/', now);
      assert.match(none, /未找到任务卡目录/); assert.doesNotMatch(none, /读取失败|活跃卡/);
      const loose = resolve(tmp, 'loose/docs/tasks');
      mkdirSync(loose, { recursive: true });
      writeFileSync(resolve(loose, 'new.md'), active('active', ''));
      writeFileSync(resolve(loose, 'old.md'), active('active', ''));
      utimesSync(resolve(loose, 'old.md'), (now - 10 * DAY) / 1000, (now - 10 * DAY) / 1000);
      assert.deepEqual(recentCards(resolve(tmp, 'loose'), 'docs/tasks', false, now), ['docs/tasks/new.md']);
      assert.match(sceneSection(resolve(tmp, 'missing'), now), /harness：任务卡读取失败/);
    });
    check('回到现场长度：超过 6 张截断、卡只读开头 256KB、整体不超上限（仓里还没有提交）', () => {
      const many = makeRepo('many');
      for (let i = 0; i < 10; i++) many.put(`2026-01-${10 + i}-卡${i}.md`, active('active', `- 仍需拍板：${'长'.repeat(400)}`));
      many.put('2026-01-01-巨.md', active('active', 'x'.repeat(256 * 1024) + '\n## 交接\n\n- 仍需拍板：尾巴\n'));
      const out = sceneSection(many.root, now);
      assert.match(out, /活跃卡 11 张/); assert.match(out, /另有 5 张：/); assert.match(out, /· 巨［active］/); assert.doesNotMatch(out, /尾巴/);
      assert.ok(out.split('\n').every((line) => line.length <= 240));
      const full = render(JSON.stringify({ cwd: many.root }), { file });
      assert.ok(full.length <= OUTPUT_LIMIT); assert.ok(full.indexOf('回到现场') < full.indexOf('在跑的外部活') && full.indexOf('在跑的外部活') < full.indexOf('未提交改动'));
      assert.doesNotMatch(render(JSON.stringify({ cwd: many.root }), { file, ledgerOnly: true }), /回到现场/);
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
