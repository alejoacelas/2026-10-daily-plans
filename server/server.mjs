// Daily plans: serves the editor, stores one markdown file per day, and keeps each week
// in step with its own tab of a Google Doc. Both directions copy whole days. When a day
// changed on both sides between two checks, the app's version wins and the other copy
// is kept in conflicts/.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  addDays, composeWeek, fingerprint, isDate, joinDay, mondayOf, splitDay, splitWeek, tabTitle, weekDates,
} from '../shared/plans.js';
import { flatTabs, getDoc, pushTab, tabToMarkdown } from './gdocs.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const DAYS = path.join(DATA, 'days');
const CONFLICTS = path.join(DATA, 'conflicts');
const STATE = path.join(DATA, 'state.json');
const PORT = Number(process.env.PORT ?? 8770);
const DOC_ID = process.env.GOOGLE_DOC_ID;
const SYNC_MS = 10_000;

fs.mkdirSync(DAYS, { recursive: true });
fs.mkdirSync(CONFLICTS, { recursive: true });
if (!fs.existsSync(path.join(DATA, '.git'))) git('init', '-q');

const EMPTY = joinDay({ plan: '', notes: '' });
const normal = (md) => joinDay(splitDay(md));
const dayFile = (date) => path.join(DAYS, `${date}.md`);
const readDay = (date) => (fs.existsSync(dayFile(date)) ? fs.readFileSync(dayFile(date), 'utf8') : '');
const readWeek = (monday) => Object.fromEntries(weekDates(monday).map((d) => [d, readDay(d)]));
const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {});

function writeFile(file, text) {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

// Writes a day unless nothing changed; a day that is still empty creates no file.
function writeDay(date, md) {
  const old = readDay(date);
  if (md === old || (!old && normal(md) === EMPTY)) return;
  writeFile(dayFile(date), md);
}

// Keeps a copy of a version that is about to be replaced without having been seen.
function keep(date, source, md) {
  if (normal(md) === EMPTY) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFile(path.join(CONFLICTS, `${date}.${stamp}.${source}.md`), md);
  console.log(`kept the ${source} version of ${date} in conflicts/`);
}

function git(...args) {
  return execFileSync('git', ['-C', DATA, ...args], { encoding: 'utf8' });
}

// History of every day file: commit pending changes every ten minutes.
function snapshot() {
  try {
    if (!git('status', '--porcelain', 'days', 'conflicts').trim()) return;
    git('add', 'days', 'conflicts');
    git('-c', 'user.name=daily-plans', '-c', 'user.email=daily-plans@localhost', 'commit', '-qm', 'snapshot');
  } catch (e) {
    console.error('snapshot failed:', e.message);
  }
}

// One check: for each week, compare each day on both sides with the version both sides
// had at the last sync (each side keeps its own copy, so formatting differences between
// markdown and Docs never look like edits). Pull days changed only in the Doc; push the
// week when any day changed in the app. At most one push per check.
async function syncOnce() {
  if (!DOC_ID) return;
  const doc = await getDoc(DOC_ID);
  const tabs = new Map(flatTabs(doc.tabs).map((t) => [t.tabProperties.title, t]));
  const state = readState();
  state.weeks ??= {};
  const mondays = new Set(Object.keys(state.weeks));
  for (const f of fs.readdirSync(DAYS)) if (f.endsWith('.md')) mondays.add(mondayOf(f.slice(0, 10)));
  const thisMonday = mondayOf(new Date().toISOString().slice(0, 10));
  for (let i = -26; i <= 26; i++) {
    const monday = addDays(thisMonday, 7 * i);
    if (tabs.has(tabTitle(monday))) mondays.add(monday);
  }

  let pushed = false;
  for (const monday of [...mondays].sort()) {
    const week = (state.weeks[monday] ??= { app: {}, doc: {} });
    const tab = tabs.get(tabTitle(monday));
    const app = readWeek(monday);
    const docDays = tab ? splitWeek(monday, tabToMarkdown(tab)) : null;
    let push = false;
    for (const date of weekDates(monday)) {
      const appChanged = normal(app[date]) !== (week.app[date] ?? EMPTY);
      const docChanged = docDays !== null && docDays[date] !== (week.doc[date] ?? EMPTY);
      if (docChanged && !appChanged) {
        if (readDay(date) !== app[date]) continue; // edited in the app meanwhile; the next check decides
        writeDay(date, docDays[date]);
        app[date] = docDays[date]; // so a push of this week in this same check includes it
        week.app[date] = normal(docDays[date]);
        week.doc[date] = docDays[date];
        console.log(`pulled ${date} from the Doc`);
      } else if (appChanged) {
        if (docChanged) keep(date, 'doc', docDays[date]);
        push = true;
      }
    }
    if (push && !pushed) {
      pushed = true;
      await pushTab(DOC_ID, tabTitle(monday), composeWeek(monday, app, { forDoc: true }), doc);
      const after = flatTabs((await getDoc(DOC_ID)).tabs).find((t) => t.tabProperties.title === tabTitle(monday));
      const afterDays = splitWeek(monday, tabToMarkdown(after));
      for (const date of weekDates(monday)) {
        week.app[date] = normal(app[date]);
        week.doc[date] = afterDays[date];
      }
      console.log(`pushed ${tabTitle(monday)}`);
    }
  }
  writeFile(STATE, JSON.stringify(state, null, 2));
}

let syncing = null;
function sync() {
  syncing ??= syncOnce()
    .catch((e) => console.error('sync failed:', e.message))
    .finally(() => (syncing = null));
  return syncing;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const date = url.searchParams.get('date');
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!isDate(date ?? '')) return send(400, 'bad date');
      const monday = mondayOf(date);
      const weekText = () => composeWeek(monday, readWeek(monday));
      // X-Version identifies the content a client last saw; an edit sent with an older
      // version still wins, but the version it replaces is kept in conflicts/.
      if (url.pathname === '/api/day' && req.method === 'GET') {
        const text = readDay(date);
        return send(200, text, { 'X-Version': fingerprint(text) });
      }
      if (url.pathname === '/api/day' && req.method === 'PUT') {
        const body = await readBody(req);
        const old = readDay(date);
        if (req.headers['x-version'] !== fingerprint(old) && normal(old) !== normal(body)) keep(date, 'replaced', old);
        writeDay(date, body);
        return send(204, '', { 'X-Version': fingerprint(readDay(date)) });
      }
      if (url.pathname === '/api/week' && req.method === 'GET') {
        const text = weekText();
        return send(200, text, { 'X-Version': fingerprint(text) });
      }
      if (url.pathname === '/api/week' && req.method === 'PUT') {
        const stale = req.headers['x-version'] !== fingerprint(weekText());
        for (const [d, md] of Object.entries(splitWeek(monday, await readBody(req)))) {
          const old = readDay(d);
          if (stale && normal(old) !== normal(md)) keep(d, 'replaced', old);
          writeDay(d, md);
        }
        return send(204, '', { 'X-Version': fingerprint(weekText()) });
      }
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        await sync();
        return send(200, tabTitle(monday));
      }
      return send(404, 'not found');
    }
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const file = path.join(ROOT, 'public', name);
    if (!fs.existsSync(file)) return send(404, 'not found');
    send(200, fs.readFileSync(file), { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  } catch (e) {
    console.error(e);
    send(500, e.message);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`daily plans on http://127.0.0.1:${PORT}`));

setInterval(sync, SYNC_MS);
setInterval(snapshot, 10 * 60_000);
sync();
