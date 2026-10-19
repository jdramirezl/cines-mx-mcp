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
| `cines_hold_status` | – | active hold (`secondsLeft`), pending secure inputs, recent purchases, `successfulPurchases`, `purchaseApprovalRequired`, session state |

### Acting on the user's behalf

| Tool | Gate | Arguments | Returns |
|---|---|---|---|
| `cines_hold_seats` | **approval** (`destructiveHint: true`) | `showtimeId`, `seats` ("F7,F8"), `ticketType?` (only if the user asked; default Admision General), `wheelchair?` | `status:"held"`, `holdId`, `expiresAt` (~9 min), `seats`, `ticketType`, `unitMxn`, `chargesMxn`, `subtotalMxn`, `totalMxn`, `purchaseApprovalRequired`, `capMxn` — or `needs_input` (see below) |
| `cines_release_hold` | none (`destructiveHint: false`) | `holdId?` (default: active hold) | `status:"released"` or `"none"` |
| `cines_purchase` | **approval** (`destructiveHint: true`) | `holdId`, `expectedTotalMxn` (= the hold's `totalMxn` shown on the card), `method?` ("paypal" default, "card" = card saved in the Cinépolis/DEUNA wallet), `userApproved?` (boolean, required `true` while `purchaseApprovalRequired`), `dryRun?` | `status:"paid"`, `bookingNumber`, `transactionNumber?`, `totalMxn`, `seats` — or `needs_input` |
| `cines_secure_input` | **hub-only, never shown to the model** | `requestId`, `value` | the paused tool's next result (`held`/`paid`/another `needs_input`) or an error |

Server-enforced purchase rules (the hub enforces them too): hard cap
$1,000 MXN (`CINES_PURCHASE_CAP_MXN` can only lower it); `expectedTotalMxn`
must equal the hold; while fewer than 3 purchases succeeded,
`userApproved: true` is required; one purchase in flight; each hold is paid
at most once; a payment is never retried (on failure the user checks e-mail).
Real payment is **disabled** until the live PayPal flow is verified with the
user (calls fail with `CINES_PAYMENT_FAILED … aún no está habilitado`);
`dryRun: true` works now.

Hub flow:

1. `cines_seat_map` → `sendPhoto(imageUrl)`; user replies seats → `cines_validate_seats`.
2. Gate `cines_hold_seats` (approval card or `propose_plan`) → summary card from the result:
   cinema, movie, date/time, language/format, seats, ticket type, total with fees.
3. First 3 purchases: ✅/❌ card on that summary; on ✅ call `cines_purchase` with
   `expectedTotalMxn = totalMxn` and `userApproved: true`. After 3 successes
   (`purchaseApprovalRequired: false`) and `totalMxn ≤ 1000`, the hub may call it
   right after the hold without a second ✅. Above the cap: never.
4. ❌ or timeout → `cines_release_hold`.

## Secure input (Phase 3 groundwork)

Any acting tool may return:

```json
{ "status": "needs_input", "secure": true, "requestId": "sec_…", "kind": "email_code | cvv | otp_3ds",
  "prompt": "…", "expiresAt": "ISO", "imageUrl": "http://127.0.0.1:8686/images/….png (optional, e.g. 3DS page)" }
```

The hub must then:

- send `prompt` (and `imageUrl` via `sendPhoto` if present) to the user;
- put the chat in **secure-input mode** for that `requestId`: the user's next
  message is NOT added to model context or memory, NOT logged, and is deleted
  from the Telegram chat after reading if possible;
- call `cines_secure_input({requestId, value})` directly (not through the
  model) and handle its result like the original tool's result (it can be
  `held`, `paid`, an error, or another `needs_input`);
- give up after `expiresAt` (the server cancels the request itself);
- never offer `cines_secure_input` to the model as a tool.

| kind | when | format |
|---|---|---|
| `email_code` | Cinépolis session expired and the mailbox did not deliver the code | 6 digits |
| `cvv` | `method:"card"` with a saved card | 3–4 digits |
| `otp_3ds` | bank 3-D Secure / OTP during payment | 4–10 alphanumerics |

If a tool call takes longer than ~110 s it returns
`{status:"in_progress", jobId}`; poll `cines_hold_status`.

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
> (`cines_purchase`) need approval; pass `expectedTotalMxn` exactly as shown.
> If a result says `needs_input`, do not ask for or repeat the secret yourself;
> the hub collects it privately.
