// Dates, labels and the day/week markdown formats, shared by the editor and the server.
// Dates are ISO strings (YYYY-MM-DD); weeks run Monday to Sunday and use ISO week numbers.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NOTES_HEADING = /^##\s+Notes\s*$/;

const parse = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const format = (d) => d.toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && format(parse(s)) === s;

export function addDays(date, n) {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + n);
  return format(d);
}

export const weekday = (date) => (parse(date).getUTCDay() + 6) % 7; // Monday = 0
export const mondayOf = (date) => addDays(date, -weekday(date));
export const weekDates = (monday) => DAYS.map((_, i) => addDays(monday, i));

export function dayLabel(date) {
  const d = parse(date);
  return `${DAYS[weekday(date)]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function isoWeek(date) {
  const thursday = parse(addDays(mondayOf(date), 3));
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return 1 + Math.floor((thursday - jan1) / 864e5 / 7);
}

// Google Doc tab title, e.g. "w41, Oct 05".
export function tabTitle(monday) {
  const d = parse(monday);
  return `w${pad(isoWeek(monday))}, ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}`;
}

// A day file is the plan, then a "## Notes" heading, then the notes.
export function splitDay(md = '') {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => NOTES_HEADING.test(l));
  if (i < 0) return { plan: lines.join('\n').trim(), notes: '' };
  return { plan: lines.slice(0, i).join('\n').trim(), notes: lines.slice(i + 1).join('\n').trim() };
}

export function joinDay({ plan, notes }) {
  return [plan, '## Notes', notes].filter(Boolean).join('\n\n') + '\n';
}

// A day's main tab: the plan, then each week tab shared with the days under its own
// "## Name" heading, then the notes. `shared` is [{ name, md }] in tab order.
export function composeDay({ plan, notes }, shared = []) {
  const parts = [plan];
  for (const s of shared) parts.push(`## ${s.name}`, s.md.trim());
  parts.push('## Notes', notes);
  return parts.filter(Boolean).join('\n\n') + '\n';
}

// Inverse of composeDay: { plan, notes, shared: { name: md } }. A heading names a section
// only when it matches a shared tab or Notes; other headings belong to the text around them.
export function splitDayView(md, names = []) {
  const byName = new Map(names.map((n) => [n.toLowerCase(), n]));
  const sections = { plan: [], notes: [] };
  const shared = Object.fromEntries(names.map((n) => [n, []]));
  let current = sections.plan;
  for (const line of md.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    const name = heading && byName.get(heading[1].toLowerCase());
    if (NOTES_HEADING.test(line)) current = sections.notes;
    else if (name && current !== sections.notes) current = shared[name];
    else current.push(line);
  }
  const text = (lines) => lines.join('\n').trim();
  return {
    plan: text(sections.plan), notes: text(sections.notes),
    shared: Object.fromEntries(names.map((n) => [n, text(shared[n])])),
  };
}

// The week's main tab: each day's plan under "## Mon, Oct 5". The Doc version drops empty days.
export function weekPlans(monday, plans, { forDoc = false } = {}) {
  const parts = [];
  for (const date of weekDates(monday)) {
    if (plans[date] || !forDoc) parts.push(`## ${dayLabel(date)}`, plans[date]);
  }
  return parts.filter(Boolean).join('\n\n') + '\n';
}

// The week's Notes tab: each day's non-empty notes under a bold "**Mon, Oct 5**" line.
export function weekNotes(monday, notes) {
  const parts = [];
  for (const date of weekDates(monday)) if (notes[date]) parts.push(`**${dayLabel(date)}**`, notes[date]);
  return parts.length ? parts.join('\n\n') + '\n' : '';
}

// Inverses of weekPlans and weekNotes: { date: text } for all seven days. Text above the
// first label goes to Monday.
export const splitWeekPlans = (monday, md) => splitByLabel(monday, md, /^##\s+(.+?)\s*$/);
export const splitWeekNotes = (monday, md) => splitByLabel(monday, md, /^\*\*(.+?)\*\*\s*$/);

function splitByLabel(monday, md = '', pattern) {
  const dates = weekDates(monday);
  const byLabel = Object.fromEntries(dates.map((d) => [dayLabel(d), d]));
  const out = Object.fromEntries(dates.map((d) => [d, []]));
  let current = monday;
  for (const line of md.split('\n')) {
    const label = line.match(pattern);
    if (label && byLabel[label[1]]) current = byLabel[label[1]];
    else out[current].push(line);
  }
  return Object.fromEntries(dates.map((d) => [d, out[d].join('\n').trim()]));
}

// Tab names become file names and Doc tab titles.
export const cleanTabName = (s) => s.replace(/[\/\\\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60);

// Short content fingerprint (FNV-1a), used to tell the server which version an edit started from.
export function fingerprint(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}
