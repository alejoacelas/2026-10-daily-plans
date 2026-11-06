// Daily plans: serves the editor, keeps the running page that is copied from day to day,
// saves it as the day's file at midnight, and keeps the page and each week of days in step
// with a Google Doc (a Today tab, and a tab per week with child tabs for Notes and the extra
// tabs). Both directions copy whole parts. When a part changed on both sides between two
// checks, the app's version wins and the other copy is kept in conflicts/.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CUTOVER, addDays, cleanTabName, composeDay, dayLabel, fingerprint, isDate, joinDay, mondayOf, splitDay, splitDayView,
  splitWeekNotes, splitWeekPlans, tabTitle, weekDates, weekNotes, weekPlans,
} from '../shared/plans.js';
import { addTab, deleteTab, flatTabs, getDoc, renameTab, tabToMarkdown, writeTab } from './gdocs.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const DAYS = path.join(DATA, 'days'); // YYYY-MM-DD.md, plus YYYY-MM-DD/ for that day's own tabs
const WEEKS = path.join(DATA, 'weeks'); // <Monday>/ holds the week's tabs
const CONFLICTS = path.join(DATA, 'conflicts');
const PAGE = path.join(DATA, 'page.md'); // the running page
const PAGE_META = path.join(DATA, 'page.json'); // { date }: the day the running page belongs to
const PAGE_TAB = 'Today'; // the running page's Doc tab, first at the top level
const TIME_ZONE = 'Europe/London';
const STATE = path.join(DATA, 'state.json');
const PORT = Number(process.env.PORT ?? 8770);
const DOC_ID = process.env.GOOGLE_DOC_ID;
const SYNC_MS = 10_000;
const STATE_VERSION = 2;
const FIRST_WEEK_TABS = [{ id: 'after', name: 'After hours', shared: true }];

fs.mkdirSync(DAYS, { recursive: true });
fs.mkdirSync(WEEKS, { recursive: true });
fs.mkdirSync(CONFLICTS, { recursive: true });
if (!fs.existsSync(path.join(DATA, '.git'))) git('init', '-q');

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const dayFile = (date) => path.join(DAYS, `${date}.md`);
const readDay = (date) => read(dayFile(date));
const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {});

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

// Writes a day unless nothing changed; a day that is still empty creates no file.
function writeDay(date, md) {
  const old = readDay(date);
  if (joinDay(splitDay(md)) === joinDay(splitDay(old))) return;
  writeFile(dayFile(date), joinDay(splitDay(md)));
}

const setPlan = (date, plan) => writeDay(date, joinDay({ ...splitDay(readDay(date)), plan }));
const setNotes = (date, notes) => writeDay(date, joinDay({ ...splitDay(readDay(date)), notes }));

// Keeps a copy of a version that is about to be replaced without having been seen.
function keep(name, source, md) {
  if (!md?.trim() || md.trim() === '## Notes') return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFile(path.join(CONFLICTS, `${name.replace(/[/\\]/g, '-')}.${stamp}.${source}.md`), md);
  console.log(`kept the ${source} version of ${name} in conflicts/`);
}

// Tabs. A week's tabs live in weeks/<Monday>/ and a day's own tabs in days/<date>/: one
// markdown file per tab, named after it, and tabs.json with the order, a stable id per tab
// and, for week tabs, whether the tab is shared with each day. A week nobody has written to
// yet shows the tabs of the latest earlier week, empty.
const scopeDir = (kind, key) => path.join(kind === 'week' ? WEEKS : DAYS, key);
const tabFile = (kind, key, tab) => path.join(scopeDir(kind, key), `${tab.name}.md`);
const readTab = (kind, key, tab) => read(tabFile(kind, key, tab)).trim();

function inheritedTabs(monday) {
  if (monday >= mondayOf(CUTOVER)) return [];
  const earlier = fs.readdirSync(WEEKS)
    .filter((m) => isDate(m) && m < monday && fs.existsSync(path.join(WEEKS, m, 'tabs.json')))
    .sort().at(-1);
  return earlier ? JSON.parse(read(path.join(WEEKS, earlier, 'tabs.json'))) : structuredClone(FIRST_WEEK_TABS);
}

