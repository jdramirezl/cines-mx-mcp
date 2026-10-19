# cines-mx-mcp

A personal [MCP](https://modelcontextprotocol.io) server that lets an assistant
look up movie listings and buy tickets at Mexican cinema chains. Cinépolis is
supported first; the provider interface leaves room for Cinemex.

It is built for **one person**, low volume, human-like use: no premiere sniping,
no resale, no scraping at scale.

> Not affiliated with Cinépolis. It talks to the same endpoints the public
> cinepolis.com web app uses; they are undocumented and can change at any time.
> When a response no longer matches the expected shape, the server reports
> `CINES_SCHEMA_CHANGED` instead of guessing.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Research + capture | done |
| 1 | Read tools (cinemas, listings, showtimes, upcoming, best showtime) | in progress |
| 2 | Seat map PNG, seat proposal, hold/release | planned |
| 3 | Purchase (PayPal first), approvals, 3DS relay | planned |

## Safety rules (read before contributing)

- **Never commit** HAR files, cookies, tokens, the `x-apikey`, card data, e-mail
  addresses, names, or screenshots containing personal data. `.gitignore`
  blocks the usual paths and `npm run check-secrets` scans everything git would
  commit; the pre-commit hook runs it automatically.
- Captures live **outside** the repo (for example `~/cines-capture/`). Redact
  them before analysis or before turning anything into a test fixture:

  ```bash
  CINES_REDACT_LITERALS="Firstname,Lastname" npm run redact -- ~/cines-capture/flow.har
  # -> ~/cines-capture/flow.redacted.har (refuses to write inside a git repo)
  ```

  Header and cookie **names** and attributes (expiry, HttpOnly…) are kept;
  values become salted hash markers such as `[COOKIE:1a2b3c4d]`, so equal values
  still correlate within one run. JWTs, bearer tokens, e-mails, Luhn-valid card
  numbers, phone numbers and long opaque tokens are scrubbed from URLs, headers
  and bodies; third-party tracker payloads are dropped.
- Private literals (your name, the live API key) can be checked without
  committing them: `CINES_SECRET_LITERALS="..." npm run check-secrets`.
- The MCP server only binds to `127.0.0.1`.
- The purchase step is a deterministic script; the language model never drives
  the payment page, and payment secrets never enter its context or the logs.

## Development

```bash
npm install
git config core.hooksPath .githooks   # enable the secret-scanning pre-commit hook
npm run check                         # typecheck + lint + tests + secret scan
```

Requires Node 22.13+.

## License

MIT
