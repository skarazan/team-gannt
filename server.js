// Team Gantt - small Express server with shared state.
// Storage: JSON file (DATA_DIR) by default, or Supabase if SUPABASE_URL + SUPABASE_SERVICE_KEY are set.
// Optional shared password: TEAM_PASSWORD (HTTP basic auth, any username).
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const PASSWORD = process.env.TEAM_PASSWORD || '';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const USE_SB = !!(SB_URL && SB_KEY);

const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGIN_PAGE = (failed, nextUrl) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team Gantt: sign in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f4fb;color:#0a0a1f}
form{background:#fff;border:2px solid #111;border-radius:14px;padding:26px 26px 22px;width:min(340px,90vw);display:grid;gap:12px;box-shadow:0 10px 30px rgba(0,0,0,.12)}
h1{margin:0;font-size:20px}p{margin:0;color:#6b7090;font-size:13px}input{border:2px solid #111;border-radius:8px;padding:9px 10px;font:inherit}
button{border:2px solid #111;border-radius:8px;padding:9px;font:inherit;font-weight:700;background:#5271FF;color:#fff;cursor:pointer}.err{color:#d11;font-weight:700}</style></head>
<body><form method="post" action="/login"><h1>Team Gantt</h1><p>Enter the team password. This browser stays signed in for 90 days.</p>
${failed ? '<p class="err">Wrong password, try again.</p>' : ''}
<input type="password" name="password" autocomplete="current-password" placeholder="Team password" autofocus required>
<input type="hidden" name="next" value="${escHtml(nextUrl.replace(/[?&]failed=1/, '') || '/')}">
<button type="submit">Sign in</button></form></body></html>`;

const PALETTE = ['#5271FF', '#FF7A1F', '#0097B2', '#FF5757', '#7F4FFF', '#38B6FF', '#5CE1E6'];
const STATUSES = ['todo', 'doing', 'done', 'blocked'];
const uid = (p) => p + crypto.randomBytes(4).toString('hex');

// ---------------------------------------------------------------- default state
function defaultState() {
  const groups = [
    'Frontend-Backend Connection',
    'Gemini Context & Harness',
    'Art Database',
    'UI/UX',
    'Procedural Map Generation',
    'Character Controls & Game Logic',
  ].map((name, i) => ({ id: uid('g_'), name, color: PALETTE[i % PALETTE.length] }));
  const members = [0, 1, 2, 3, 4].map((i) => ({ id: 'm' + (i + 1), name: 'Member ' + (i + 1), color: PALETTE[i] }));
  return { rev: 1, members, groups, tasks: [] };
}

// ---------------------------------------------------------------- persistence
const sbHeaders = () => ({ apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' });

async function loadState() {
  if (USE_SB) {
    const r = await fetch(`${SB_URL}/rest/v1/gantt_state?id=eq.1&select=data`, { headers: sbHeaders() });
    if (!r.ok) throw new Error('Supabase load failed: HTTP ' + r.status);
    const rows = await r.json();
    return rows.length ? rows[0].data : null;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
}

async function writeState(s) {
  if (USE_SB) {
    const r = await fetch(`${SB_URL}/rest/v1/gantt_state?on_conflict=id`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ id: 1, data: s }]),
    });
    if (!r.ok) throw new Error('Supabase save failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let state;
let saveChain = Promise.resolve();
function persist() {
  const snapshot = JSON.parse(JSON.stringify(state));
  const p = saveChain.then(() => writeState(snapshot));
  saveChain = p.catch((e) => console.error(e.message));
  return p;
}

// ---------------------------------------------------------------- validation
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isColor = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

let skipDepCheck = false;
// would giving `id` these deps make a loop? (walk from each dep through existing deps looking for id)
function createsCycle(id, deps) {
  const map = new Map(state.tasks.map((t) => [t.id, t.deps || []]));
  const seen = new Set(), stack = [...deps];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === id) return true;
    if (seen.has(cur)) continue; seen.add(cur);
    for (const n of map.get(cur) || []) stack.push(n);
  }
  return false;
}
// sequential ids T001, T002... so tickets can reference each other
function nextTaskId() {
  let max = 0;
  for (const t of state.tasks) { const m = /^t_t(\d+)$/i.exec(t.id); if (m) max = Math.max(max, +m[1]); }
  return 't_t' + String(max + 1).padStart(3, '0');
}

function applyTask(task, input) {
  if ('title' in input) { task.title = str(input.title); if (!task.title) return 'Title is required'; }
  if ('groupId' in input) {
    if (!state.groups.some((g) => g.id === input.groupId)) return 'Unknown group';
    task.groupId = input.groupId;
  }
  if ('assigneeId' in input) {
    if (input.assigneeId && !state.members.some((m) => m.id === input.assigneeId)) return 'Unknown member';
    task.assigneeId = input.assigneeId || null;
  }
  if ('start' in input) { if (!isDate(input.start)) return 'Bad start date'; task.start = input.start; }
  if ('end' in input) { if (!isDate(input.end)) return 'Bad end date'; task.end = input.end; }
  if (task.end < task.start) {
    if ('start' in input && !('end' in input)) task.end = task.start; else return 'End is before start';
  }
  if ('progress' in input) task.progress = Math.max(0, Math.min(100, Math.round(Number(input.progress) || 0)));
  if ('status' in input) { if (!STATUSES.includes(input.status)) return 'Bad status'; task.status = input.status; }
  if ('notes' in input) task.notes = str(input.notes, 2000);
  if ('deps' in input) {
    if (!Array.isArray(input.deps)) return 'deps must be a list';
    const ids = [...new Set(input.deps.map((d) => String(d)))].filter((d) => d !== task.id);
    if (ids.length > 50) return 'Too many dependencies';
    if (!skipDepCheck) {
      for (const d of ids) if (!state.tasks.some((x) => x.id === d)) return 'Unknown dependency ' + d;
      if (createsCycle(task.id, ids)) return 'That dependency would create a loop';
    }
    task.deps = ids;
  }
  return null;
}

const bump = () => { state.rev += 1; };

// ---------------------------------------------------------------- app
const app = express();
app.disable('x-powered-by');

app.get('/healthz', (req, res) => res.send('ok'));

if (PASSWORD) {
  const want = crypto.createHash('sha256').update(PASSWORD).digest();
  // After one successful password prompt the browser gets a 90-day sign-in cookie.
  // It is derived from the password, so changing TEAM_PASSWORD signs everyone out.
  const sessionToken = crypto.createHmac('sha256', PASSWORD).update('team-gantt-session-v1').digest('hex');
  const COOKIE = 'tg_session';
  const hasSession = (req) => (req.headers.cookie || '').split(';').some((c) => {
    const [k, ...v] = c.trim().split('=');
    if (k !== COOKIE) return false;
    const a = Buffer.from(v.join('=')), b = Buffer.from(sessionToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  app.set('trust proxy', 1);
  // Sign-in form posts here: { password, next }
  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const got = crypto.createHash('sha256').update(String(req.body.password || '')).digest();
    const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/';
    if (!crypto.timingSafeEqual(want, got)) return res.redirect(303, '/?failed=1');
    res.cookie(COOKIE, sessionToken, { maxAge: 90 * 864e5, httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
    res.redirect(303, next.replace(/[?&]failed=1/, '') || '/');
  });
  app.use((req, res, next) => {
    if (hasSession(req)) return next();
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
      const got = crypto.createHash('sha256').update(pass).digest();
      if (crypto.timingSafeEqual(want, got)) {
        res.cookie(COOKIE, sessionToken, { maxAge: 90 * 864e5, httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
        return next();
      }
    }
    // Browsers get a sign-in page (works in browsers/panes that never show the basic-auth popup);
    // scripts can still use HTTP basic auth.
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
      const failed = req.query.failed === '1';
      return res.status(401).type('html').send(LOGIN_PAGE(failed, req.originalUrl));
    }
    res.set('WWW-Authenticate', 'Basic realm="Team Gantt"').status(401).send('Password required');
  });
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
};
const bad = (res, msg) => res.status(400).json({ error: msg });
const done = async (res) => { bump(); await persist(); res.json(state); };

app.get('/api/state', (req, res) => {
  if (String(req.query.rev) === String(state.rev)) return res.json({ unchanged: true, rev: state.rev });
  res.json(state);
});

app.get('/api/export', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="gantt-backup.json"').json(state);
});

// groups
app.post('/api/groups', wrap(async (req, res) => {
  const name = str(req.body.name, 80);
  if (!name) return bad(res, 'Name is required');
  const color = isColor(req.body.color) ? req.body.color : PALETTE[state.groups.length % PALETTE.length];
  state.groups.push({ id: uid('g_'), name, color });
  await done(res);
}));
app.patch('/api/groups/:id', wrap(async (req, res) => {
  const g = state.groups.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  if ('name' in req.body) { g.name = str(req.body.name, 80); if (!g.name) return bad(res, 'Name is required'); }
  if (isColor(req.body.color)) g.color = req.body.color;
  await done(res);
}));
app.delete('/api/groups/:id', wrap(async (req, res) => {
  if (!state.groups.some((x) => x.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
  state.groups = state.groups.filter((x) => x.id !== req.params.id);
  state.tasks = state.tasks.filter((t) => t.groupId !== req.params.id);
  const left = new Set(state.tasks.map((t) => t.id));
  for (const x of state.tasks) if (x.deps) x.deps = x.deps.filter((d) => left.has(d));
  await done(res);
}));

// tasks
app.post('/api/tasks', wrap(async (req, res) => {
  const t = { id: nextTaskId(), groupId: null, title: '', assigneeId: null, start: '', end: '', progress: 0, status: 'todo', notes: '', deps: [], log: [] };
  const input = { ...req.body };
  if (!('end' in input) && isDate(input.start)) input.end = input.start;
  for (const k of ['groupId', 'title', 'start', 'end']) if (!(k in input)) return bad(res, k + ' is required');
  const err = applyTask(t, input);
  if (err) return bad(res, err);
  state.tasks.push(t);
  await done(res);
}));
app.patch('/api/tasks/:id', wrap(async (req, res) => {
  const t = state.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const copy = { ...t };
  const err = applyTask(copy, req.body);
  if (err) return bad(res, err);
  Object.assign(t, copy);
  await done(res);
}));
// handoff notes: what changed / warnings for whoever picks up dependent tasks
const NOTE_KINDS = ['note', 'warning'];
function cleanLog(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-100).map((n) => ({
    id: str(n.id, 30) || uid('n_'),
    authorId: n.authorId && state.members.some((m) => m.id === n.authorId) ? n.authorId : null,
    kind: NOTE_KINDS.includes(n.kind) ? n.kind : 'note',
    text: str(n.text, 2000),
    at: typeof n.at === 'string' && !isNaN(Date.parse(n.at)) ? n.at : new Date().toISOString(),
  })).filter((n) => n.text);
}
app.post('/api/tasks/:id/notes', wrap(async (req, res) => {
  const t = state.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const text = str(req.body.text, 2000);
  if (!text) return bad(res, 'Note text is required');
  const kind = NOTE_KINDS.includes(req.body.kind) ? req.body.kind : 'note';
  const authorId = req.body.authorId && state.members.some((m) => m.id === req.body.authorId) ? req.body.authorId : null;
  t.log = t.log || [];
  if (t.log.length >= 100) return bad(res, 'This task already has 100 notes');
  t.log.push({ id: uid('n_'), authorId, kind, text, at: new Date().toISOString() });
  await done(res);
}));
app.delete('/api/tasks/:id/notes/:nid', wrap(async (req, res) => {
  const t = state.tasks.find((x) => x.id === req.params.id);
  if (!t || !(t.log || []).some((n) => n.id === req.params.nid)) return res.status(404).json({ error: 'Not found' });
  t.log = t.log.filter((n) => n.id !== req.params.nid);
  await done(res);
}));

app.delete('/api/tasks/:id', wrap(async (req, res) => {
  if (!state.tasks.some((x) => x.id === req.params.id)) return res.status(404).json({ error: 'Not found' });
  state.tasks = state.tasks.filter((x) => x.id !== req.params.id);
  for (const x of state.tasks) if (x.deps) x.deps = x.deps.filter((d) => d !== req.params.id);
  await done(res);
}));

// members (bulk rename / recolor)
app.patch('/api/members', wrap(async (req, res) => {
  const list = Array.isArray(req.body.members) ? req.body.members : [];
  for (const u of list) {
    const m = state.members.find((x) => x.id === u.id);
    if (!m) continue;
    if ('name' in u && str(u.name, 40)) m.name = str(u.name, 40);
    if (isColor(u.color)) m.color = u.color;
  }
  await done(res);
}));

// Friendly bulk add (merges into existing board). Used by the Import button and usable by scripts.
// { "groups": [ { "name": "Art Database", "tasks": [ { "title": "...", "assignee": "Member 2",
//                 "start": "2026-11-09", "end": "2026-11-13", "status": "todo", "progress": 0, "notes": "" } ] } ] }
// Apply an import (new tasks + updates) all-or-nothing. Throws with a readable message.
async function applyImport(reqBody) {
  const req = { body: reqBody };
  const groups = (req.body && req.body.groups) || [];
  const updates = (req.body && req.body.updates) || [];
  if (!Array.isArray(groups) || !Array.isArray(updates) || (!groups.length && !updates.length))
    throw new Error('Expected { "groups": [ ... ] } and/or { "updates": [ ... ] }');
  const staged = JSON.parse(JSON.stringify(state));
  const saved = state; state = staged;
  try {
    let added = 0, updated = 0;
    // "T005" or "t_t005" -> task id
    const resolve = (ref, ctx) => {
      const r = String(ref).trim();
      const id = /^t\d+$/i.test(r) ? 't_' + r.toLowerCase() : r;
      if (!state.tasks.some((x) => x.id === id)) throw new Error(`Unknown task "${r}" (${ctx})`);
      return id;
    };
    const memberRef = (ref, ctx) => {
      if (ref === null || ref === '') return null;
      const m = state.members.find((x) => x.name.toLowerCase() === String(ref).toLowerCase() || x.id === ref);
      if (!m) throw new Error(`Unknown assignee "${ref}" (${ctx})`);
      return m.id;
    };
    const pendingDeps = [], pendingBlocks = [];
    for (const gi of groups) {
      const name = str(gi.name, 80);
      if (!name) throw new Error('Every group needs a name');
      let g = state.groups.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!g) {
        g = { id: uid('g_'), name, color: isColor(gi.color) ? gi.color : PALETTE[state.groups.length % PALETTE.length] };
        state.groups.push(g);
      }
      for (const ti of Array.isArray(gi.tasks) ? gi.tasks : []) {
        const input = { title: ti.title, groupId: g.id, start: ti.start, end: ti.end || ti.start };
        for (const k of ['progress', 'status', 'notes']) if (k in ti) input[k] = ti[k];
        if (ti.assignee) input.assigneeId = memberRef(ti.assignee, `task "${ti.title}"`);
        const t = { id: nextTaskId(), groupId: g.id, title: '', assigneeId: null, start: '', end: '', progress: 0, status: 'todo', notes: '', deps: [], log: [] };
        const err = applyTask(t, input);
        if (err) throw new Error(`${err} (task "${ti.title}")`);
        state.tasks.push(t); added++;
        if (Array.isArray(ti.deps)) pendingDeps.push([t, ti.deps, `task "${ti.title}"`]);
        if (Array.isArray(ti.unblocks)) pendingBlocks.push([t, ti.unblocks, `task "${ti.title}"`]);
      }
    }
    // new tasks' dependencies (may point at existing tasks or at each other)
    for (const [t, refs, ctx] of pendingDeps) {
      const err = applyTask(t, { deps: refs.map((r) => resolve(r, ctx)) });
      if (err) throw new Error(`${err} (${ctx})`);
    }
    // "unblocks": existing tasks that should wait on this new task
    for (const [t, refs, ctx] of pendingBlocks) {
      for (const r of refs) {
        const other = state.tasks.find((x) => x.id === resolve(r, ctx));
        const err = applyTask(other, { deps: [...new Set([...(other.deps || []), t.id])] });
        if (err) throw new Error(`${err} (${ctx} unblocks ${r})`);
      }
    }
    // edits to existing tasks: { "task": "T005", "title"?, "notes"?, "appendNotes"?, "assignee"?, "start"?, "end"?, "status"?, "addDeps"?, "removeDeps"? }
    for (const u of updates) {
      const id = resolve(u.task, 'updates');
      const t = state.tasks.find((x) => x.id === id);
      const input = {};
      for (const k of ['title', 'notes', 'start', 'end', 'status', 'progress']) if (k in u) input[k] = u[k];
      if ('appendNotes' in u) input.notes = ((t.notes || '') + '\n' + String(u.appendNotes)).trim();
      if ('assignee' in u) input.assigneeId = memberRef(u.assignee, `update ${u.task}`);
      if (u.addDeps || u.removeDeps) {
        const add = (u.addDeps || []).map((r) => resolve(r, `update ${u.task}`));
        const rm = new Set((u.removeDeps || []).map((r) => resolve(r, `update ${u.task}`)));
        input.deps = [...new Set([...(t.deps || []), ...add])].filter((d) => !rm.has(d));
      }
      const copy = { ...t };
      const err = applyTask(copy, input);
      if (err) throw new Error(`${err} (update ${u.task})`);
      Object.assign(t, copy); updated++;
    }
    state.rev = saved.rev;
    bump(); await persist();
    return { added, updated };
  } catch (e) {
    state = saved;
    throw e;
  }
}

app.post('/api/bulk', wrap(async (req, res) => {
  try {
    const r = await applyImport(req.body);
    res.json({ ...state, ...r });
  } catch (e) { bad(res, e.message); }
}));

// full restore from a backup
app.put('/api/state', wrap(async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.members) || !Array.isArray(b.groups) || !Array.isArray(b.tasks)) return bad(res, 'Not a valid backup');
  const next = { rev: state.rev, members: [], groups: [], tasks: [], inboxLog: state.inboxLog || [] };
  const saved = state; state = next;
  try {
    for (const m of b.members) next.members.push({ id: str(m.id, 20), name: str(m.name, 40) || 'Member', color: isColor(m.color) ? m.color : PALETTE[0] });
    for (const g of b.groups) next.groups.push({ id: str(g.id, 30), name: str(g.name, 80) || 'Group', color: isColor(g.color) ? g.color : PALETTE[0] });
    for (const x of b.tasks) {
      const t = { id: str(x.id, 30) || uid('t_'), groupId: null, title: '', assigneeId: null, start: '', end: '', progress: 0, status: 'todo', notes: '', deps: [], log: [] };
      skipDepCheck = true; const err = applyTask(t, x); skipDepCheck = false;
      t.log = cleanLog(x.log);
      if (err) throw new Error(err + ' (task "' + str(x.title) + '")');
      next.tasks.push(t);
    }
    const ids = new Set(next.tasks.map((t) => t.id));
    if (ids.size !== next.tasks.length) throw new Error('Duplicate task ids in backup');
    for (const t of next.tasks) {
      t.deps = (t.deps || []).filter((d) => ids.has(d));
    }
    for (const t of next.tasks) if (createsCycle(t.id, t.deps)) throw new Error('Dependency loop involving "' + t.title + '"');
    bump(); await persist();
    res.json(state);
  } catch (e) {
    state = saved;
    bad(res, e.message);
  }
}));

// ---------------------------------------------------------------- inbox
// Import files committed to inbox/ are applied once, in name order, on the next start (i.e. after each deploy).
// Results are kept in state.inboxLog so the board shows what happened.
const INBOX_DIR = path.join(__dirname, 'inbox');
async function applyInbox() {
  let files = [];
  try { files = fs.readdirSync(INBOX_DIR).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
  state.inboxLog = Array.isArray(state.inboxLog) ? state.inboxLog : [];
  const seen = new Set(state.inboxLog.map((x) => x.file));
  for (const file of files) {
    if (seen.has(file)) continue;
    const entry = { file, at: new Date().toISOString(), ok: false };
    try {
      const body = JSON.parse(fs.readFileSync(path.join(INBOX_DIR, file), 'utf8'));
      const r = await applyImport(body);
      Object.assign(entry, { ok: true, added: r.added, updated: r.updated, note: str(body.description, 300) });
      console.log(`inbox: applied ${file} (+${r.added} tasks, ${r.updated} updated)`);
    } catch (e) {
      entry.error = String(e.message).slice(0, 300);
      console.error(`inbox: FAILED ${file}: ${entry.error}`);
    }
    state.inboxLog.push(entry);
    state.inboxLog = state.inboxLog.slice(-200);
    bump(); await persist();
  }
}
app.get('/api/inbox-log', (req, res) => res.json(state.inboxLog || []));

// ---------------------------------------------------------------- start
(async () => {
  state = await loadState();
  if (!state) { state = defaultState(); await writeState(state); }
  await applyInbox();
  app.listen(PORT, () => console.log(`Team Gantt on :${PORT} (storage: ${USE_SB ? 'supabase' : DATA_FILE}, password: ${PASSWORD ? 'on' : 'off'})`));
})().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