function listTabs(kind, key) {
  const dir = scopeDir(kind, key);
  const file = path.join(dir, 'tabs.json');
  const saved = fs.existsSync(file) ? JSON.parse(read(file)) : null;
  const tabs = saved ?? (kind === 'week' ? inheritedTabs(key) : []);
  if (!fs.existsSync(dir)) return tabs;
  // Files added by hand (or by the bot) become tabs at the end.
  const extra = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !tabs.some((t) => `${t.name}.md` === f)).sort();
  for (const f of extra) tabs.push({ id: randomUUID().slice(0, 8), name: f.slice(0, -3), ...(kind === 'week' && { shared: false }) });
  if (!saved || extra.length) saveTabs(kind, key, tabs);
  return tabs;
}

const saveTabs = (kind, key, tabs) => writeFile(path.join(scopeDir(kind, key), 'tabs.json'), JSON.stringify(tabs, null, 2) + '\n');

function writeTabText(kind, key, tab, md) {
  md = md.trim();
  if (md === readTab(kind, key, tab)) return;
  saveTabs(kind, key, listTabs(kind, key)); // a week's inherited tab list becomes its own
  writeFile(tabFile(kind, key, tab), md ? `${md}\n` : '');
}

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function uniqueName(tabs, wanted) {
  let name = cleanTabName(wanted) || 'Untitled';
  if (sameName(name, 'Notes')) name = 'Notes 2';
  const base = name;
  for (let i = 2; tabs.some((t) => sameName(t.name, name)); i++) name = `${base} ${i}`;
  return name;
}

// Adds, renames, shares or removes a tab; returns the tab it acted on.
function changeTabs(kind, key, { op, id, name, shared }) {
  const tabs = listTabs(kind, key);
  const tab = tabs.find((t) => t.id === id);
  if (op === 'add') {
    const added = { id: randomUUID().slice(0, 8), name: uniqueName(tabs, name ?? ''), ...(kind === 'week' && { shared: false }) };
    saveTabs(kind, key, [...tabs, added]);
    return added;
  }
  if (!tab) throw Object.assign(new Error('no such tab'), { status: 404 });
  if (op === 'rename') {
    const to = uniqueName(tabs.filter((t) => t !== tab), name ?? '');
    if (fs.existsSync(tabFile(kind, key, tab))) fs.renameSync(tabFile(kind, key, tab), tabFile(kind, key, { name: to }));
    tab.name = to;
  } else if (op === 'share' && kind === 'week') {
    tab.shared = !!shared;
  } else if (op === 'remove') {
    keep(`${key} ${tab.name}`, 'removed', readTab(kind, key, tab));
    fs.rmSync(tabFile(kind, key, tab), { force: true });
    tabs.splice(tabs.indexOf(tab), 1);
  } else {
    throw Object.assign(new Error('bad op'), { status: 400 });
  }
  saveTabs(kind, key, tabs);
  return tab;
}

// Views: what each editor tab shows, and how an edit to it is written back. `stale` means
// the edit started from an older version; replaced parts are then kept in conflicts/.
const sharedTabs = (monday) => listTabs('week', monday).filter((t) => t.shared);

function dayView(date) {
  if (date >= CUTOVER) return readDay(date);
  const monday = mondayOf(date);
  const shared = sharedTabs(monday).map((t) => ({ name: t.name, md: readTab('week', monday, t) }));
  return composeDay(splitDay(readDay(date)), shared);
}

function writeDayView(date, md, stale) {
  if (date >= CUTOVER) {
    if (stale && readDay(date).trim() !== md.trim()) keep(date, 'replaced', readDay(date));
    if (md.trim() !== readDay(date).trim()) writeFile(dayFile(date), `${md.trim()}\n`);
    return;
  }
  const monday = mondayOf(date);
  const tabs = sharedTabs(monday);
  const view = splitDayView(md, tabs.map((t) => t.name));
  const old = readDay(date);
  const day = joinDay(view);
  if (stale && joinDay(splitDay(old)) !== day) keep(date, 'replaced', old);
  writeDay(date, day);
  for (const t of tabs) {
    if (stale && readTab('week', monday, t) !== view.shared[t.name]) keep(`${monday} ${t.name}`, 'replaced', readTab('week', monday, t));
    writeTabText('week', monday, t, view.shared[t.name]);
  }
}

