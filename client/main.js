import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import { CUTOVER, addDays, dayLabel, isDate, mondayOf, tabTitle, weekDates } from '../shared/plans.js';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The view is the running page (no hash), a past day, or a week before the cutover, and
// one of its tabs: null for the main tab, 'notes' for the week's Notes, or a tab id. The
// hash names the tab: #2026-10-11, #w2026-10-11/Notes, #2026-10-11/Call%20prep.
let pageDate = today(); // the day the running page belongs to, as the server says
const PAGE = { page: true, week: false, date: null, tab: null };
const hasWeekView = (date) => mondayOf(date) < mondayOf(CUTOVER);

function viewFromHash() {
  const m = decodeURIComponent(location.hash).match(/^#(w?)(\d{4}-\d{2}-\d{2})(?:\/(.+))?$/);
  if (!m || !isDate(m[2]) || m[2] >= pageDate) return PAGE;
  return { week: m[1] === 'w' && hasWeekView(m[2]), date: m[2], tabName: m[3] ?? null };
}

// A past day, or the page for today and later.
const dayOrPage = (date, tabName = null) => (date >= pageDate ? PAGE : { week: false, date, tabName });

function apiUrl(v) {
  if (v.page) return 'api/page';
  if (v.tab === 'notes') return `api/notes?date=${v.date}`;
  if (v.tab) return `api/tab?date=${v.date}&kind=${v.week ? 'week' : 'day'}&id=${v.tab}`;
  return `api/${v.week ? 'week' : 'day'}?date=${v.date}`;
}

let tabs = { week: [], day: [] }; // the tabs of the view's week and day, from the server

// The tabs shown in the title line, left to right; the main tab comes last.
function tabList(v = view) {
  if (v.page) return [];
  const own = (v.week ? tabs.week : tabs.day).map((t) => ({ key: t.id, name: t.name, shared: t.shared, own: true }));
  return v.week
    ? [{ key: 'notes', name: 'Notes' }, ...own, { key: null, name: 'week' }]
    : [...own, { key: null, name: 'day' }];
}

const editor = new Editor({
  element: $('editor'),
  extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), Markdown],
  editable: false, // until the first view has loaded, so early typing isn't overwritten
});

let view = PAGE;
let loading = false;
let dirty = false;
let editingUrl = null;
let timer = null;
let lastInput = 0;
let unsaved = 0; // saves sent but not yet confirmed
const versions = new Map(); // api url → version of the content the editor last loaded or saved
let hintTimer = null;
let saves = Promise.resolve();

function setStatus(s) {
  $('status').className = s;
}

async function put(url, body) {
  for (;;) {
    try {
      const res = await fetch(url, {
        method: 'PUT', body, keepalive: body.length < 60_000, headers: { 'X-Version': versions.get(url) ?? '' },
      });
      if (res.ok) {
        notePageDate(res);
        return versions.set(url, res.headers.get('X-Version'));
      }
    } catch {}
    setStatus('error');
    await sleep(3000);
  }
}

// Sends the editor's content for the current view; saves run one at a time, in order.
function flush() {
  clearTimeout(timer);
  if (!dirty) return saves;
  dirty = false;
  if (editingUrl !== apiUrl(view)) return saves; // never save one view's text under another
  const url = editingUrl;
  const body = editor.getMarkdown();
  unsaved++;
  saves = saves.then(() => put(url, body)).then(() => --unsaved || dirty || setStatus(''));
  return saves;
}

editor.on('update', () => {
  if (loading || !editor.isEditable) return;
  dirty = true;
  lastInput = Date.now();
  editingUrl = apiUrl(view);
  clearTimeout(timer);
  timer = setTimeout(flush, 300);
});

function setContent(md) {
  loading = true;
  editor.commands.setContent(md, { contentType: 'markdown' });
  loading = false;
}

function viewHash() {
  if (view.page) return '';
  const current = tabList().find((t) => t.key === view.tab);
  return `#${view.week ? 'w' : ''}${view.date}${current?.key ? `/${encodeURIComponent(current.name)}` : ''}`;
}

function render() {
  const current = tabList().find((t) => t.key === view.tab);
  $('title').textContent = view.page ? dayLabel(pageDate) : view.week ? tabTitle(mondayOf(view.date)) : dayLabel(view.date);
  document.title = current?.key ? `${current.name} · ${$('title').textContent}` : $('title').textContent;
  history.replaceState(null, '', viewHash() || location.pathname + location.search);
  renderTabs();
}

