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
  if (i < 0) return { plan: md.trim(), notes: '' };
  return { plan: lines.slice(0, i).join('\n').trim(), notes: lines.slice(i + 1).join('\n').trim() };
}

export function joinDay({ plan, notes }) {
  return [plan, '## Notes', notes].filter(Boolean).join('\n\n') + '\n';
}

// The week: each day's plan under "## Mon, Oct 5", then "## Notes" with each day's
// non-empty notes under a bold "**Mon, Oct 5**" line. The doc version drops empty days.
export function composeWeek(monday, days, { forDoc = false } = {}) {
  const parts = [];
  const notes = [];
  for (const date of weekDates(monday)) {
    const day = splitDay(days[date]);
    if (day.plan || !forDoc) parts.push(`## ${dayLabel(date)}`, day.plan);
    if (day.notes) notes.push(`**${dayLabel(date)}**`, day.notes);
  }
  if (notes.length || !forDoc) parts.push('## Notes', ...notes);
  return parts.filter(Boolean).join('\n\n') + '\n';
}

// Inverse of composeWeek: returns { date: dayMarkdown } for all seven days.
// Text above the first day heading, or above the first bold label under Notes, goes to Monday.
export function splitWeek(monday, md) {
  const dates = weekDates(monday);
  const byLabel = Object.fromEntries(dates.map((d) => [dayLabel(d), d]));
  const plan = Object.fromEntries(dates.map((d) => [d, []]));
  const notes = Object.fromEntries(dates.map((d) => [d, []]));
  let section = plan;
  let current = monday;
  for (const line of md.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    const bold = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (section === plan && heading && byLabel[heading[1]]) current = byLabel[heading[1]];
    else if (section === plan && NOTES_HEADING.test(line)) [section, current] = [notes, monday];
    else if (section === notes && bold && byLabel[bold[1]]) current = byLabel[bold[1]];
    else section[current].push(line);
  }
  return Object.fromEntries(dates.map((d) => [
    d, joinDay({ plan: plan[d].join('\n').trim(), notes: notes[d].join('\n').trim() }),
  ]));
}
