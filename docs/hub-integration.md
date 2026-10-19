# Hub integration (assistant-hub)

## Registry entry (`mcp-servers.json`)

```json
"cines": {
  "description": "cines-mx-mcp (Cinépolis listings, showtimes, seat maps). Loopback, no auth. Enabled where CINES_MCP_URL is set in .env (server Mac: http://127.0.0.1:8686/mcp).",
  "url": "${CINES_MCP_URL}",
  "enabled": true
}
```

Tool names already carry the `cines_` prefix, so no `toolPrefix` is needed.
Default error style: failures are `isError: true` with a single JSON text
block that is exactly `{error:{code,message,retryable}}`; successes are a
single JSON text block.

## Tools (Phase 1–2a)

All current tools are **read-only** (`readOnlyHint: true`,
`destructiveHint: false`); none hold seats or spend money.

| Tool | Purpose |
|---|---|
| `cines_list_cinemas` | User's cinemas with distance |
| `cines_listings` | Movies + times at a cinema for a date (`cinema`, `date`) |
| `cines_find_movie` | Which of the user's cinemas show a movie, on which dates |
| `cines_showtimes` | All showtimes for a movie, filters for date/language/format |
| `cines_best_showtime` | Best + 2 alternatives, warnings, Admision General price, promo advice |
| `cines_upcoming` | Upcoming releases and presales |
| `cines_seat_map` | Live seat map PNG (`imageUrl`) + proposed seats; does not hold |
| `cines_validate_seats` | Check "F7,F8", preview PNG; does not hold |

Planned and **approval-gated** (Phase 2b/3): `cines_hold_seats`,
`cines_purchase`. `cines_release_hold` will be ungated.

## Images

`cines_seat_map` / `cines_validate_seats` return
`imageUrl: http://127.0.0.1:<port>/images/<id>.png` (valid 30 min, loopback
only). The hub should fetch that URL and send it with Telegram `sendPhoto`
when a tool result contains `imageUrl`; the model only needs to say what it
proposes.

## Error codes

| Code | retryable | Meaning |
|---|---|---|
| `CINES_UNAVAILABLE` | yes | Cinépolis down/rate limiting/transient backend error |
| `CINES_BLOCKED` | no | Cloudflare blocked this Mac; back off |
| `CINES_SCHEMA_CHANGED` | no | Cinépolis changed its API/site; needs a code update |
| `CINES_NOT_FOUND` | no | Unknown cinema/movie/showtime |
| `CINES_BAD_REQUEST` | no | Bad input (date, seat labels, showtime id) |
| `CINES_SESSION_EXPIRED` | no | Member session expired (Phase 2b+) |
| `CINES_HOLD_EXPIRED`, `CINES_PAYMENT_FAILED`, `CINES_LIMIT_EXCEEDED` | no | Phase 3 |

## Prompt hint (short)

> Cines (Cinépolis, Mexico City): for "quiero ver X hoy en la noche", call
> `cines_best_showtime` (window `night` = 19:00–24:00) and present the best
> option plus the 2 alternatives with their warnings and price. Prefer
> subtitled; mention dubbed only when it is the only option. Default ticket is
> Admision General; mention cheaper promos or Club tickets only as advice. To
> choose seats call `cines_seat_map` with the `showtimeId` and party size and
> send the image; if the user replies with seats like "F7,F8", call
> `cines_validate_seats`. Nothing is held or bought by these tools.
