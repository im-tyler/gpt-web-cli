# gpt-web-cli

`chatgpt-web` — CLI for driving ChatGPT from a terminal agent. Repo: `Tyler/gpt-web-cli` (Forgejo-only, PRIVATE). Bin is npm-linked globally (`~/.local/bin/chatgpt-web`).

## Commands

- `start "prompt"` -> prints job id, returns immediately
- `send <id> "text"` -> follow-up in the same conversation
- `wait <id> [secs]` -> blocks, prints reply, exit 1 on error (default 600s)
- `list`, `chats`, `login`
- `files <chat-id>` / `download <chat-id> [n|all] [outdir]` -> conversation file artifacts

## File download notes

Agent-chat files have no stable listing API (conversation endpoint 404s; `/interpreter/download` needs message_id + sandbox_path). Working approach: click each `[data-testid="library-file-icon"]` (reload the page between clicks — the estuary fetch is cache-swallowed on repeat clicks in one session), intercept `GET /backend-api/estuary/content?id=<file_id>&fn=<name>` and read `response.body()` IMMEDIATELY (bodies die on next navigation). 4 sidebar icons may be 2-4 unique files; dedupe by id.

## Architecture (do not regress this)

One long-lived **plain Chrome** daemon (`--remote-debugging-port=9777`, real keychain, zero automation flags) is spawned on demand; all commands drive it over CDP via playwright-core `connectOverCDP`. Login session lives inside that process.

**NEVER** run Playwright `launchPersistentContext` against the profile dir (`~/.chatgpt-web/profile`). Playwright injects `--use-mock-keychain`; Chrome then cannot decrypt the session cookies written by real Chrome and silently DELETES them (destroyed a live session this way once, 2026-09-09). No UA spoofing either — it is real Chrome; spoofing breaks Cloudflare.

## Operational rules

- The daemon Chrome window must stay open (minimize is fine). Cmd+Q = session home gone.
- One turn at a time (running-job guard; also Chrome-side reality).
- Jobs: `~/.chatgpt-web/jobs/<id>.json` (id, status, prompt, reply, url, history, pid). Crashed runners self-heal to `error` via pid check.
- chatgpt.com renders a logged-out SSR shell with login buttons for a few seconds after navigation — page classification must wait for settle (`classifyPage`), never judge on first paint.
- Response completion = assistant text stable ~1.2s + no stop button.
- Env: `CHATGPT_WEB_HOME`, `CHATGPT_WEB_TIMEOUT` (secs/turn, default 300), `CHATGPT_WEB_CDP_PORT` (default 9777), `CHATGPT_WEB_CHROME` (binary path).

## State

Working end-to-end 2026-09-09: login (auto-detects completion), start/send/wait, chats listing. Known limitation: Chrome auto-update restarts kill the daemon port mid-turn; next command respawns (job errors, retry).
