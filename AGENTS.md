# daily-plans

A minimal WYSIWYG markdown editor for daily plans, hosted on the agent server
(`~/best/projects/2026-09-26-agent-server`). Each week syncs both ways with its own tab of
the "daily" Google Doc.

- Visibility: public repository. Plan content lives only on the server and in the Google Doc; never commit it.
- Google account: personal (`alejoacelas@gmail.com`), Docs scope only.
- Still running or billing: `daily-plans.service` on the agent server (no extra cost).

## How it works

- One markdown file per day in `DATA_DIR/days/YYYY-MM-DD.md`: the plan, then `## Notes`, then notes.
  `DATA_DIR` is a Git repository the server commits to every ten minutes, so every version is recoverable.
- The week view (`shared/plans.js`) is each day's plan under `## Mon, Oct 5`, then `## Notes`
  with each non-empty day's notes under a bold `**Mon, Oct 5**` line. Saving the week view
  splits it back into day files; whichever view saves last wins.
- Every 10 s the server reads the whole Doc (`server/server.mjs`, `syncOnce`). Each week's tab is
  named `w41, Oct 05` (ISO week, Monday's date). For each day it compares both sides with the
  version each side had at the last sync, kept per side in `DATA_DIR/state.json`: days changed
  only in the Doc are written to the app; any day changed in the app makes the server rewrite the
  whole tab. A day changed on both sides since the last check takes the app's version, and the
  Doc's copy goes to `DATA_DIR/conflicts/`.
- Doc writes carry the revision they were based on (`requiredRevisionId`), so an edit made in the
  Doc between the server's read and its write makes the write fail and wait for the next check.
- The editor saves 300 ms after typing stops and sends the version it started from (`X-Version`).
  A save based on an older version still wins, but the replaced text goes to `conflicts/`. The
  editor reloads from the server every 5 s while visible, once typing has paused for 3 s.
  ⌘S syncs at once.
- `server/gdocs.mjs` converts markdown to Docs requests and back, covering only headings,
  paragraphs, bold, italic, strikethrough, code, links and bullet, numbered and checkbox lists.
  The token needs only the `documents` scope. Anything else in the Doc is dropped on the next push.
- The Docs API cannot read or set a checkbox's tick. Done items are written as struck-through
  text, and a checkbox item whose text is entirely struck through reads as done. To mark an item
  done in the Doc, strike it through (⌘⇧X); a tick alone is lost on the next push.
- The page is always light, regardless of the system appearance.

## Develop

`npm install`, `npm run build` (bundles `client/` into `public/app.js`), `npm test`.
Run locally with `DATA_DIR=/tmp/plans node --env-file=.env server/server.mjs`; rebuild `.env` with
`op inject --account my.1password.com -i .env.tpl -o .env`.

## Deploy

The server runs a clone at `~/work/daily-plans` under the user service in `deploy/daily-plans.service`,
which injects secrets with `op-agent run`. Tailscale Serve proxies
`https://agent-server.tail622085.ts.net/plans` (tailnet only) to `127.0.0.1:8770`.

```bash
ssh agent-server 'cd ~/work/daily-plans && git pull && npm ci && npm run build && systemctl --user restart daily-plans'
```

## Secrets

All in personal 1Password (`my.1password.com`). The server reads the `server-agents` copies.

| Variable | Item (Personal ID → server-agents ID) | Field |
| --- | --- | --- |
| `GOOGLE_CLIENT_SECRET` | `GOOGLE_OAUTH_CLIENT_SECRET — google-oauth-client-mac-air-2020-personal` (→ `wzteo6sgsks7chstxswix4aa6u`) | `credential` |
| `GOOGLE_REFRESH_TOKEN` | `GOOGLE_REFRESH_TOKEN — daily-plans` (`hvcmfrvqgiw6fqs5ugis7exz3m` → `kcd6k7wybzg2rierbicwkx7if4`) | `credential` |
| `GOOGLE_DOC_ID` | same item as `GOOGLE_REFRESH_TOKEN` | `doc_id` |

`GOOGLE_CLIENT_ID` is not secret and sits in `.env.tpl`. To mint a new refresh token, run an
OAuth installed-app flow with that client, scope `https://www.googleapis.com/auth/documents`,
`access_type=offline`, `prompt=consent`, and update both items.