function renderTabs() {
  const nav = $('tabs');
  nav.replaceChildren();
  // Tabs belong to the old layout: the page has none, and later days only show their own.
  const list = tabList();
  if (!view.page && view.date < CUTOVER) {
    const add = el('button', { className: 'add', title: 'New tab', textContent: '+' });
    add.onclick = addTab;
    nav.append(add);
  } else if (list.length <= 1) {
    return;
  }
  for (const t of list) {
    const tab = el('span', { className: `tab${t.key === view.tab ? ' on' : ''}` });
    const name = el('button', { className: 'name', textContent: t.name });
    name.onclick = () => t.key !== view.tab && go({ ...view, tab: t.key });
    if (t.own) {
      name.title = 'Double-click to rename';
      name.ondblclick = () => rename(t, name);
    }
    tab.append(name);
    if (t.own && view.week) {
      const dot = el('button', {
        className: `dot${t.shared ? ' on' : ''}`,
        title: t.shared ? 'Shown in each day. Click to keep it in the week only.' : 'Show in each day',
      });
      dot.setAttribute('aria-pressed', !!t.shared);
      dot.onclick = () => changeTab('week', { op: 'share', id: t.key, shared: !t.shared });
      tab.append(dot);
    }
    nav.append(tab);
  }
}

function el(tag, props) {
  return Object.assign(document.createElement(tag), props);
}

async function changeTab(kind, change) {
  await flush();
  const res = await fetch(`api/tabs?date=${view.date}`, { method: 'POST', body: JSON.stringify({ kind, ...change }) });
  if (!res.ok) return setStatus('error');
  const tab = await res.json();
  await loadTabs(view.date);
  render();
  return tab;
}

async function addTab() {
  editor.view.dom.blur(); // otherwise loading the new tab hands focus back to the editor
  const tab = await changeTab(view.week ? 'week' : 'day', { op: 'add', name: 'Untitled' });
  if (!tab) return;
  await go({ ...view, tab: tab.id }, { place: false });
  const button = [...$('tabs').querySelectorAll('.tab.on .name')][0];
  if (button) rename({ key: tab.id, name: tab.name }, button);
}

// Inline rename: Enter or leaving the field saves, Escape cancels, an empty name removes the tab.
function rename(t, button) {
  const input = el('input', { className: 'rename', value: t.name, size: Math.max(t.name.length, 4) });
  input.oninput = () => (input.size = Math.max(input.value.length, 4));
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    const kind = view.week ? 'week' : 'day';
    if (save && !name) {
      if (confirm(`Remove the tab "${t.name}"? Its text is kept in conflicts/ on the server.`)) {
        await changeTab(kind, { op: 'remove', id: t.key });
        return go({ ...view, tab: null });
      }
    } else if (save && name !== t.name) {
      await changeTab(kind, { op: 'rename', id: t.key, name });
    }
    render();
    editor.commands.focus();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  button.replaceWith(input);
  input.focus();
  input.select();
}

async function loadTabs(date) {
  const res = await fetch(`api/tabs?date=${date}`);
  if (res.ok) tabs = await res.json();
}

// Position just inside the end of the first top-level node matching `test`.
function endOf(test) {
  let pos = null;
  editor.state.doc.forEach((node, offset) => {
    if (pos === null && test(node)) pos = offset + node.nodeSize - 1;
  });
  return pos;
}

function placeCursor() {
  if (view.week && view.tab === 'notes') {
    const pos = endOf((n) => n.textContent.trim() === dayLabel(view.date));
    editor.chain().focus().setTextSelection(pos ?? 1).scrollIntoView().run();
    return;
  }
  if (view.week && !view.tab) {
    const pos = endOf((n) => n.type.name === 'heading' && n.textContent.trim() === dayLabel(view.date));
    editor.chain().focus().setTextSelection(pos ?? 1).scrollIntoView().run();
    return;
  }
  if (!view.page && view.date < CUTOVER && !view.tab && editor.state.doc.firstChild.type.name === 'heading') {
    // Empty plan: open a line above "Notes" to type in.
    loading = true;
    editor.chain().insertContentAt(0, { type: 'paragraph' }).run();
    loading = false;
  }
  editor.chain().focus().setTextSelection(1).run();
  window.scrollTo(0, 0);
}

// Opens a view. `next.tab` is a tab key; `next.tabName` (from the hash or from another
// day or week) picks a tab by name instead, falling back to the main tab.
async function go(next, { place = true } = {}) {
  await flush();
  editor.setEditable(false, false);
  if (next.page) {
    view = PAGE;
  } else {
    await loadTabs(next.date);
    const list = tabList(next);
    const wanted = next.tabName !== undefined
      ? list.find((t) => t.key && t.name.toLowerCase() === next.tabName?.toLowerCase())
      : list.find((t) => t.key === next.tab);
    view = { week: next.week, date: next.date, tab: wanted?.key ?? null };
  }
  render();
  const res = await fetch(apiUrl(view));
  notePageDate(res);
  const text = await res.text();
  versions.set(apiUrl(view), res.headers.get('X-Version'));
  setContent(text);
  editor.setEditable(true, false);
  if (place) placeCursor();
}

