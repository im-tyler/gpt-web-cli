# chatgpt-web

CLI for driving ChatGPT from a terminal agent. Spawns a long-lived plain Chrome daemon and drives it over CDP — real browser, real session, no API key.

## Install

```
git clone https://github.com/im-tyler/gpt-web-cli
cd gpt-web-cli && npm install && npm link
```

## Usage

```
chatgpt-web login                         # log in once; session lives in the daemon
chatgpt-web start "prompt"                # prints a job id, returns immediately
chatgpt-web wait <id>                     # blocks, prints the reply (--stream for live output)
chatgpt-web send <id> "follow-up"         # continue the same conversation
chatgpt-web start "prompt" --file a.png   # attach files
chatgpt-web list                          # CLI jobs
chatgpt-web chats                         # account conversations
chatgpt-web files <chat-id>               # list file artifacts from a chat
chatgpt-web download <chat-id> [n|all]    # download them
chatgpt-web status                        # daemon, session, usage vs caps
```

## Notes

- macOS only (hides the Chrome window via System Events).
- The Chrome daemon must stay alive — minimize is fine, quitting loses the session.
- Runs against your own ChatGPT account via the web UI, so it paces itself: randomized human-like send gaps, daily turn caps, and new-chat limits (all tunable via `CHATGPT_WEB_*` env vars).
