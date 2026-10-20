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

## Account setup (once, on the server Mac, after install)

1. `cp config/cines.env.example ~/.config/cines-mx/cines.env && chmod 600 ~/.config/cines-mx/cines.env`
   and set `CINES_LOGIN_EMAIL` (your Cinépolis e-mail) and `CINES_IMAP_USER`
   (the dedicated bot mailbox).
2. Store the bot mailbox's Gmail app password in the Keychain (prompts, nothing echoed):
   `security add-generic-password -s cines-mx-imap -a "<bot mailbox>" -w`
3. `bin/cinesctl mailbox-test` → expect `IMAP OK`.
4. `bin/cinesctl login` → a Chrome window with the **bot's own profile** opens;
   log into Cinépolis with **e-mail + 6-digit code** (not Google). **Check
   first:** open "Mi cuenta" and confirm it is your usual Club Cinépolis account
   (same points balance and account tickets you see with Google). If it shows an
   empty/new account, stop and report it: automatic re-login would then need
   the Google path instead. The window closes itself once logged in.
5. `bin/cinesctl paypal-login` → log into PayPal in the same profile (tick
   "keep me logged in"), then close the window.
6. `bin/cinesctl session` → `state: valid`, `hasRefreshToken: true`.
7. `bin/cinesctl restart`.

The bot's Chrome runs **headed** (Cloudflare blocks headless Chrome on
cinepolis.com); a window may appear briefly during keepalive (every 6 h) or a
purchase. Keep the user logged in on the server Mac.

## First real purchase (PayPal, 1 cheap ticket, you at the Mac)

Real payment is off by default. It runs only after you arm it at the Mac,
for one attempt, within 30 min.

**(a) Hold → release test.** No money moves.
1. From Telegram, ask Alfred for a cheap showtime and pick 1 seat.
2. Approve the **hold** card. Alfred shows the summary with the total.
3. On the purchase ✅/❌ card, press **❌**. Alfred releases the seats.
4. `bin/cinesctl hold-status` → `"hold": null`. Optionally check on cinepolis.com that the seat is free again.

**(b) Pre-flight and arm.**
1. Ask Alfred for the showtime again and note its `showtimeId` (for example `570-102603`).
2. `bin/cinesctl preflight <showtimeId> 1`. All lines must be `ok`.
   It may open the bot's Chrome briefly, for the session and PayPal checks.
3. `bin/cinesctl arm-payment`, then type `ARMAR`. This enables one real payment for 30 min.

**(c) The purchase**, while you watch the Mac screen.
1. In Telegram, pick the seat, approve the hold, then ✅ on the purchase card.
2. On the Mac, the bot's Chrome window comes to the front with the DEUNA checkout. It shows "Redirigiendo… PayPal".
3. A **PayPal window** opens: `paypal.com/checkoutnow?token=…`.
4. If PayPal asks, log in, do any 2FA / SMS / "new device" check, then **approve** the payment.
   The script waits up to 15 min (`CINES_PAYPAL_WAIT_MIN`) and keeps the seats alive meanwhile.
5. When Cinépolis confirms, the script saves a screenshot and Alfred sends it with the booking number.
   Screenshots go to `~/Library/Application Support/cines-mx/screenshots/` (0700).

If you **close the window**, or the wait runs out with no booking, the seats are released and nothing is charged.
If the payment ends in an unclear state, the seats are **not** released.
Either way the payment is **never retried**: check your Cinépolis / PayPal e-mail.
The arm is used up either way; arm again only for a new, deliberate attempt.

**After.**
- `bin/cinesctl hold-status`:
  - `"hold": null`
  - the newest purchase is `paid` with `bookingNumber` and `screenshotPath`
  - `paymentArmed.armed: false`
- The ticket e-mail also arrives in your main inbox.

Emergency: `bin/cinesctl release-hold` and `bin/cinesctl disarm-payment`.

## Card purchase (saved card + CVV from Telegram; nobody at the Mac)

Default method since v2. Uses the card already saved in your Cinépolis account
(DEUNA wallet). You never type card data anywhere except the CVV, through
Alfred's secure input.

1. `bin/cinesctl preflight <showtimeId> 1` now also lists your saved cards
   (`card  tarjetas guardadas: *1234 (predeterminada) · se usará *1234`).
   It opens the bot's Chrome briefly; nothing is held or typed.
   Several cards? Set `CINES_CARD_LAST4=1234` in `cines.env`, or tell Alfred which one.
2. Arm as before (`bin/cinesctl arm-payment`, one attempt).
3. In Telegram: hold → ✅ → Alfred asks for the **CVV** in secure mode → reply with the 3–4 digits.
   On the Mac the bot's Chrome opens cinepolis.com with the DEUNA card window,
   types the CVV there, and Cinépolis charges once. Alfred replies with the booking number.

Outcomes: declined or any failure before the charge → seats released, nothing charged.
No clear answer from Cinépolis → seats kept, never retried: check your e-mail and bank.
3-D Secure: if the bank asks for it, nothing is charged and the seats are released
("Tu banco pidió una verificación extra…"); use PayPal or the Cinépolis app.

### Arming from Telegram with a PIN (optional)

Once, at the Mac: `bin/cinesctl set-arm-pin` (hidden input, typed twice, 6–8
digits, not repeated or consecutive). Only a salted scrypt hash is stored
(`state/arm-pin.json`, 0600). Afterwards an unarmed purchase asks the PIN in
Telegram's secure mode before the CVV; a correct PIN arms that one purchase
only (10 min). One attempt every 30 s; 3 wrong in a row disable it until you run
`set-arm-pin` again. `bin/cinesctl clear-arm-pin` removes it. `arm-payment`
still works and skips the PIN.

Never start the server with `DEBUG=pw:*`: Playwright would log typed keys.

## Uninstall

```bash
bin/cinesctl uninstall   # keeps ~/.config/cines-mx and logs
```
