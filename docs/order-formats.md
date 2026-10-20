# Order / hold inputs per cinema type and format

How `cines_hold_seats` fills the Cinépolis `Order` mutation. Every value comes
from **that showtime's own data** at hold time (Cinemas, Billboard, Seats and
Tickets responses). Nothing is hard-coded per cinema.

Sources:
- the recorded purchase (Parque Toreo, regular room, 2026-10-19)
- one live read-only check of Miyana Polanco VIP, session 56651 (2026-10-20)
- the site's own JavaScript

"Not observed" means the rule is derived from the code path but hasn't been seen live yet.

## Call sequence (all types)

1. `UserSessionId{cinemaId: <vistaId>}` (member token) → `user_session_id`, sent as `tickets.orderId`.
2. `Tickets{…, userSessionId}` (member token): the site does this right before `Order`. Its list (Club/account tickets) is never picked automatically.
3. `Tickets{cinemaVistaId, sessionId}` (public) → the ticket options and the chosen type.
4. `Order{orderData}` (member token).
5. Release: `CancelOrder{country_id, order_session_id: user_session_id}` on `/v1/carts`. Keepalive: `ExtendOrder`.

`orderSessionId` = `uuidv4-<epoch ms>`, as the site generates it.
Headers are the same for every type: `x-apikey`, `country-id`, `language`, plus a raw JWT in `Authorization` for member calls.
No extra cart or session fields were seen beyond these.

## Per type

| Room / format | Cinemas (user's) | Seats `experience` | Ticket types seen | Seat area | Seat ids |
|---|---|---|---|---|---|
| Regular (TRADICIONAL) | Parque Toreo (570), Plaza Carso (419), Satélite (158) | `TRADICIONAL` | Toreo: Que Oferton 2026 (5026/2050) $45, **Admision General (2223/0136) $92**, Niños (2224) $74, 3 Era Edad (2225) $74; +$7 fee each | `0000000001` "TRADICIONAL" | row letter + number, e.g. `C6`; `Special` = wheelchair; aisles are column gaps |
| VIP | Parque Toreo VIP (656), Plaza Carso VIP (446), Miyana Polanco VIP (673), Plaza Satélite VIP (900) | `VIP` | Miyana 673: only **Admision General (2223/0001) $197** +$7 | `0000000001` "Sala VIP" / category "VIP" | same format; seats come in pairs separated by gaps (no special love-seat id; `seatStyle` "Normal") |
| 4DX | Satélite and others (billboard `experience: 4DX`) | `4DX` (seat area name changes with it) | not observed | not observed | seen: `Broken` status on some seats |
| IMAX | billboard `experience: IMAX` | `IMAX` | not observed | not observed | not observed |
| Macro XE | billboard `experience: XE` | `XE` | not observed | not observed | not observed |
| ScreenX | billboard `experience: SCREENX` | `SCREENX` | not observed | not observed | not observed |
| Sala Junior | billboard `experience: SJ` | `TRADICIONAL` (SJ is not a seat area) | not observed | not observed | not observed |

## Rules applied automatically

- `experience` (Seats call) comes from `seatExperience()`: the showtime's own experience, else `VIP` for VIP cinemas, else `TRADICIONAL`.
- Ticket type: the user's request, else "Admision General", else the first general/adult non-package type in **that showtime's** public Tickets response. Each seat gets the ticket options of its own `areaCategoryCode`.
- `cinema.type` and `businessType` come from the Cinemas response; `schedule` (sessionId, screen, language) from the Billboard.
- Seat `number`, `areaCategoryCode` and `position{rowIndex, columnIndex, areaNumber}` come from the Seats response. `description` is the seat area category name.
- Seat states:
  - `Special` / `Companion`: wheelchair and companion seats, only selectable on request.
  - `Sold`, `House`, `Reserved`: taken.
  - `Broken`: blocked.
  - Any unknown status is treated as taken and reported.

## Errors

When Cinépolis answers with GraphQL `errors` and a null result, its own message (redacted) is returned:
- `CINES_BAD_REQUEST` for seat or business rules
- `CINES_SESSION_EXPIRED` for auth
- `CINES_UNAVAILABLE` for internal errors that aren't about seats or tickets

`CINES_SCHEMA_CHANGED` is reserved for data that is present but malformed.