// The day whose section holds the cursor in the week view.
function dayAtCursor() {
  const labels = Object.fromEntries(weekDates(mondayOf(view.date)).map((d) => [dayLabel(d), d]));
  const cursor = editor.state.selection.from;
  let day = null;
  editor.state.doc.forEach((node, offset) => {
    if (offset > cursor) return;
    const text = node.textContent.trim();
    if (labels[text] && (node.type.name === 'heading' || node.type.name === 'paragraph')) day = labels[text];
  });
  return day;
}

async function syncNow() {
  await flush();
  $('flash').textContent = 'syncing…';
  const res = await fetch(`api/sync?date=${view.date}`, { method: 'POST' }).catch(() => null);
  $('flash').textContent = res?.ok ? 'synced' : 'sync failed';
  setTimeout(() => ($('flash').textContent = ''), 2000);
  refresh();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Meta') hintTimer = setTimeout(() => document.body.classList.add('hints'), 700);
  if (!(e.metaKey || e.ctrlKey)) return;
  clearTimeout(hintTimer);
  const step = { BracketLeft: -1, BracketRight: 1 }[e.code];
  if (step && e.shiftKey) {
    // Previous or next day (day view) or week (week view), on the same tab. The page is
    // the last day.
    e.preventDefault();
    if (view.page) return step < 0 && go(dayOrPage(addDays(pageDate, -1)));
    const name = view.tab ? tabList().find((t) => t.key === view.tab).name : null;
    const date = addDays(view.date, view.week ? 7 * step : step);
    go(view.week ? (hasWeekView(date) ? { week: true, date, tabName: name } : PAGE) : dayOrPage(date, name));
  } else if (step) {
    e.preventDefault();
    const list = tabList();
    if (list.length <= 1) return;
    const i = list.findIndex((t) => t.key === view.tab);
    go({ ...view, tab: list[(i + step + list.length) % list.length].key });
  } else if (e.code === 'Backslash') {
    e.preventDefault();
    if (view.week) {
      const day = view.tab !== null && view.tab !== 'notes' ? null : dayAtCursor();
      go(dayOrPage(day ?? view.date));
    } else if (!view.page && hasWeekView(view.date)) {
      go({ week: true, date: view.date, tab: null });
    }
  } else if (e.code === 'KeyS') {
    e.preventDefault();
    syncNow();
  }
}, true);

window.addEventListener('keyup', (e) => {
  if (e.key !== 'Meta') return;
  clearTimeout(hintTimer);
  document.body.classList.remove('hints');
});

window.addEventListener('hashchange', () => {
  if (location.hash !== viewHash()) go(viewFromHash());
});

$('title').addEventListener('click', () => go(PAGE));

// The page moves to the next day at midnight; the server says which day it belongs to.
function notePageDate(res) {
  const date = res?.headers.get('X-Page-Date');
  if (!date || date === pageDate) return;
  pageDate = date;
  if (view.page) render();
}

// Pick up changes from the Doc or another device: every few seconds while the page is
// visible, and whenever the window regains focus, but never mid-edit.
async function refresh() {
  const quiet = () => !dirty && !unsaved && !loading && editor.isEditable && Date.now() - lastInput > 3000
    && !document.querySelector('input.rename');
  if (document.hidden || !quiet()) return;
  // Tabs added, renamed or removed elsewhere (another device, the bot).
  if (!view.page) {
    const before = JSON.stringify(tabs);
    const date = view.date;
    await loadTabs(date);
    if (date !== view.date || !quiet()) return;
    if (JSON.stringify(tabs) !== before) {
      if (!tabList().some((t) => t.key === view.tab)) return go({ ...view, tab: null });
      render();
    }
  }
  const url = apiUrl(view);
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return;
  notePageDate(res);
  const text = await res.text();
  const version = res.headers.get('X-Version');
  if (!quiet() || url !== apiUrl(view) || version === versions.get(url)) return;
  versions.set(url, version);
  const { from } = editor.state.selection;
  setContent(text);
  editor.commands.setTextSelection(Math.min(from, editor.state.doc.content.size - 1));
}
setInterval(refresh, 5000);
window.addEventListener('focus', refresh);

document.addEventListener('visibilitychange', () => (document.hidden ? flush() : refresh()));
window.addEventListener('pagehide', flush);

// Learn the page's day before reading the hash, which may name a day that is now the page.
fetch('api/page').then(notePageDate, () => {}).finally(() => go(viewFromHash()));
