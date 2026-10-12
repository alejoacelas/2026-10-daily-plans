import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTabName, composeDay, dayLabel, isoWeek, splitDay, splitDayView, splitWeekNotes, splitWeekPlans, tabTitle,
  weekNotes, weekPlans,
} from '../shared/plans.js';
import { layout } from '../server/gdocs.mjs';

const monday = '2026-10-05';
const plans = { '2026-10-07': '- [ ] Draft proposal\n- [x] Gym', '2026-10-11': '### Evening\n\nRead' };
const notes = { '2026-10-07': 'Sam prefers Thursday' };

test('labels and tab titles', () => {
  assert.equal(dayLabel('2026-10-11'), 'Sun, Oct 11');
  assert.equal(isoWeek('2026-10-11'), 41);
  assert.equal(isoWeek('2027-01-01'), 53);
  assert.equal(tabTitle(monday), 'w41, Oct 05');
});

test('week plans round-trip into the same days', () => {
  const back = splitWeekPlans(monday, weekPlans(monday, plans));
  assert.equal(back['2026-10-07'], plans['2026-10-07']);
  assert.equal(back['2026-10-11'], plans['2026-10-11']);
  assert.equal(back['2026-10-05'], '');
});

test('the Doc version of the plans drops empty days', () => {
  assert.equal(weekPlans(monday, plans, { forDoc: true }),
    '## Wed, Oct 7\n\n- [ ] Draft proposal\n- [x] Gym\n\n## Sun, Oct 11\n\n### Evening\n\nRead\n');
});

test('week notes list only days with notes and split back by label', () => {
  const md = weekNotes(monday, notes);
  assert.equal(md, '**Wed, Oct 7**\n\nSam prefers Thursday\n');
  const typed = `${md}\n**Fri, Oct 9**\n\nnew note\n`;
  assert.equal(splitWeekNotes(monday, typed)['2026-10-09'], 'new note');
  assert.equal(splitWeekNotes(monday, typed)['2026-10-07'], 'Sam prefers Thursday');
});

test('a day view holds the plan, the shared week tabs, then the notes', () => {
  const view = composeDay({ plan: '- run', notes: 'note' }, [{ name: 'After hours', md: '- read' }, { name: 'Reading', md: '' }]);
  assert.equal(view, '- run\n\n## After hours\n\n- read\n\n## Reading\n\n## Notes\n\nnote\n');
  const back = splitDayView(view, ['After hours', 'Reading']);
  assert.deepEqual(back, { plan: '- run', notes: 'note', shared: { 'After hours': '- read', Reading: '' } });
  assert.deepEqual(splitDay('- run\n\n## Notes\n\nnote\n'), { plan: '- run', notes: 'note' });
});

test('headings that are not shared tabs stay in the text', () => {
  const back = splitDayView('## Morning\n\n- run\n\n## Notes\n\n## After hours\n\nx\n', ['After hours']);
  assert.equal(back.plan, '## Morning\n\n- run');
  assert.equal(back.notes, '## After hours\n\nx');
});

test('tab names are safe file names', () => {
  assert.equal(cleanTabName('  a/b\\c  '), 'a b c');
  assert.equal(cleanTabName('..hidden'), 'hidden');
});

test('layout indents nested list items and records one list range', () => {
  const { text, lists, spans } = layout('- [ ] a\n  - [x] b\n- c\n');
  assert.equal(text, 'a\n\tb\nc\n');
  assert.deepEqual(lists, [{ start: 0, end: 7, preset: 'BULLET_CHECKBOX' }]);
  assert.ok(spans.some((s) => s.style.strikethrough && text.slice(s.start, s.end) === 'b'));
});
