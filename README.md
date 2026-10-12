# Daily plans

A quiet markdown editor for daily plans. Each day has a plan and a `## Notes` section;
the week view stacks the plans, with the notes in their own tab.

Tabs sit on the right of the title line, with the main tab (**day** or **week**) last. Hover
over the title line for **+** to add a tab, and double-click a tab to rename it (clear the name
to remove it). A week tab with a grey dot is shared with every day: it appears in each day's
main tab between the plan and the notes. Hover over a week tab and click its ring to share it,
or click the dot to stop. New weeks start with the previous week's tabs, empty.

Each week also lives in its own tab of a Google Doc, with child tabs for Notes and the other
tabs, and edits on either side reach the other within about 15 seconds.
In the Doc, mark a task done by striking it through (⌘⇧X): Google doesn't let apps read the
checkbox tick.

| Keys | Action |
| --- | --- |
| ⌘[ / ⌘] | Previous / next tab |
| ⌘⇧[ / ⌘⇧] | Previous / next day (in the week view: previous / next week), on the same tab |
| ⌘\ | Switch between the day and its week (from the week, opens the day under the cursor) |
| ⌘S | Sync with the Google Doc now |

Every night the server saves a snapshot of this week and next, so you can compare the plan
you started a week with against how it went (ask the Telegram bot).

Click the date to return to today. Add `?look=tint` (blue-grey background, blue headings) or `?look=flat` (the default) to
the address to change the look; the choice is remembered on that device.

The icon is a crop of Katsushika Hokusai's *Under the Wave off Kanagawa* (about 1831), from
[the Metropolitan Museum of Art's Open Access image](https://www.metmuseum.org/art/collection/search/45434) (public domain, CC0).
