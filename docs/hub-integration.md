# Hub integration (assistant-hub)

## Registry entry (`mcp-servers.json`)

```json
"cines": {
  "description": "cines-mx-mcp (Cinépolis listings, showtimes, seat maps, holds, purchases). Loopback, no auth. Enabled where CINES_MCP_URL is set in .env (server Mac: http://127.0.0.1:8686/mcp).",
  "url": "${CINES_MCP_URL}",
  "enabled": true
}
```

Tool names already carry the `cines_` prefix (no `toolPrefix`). Default error
style: a failure is `isError: true` with one JSON text block that is exactly
`{error:{code,message,retryable}}`; a success is one JSON text block.

## Tools

### Read (ungated, `readOnlyHint: true`)

| Tool | Arguments | Returns |
|---|---|---|
| `cines_list_cinemas` | – | user's cinemas with distance |
| `cines_listings` | `cinema?`, `date?` | movies + times at a cinema for a date |
| `cines_find_movie` | `movie` | which of the user's cinemas show it, dates |
| `cines_showtimes` | `movie`, `cinema?`, `date?`, `language?` (SUB/ESP/ORIGINAL), `format?` | showtimes with `showtimeId` |
| `cines_best_showtime` | `movie`, `date?`, `window?` (morning/afternoon/evening/night/any), `after?`, `before?` (HH:MM), `tickets?`, `vip?` (only/exclude/any), `format?`, `cinema?` | `best` + 2 `alternatives`, warnings, price (Admision General + $7 fee/ticket), cheaper promos as advice |
| `cines_upcoming` | `days?`, `presaleOnly?` | upcoming releases / presales |
| `cines_seat_map` | `showtimeId`, `tickets?`, `wheelchair?` | `imageUrl` (PNG), `proposal` e.g. `["D5","D6"]`, counts — does not hold |
| `cines_validate_seats` | `showtimeId`, `seats` ("F7,F8"), `tickets?`, `wheelchair?` | `ok`, `errors`, `warnings`, preview `imageUrl` — does not hold |
| `cines_hold_status` | – | active hold (`secondsLeft`), pending challenges, recent purchases, `successfulPurchases`, `purchaseApprovalRequired`, session state |

### Acting on the user's behalf (final Phase 3 contract, v1)

All amounts are **MXN, authoritative, fees included** (`currency: "MXN"`).
The hub may enforce its $1,000 cap from `total`; the server enforces it too.

**`cines_hold_seats`** — GATED (`destructiveHint: true`)

| Arg | Type | Notes |
|---|---|---|
| `showtimeId` | string | from `cines_showtimes` / `cines_best_showtime` |
| `seats` | string[] (or `"F7,F8"`) | validated like `cines_validate_seats` |
| `tickets` | int, optional | party size; must equal `seats.length` |
| `ticketType` | string, optional | only if the user asked; default Admision General; Club tickets never by default |
| `wheelchair` | bool, optional | |

→ `{status:"held", holdId, cinema, movie, startsAt, seats, ticketType, unitMxn, chargesMxn, subtotalMxn, total, currency:"MXN", expiresAt, purchaseApprovalRequired, capMxn}`
or `{status:"needs_email_code", challengeId, …}` (see Secure input).
`expiresAt` ≈ 9 min; the server auto-releases at expiry.

**`cines_purchase`** — GATED (`destructiveHint: true`)

| Arg | Type | Notes |
|---|---|---|
| `holdId` | string | |
| `expectedTotal` | number (MXN) | must equal the hold's `total` shown on the approval card (anti-drift) |
| `userApproved` | bool | required `true` while `purchaseApprovalRequired` (first 3 purchases) |
| `method` | `"paypal"` (default) \| `"card"` | `card` = card saved in the Cinépolis/DEUNA wallet |
| `dryRun` | bool, optional | simulate; nothing is charged |

**No secrets as arguments**: there is deliberately no `cvv` parameter. When a
method needs one, the call returns `needs_cvv` and the secret goes through
`cines_submit_code` (hub-only), so it can never come from the model.

→ `{status:"paid", purchaseId, bookingNumber, transactionNumber?, total, currency:"MXN", seats, imageUrl?}`
(`imageUrl` = confirmation screenshot, loopback, 30 min → `sendPhoto`)
or `{status:"needs_cvv" | "needs_3ds" | "needs_email_code", challengeId, …}`.

**`cines_submit_code`** — HUB-ONLY, never offered to the model

`{challengeId, code}` → the paused call's next result, with the same shapes as
above: `held`, `paid`, another `needs_*`, or an error. A wrong format returns
`CINES_BAD_REQUEST` and the challenge stays open.

**`cines_release_hold`** — ungated (`destructiveHint: false`)

`{holdId?}` (default: the active hold) → `{status:"released" | "none", holdId?, seats?}`

Server-enforced rules (the hub enforces them too):
- hard cap $1,000 MXN; `CINES_PURCHASE_CAP_MXN` can only lower it
- `expectedTotal` must equal the hold's `total`
- `userApproved: true` required for the first 3 purchases
- one purchase in flight; each hold is paid at most once; a payment is never retried (on failure the user checks e-mail)

