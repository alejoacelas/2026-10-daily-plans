import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import { addDays, dayLabel, isDate, mondayOf, tabTitle, weekDates } from '../shared/plans.js';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The view is a day, or the week containing `date`, and one of its tabs: null for the
// main tab, 'notes' for the week's Notes, or a tab id. The hash names the tab:
// #2026-10-11, #w2026-10-11/Notes, #2026-10-11/Call%20prep.
function viewFromHash() {
  const m = decodeURIComponent(location.hash).match(/^#(w?)(\d{4}-\d{2}-\d{2})(?:\/(.+))?$/);
  return m && isDate(m[2]) ? { week: m[1] === 'w', date: m[2], tabName: m[3] ?? null } : { week: false, date: today(), tab: null };
}

function apiUrl(v) {
  if (v.tab === 'notes') return `api/notes?date=${v.date}`;
  if (v.tab) return `api/tab?date=${v.date}&kind=${v.week ? 'week' : 'day'}&id=${v.tab}`;
  return `api/${v.week ? 'week' : 'day'}?date=${v.date}`;
}

let tabs = { week: [], day: [] }; // the tabs of the view's week and day, from the server

// The tabs shown in the title line, left to right; the main tab comes last.
function tabList(v = view) {
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

let view = viewFromHash();
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
      if (res.ok) return versions.set(url, res.headers.get('X-Version'));
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
  setStatus('saving');
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
  const current = tabList().find((t) => t.key === view.tab);
  return `#${view.week ? 'w' : ''}${view.date}${current?.key ? `/${encodeURIComponent(current.name)}` : ''}`;
}

function render() {
  const current = tabList().find((t) => t.key === view.tab);
  $('title').textContent = view.week ? tabTitle(mondayOf(view.date)) : dayLabel(view.date);
  document.title = current?.key ? `${current.name} · ${$('title').textContent}` : $('title').textContent;
  history.replaceState(null, '', viewHash());
  renderTabs();
}

function renderTabs() {
  const nav = $('tabs');
  nav.replaceChildren();
  const add = el('button', { className: 'add', title: 'New tab', textContent: '+' });
  add.onclick = addTab;
  nav.append(add);
  for (const t of tabList()) {
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
  if (!view.tab && editor.state.doc.firstChild.type.name === 'heading') {
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
  await loadTabs(next.date);
  const list = tabList(next);
  const wanted = next.tabName !== undefined
    ? list.find((t) => t.key && t.name.toLowerCase() === next.tabName?.toLowerCase())
    : list.find((t) => t.key === next.tab);
  view = { week: next.week, date: next.date, tab: wanted?.key ?? null };
  render();
  const res = await fetch(apiUrl(view));
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
    // Same tab, previous or next day (day view) or week (week view).
    e.preventDefault();
    const name = tabList().find((t) => t.key === view.tab).name;
    go({ week: view.week, date: addDays(view.date, view.week ? 7 * step : step), tabName: view.tab ? name : null });
  } else if (step) {
    e.preventDefault();
    const list = tabList();
    const i = list.findIndex((t) => t.key === view.tab);
    go({ ...view, tab: list[(i + step + list.length) % list.length].key });
  } else if (e.code === 'Backslash') {
    e.preventDefault();
    const day = view.week && view.tab !== null && view.tab !== 'notes' ? null : dayAtCursor();
    go(view.week ? { week: false, date: day ?? view.date, tab: null } : { week: true, date: view.date, tab: null });
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

$('title').addEventListener('click', () => go({ week: false, date: today(), tab: null }));

// Pick up changes from the Doc or another device: every few seconds while the page is
// visible, and whenever the window regains focus, but never mid-edit.
async function refresh() {
  const quiet = () => !dirty && !unsaved && !loading && editor.isEditable && Date.now() - lastInput > 3000
    && !document.querySelector('input.rename');
  if (document.hidden || !quiet()) return;
  // Tabs added, renamed or removed elsewhere (another device, the bot).
  const before = JSON.stringify(tabs);
  const date = view.date;
  await loadTabs(date);
  if (date !== view.date || !quiet()) return;
  if (JSON.stringify(tabs) !== before) {
    if (!tabList().some((t) => t.key === view.tab)) return go({ ...view, tab: null });
    render();
  }
  const url = apiUrl(view);
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return;
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

go(view);
