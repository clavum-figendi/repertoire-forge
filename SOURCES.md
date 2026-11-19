# Sources and third-party notices

## Stockfish
Bundled engine: stockfish npm 17.1.0, single-thread lite NNUE build `stockfish-17.1-lite-single-03e3232`. Upstream https://github.com/nmrugg/stockfish.js/tree/v17.1.0 ; original engine https://stockfishchess.org/ . GPLv3 full license in `public/engine/Copying.txt`, authors in `public/engine/AUTHORS`. Exact npm distribution https://registry.npmjs.org/stockfish/-/stockfish-17.1.0.tgz (npm SHA1 fe49c54a9fc0ed601d5d7e3108ed11c0522a414d). Corresponding engine source/build instructions available at the pinned upstream tag. This application is distributed under GPLv3, see LICENSE. Engine score is a finite-depth estimate, not proof of optimality.

## Opening theory options (live public data, not bundled)
- Lichess Masters explorer: https://explorer.lichess.ovh/masters ; documentation https://lichess.org/api ; server https://github.com/lichess-org/lila-openingexplorer . Strong over-the-board master game results; frequency and W/D/L are empirical, not objective evaluation. Default source. Calls are sequential, spaced at least 1.1s apart and cached for the session. API unavailability is an error, never evidence that a line is out of theory.
- Lichess rated explorer: https://explorer.lichess.ovh/lichess ; configured 2200/2500 rating buckets, blitz/rapid/classical. Broader coverage, online selection bias.
- User-supplied legal PGN books: only import data you have rights to use. Imported occurrence counts do not establish empirical winning chances unless real result metadata is retained.
- Lichess opening names: https://github.com/lichess-org/chess-openings , CC0. Useful ECO classification/reference, but not by itself a statistical strong-player book. Not bundled.
- Lichess downloadable database: https://database.lichess.org/ , CC0 game data. Large public corpus; the app deliberately does not download multi-gigabyte archives automatically.
- PGN Mentor: https://www.pgnmentor.com/files.html . Public event/player PGNs useful as user-supplied reference; check terms before redistributing. Not a guarantee of textbook recommendations.
- Opening textbooks are often copyrighted. No textbook text or proprietary repertoire is bundled; use an authorized PGN export rather than scraped content.

## Game import
Lichess public username PGN export: https://lichess.org/api#tag/Games/operation/apiGamesUser .
Chess.com read-only public archives: https://support.chess.com/en/articles/9650547-published-data-api . Monthly archives are read sequentially, newest month first; games are streamed in bounded batches. All-history mode has no hidden matching-game cap. Each provider's live speed classification is preserved; Chess.com Daily is excluded. Provider availability/CORS policies may change; PGN upload remains available. No password or token requested.

## Maia
[CSSLab Maia-2](https://github.com/CSSLab/maia2) rapid ONNX model, obtained from the [official frontend at the pinned revision](https://github.com/CSSLab/maia-platform-frontend/tree/e23a50e499b839ce85a79f9ca2cf99bb7211cc72). Model checksum, source and notices are in `public/models/maia2/`. Uses pinned IndieFoundry encoding/decoding and ONNX Runtime Web in a single-threaded browser worker. Human move likelihood is not engine optimality. The first ten plies were excluded in training; take early-opening predictions with caution.

## Libraries
chess.js 1.4.0 BSD-2-Clause; sql.js 1.13.0 MIT (SQLite public domain); fflate 0.8.3 MIT. Their actual package license texts are copied into `licenses/` during packaging. Vite and Playwright are development tools only.
