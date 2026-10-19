# Mac runbook (server Mac)

Runs `cines-mx-mcp` as a LaunchAgent next to the hub and Mason. Everything
stays on `127.0.0.1`.

## Install

```bash
git clone https://github.com/jdramirezl/cines-mx-mcp.git ~/code/cines-mx-mcp
cd ~/code/cines-mx-mcp
npm ci
mkdir -p ~/.config/cines-mx && chmod 700 ~/.config/cines-mx
cp config/alert.env.example ~/.config/cines-mx/alert.env && chmod 600 ~/.config/cines-mx/alert.env
#   fill TELEGRAM_BOT_TOKEN (same as the hub) and TELEGRAM_CHAT_ID
# optional: cp config/cines.env.example ~/.config/cines-mx/cines.env  (NODE_BIN, port)
bin/cinesctl install --dry-run   # preview
bin/cinesctl install
sleep 5 && bin/cinesctl status   # expect: MCP http://127.0.0.1:8686/mcp: OK (8 tools)
bin/cinesctl health
```

Then in the hub's `.env`: `CINES_MCP_URL=http://127.0.0.1:8686/mcp` and run the
hub's `scripts/deploy.sh`. The hub reconnects to servers that come up later.

`install` deploys a copy of the built app to
`~/Library/Application Support/cines-mx/app`, so moving or editing the repo
does not break the running service. Re-run `bin/cinesctl install` after
`git pull` to update.

## What runs

| Agent | What | When |
|---|---|---|
| `com.jdrami.cines-mcp` | `node dist/server.js` on 127.0.0.1:8686 | always (KeepAlive) |
| `com.jdrami.cines-health` | health check, Telegram 🔴/🟢 on change | login + 03:10, 09:10, 15:10, 21:10 |

Logs: `~/Library/Logs/cines-mx/` (`bin/cinesctl logs`).

## Node

Needs Node ≥ 22.13 at a stable path. `cinesctl` uses `NODE_BIN` from
`~/.config/cines-mx/cines.env`, else Homebrew/`/usr/local/bin/node`, else the
`node` on PATH (warns for nvm/fnm/volta/mise paths). On Intel Macs prefer the
nodejs.org installer over Homebrew (Homebrew builds from source).

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `MCP …: UNREACHABLE` | server not running | `bin/cinesctl logs`, `bin/cinesctl restart` |
| health `cinepolis: CINES_BLOCKED` | Cloudflare refuses this Mac's requests | wait; check from a browser on the same network. If persistent, the transport fingerprint may need an update |
| health `cinepolis: CINES_SCHEMA_CHANGED` | Cinépolis changed its API (e.g. Vista Cloud migration) | update the code; capture a new HAR and redact it (`npm run redact`) |
| `API key not found` | site script layout changed | set `CINEPOLIS_API_KEY` in the agent env as a stopgap, then fix discovery |
| slow first answer | catalog warm-up (~7 s) after start | normal; cached for 10 min |

## Uninstall

```bash
bin/cinesctl uninstall   # keeps ~/.config/cines-mx and logs
```