const parts = (monday, which) => Object.fromEntries(weekDates(monday).map((d) => [d, splitDay(readDay(d))[which]]));

function writeWeekPart(monday, which, byDate, stale) {
  for (const [date, text] of Object.entries(byDate)) {
    const old = splitDay(readDay(date))[which];
    if (stale && old !== text) keep(date, 'replaced', readDay(date));
    (which === 'plan' ? setPlan : setNotes)(date, text);
  }
}

function view(url) {
  const date = url.searchParams.get('date');
  const monday = mondayOf(date);
  switch (url.pathname) {
    case '/api/day':
      if (date >= pageDate()) return null; // today and later are the running page
      return { read: () => dayView(date), write: (md, stale) => writeDayView(date, md, stale) };
    case '/api/week':
      return {
        read: () => weekPlans(monday, parts(monday, 'plan')),
        write: (md, stale) => writeWeekPart(monday, 'plan', splitWeekPlans(monday, md), stale),
      };
    case '/api/notes':
      return {
        read: () => weekNotes(monday, parts(monday, 'notes')),
        write: (md, stale) => writeWeekPart(monday, 'notes', splitWeekNotes(monday, md), stale),
      };
    case '/api/tab': {
      const kind = url.searchParams.get('kind') === 'week' ? 'week' : 'day';
      const key = kind === 'week' ? monday : date;
      const find = () => listTabs(kind, key).find((t) => t.id === url.searchParams.get('id'));
      if (!find()) return null;
      return {
        read: () => (readTab(kind, key, find()) ? `${readTab(kind, key, find())}\n` : ''),
        write: (md, stale) => {
          const tab = find();
          if (stale && readTab(kind, key, tab) !== md.trim()) keep(`${key} ${tab.name}`, 'replaced', readTab(kind, key, tab));
          writeTabText(kind, key, tab, md);
        },
      };
    }
  }
  return null;
}

// Before tabs, a week's After hours text was weeks/<Monday>.md.
function migrateAfterHours() {
  for (const f of fs.readdirSync(WEEKS)) {
    const monday = f.slice(0, -3);
    if (!f.endsWith('.md') || !isDate(monday) || fs.existsSync(path.join(WEEKS, monday))) continue;
    const text = read(path.join(WEEKS, f)).trim();
    saveTabs('week', monday, FIRST_WEEK_TABS);
    if (text) writeFile(tabFile('week', monday, FIRST_WEEK_TABS[0]), `${text}\n`);
    fs.rmSync(path.join(WEEKS, f));
    console.log(`moved ${f} to ${monday}/After hours.md`);
  }
}
migrateAfterHours();

function git(...args) {
  return execFileSync('git', ['-C', DATA, ...args], { encoding: 'utf8' });
}

// History of every day file and the page: commit pending changes every ten minutes.
const TRACKED = ['days', 'weeks', 'conflicts', 'page.md', 'page.json'];
function snapshot() {
  try {
    if (!git('status', '--porcelain', ...TRACKED).trim()) return;
    git('add', '-A', ...TRACKED);
    git('-c', 'user.name=daily-plans', '-c', 'user.email=daily-plans@localhost', 'commit', '-qm', 'snapshot');
  } catch (e) {
    console.error('snapshot failed:', e.message);
  }
}

function localNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// The running page. It starts as the first day's entry; after that, the first check past
// midnight saves it as the file of the day it belonged to, tags that state in Git
// (eod/YYYY-MM-DD) and carries on as the next day's page. A missed midnight is caught up by
// the next check, and the page goes to the day it last belonged to.
const readPage = () => read(PAGE);
const pageDate = () => JSON.parse(read(PAGE_META) || '{}').date;
const writePage = (md) => writeFile(PAGE, md.trim() ? `${md.trim()}\n` : '');

function startPage() {
  if (fs.existsSync(PAGE_META)) return;
  const { date } = localNow();
  writePage(readDay(date));
  writeFile(PAGE_META, JSON.stringify({ date }) + '\n');
  console.log(`started the running page from ${date}`);
}

function rollOver() {
  const { date } = localNow();
  const from = pageDate();
  if (!from || date <= from) return;
  snapshot();
  if (readPage().trim()) writeFile(dayFile(from), readPage());
  writeFile(PAGE_META, JSON.stringify({ date }) + '\n');
  snapshot();
  try {
    git('tag', '-f', `eod/${from}`);
  } catch (e) {
    console.error('tag failed:', e.message);
  }
  console.log(`saved the page as ${from}; it is now ${date}'s page`);
}

