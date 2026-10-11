# Decisions

## Core decisions

### Sync with the Google Doc

- [Copy whole days, last writer wins, keep the loser.](#whole-day-sync)
- [Use only the Docs API's `documents` scope.](#docs-scope-only)

### Editor

- [Always light.](#always-light)

## Details

### Whole-day sync

Both sides exchange whole days rather than diffs, checked every 10 s. Alejandro chose
last-writer-wins over version-checked writes with quiet periods or per-surface locks, for
simplicity. A day changed on both sides between checks takes the app's version, because a
Docs-scope token cannot see when the Doc was edited. Nothing is discarded: the losing version
goes to `conflicts/`, and day files are committed to Git every ten minutes.

### Docs scope only

The server's token can edit Google Docs but not read or delete Drive files, so markdown↔Docs
conversion is done in `server/gdocs.mjs` instead of with `gdoc` (which needs the Drive scope).
The cost is that only markdown features sync; other Doc formatting is overwritten.

### Always light

Alejandro asked for a light page regardless of the system appearance, using Google Docs' greys
and blues. `?look=tint` is the alternative palette.

## Decision log

- 2026-10-11: Two-way sync with last writer wins, replacing the hourly afternoon push.
