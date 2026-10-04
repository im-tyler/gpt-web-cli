# gpt-web-cli

`chatgpt-web` — CLI for driving ChatGPT from a terminal agent. Repo: `Tyler/gpt-web-cli` (Forgejo) with public GitHub mirror `im-tyler/gpt-web-cli` (remote `github`). Bin is npm-linked globally (`~/.local/bin/chatgpt-web`).

## Commands

- `start "prompt"` -> prints job id, returns immediately; `--file <path>` (repeatable) attaches files
- `send <id> "text"` -> follow-up in the same conversation; `--file` works here too
- `resume <id>` -> retry a failed assistant turn in standard ChatGPT (clicks the thread's own Retry control). NEVER clicks "Use Work": when the Work interstitial gates a conversation, sends/resume fail fast with that explanation — recover by starting a new chat. The interstitial's Retry is inert underneath (verified 2026-09-12); the backend wedges the thread into Work mode.
- `wait <id> [secs]` -> blocks, prints reply, exit 1 on error (default 600s); `--stream` prints as it grows
- `list`, `status`, `chats` (account threads via `/backend-api/conversations`, not CLI jobs), `login`
- `chats --delete <id>... | --all` -> soft-delete listed conversations via `PATCH /backend-api/conversation/{id}` `{is_visible:false}` (30-day recovery in Settings > Deleted chats). The old `PATCH /backend-api/conversation?id=` form returns 405 since ~2026-09 (verified 2026-09-17).

## Agent-mode threads (browser-research prompts)

Browse/research-heavy prompts (audits, "check github", file-producing tasks) route to ChatGPT agent mode: server-side `web.run`/`container.exec` tools, `async_status` numeric on the conversation (`3` running, `4` stopped; null observed mid-flight). Consequences learned live 2026-09-17:

- `start`/`send` observation often fails ("prompt was not observed as a new user message") because the agent DOM differs — the send still lands; the chat is created and the task runs. Check `~/.chatgpt-web/jobs/<id>.json` for the `url`, then poll `/backend-api/conversation/{id}` (`async_status`, `update_time`, mapping node count) instead of `wait`.
- Agent tasks can stop mid-research at their step budget (async 4, no deliverable, last message mid-thought). Recovery: `send <job-id> "You completed the research but never delivered the report. Please now write the complete ... to a single .md file."` — re-engages the same agent run.
- Deliverables are `sandbox:/mnt/data/*.md` links. If a sidebar file card appears, `files`/`download` work; often it does not — then reconstruct from the conversation JSON: the agent writes files via heredocs, so `code`-type messages contain `cat > path <<'MARK'` chunks; extract payload per marker, concatenate in create_time order, run any assembler script locally (patch `/mnt/data` paths).
- `files <chat-id>` / `download <chat-id> [n|all] [outdir]` -> conversation file artifacts
- `dot` -> bind + status of the account's dot; `dot "message"` -> send one paced, capped message into the dot thread; `dot --poll [--json]` -> messages since last poll (advances the watermark); `dot --context [n] [--json]` -> last n messages (watermark untouched); `dot --reset` -> forget the binding. There is NO `wait` for dots: the dot replies on its own horizon (minutes to hours), so poll instead. Sends verify acceptance API-first with a DOM `.message-row.self` fallback; `--file` is not supported yet.

## Dot threads (v0.6, verified 2026-10-03)

A dot conversation is NOT a `/c/<id>` thread. `/backend-api/conversation/<id>` returns 404 and the thread never appears in `/backend-api/conversations` — the Sept agent-mode polling advice does not apply. The dot surface is a **messaging room**:

- Discovery: `chatgpt.com/dots` redirects to `/dots/<dot-id>`; the room is the single `type:"DM"`, `app_source:"chatgpt:messaging"` entry in `GET /backend-api/messaging/rooms`. The binding (roomId, dotId, myId, watermark) lives in `~/.chatgpt-web/dot.json`, written only under the `dot` lock. Exactly one dot is tracked; multiple DM rooms refuse with the list.
- Reads: `GET /backend-api/messaging/rooms/<roomId>/messages?limit=100` (bearer, from a chatgpt.com page). Items: `{id, created_at, account_user_id, content.text}` — **authorship is `account_user_id`** (`user-…` = you, `calpico-member-…` = the dot); the `role` field is "user" on BOTH sides and must not be trusted.
- Sends: page composer on `/dots/<dot-id>` — the composer selectors are standard but the submit button is `button[aria-label="Send"]`, NOT `#composer-submit-button` (which does not exist on this surface). The transcript renders NO `[data-message-author-role]` nodes; own messages are `.message-row.self`. `data-message-id` on those nodes is the ROOM id on every node — useless as a message identity.
- Watermark: `{t, ids}` — membership is decided by ID (ids already counted are old), with created_at only as a coarse floor: the server returns created_at with varying sub-second precision between fetches, so exact time equality misclassifies the just-sent message (observed live 2026-10-03). After a send the watermark is the sent message, not the room tip, so a fast dot reply survives for the next poll.
- Caps: a dot send is admitted like `send` (tab slot, daily turn cap, `lastSendAt` gap, send lock) but never counts against the new-chat cap — the thread already exists. Reads (`dot`, `--poll`, `--context`) are free like `chats`. Dot conversations don't count toward ChatGPT usage limits; Work/Codex tasks the dot starts do. One TOCTOU note: the inline dot send occupies a tab without registering in the job store, so admission can briefly see one slot freer than it is (ceiling stays 3 tabs, same as documented).
- No notifications for dot commands (they are synchronous); no `--file` yet (the dot composer's attachment UI is unmapped).

## Web UI change 2026-10-04 (v0.6.2 fix, verified live)

The main chat surface converged to the dot-surface markup shape. On chatgpt.com (Chrome 154 era):

- Submit button is `button[aria-label="Send"]` — NO `#composer-submit-button`, NO `data-testid="send-button"`. `SUBMIT_SEL` now carries all three.
- Transcripts render ZERO `[data-message-author-role]` / `data-message-id` nodes (main chats, not just dots). Consequences, all fixed API-first:
  - `waitForReply` no longer scrapes the DOM. It polls `/backend-api/conversation/{id}` (via `fetchConversationMessages`, which now exposes message `status`) for the first assistant message after the accepted user message; completion = `status === 'finished_successfully'`, fallback = text stable 4 polls AND >20s since first seen (only when status is absent). Partials fire from the growing API text.
  - `sendPromptGuarded`'s DOM `priorIds` snapshot is always `[]` now — harmless for fresh chats, but `waitForAcceptedPrompt` takes the NEWEST matching user message (reversed scan) so verbatim-repeated recovery sends ("You completed the research but never delivered...") can't re-accept an older identical prompt.
- Still dead / unmapped on the new UI (not blocking start/send/wait): `resume`'s `regenerate-thread-error-button`, the DOM half of `attachmentsReady` chips (unrecognized layout refuses — `--file` uploads will error "attachment UI unrecognized" until remapped), `STOP_SEL`/`replyAfterUser` (removed).
- Drafts persist server-side on the new-chat surface; `typePrompt`'s select-all + insertText replaces them (verified).

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

- The daemon Chrome process must stay alive. Windowed: minimize is fine; Cmd+Q = session home gone. `CHATGPT_WEB_HEADLESS=1` does **not** pass `--headless` (Cloudflare challenges that). It spawns the same headed Chrome and hides the process via System Events (`visible=false`). Login unhides (and opts out of auto-hide for its whole run). Never spoof UA or use stealth patches.
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

Working 2026-10-04 (v0.6.2): login, start/send/wait, `chats` (+delete), status, pacing + caps, multi-tab concurrency — all against the post-2026-10 web UI (aria-label Send button + API-first reply tracking, see the UI-change section). `resume`, `--file` uploads and `files`/`download` sidebar paths are NOT yet re-verified against the new markup. Working 2026-09-10: login, start/send/wait (`--file`, `--stream`), `chats` via `/backend-api/conversations` (id / async_status / updated / title), files/download, status (windowed|hidden|headless), pacing + caps, **multi-tab concurrency (v0.5): per-turn tabs + global send lock, `CHATGPT_WEB_MAX_TABS` default 2**. CDP: `connectOverCDP({ noDefaults: true })` + `PUT /json/new` if no page target. `CHATGPT_WEB_HEADLESS=1` hides headed Chrome (System Events `visible=false`); never `--headless` (Cloudflare). Hidden mode is self-healing (v0.6.1): a 1.2s re-hide loop runs for the whole command AND the cold launch (on the spawned pid, from the first moment), plus a final sweep after the command — Chrome otherwise foregrounds itself at launch and on navigation, which stole focus and dropped the operator's keystrokes into Chrome. Residual: a sub-2s flash per launch/command can still steal focus once; keep the daemon warm (any command) to make that rare. Login is the only visible path by design. Dock icon stays. Known limitation: Chrome auto-update restarts kill the daemon port mid-turn; next command respawns (job errors, retry). Killing the daemon by pid leaves `daemon.json` stale — delete it (and `locks/`) before the next command or every command fails with `daemon identity mismatch: pid`.
