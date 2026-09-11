# gpt-web-cli

`chatgpt-web` — CLI for driving ChatGPT from a terminal agent. Repo: `Tyler/gpt-web-cli` (Forgejo) with public GitHub mirror `im-tyler/gpt-web-cli` (remote `github`). Bin is npm-linked globally (`~/.local/bin/chatgpt-web`).

## Commands

- `start "prompt"` -> prints job id, returns immediately; `--file <path>` (repeatable) attaches files
- `send <id> "text"` -> follow-up in the same conversation; `--file` works here too
- `wait <id> [secs]` -> blocks, prints reply, exit 1 on error (default 600s); `--stream` prints as it grows
- `list`, `status`, `chats` (account threads via `/backend-api/conversations`, not CLI jobs), `login`
- `files <chat-id>` / `download <chat-id> [n|all] [outdir]` -> conversation file artifacts

## Upload + streaming notes (v0.3)

- Uploads: click `[data-testid="composer-plus-btn"]` -> popover -> `getByText(/upload from computer/i)` -> `page.waitForEvent('filechooser')` -> `setFiles`. Match by regex, NOT exact text (popover markup varies).
- NEVER leave a pending `waitForEvent` promise unawaited after an early throw — attach a sibling `.catch(() => {})` immediately, or the delayed rejection kills the whole runner as an unhandled rejection (job reads "runner died").
- First send on a fresh chat navigates `/` -> `/c/<id>` and the message list REMOUNTS — assistant-message count flickers 0->1->0. Response-start detection requires 2 consecutive positive sightings, never break-then-recheck.
- Job statuses: `running` -> `streaming` (partial reply written every >=2s) -> `done`. Admission/reapStale/send-guard all treat `streaming` as busy.

## File download notes

Agent-chat files have no stable listing API (conversation endpoint 404s; `/interpreter/download` needs message_id + sandbox_path). Working approach: click each `[data-testid="library-file-icon"]` (reload the page between clicks — the estuary fetch is cache-swallowed on repeat clicks in one session), intercept `GET /backend-api/estuary/content?id=<file_id>&fn=<name>` and read `response.body()` IMMEDIATELY (bodies die on next navigation). 4 sidebar icons may be 2-4 unique files; dedupe by id.

## Concurrency (v0.5)

Multiple agents can use the CLI at once. Up to `CHATGPT_WEB_MAX_TABS` concurrent turns (default 2), each in its own tab: `start`/`send` admit while `runningJobs().length < maxTabs`. Every command invocation creates its own page (`withPage` → `context.newPage()`, closed in `finally`) — no command ever touches another turn's tab. The send phase (gap wait → settle → upload → type → click) runs under a cross-process filesystem lock (`~/.chatgpt-web/locks/send.lock`, atomic `mkdir`, stale-broken after 120s); the min-gap is measured between SENDS (`state.lastSendAt`), not turn ends. Response waits happen in parallel outside the lock. Caps remain global per account; the limits check + `recordTurn` run under `locks/state.lock` so concurrent starts can't lose counts. Admission check has a small TOCTOU window — two simultaneous starts can both pass; harmless at cap 2.

## Architecture (do not regress this)

One long-lived **plain Chrome** daemon (`--remote-debugging-port=9777`, real keychain, zero automation flags) is spawned on demand; all commands drive it over CDP via playwright-core `connectOverCDP({ noDefaults: true })` (Chrome 152+ rejects `Browser.setDownloadBehavior` on the default profile). If `/json` has no `page` target, `PUT /json/new?about:blank` first. Login session lives inside that process.

**NEVER** run Playwright `launchPersistentContext` against the profile dir (`~/.chatgpt-web/profile`). Playwright injects `--use-mock-keychain`; Chrome then cannot decrypt the session cookies written by real Chrome and silently DELETES them (destroyed a live session this way once, 2026-09-09). No UA spoofing either — it is real Chrome; spoofing breaks Cloudflare.

## Operational rules

- The daemon Chrome process must stay alive. Windowed: minimize is fine; Cmd+Q = session home gone. `CHATGPT_WEB_HEADLESS=1` does **not** pass `--headless` (Cloudflare challenges that). It spawns the same headed Chrome and hides the process via System Events (`visible=false`). Login unhides. Never spoof UA or use stealth patches.
- Up to `CHATGPT_WEB_MAX_TABS` concurrent turns (default 2), one tab each. Sends are serialized + paced globally (send lock + `lastSendAt` gap); response waits overlap. Do not raise the gap-bypass or tabs past 3 — interleaved machine-cadence tabs are a flag tell.
- Jobs: `~/.chatgpt-web/jobs/<id>.json` (id, status, prompt, reply, url, history, pid). Crashed runners self-heal to `error` via pid check.
- chatgpt.com renders a logged-out SSR shell with login buttons for a few seconds after navigation — page classification must wait for settle (`classifyPage`), never judge on first paint.
- Response completion = assistant text stable ~1.2s + no stop button.
- Env: `CHATGPT_WEB_HOME`, `CHATGPT_WEB_TIMEOUT` (secs/turn, default 300), `CHATGPT_WEB_CDP_PORT` (default 9777), `CHATGPT_WEB_CHROME` (binary path), `CHATGPT_WEB_HEADLESS=1` (hide headed window; never `--headless`), `CHATGPT_WEB_MAX_TABS` (concurrent turns, default 2), `CHATGPT_WEB_MAX_TURNS_DAY` (default 100), `CHATGPT_WEB_MAX_NEW_CHATS` (per hour, default 6), `CHATGPT_WEB_MIN_GAP` (secs between sends, default 8), `CHATGPT_WEB_NOTIFY=0` disables notifications.

## Pacing + caps (flag-risk reduction, v0.2)

Behavioral camouflage is the priority — NOT fingerprint spoofing (real Chrome + zero flags already; spoofing would create tells). Built in:

- Randomized human pacing: 8-16s enforced gap between sends (`CHATGPT_WEB_MIN_GAP`, measured from `state.lastSendAt` under the send lock), 1.5-4s settle before typing, jittered poll intervals (~0.6-1.3s).
- Caps in `~/.chatgpt-web/state.json`: max 100 turns/day (`CHATGPT_WEB_MAX_TURNS_DAY`), max 6 new conversations/hour (`CHATGPT_WEB_MAX_NEW_CHATS`) — `start`/`send` refuse with exit 1 when hit; prefer `send` follow-ups over new chats.
- macOS notification on every turn end/error (`CHATGPT_WEB_NOTIFY=0` to disable).
- `status` command: daemon, session, usage vs caps, running jobs.
- Account hygiene matters more than code: automation runs on a secondary account, never a business one.

## State

Working 2026-09-10: login, start/send/wait (`--file`, `--stream`), `chats` via `/backend-api/conversations` (id / async_status / updated / title), files/download, status (windowed|hidden|headless), pacing + caps, **multi-tab concurrency (v0.5): per-turn tabs + global send lock, `CHATGPT_WEB_MAX_TABS` default 2**. CDP: `connectOverCDP({ noDefaults: true })` + `PUT /json/new` if no page target. `CHATGPT_WEB_HEADLESS=1` hides headed Chrome (System Events `visible=false`); never `--headless` (Cloudflare). Login unhides. Hide runs before `page.goto`, so navigation can flash/focus the window; Dock icon stays. Known limitation: Chrome auto-update restarts kill the daemon port mid-turn; next command respawns (job errors, retry).
