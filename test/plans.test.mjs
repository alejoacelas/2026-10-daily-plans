import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeWeek, dayLabel, isoWeek, splitDay, splitWeek, tabTitle } from '../shared/plans.js';
import { layout } from '../server/gdocs.mjs';

const monday = '2026-10-05';
const days = {
  '2026-10-07': '- [ ] Draft proposal\n- [x] Gym\n\n## Notes\n\nSam prefers Thursday\n',
  '2026-10-11': '### Evening\n\nRead\n\n## Notes\n',
};

test('labels and tab titles', () => {
  assert.equal(dayLabel('2026-10-11'), 'Sun, Oct 11');
  assert.equal(isoWeek('2026-10-11'), 41);
  assert.equal(isoWeek('2027-01-01'), 53);
  assert.equal(tabTitle(monday), 'w41, Oct 05');
});

test('week round-trips into the same days', () => {
  const back = splitWeek(monday, composeWeek(monday, days));
  assert.equal(back['2026-10-07'], days['2026-10-07']);
  assert.equal(back['2026-10-11'], days['2026-10-11']);
  assert.deepEqual(splitDay(back['2026-10-05']), { plan: '', notes: '' });
});

test('doc version drops empty days and empty notes', () => {
  assert.equal(composeWeek(monday, days, { forDoc: true }),
    '## Wed, Oct 7\n\n- [ ] Draft proposal\n- [x] Gym\n\n### Evening\n\nRead\n\n'.replace('### Evening', '## Sun, Oct 11\n\n### Evening') +
    '## Notes\n\n**Wed, Oct 7**\n\nSam prefers Thursday\n');
});

test('notes typed in the week view land on their day', () => {
  const md = composeWeek(monday, days) + '\n**Fri, Oct 9**\n\nnew note\n';
  assert.equal(splitDay(splitWeek(monday, md)['2026-10-09']).notes, 'new note');
});

test('layout indents nested list items and records one list range', () => {
  const { text, lists, spans } = layout('- [ ] a\n  - [x] b\n- c\n');
  assert.equal(text, 'a\n\tb\nc\n');
  assert.deepEqual(lists, [{ start: 0, end: 7, preset: 'BULLET_CHECKBOX' }]);
  assert.ok(spans.some((s) => s.style.strikethrough && text.slice(s.start, s.end) === 'b'));
});
