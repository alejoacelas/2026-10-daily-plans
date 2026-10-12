# Decisions

## Core decisions

### Sync with the Google Doc

- [Copy whole parts (a day's plan or notes, a tab), last writer wins, keep the loser.](#whole-day-sync)
- [Use only the Docs API's `documents` scope.](#docs-scope-only)

### Tabs

- [Week tabs are shared with days per tab; Notes stays per day.](#tabs)

### History

- [Nightly markdown snapshots are a stopgap for the bot.](#nightly-snapshots)

### Editor

- [Always light.](#always-light)

## Details

### Whole-day sync

Both sides exchange whole parts (a day's plan, a day's notes, a tab's text) rather than diffs, checked every 10 s. Alejandro chose
last-writer-wins over version-checked writes with quiet periods or per-surface locks, for
simplicity. A part changed on both sides between checks takes the app's version, because a
Docs-scope token cannot see when the Doc was edited. Nothing is discarded: the losing version
goes to `conflicts/`, and day files are committed to Git every ten minutes.

### Docs scope only

The server's token can edit Google Docs but not read or delete Drive files, so markdown↔Docs
conversion is done in `server/gdocs.mjs` instead of with `gdoc` (which needs the Drive scope).
The cost is that only markdown features sync; other Doc formatting is overwritten.

### Tabs

Alejandro asked for tabs in both views, with a one-click control beside each week tab to show
it in every day, in place of a fixed After hours section. The week's Notes tab is each day's
own notes gathered, so it has no sharing control. Shared tabs appear in a day's main tab
between the plan and the notes. In the Doc, extra tabs are child tabs of the week's tab so each
week stays one unit. The app owns the tab list: tabs added or renamed in the Doc are ignored.

### Nightly snapshots

The Git history in the data folder (commits every ten minutes, `eod/YYYY-MM-DD` tags) is the
lasting record. The plain-markdown copies in `snapshots/` exist only because the Telegram bot
has no shell and so cannot read Git history. Once the bot can run `git`, remove the snapshot
files and have it compare `eod/` tags instead.

### Always light

Alejandro asked for a light page regardless of the system appearance, using Google Docs' greys
and blues. `?look=tint` is the alternative palette.

## Decision log

- 2026-10-12: Tabs in the day and week views replace the fixed After hours section; each week
  tab can be shared with the days.
- 2026-10-11: Nightly `snapshots/` markdown files as a temporary way for the bot to compare
  plans over time; drop them when the bot gets Git access.
- 2026-10-11: Two-way sync with last writer wins, replacing the hourly afternoon push.
