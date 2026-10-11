import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import { addDays, dayLabel, isDate, isoWeek, mondayOf, tabTitle, weekDates } from '../shared/plans.js';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The view is a day, or the week containing `date` (#w2026-10-11).
function viewFromHash() {
  const m = location.hash.match(/^#(w?)(\d{4}-\d{2}-\d{2})$/);
  return m && isDate(m[2]) ? { week: m[1] === 'w', date: m[2] } : { week: false, date: today() };
}
const apiUrl = (v) => `api/${v.week ? 'week' : 'day'}?date=${v.date}`;

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

function render() {
  const monday = mondayOf(view.date);
  $('title').textContent = view.week ? tabTitle(monday) : dayLabel(view.date);
  $('week').textContent = view.week ? 'week' : `w${pad(isoWeek(view.date))}`;
  document.title = $('title').textContent;
  history.replaceState(null, '', `#${view.week ? 'w' : ''}${view.date}`);
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
  if (view.week) {
    const pos = endOf((n) => n.type.name === 'heading' && n.textContent.trim() === dayLabel(view.date));
    editor.chain().focus().setTextSelection(pos ?? 1).scrollIntoView().run();
    return;
  }
  if (editor.state.doc.firstChild.type.name === 'heading') {
    // Empty plan: open a line above "Notes" to type in.
    loading = true;
    editor.chain().insertContentAt(0, { type: 'paragraph' }).run();
    loading = false;
  }
  editor.chain().focus().setTextSelection(1).run();
  window.scrollTo(0, 0);
}

async function go(next) {
  await flush();
  editor.setEditable(false, false);
  view = next;
  render();
  const res = await fetch(apiUrl(view));
  const text = await res.text();
  versions.set(apiUrl(view), res.headers.get('X-Version'));
  setContent(text);
  editor.setEditable(true, false);
  placeCursor();
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
    else if (node.type.name === 'heading' && text === 'After hours') day = null;
  });
  return day;
}

async function syncNow() {
  await flush();
  $('week').textContent = 'syncing…';
  const res = await fetch(`api/sync?date=${view.date}`, { method: 'POST' }).catch(() => null);
  $('week').textContent = res?.ok ? 'synced' : 'sync failed';
  setTimeout(render, 2000);
  refresh();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Meta') hintTimer = setTimeout(() => document.body.classList.add('hints'), 700);
  if (!(e.metaKey || e.ctrlKey)) return;
  clearTimeout(hintTimer);
  const step = { BracketLeft: -1, BracketRight: 1 }[e.code];
  if (step) {
    e.preventDefault();
    const byWeek = e.shiftKey || view.week;
    go({ week: view.week, date: addDays(view.date, byWeek ? 7 * step : step) });
  } else if (e.code === 'Backslash') {
    e.preventDefault();
    go(view.week ? { week: false, date: dayAtCursor() ?? view.date } : { week: true, date: view.date });
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
  const next = viewFromHash();
  if (next.date !== view.date || next.week !== view.week) go(next);
});

$('title').addEventListener('click', () => go({ week: false, date: today() }));

// Pick up changes from the Doc or another device: every few seconds while the page is
// visible, and whenever the window regains focus, but never mid-edit.
async function refresh() {
  const quiet = () => !dirty && !unsaved && !loading && editor.isEditable && Date.now() - lastInput > 3000;
  if (document.hidden || !quiet()) return;
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
