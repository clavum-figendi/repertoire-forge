# Processing formats

Repertoire Forge supports browser, Cloudflare serverless, and native command-line preparation. All produce the same JSON workspace format; use **Export → Choose backup** on web/Android to load prepared positions for Memorize and Play.

## Maia Elo

Settings → Maia Elo selects below-1100 through 2000+ in 100-point buckets. The default is the strongest supported 2000+ bucket. This model does **not** have a separate grandmaster category: entering 2600 would still select the same top category, so the app does not pretend to offer it. Use Stockfish for move quality.

## Browser capacity

An archive capacity stop retains the successfully parsed games, including completed games in the current batch. Press **Backsolve repertoire** to continue with them. Network errors and user cancellation still leave the previous workspace untouched. The browser is intentionally bounded; larger archives belong in the native or serverless preparation path.

## Cloudflare Free

Select **Cloudflare Free backend** under **Import by username → Processing**. The hosted endpoint is preconfigured; you can also deploy your own Free Worker using `cloud/README.md` and change the HTTPS origin in Settings. Cloud mode fetches Lichess archives. Use on-device or native processing for direct Chess.com imports. The backend receives your public username, filters and analysis settings, fetches public games, and analyses them on Cloudflare, not this computer. Processing uses resumable bounded steps; keep the page open or use **Resume cloud job**. The job capability is stored only in this tab's session storage. Downloaded results are not automatically substituted for the current workspace.

The ordinary Free Worker has only 10 ms CPU/request. The computation runs instead inside a SQLite-backed Durable Object with a documented 30-second CPU budget per request. This is still finite: Free request/storage/write limits and modest per-step search bounds apply. No paid plan is enabled. Cloud mode does not mean unlimited computation or indefinite browser-independent background execution.

**Delete cloud job** removes its stored data. Treat its capability as private. Public usernames/positions are transmitted only when you choose cloud mode; locally imported games and model inference otherwise stay on-device.

## Native

See `native/README.md` for installation, Stockfish requirements and commands. Use the native CLI for archives that exceed browser storage or for long/deep analysis, then import its JSON output through **Export → Choose backup**. PGN is interoperable line notation; JSON additionally carries exact flashcards and mistake/refutation metadata.