// The Doc tabs of one week: the week tab itself (each day's plan), then child tabs for
// Notes, each week tab and each day's own tab. Each Doc tab is made of parts (a day's plan,
// a day's notes, a tab's text) that are compared and copied whole.
function docSpecs(monday) {
  const dates = weekDates(monday);
  const specs = [
    {
      key: 'main', title: tabTitle(monday),
      parts: dates.map((d) => ({ key: `plan:${d}`, name: `${d} plan`, read: () => splitDay(readDay(d)).plan, write: (t) => setPlan(d, t) })),
      compose: () => weekPlans(monday, parts(monday, 'plan'), { forDoc: true }),
      split: (md) => prefix('plan', splitWeekPlans(monday, md)),
    },
    {
      key: 'notes', title: 'Notes',
      parts: dates.map((d) => ({ key: `notes:${d}`, name: `${d} notes`, read: () => splitDay(readDay(d)).notes, write: (t) => setNotes(d, t) })),
      compose: () => weekNotes(monday, parts(monday, 'notes')),
      split: (md) => prefix('notes', splitWeekNotes(monday, md)),
    },
  ];
  const tabSpec = (kind, key, tab, title) => {
    const id = kind === 'week' ? `w:${tab.id}` : `d:${key}:${tab.id}`;
    const current = () => listTabs(kind, key).find((t) => t.id === tab.id);
    return {
      key: id, title,
      parts: [{ key: id, name: `${key} ${tab.name}`, read: () => readTab(kind, key, current() ?? tab), write: (t) => current() && writeTabText(kind, key, current(), t) }],
      compose: () => readTab(kind, key, current() ?? tab),
      split: (md) => ({ [id]: md.trim() }),
    };
  };
  for (const t of listTabs('week', monday)) specs.push(tabSpec('week', monday, t, t.name));
  for (const d of dates) for (const t of listTabs('day', d)) specs.push(tabSpec('day', d, t, `${dayLabel(d)} · ${t.name}`));
  return specs;
}

const prefix = (p, byDate) => Object.fromEntries(Object.entries(byDate).map(([d, t]) => [`${p}:${d}`, t]));

// The Today tab and the running page: the same rule as a week's parts, for one part.
// Returns true when it wrote to the Doc, so the weeks wait for the next check.
async function syncPage(doc, state) {
  const p = (state.page ??= { app: '', doc: '', tabId: null });
  let tab = doc.tabs.find((t) => t.tabProperties.tabId === p.tabId) ?? doc.tabs.find((t) => t.tabProperties.title === PAGE_TAB);
  p.tabId = tab?.tabProperties.tabId ?? null;
  const app = readPage().trim();
  const docText = tab ? tabToMarkdown(tab).trim() : undefined;
  const appChanged = app !== p.app;
  const docChanged = docText !== undefined && docText !== p.doc;
  if (docChanged && !appChanged) {
    writePage(docText);
    [p.app, p.doc] = [readPage().trim(), docText];
    console.log('pulled the page from the Doc');
    return false;
  }
  if (tab && !appChanged) return false;
  if (docChanged) keep('page', 'doc', docText);
  try {
    let revision = doc.revisionId;
    if (!tab) {
      const added = await addTab(DOC_ID, doc, { title: PAGE_TAB, index: 0 }, revision);
      [p.tabId, revision] = [added.tabId, added.revisionId];
      tab = { tabProperties: { tabId: added.tabId } };
    }
    await writeTab(DOC_ID, tab, app, revision);
    const after = flatTabs((await getDoc(DOC_ID)).tabs).find((t) => t.tabProperties.tabId === p.tabId);
    [p.app, p.doc] = [app, after ? tabToMarkdown(after).trim() : ''];
    console.log('pushed the page');
  } catch (e) {
    console.error('push of the page stopped:', e.message);
  }
  return true;
}

