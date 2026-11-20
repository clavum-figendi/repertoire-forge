# Repertoire Forge native CLI

A real Rust executable: `reqwest` downloads public archives, `pgn-reader` and
`shakmaty` parse and legally replay standard-chess mainlines, and a separate native
Stockfish process performs finite-depth UCI searches. No Node, browser, WASM, or
remote engine is involved in native computation. Node is used only by the optional
web-compatibility verification script.

## Download / requirements

`dist/repertoire-forge-linux-x86_64` is the compiled, stripped Linux x86_64 executable.
The adjacent `.tar.gz` contains the executable, this README, and the GPL license.
Requires glibc **2.39+** (for example Ubuntu 24.04+) and `libgcc_s.so.1`.
It is **not** a static/musl or macOS/Windows build. Download/install Stockfish
separately; it is intentionally not bundled in the release tarball.

```sh
chmod +x repertoire-forge-linux-x86_64
./repertoire-forge-linux-x86_64 --help
./repertoire-forge-linux-x86_64 \
  --input games.pgn --min-moves 10 --time-controls blitz,rapid \
  --depth 14 --max-ply 40 --stockfish /usr/games/stockfish \
  --output repertoire

./repertoire-forge-linux-x86_64 \
  --platform lichess --username YOUR_NAME --min-moves 10 \
  --time-controls rapid,classical --depth 14 --max-ply 40 \
  --stockfish /usr/games/stockfish --output lichess-repertoire

./repertoire-forge-linux-x86_64 \
  --platform chesscom --username YOUR_NAME --max-games 100 \
  --depth 10 --stockfish /usr/games/stockfish --output chesscom-repertoire
```

`--input` bypasses downloading. `--username`, if supplied even with a local file,
also limits cards to that player's moves; both players' moves are still analyzed.
`--platform` accepts `lichess`, `chesscom`, or `chess.com`.
`--min-moves N` matches the web archive's **strict** rule: original game length must
be **greater than 2*N plies**, before any max-ply truncation. `--time-controls` is a
comma-separated list of bullet/blitz/rapid/classical/correspondence or exact PGN
values such as `600+0`. Empty means all. Classification uses base seconds + 40
increments. `--max-games N` optionally caps fetched/scanned games (not matched
games); `0`, the default, requests all. Depth is 4–20 and max-ply 2–160, matching web
restore setting bounds. Default depth/max-ply are 14/40.

## Outputs and restore

For output prefix `repertoire`:

* `repertoire.json`: web backup, format `repertoire-forge`, version 1, graph with
  nodes/edges/authoritative lines, unique cards and all DEFAULT_SETTINGS fields.
  Import through the app's **Export → Restore JSON** control. `native` contains
  extra execution statistics. No large duplicate sourceGraph is embedded.
* `repertoire.pgn`: legally replayable **pruned** mainlines, one game per retained
  input game, including a generated immediate refutation. Shared lines are not
  merged into a variation trie; duplicate games without unique provider IDs may
  remain as separate lines, but cards and evaluated positions are globally unique.
* `repertoire.cache.ndjson`: persistent first-four-FEN evaluation cache, scoped by
  engine identity/executable metadata/depth. Rerunning the same command reconstructs
  the result using cached searches; this is **not** a resume-at-last-game cursor.
* `repertoire.archive.pgn`: downloaded PGN spool when fetching remotely. It can
  subsequently be passed to `--input` without downloading again.

Checkpoints replace JSON/PGN via temporary files plus rename every 25 retained
games and at completion. Engine failures and PGN input I/O errors attempt to save
usable partial output with `native.complete=false`, print an error, and exit
nonzero. Malformed individual games are skipped with warnings. A partially failed
archive stream retains complete received games on disk and processes those games,
then exits nonzero. SIGKILL/power loss can lose work after the last checkpoint;
rerun with the same prefix to reuse the flushed analysis cache. JSON and PGN are
each atomically replaced, but are not a single filesystem transaction.

## Backsolve definition

For each original mainline, evaluate each position and its played child. Scores are
from the side-to-move perspective: loss is **parent score + child score**. A played
move different from the engine's best move is bad only when loss is **strictly
>25 cp**. Mate scores use the web core's mate-distance mapping. Keep the original
path through its **first bad move**, append the child's legal best move as an
immediate refutation (if any), and discard the remainder. Cards use the parent's
best move plus the immediate refutation, unique by the first four FEN fields.
Repeated positions truncate a path. One thread, 32 MiB engine hash, finite depth,
and a 120-second search timeout bound individual engine operations.

## Limits / honest limitations

* Standard chess only. Input side variations are ignored, not expanded. All moves
  of each original mainline are validated, even beyond max-ply.
* No masters/opening-explorer theory skipping is performed; every visited move is
  Stockfish-tested. DEFAULT_SETTINGS theory fields are exported for compatibility,
  not a claim that theory was used. Maia is not involved.
* Low-depth runs can classify plausible opening moves as inaccuracies. The live
  retrieval smoke tests deliberately use depth 4 for speed, not opening quality.
* Lichess is streamed line-by-line to disk. Chess.com is fetched month-by-month,
  with each games-array object parsed incrementally (the full month is not retained).
  Provider speed classification is preserved for Chess.com. Requests are public/unauthenticated;
  private games and provider rate/availability limits still apply. Chess.com retries
  429 responses, but interrupted downloads are restarted rather than cursor-resumed.
* Memory contains the retained graph and evaluation cache. Web restore limits
  still apply: JSON 25 MiB, 200k positions, 100k lines/cards. The CLI stops before
  these count limits and preserves the previous checkpoint; split large inputs.
  Thus it does not promise that an unlimited all-history result fits one web backup.
* A failed remote request can reuse an existing archive spool for the same output
  prefix; use a separate prefix for each username, or explicitly use `--input`.

## Build / tests

```sh
cargo build --release --locked -j 2
cargo test --release --locked
# Integration tests expect vendor/stockfish/usr/games/stockfish, or set STOCKFISH.
# Optional Node verification (project dependencies required):
node tests/verify-web.mjs
```

`artifacts/rust-tests.log` records native unit/integration tests against real
Stockfish 17. `artifacts/fixture*`, `lichess-live*`, and `chesscom-live*` contain real
runs, caches, backups and PGN. Live runs fetched two public games each from Lichess
(thibault) and Chess.com (erik). `artifacts/web-compatibility.json` verifies the exact
current web restore validators, legal PGN round-trip, unique/legal cards, and parity
with the JS core when fed the **actual native Stockfish evaluations**. The JS core
is a test oracle only; the shipped executable does not call it.

The compiled binary was exercised before own regenerable Cargo target artifacts
were removed to conserve disk. Source and Cargo.lock are retained. Source license:
GPL-3.0-or-later (see LICENSE). Dependencies retain their respective licenses.
