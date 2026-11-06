# Daily plans

A quiet markdown editor for daily plans. Today is one running page: it carries over
from day to day, and at midnight (London time) the server saves it as that day's
entry. Edits after midnight change only the new day. To keep a section from one day
to the next, leave it on the page.

⌘⇧[ and ⌘⇧] step through past days; ⌘⇧] past yesterday returns to the page, and so
does clicking the date. Days before Nov 6, 2026 keep their old layout: shared week tabs,
notes, and a week view (⌘\) for weeks before Nov 2.

The page lives in the "Today" tab of a Google Doc, and each past day in its week's
tab. Edits on either side reach the other within about 15 seconds. In the Doc, mark a
task done by striking it through (⌘⇧X): Google doesn't let apps read the checkbox tick.

| Keys | Action |
| --- | --- |
| ⌘⇧[ / ⌘⇧] | Previous / next day |
| ⌘S | Sync with the Google Doc now |
| ⌘[ / ⌘] | Previous / next tab (days before Nov 6) |
| ⌘\ | Switch between a day and its week (weeks before Nov 2) |

Add `?look=tint` (blue-grey background, blue headings) or `?look=flat` (the default) to
the address to change the look; the choice is remembered on that device.

The icon is a crop of Katsushika Hokusai's *Under the Wave off Kanagawa* (about 1831), from
[the Metropolitan Museum of Art's Open Access image](https://www.metmuseum.org/art/collection/search/45434) (public domain, CC0).