// One check. For each week, compare each part on both sides with the version both sides
// had at the last sync (each side keeps its own copy, so formatting differences between
// markdown and Docs never look like edits). Pull parts changed only in the Doc; rewrite
// each Doc tab with a part changed in the app. At most one week is written per check, and
// every write is refused if the Doc changed since it was read.
async function syncOnce() {
  if (!DOC_ID) return;
  const doc = await getDoc(DOC_ID);
  const byId = new Map(flatTabs(doc.tabs).map((t) => [t.tabProperties.tabId, t]));
  let state = readState();
  if (state.version !== STATE_VERSION) {
    // The Doc still has the old one-tab layout: rewrite every known week from the app.
    state = { version: STATE_VERSION, weeks: {}, rewrite: Object.keys(state.weeks ?? {}) };
  }
  const mondays = new Set([...Object.keys(state.weeks), ...state.rewrite]);
  for (const f of fs.readdirSync(DAYS)) if (isDate(f.slice(0, 10))) mondays.add(mondayOf(f.slice(0, 10)));
  for (const f of fs.readdirSync(WEEKS)) if (isDate(f)) mondays.add(f);
  const thisMonday = mondayOf(new Date().toISOString().slice(0, 10));
  for (let i = -26; i <= 26; i++) {
    const monday = addDays(thisMonday, 7 * i);
    if (doc.tabs.some((t) => t.tabProperties.title === tabTitle(monday))) mondays.add(monday);
  }

  let wrote = await syncPage(doc, state);
  for (const monday of [...mondays].sort()) {
    const week = (state.weeks[monday] ??= { app: {}, doc: {}, tabs: {} });
    const rewrite = state.rewrite.includes(monday);
    const main = byId.get(week.tabs.main) ?? doc.tabs.find((t) => t.tabProperties.title === tabTitle(monday));
    const children = main?.childTabs ?? [];
    const specs = docSpecs(monday);
    const work = [];
    for (const spec of specs) {
      const tab = spec.key === 'main' ? main
        : children.find((t) => t.tabProperties.tabId === week.tabs[spec.key])
          ?? children.find((t) => t.tabProperties.title === spec.title && !Object.values(week.tabs).includes(t.tabProperties.tabId));
      if (tab) week.tabs[spec.key] = tab.tabProperties.tabId;
      const docParts = tab ? spec.split(tabToMarkdown(tab)) : {};
      let push = rewrite && (tab || spec.parts.some((p) => p.read()));
      for (const part of spec.parts) {
        const app = part.read();
        const docText = docParts[part.key];
        const appChanged = app !== (week.app[part.key] ?? '');
        const docChanged = !rewrite && docText !== undefined && docText !== (week.doc[part.key] ?? '');
        if (docChanged && !appChanged) {
          part.write(docText);
          week.app[part.key] = part.read();
          week.doc[part.key] = docText;
          console.log(`pulled ${part.name} from the Doc`);
        } else if (appChanged) {
          if (docChanged) keep(part.name, 'doc', docText);
          push = true;
        }
      }
      const rename = tab && spec.key !== 'main' && tab.tabProperties.title !== spec.title;
      if (push || rename) work.push({ spec, tab, push, rename });
    }
    // Doc tabs whose app tab was removed.
    const live = new Set(specs.map((s) => s.key));
    const gone = Object.keys(week.tabs).filter((k) => !live.has(k));
    if (wrote || (!work.length && !gone.length)) continue;
    wrote = true;
    await writeWeek(monday, week, doc, main, specs, work, gone);
    state.rewrite = state.rewrite.filter((m) => m !== monday);
  }
  writeFile(STATE, JSON.stringify(state, null, 2));
}

