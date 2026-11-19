# Repertoire Forge acceptance and integration plan

Independent new project; do not modify astra-chess or Hermes. No commits/pushes authorized.

## Shared contract
ES modules, chess.js 1.4.0. Core in src/core.js exports:
- DEFAULT_SETTINGS {mistakeCp:25,depth:14,maxPly:40,theoryPlies:16,minTheoryGames:20,maxTheoryDrop:0.05,trainSide:'both',username:''}
- positionKey(fen): first 4 FEN fields.
- importPgn(text, existingGraph?): graph {version:1,root:string,nodes:{[key]:{key,fen,visits,edges:[{uci,san,to,count,manual?}],analysis?,theory?}},games:number,warnings:[]}. PGN main lines plus RAV; reject invalid games visibly, bounded input; transpositions and game frequencies.
- backsolve(graph,{settings,evaluate,theory,onProgress,signal}): async result {graph,cards,stats}. Never mutate original input graph. evaluate(fen,settings) => {bestMove:uci,scoreCp:number,mate?:number,depth:number,pv?:string[],source:'stockfish'} with side-to-move scores. theory(fen)=> {white,draws,black,moves:[{uci,san,white,draws,black}],source}. Analyze played move via child eval sign inversion, not parent's PV approximation. Preserve first mistake + exactly immediate best refutation; path-sensitive pruning, no descendants leaking via transpositions; best move generated if absent. Theory skip uses sample threshold plus mover expected-score loss <=maxTheoryDrop. Limit cycles/path; cache analysis per position; cancellation. Cards {id:positionKey,fen,uci,san,source,due:ms,interval:days,repetitions,ease,lapses} unique; username side filters both analysis cards and refutations where applicable. Deduplicate cards.
- reviewCard(card,grade,now=Date.now()) pure schedule, grades again/hard/good/easy.
- exportPgn(graph): legal variations with setup FEN support and cycle guards.
- addMove(graph,key,uci): clone graph with legal manual edge.

Integrations parent owns src/services.js and src/export.js:
- createEngine(onStatus?): Promise engine {evaluate(fen,settings),close()}; real bundled Stockfish UCI worker.
- getTheory(fen,source='masters',signal): cached Lichess masters/lichess.
- fetchGames(platform,username,{maxGames,signal}): PGN text.
- exportAnki(cards): Promise<Uint8Array> .apkg; exportCsv(cards); download(name,data,type).
UI agent owns index.html, src/main.js, src/style.css, public/manifest.webmanifest, public/sw.js only. Import core/services/export functions above. Local persistence IndexedDB preferred; settings localStorage acceptable. Display explicit real states and errors. App builds offline with bundled assets. Four tabs import/backsolve, browse, memorize, export; configurable settings; editable board with legal click moves, promotion selection, flip and keyboard navigation; nested variation tree with transposition links; eval and theory on demand; cancellation and progress; review scheduler with answer reveal and grades. Source recommendations with links and honest Maia status. User-supplied book PGN via separate import option, resolve using theory adapter UI provides or getTheory.
Parent owns Android shell/build, README, provenance, tests/integration and packaging.

## Gates
1 dependencies + baseline red/green core tests
2 implementation core and UI in parallel exclusive files
3 integration and Stockfish real execution
4 spec review then code-quality review with saved findings
5 production browser desktop/mobile/offline workflows
6 compiled signed APK asset/signature checks; emulator if available, otherwise disclose unverified Android runtime
7 source+web+APK package and checksums; test extracted source/build.

## Important semantics
No promise of mathematically optimal play at finite depth; label engine depth and source. No copyrighted textbook text bundled. No Maia fake scores or fake engine fallback. 25cp = 0.25 pawn, not 0.25cp. API errors must not imply out-of-theory. Free public APIs only, rate limit/cache, no credentials needed. Persistence and destructive replacement confirmation. No multiplayer/server secrets.
