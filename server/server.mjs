// Daily plans: serves the editor, stores one markdown file per day, and pushes each
// changed week to its own tab of a Google Doc every hour from noon to midnight.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { composeWeek, isDate, mondayOf, splitDay, splitWeek, tabTitle, weekDates } from '../shared/plans.js';
import { pushTab } from './gdocs.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const DAYS = path.join(DATA, 'days');
const STATE = path.join(DATA, 'state.json');
const PORT = Number(process.env.PORT ?? 8770);
const DOC_ID = process.env.GOOGLE_DOC_ID;
const TIME_ZONE = process.env.PLANS_TIME_ZONE ?? 'Europe/London';

fs.mkdirSync(DAYS, { recursive: true });
if (!fs.existsSync(path.join(DATA, '.git'))) git('init', '-q');

const dayFile = (date) => path.join(DAYS, `${date}.md`);
const readDay = (date) => (fs.existsSync(dayFile(date)) ? fs.readFileSync(dayFile(date), 'utf8') : '');
const readWeek = (monday) => Object.fromEntries(weekDates(monday).map((d) => [d, readDay(d)]));
const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { pushed: {} });

function writeFile(file, text) {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

// Writes a day unless nothing changed; a day that is still empty creates no file.
function writeDay(date, md) {
  const old = readDay(date);
  const { plan, notes } = splitDay(md);
  if (md === old || (!old && !plan && !notes)) return;
  writeFile(dayFile(date), md);
}

function git(...args) {
  return execFileSync('git', ['-C', DATA, ...args], { encoding: 'utf8' });
}

// Keeps a history of every day file: commit pending changes every ten minutes.
function snapshot() {
  try {
    if (!git('status', '--porcelain', 'days').trim()) return;
    git('add', 'days');
    git('-c', 'user.name=daily-plans', '-c', 'user.email=daily-plans@localhost', 'commit', '-qm', 'snapshot');
  } catch (e) {
    console.error('snapshot failed:', e.message);
  }
}

const hash = (s) => createHash('sha256').update(s).digest('hex');

async function pushWeek(monday) {
  if (!DOC_ID) throw new Error('GOOGLE_DOC_ID is not set');
  const md = composeWeek(monday, readWeek(monday), { forDoc: true });
  await pushTab(DOC_ID, tabTitle(monday), md);
  const state = readState();
  state.pushed[monday] = hash(md);
  writeFile(STATE, JSON.stringify(state, null, 2));
  console.log(`pushed ${tabTitle(monday)}`);
}

async function pushChangedWeeks() {
  const state = readState();
  const mondays = new Set(fs.readdirSync(DAYS).filter((f) => f.endsWith('.md')).map((f) => mondayOf(f.slice(0, 10))));
  for (const monday of [...mondays].sort()) {
    const md = composeWeek(monday, readWeek(monday), { forDoc: true });
    if (state.pushed[monday] === hash(md)) continue;
    try {
      await pushWeek(monday);
    } catch (e) {
      console.error(`push ${monday} failed:`, e.message);
    }
  }
}

// Push once per hour from 12:00 to 23:59 local time.
let lastPushHour = null;
function tick() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}`;
  if (Number(parts.hour) >= 12 && hour !== lastPushHour) {
    lastPushHour = hour;
    pushChangedWeeks();
  }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

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
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!isDate(date ?? '')) return send(400, 'bad date');
      const monday = mondayOf(date);
      if (url.pathname === '/api/day' && req.method === 'GET') return send(200, readDay(date));
      if (url.pathname === '/api/day' && req.method === 'PUT') {
        writeDay(date, await readBody(req));
        return send(204, '');
      }
      if (url.pathname === '/api/week' && req.method === 'GET') return send(200, composeWeek(monday, readWeek(monday)));
      if (url.pathname === '/api/week' && req.method === 'PUT') {
        const days = splitWeek(monday, await readBody(req));
        for (const [d, md] of Object.entries(days)) writeDay(d, md);
        return send(204, '');
      }
      if (url.pathname === '/api/push' && req.method === 'POST') {
        await pushWeek(monday);
        return send(200, tabTitle(monday));
      }
      return send(404, 'not found');
    }
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const file = path.join(ROOT, 'public', name);
    if (!fs.existsSync(file)) return send(404, 'not found');
    send(200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
  } catch (e) {
    console.error(e);
    send(500, e.message);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`daily plans on http://127.0.0.1:${PORT}`));

setInterval(tick, 60_000);
setInterval(snapshot, 10 * 60_000);
tick();