async function writeWeek(monday, week, doc, main, specs, work, gone) {
  let revision = doc.revisionId;
  const written = [];
  try {
    if (!main) {
      const added = await addTab(DOC_ID, doc, { title: tabTitle(monday) }, revision);
      [week.tabs.main, revision] = [added.tabId, added.revisionId];
    }
    const mainId = week.tabs.main;
    for (const key of gone) {
      const tab = (main?.childTabs ?? []).find((t) => t.tabProperties.tabId === week.tabs[key]);
      if (tab) {
        const text = tabToMarkdown(tab).trim();
        if (text !== (week.doc[key] ?? '')) keep(`${monday} ${tab.tabProperties.title}`, 'doc', text);
        revision = await deleteTab(DOC_ID, tab.tabProperties.tabId, revision);
      }
      delete week.tabs[key];
      for (const side of [week.app, week.doc]) delete side[key];
    }
    for (const { spec, tab, push, rename } of work) {
      let target = tab ?? (spec.key === 'main' ? { tabProperties: { tabId: mainId } } : null);
      if (!target) {
        if (!spec.compose().trim()) { for (const p of spec.parts) week.app[p.key] = p.read(); continue; }
        const index = specs.slice(0, specs.indexOf(spec)).filter((s) => s.key !== 'main' && week.tabs[s.key]).length;
        const added = await addTab(DOC_ID, doc, { title: spec.title, parentTabId: mainId, index }, revision);
        revision = added.revisionId;
        week.tabs[spec.key] = added.tabId;
        target = { tabProperties: { tabId: added.tabId } };
      }
      if (rename) revision = await renameTab(DOC_ID, target.tabProperties.tabId, spec.title, revision);
      if (push) {
        const app = Object.fromEntries(spec.parts.map((p) => [p.key, p.read()]));
        revision = await writeTab(DOC_ID, target, spec.compose(), revision);
        written.push({ spec, app });
      }
    }
    console.log(`pushed ${tabTitle(monday)}`);
  } catch (e) {
    console.error(`push of ${tabTitle(monday)} stopped:`, e.message);
  } finally {
    // Record what the Doc now holds for every tab that was written.
    if (written.length) {
      const after = new Map(flatTabs((await getDoc(DOC_ID)).tabs).map((t) => [t.tabProperties.tabId, t]));
      for (const { spec, app } of written) {
        const tab = after.get(week.tabs[spec.key]);
        const docParts = tab ? spec.split(tabToMarkdown(tab)) : {};
        for (const p of spec.parts) {
          week.app[p.key] = app[p.key];
          week.doc[p.key] = docParts[p.key] ?? '';
        }
      }
    }
  }
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
    // Any web page Alejo opens can reach the tailnet, so refuse writes a page on another
    // site forged. Browsers mark them; scripts send no such header.
    if (req.method !== 'GET' && (req.headers['sec-fetch-site'] ?? 'same-origin') !== 'same-origin') {
      return send(403, 'cross-site request');
    }
    if (url.pathname === '/api/page' && ['GET', 'PUT'].includes(req.method)) {
      // X-Page-Date names the day the page belongs to, which changes at midnight.
      if (req.method === 'GET') {
        return send(200, readPage(), { 'X-Version': fingerprint(readPage()), 'X-Page-Date': pageDate() });
      }
      const md = await readBody(req);
      if (req.headers['x-version'] !== fingerprint(readPage()) && readPage().trim() !== md.trim()) keep('page', 'replaced', readPage());
      writePage(md);
      return send(204, '', { 'X-Version': fingerprint(readPage()), 'X-Page-Date': pageDate() });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!isDate(date ?? '')) return send(400, 'bad date');
      const monday = mondayOf(date);
      if (url.pathname === '/api/tabs') {
        if (req.method === 'POST') {
          const change = JSON.parse(await readBody(req));
          const kind = change.kind === 'week' ? 'week' : 'day';
          const tab = changeTabs(kind, kind === 'week' ? monday : date, change);
          return send(200, JSON.stringify(tab), { 'Content-Type': 'application/json' });
        }
        const tabs = { week: listTabs('week', monday), day: listTabs('day', date) };
        return send(200, JSON.stringify(tabs), { 'Content-Type': 'application/json' });
      }
      // X-Version identifies the content a client last saw; an edit sent with an older
      // version still wins, but the version it replaces is kept in conflicts/.
      const v = ['GET', 'PUT'].includes(req.method) && view(url);
      if (v && req.method === 'GET') {
        const text = v.read();
        return send(200, text, { 'X-Version': fingerprint(text) });
      }
      if (v) {
        const stale = req.headers['x-version'] !== fingerprint(v.read());
        v.write(await readBody(req), stale);
        return send(204, '', { 'X-Version': fingerprint(v.read()) });
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
    if (!e.status) console.error(e);
    send(e.status ?? 500, e.message);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`daily plans on http://127.0.0.1:${PORT}`));

setInterval(sync, SYNC_MS);
setInterval(snapshot, 10 * 60_000);
setInterval(rollOver, 60_000);
startPage();
rollOver();
sync();