Real payment is **off unless armed** on the server Mac (`cinesctl arm-payment`,
interactive, one attempt, ≤ 60 min). Unarmed, a real call fails with
`CINES_PAYMENT_FAILED … no está armado` before anything is recorded;
`dryRun: true` always works. `cines_hold_status` reports `paymentArmed`.
The PayPal step can take minutes (the user approves at the Mac): the call
returns `{status:"in_progress", jobId}` after ~110 s; poll `cines_hold_status`
until `purchases[0].status` is `paid` (with `bookingNumber`, `imageUrl`) or
`failed` / `unknown`.

Hub flow:
1. `cines_seat_map` → `sendPhoto(imageUrl)`; the user replies with seats → `cines_validate_seats`.
2. Gate `cines_hold_seats` → summary card from the result: cinema, movie, `startsAt`, seats, ticket type, `total` MXN.
3. While `purchaseApprovalRequired`: ✅/❌ card; on ✅ call `cines_purchase{holdId, expectedTotal: total, userApproved: true}`.
   After 3 successes and `total ≤ 1000`, the hub may call it right after the hold without a second ✅. Above the cap: never.
4. On ❌ or timeout → `cines_release_hold`.

## Secure input

A `needs_*` result looks like:

```json
{ "status": "needs_email_code | needs_3ds | needs_cvv", "secure": true, "challengeId": "sec_…",
  "kind": "email_code | otp_3ds | cvv", "prompt": "…", "expiresAt": "ISO",
  "imageUrl": "http://127.0.0.1:8686/images/….png (optional, e.g. 3DS page)" }
```

Hub behaviour:
- send `prompt` to the user, and `imageUrl` via `sendPhoto` if present;
- enter **secure-input mode** for `challengeId`: the user's next message is not
  added to model context or memory, not logged, and is deleted from the chat if possible;
- call `cines_submit_code({challengeId, code})` directly and handle its result like the original call's result;
- give up at `expiresAt`, when the server also cancels the challenge.

| status | kind | when | format |
|---|---|---|---|
| `needs_email_code` | `email_code` | session expired and the bot mailbox did not deliver the code within ~150 s | 6 digits |
| `needs_cvv` | `cvv` | `method:"card"` | 3–4 digits |
| `needs_3ds` | `otp_3ds` | bank 3-D Secure / OTP | 4–10 alphanumerics |

A call that takes longer than ~110 s returns `{status:"in_progress", jobId}`; poll `cines_hold_status`.

Mapping from thread 5's draft:
- `seats[]`, `tickets`, `holdId`, `cinema`, `movie`, `startsAt`, `total`, `currency`, `expiresAt`: adopted as proposed.
- `needs_3ds` / `needs_email_code` + `challengeId`: adopted; `needs_cvv` added.
- `cines_submit_code{challengeId, code}`: adopted.
- `purchaseId`: adopted.
- `cvv?` on `cines_purchase`: replaced by `needs_cvv` → `cines_submit_code`, so a secret can never be a model-visible argument.
- Added `expectedTotal` (anti-drift) and `userApproved` (first-3 rule), both required server-side.

## Images

Seat tools return `imageUrl: http://127.0.0.1:<port>/images/<id>.png` (valid
30 min, loopback only). When a tool result contains `imageUrl`, the hub fetches
it and sends it with Telegram `sendPhoto`.

## Error codes

| Code | retryable | Meaning |
|---|---|---|
| `CINES_UNAVAILABLE` | yes | Cinépolis down / rate limiting / transient backend error |
| `CINES_BLOCKED` | no | Cloudflare blocked this Mac; back off |
| `CINES_SCHEMA_CHANGED` | no | Cinépolis changed its API/site; needs a code update |
| `CINES_NOT_FOUND` | no | Unknown cinema/movie/showtime/hold/request |
| `CINES_BAD_REQUEST` | no | Bad input, seat rules, missing approval, total mismatch |
| `CINES_SESSION_EXPIRED` | no | Member session expired and could not be recovered |
| `CINES_HOLD_EXPIRED` | no | Seats no longer held; choose again |
| `CINES_PAYMENT_FAILED` | no | Payment failed or not enabled; never retried |
| `CINES_LIMIT_EXCEEDED` | no | Above the $1,000 cap |

## Prompt hint (short)

> Cines (Cinépolis, Mexico City): for "quiero ver X hoy en la noche", call
> `cines_best_showtime` (window `night` = 19:00–24:00) and present the best
> option plus the 2 alternatives with warnings and total price. Prefer
> subtitled; mention dubbed only when it is the only option. Default ticket is
> Admision General; mention cheaper promos or Club tickets only as advice. For
> seats call `cines_seat_map` (send the image); if the user replies seats like
> "F7,F8", call `cines_validate_seats`. Holding (`cines_hold_seats`) and paying
> (`cines_purchase`) need approval; pass `expectedTotal` = the hold's `total`.
> Never ask for, accept or repeat card data or codes in chat; if a result says
> `needs_*`, the hub collects the secret privately.
