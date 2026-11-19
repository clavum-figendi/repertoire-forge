# Repertoire Forge

Local-first chess repertoire builder for web and Android. Import your games, merge transpositions, compare theory, analyze with bundled Stockfish 17.1, prune after a first mistake and train the resulting positions.

## Run the web app

Open [Repertoire Forge on GitHub Pages](https://clavum-figendi.github.io/repertoire-forge/). The gear menu holds the opening reference, custom reference book, engine settings and training preferences. If you used a local preview before, export a JSON backup there and restore it on the hosted site: browser storage is separate for each origin.

The `web/` folder in the release is prebuilt and needs no Node dependencies. Serve it over localhost, not `file://`:

    python3 -m http.server 8080 --directory web

Then open http://localhost:8080 . Install as a PWA in a supporting browser after the first successful load, allow assets to cache, then reload once online before disconnecting. Online imports/theory require internet; bundled engine, saved data and training do not. Data lives only in this browser's local storage/IndexedDB. Export JSON backups regularly; clearing site data deletes it.

From source (Node 22+):

    npm ci
    npm test
    npm run dev
    npm run build

Dev server defaults to all interfaces for convenience; do not expose it to the public internet. Deploy only the static production `dist/` on HTTPS. No server or paid API is necessary.

## Workflow

1. Paste/upload standard PGN, or import public Lichess/Chess.com games by username. Start with a modest recent sample; deep Stockfish analysis of a large archive can take hours on a phone.
2. Select reference theory and tune sample threshold, theory window, W/D/L expected-score drop, analysis depth and mistake threshold. **25 centipawns = 0.25 pawn.** Theory statistics and engine evaluation answer different questions; neither proves mathematical optimality.
3. Backsolve, inspect progress, cancel if needed. API failure is shown rather than treated as an unknown opening. Card answers come from Stockfish, not a pretend fallback.
4. Browse legal continuations on the board and add manual moves. Manual edits are not automatically engine-certified; rerun analysis as appropriate.
5. Practice due positions: **play your answer on the board**; the app says whether it matches the repertoire move and shows the correct move if not (or reveal without guessing). Then grade Again / Hard / Good / Easy. The scheduler is SM-2-inspired, not Anki's FSRS. Anki export creates a fresh deck; it does not migrate the app's review history.
6. Download PGN, CSV, Anki `.apkg`, or full JSON backup.

## Android

Install the accompanying APK by allowing installation from your chosen file manager. Package `org.repertoireforge.app`, minimum Android 8/API 26. A current Android System WebView **Chromium 120+** is required (modern JS, WASM, AbortSignal APIs). The web app and engine are bundled; cold launch does not require hosting. Internet permission is used only for public chess APIs. The app requests no account credentials, microphone or broad storage access. System document pickers import PGN and save exports.

The APK is **development-signed**, not a Play Store production release. A stable development identity is retained outside this source package. Build/signature/asset checks are separate from Android runtime testing; consult `VERIFICATION.md` for actual results. No physical-device runtime claim is made.

Rebuild with JDK17 and Android SDK35/build-tools35 installed:

    npm ci && npm run build
    export JAVA_HOME=/path/to/jdk17
    export ANDROID_HOME=/path/to/android-sdk
    python3 tools/build_android.py

The build script uses standard javac/aapt/d8/zipalign/apksigner directly (no Gradle download). It generates a development keystore outside the repository on first use. That signing identity is not included in source or release archives.

## Scope and caveats

- Finite-depth engine recommendations, not guaranteed optimal moves; retain a larger threshold or stronger theory filter for stylistic openings.
- Canonical position identity uses the first four FEN fields: board, active side, castling and legal en passant. Move counters are not distinct opening cards. Repetition history is not represented by FEN alone.
- PGN branch expansion/analysis are bounded; invalid games produce warnings. Standard chess only.
- Maia is documented as an optional future integration, **not bundled**. It needs lc0 plus model weights, and human move probabilities are not optimality scores.
- Public API rate limits, CORS restrictions or outages may block online imports/theory; file import works independently. No credentials requested.
- Statistical theory sources, licenses and links are listed in SOURCES.md. No copyrighted textbook content is bundled.

GPLv3. Stockfish license/authors and dependency licenses are included.
