import { Chess } from 'chess.js';
import { DEFAULT_SETTINGS, positionKey, importPgn, backsolve, reviewCard, exportPgn, addMove } from './core.js';
import { createEngine, getTheory, fetchGames } from './services.js';
import { exportAnki, exportCsv, download } from './export.js';
import {startDrill, advanceDrill, drillChoices, chooseDrillReply, boardFlipped} from './drill.js';
import {predictMaia,MAIA_MODEL_BYTES,MAIA_RUNTIME_BYTES,MAIA_RATING} from './maia.js';
import './style.css';

const SAMPLE = '[Event "Sample · Italian opening"]\n[White "Sample White"]\n[Black "Sample Black"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 (3... Nf6 4. d3) 4. c3 Nf6 5. d3 d6 *';
const glyphs = { wk:'♔', wq:'♕', wr:'♖', wb:'♗', wn:'♘', wp:'♙', bk:'♚', bq:'♛', br:'♜', bb:'♝', bn:'♞', bp:'♟' };
const pieceNames = { k:'king', q:'queen', r:'rook', b:'bishop', n:'knight', p:'pawn' };
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function blankGraph() { const fen = new Chess().fen(); const key = positionKey(fen); return { version:1, root:key, nodes:{[key]:{key,fen,visits:0,edges:[]}}, games:0, warnings:[] }; }
const state = { maiaAllowed:false, archive:null, drill:null, drillSide:'w', sourceGraph:null, draft:'', graph:blankGraph(), cards:[], book:null, settings:{...DEFAULT_SETTINGS}, workspace:'Backsolve', path:[], flipped:false, selected:null, revealed:false, reviewId:null, busy:false, controller:null, engine:null, progress:'', notice:'', error:'', inspection:null, source:'masters' };
let db;
async function openStore() {
  return new Promise((resolve,reject) => { const req = indexedDB.open('repertoire-forge',1); req.onupgradeneeded = () => req.result.createObjectStore('state'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
async function persist(overrides={}) {
  if (!db) throw new Error('IndexedDB is unavailable');
  const data = { draft:state.draft, graph:state.graph, sourceGraph:state.sourceGraph, cards:state.cards, book:state.book, settings:state.settings, source:state.source, ...overrides };
  await new Promise((resolve,reject) => { const tx = db.transaction('state','readwrite'); tx.objectStore('state').put(data,'workspace'); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); });
}
function currentKey() { return state.path.at(-1) || state.graph.root; }
function currentNode() { return state.graph.nodes[currentKey()] || state.graph.nodes[state.graph.root]; }
function visibleEdges(key=currentKey(),path=state.path) {
  const edges=state.graph.nodes[key]?.edges||[];
  if(!Array.isArray(state.graph.lines))return edges;
  const ucis=[];let previous=state.graph.root;
  for(const target of path){const edge=state.graph.nodes[previous]?.edges.find(e=>e.to===target);if(!edge)return [];ucis.push(edge.uci);previous=target;}
  const allowed=new Set(state.graph.lines.filter(line=>(line.root||state.graph.root)===state.graph.root&&ucis.every((uci,i)=>line.moves[i]===uci)).map(line=>line.moves[ucis.length]).filter(Boolean));
  return edges.filter(e=>allowed.has(e.uci));
}
function dueCards() { return state.cards.filter(c => c.due <= Date.now()); }
function review() { return state.cards.find(c=>c.id===state.reviewId) || dueCards()[0]; }
function boardFen() { return state.workspace==='Play' && state.drill ? state.drill.fen : state.workspace==='Memorize' && review() ? review().fen : currentNode().fen; }
function notify(message,error=false) { state.error=error?message:''; state.notice=error?'':message; renderNotice(); }
function renderNotice() { const error=[state.error,state.storageError].filter(Boolean).join(' ');$('#notification').innerHTML = error ? `<div role="alert" class="message error">${esc(error)}</div>` : state.notice ? `<div role="status" class="message">${esc(state.notice)}</div>`:''; }
async function save() { try { await persist();state.storageError=''; } catch(e) { state.storageError=`Could not save locally: ${e.message}. Download a JSON backup.`;renderNotice(); } }
function summary() { const nodes=Object.values(state.graph.nodes); return `${state.graph.games} game${state.graph.games===1?'':'s'} · ${nodes.length} positions · ${state.cards.length} cards`; }

const navIcons = ['<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>','<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10m0-4h6a6 6 0 0 0 6-4"/>','<path d="M8 3h9a2 2 0 0 1 2 2v12H8a2 2 0 0 0 0 4h11M8 3a3 3 0 0 0-3 3v13m4-10h6"/>','<path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/>'].map(path=>`<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`);
const playIcon='<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M7 4v16l13-8Z"/></svg>';
function render() {
  // All imported strings interpolated into markup are escaped; numeric values are validated at entry.
  $('#app').innerHTML = `
    <header class="app-header"><a class="brand" href="./" aria-label="Repertoire Forge home"><span class="brand-mark">♞</span><span>REPERTOIRE <b>FORGE</b></span></a><div class="header-tools">${state.busy?'<button class="text-button danger" data-action="cancel" aria-label="Cancel current task">Cancel task ×</button>':''}<button class="icon-button" data-action="settings" aria-label="Settings">⚙</button></div></header>
    <nav class="workspaces" aria-label="Workspaces">${['Backsolve','Browse','Memorize','Play','Export'].map((w,i)=>`<button data-workspace="${w}" aria-label="${w}" class="${state.workspace===w?'active':''}" aria-current="${state.workspace===w?'page':'false'}">${i===3?playIcon:navIcons[i===4?3:i]}${w}${w==='Memorize'&&dueCards().length?`<span class="badge">${dueCards().length}</span>`:''}</button>`).join('')}</nav>
    <main data-view="${state.workspace}"><div class="workspace-heading"><h1>${({Backsolve:'Build your repertoire',Browse:'Explore your lines',Memorize:'Practice',Play:'Play the repertoire',Export:'Export'})[state.workspace]}</h1><span class="summary" data-testid="graph-summary">${summary()}</span></div><div id="notification" aria-live="polite"></div>
    <div class="studio"><section class="board-panel" aria-label="Position workspace"><div class="panel-top"><span>${state.workspace==='Memorize'?'Recall':'Board'}</span>${['Memorize','Play'].includes(state.workspace)?'':'<button class="text-button" data-action="flip" aria-label="Flip board">⇅ Flip board</button>'}</div><div id="board" class="board" role="grid" aria-label="Chess board"></div><div class="board-toolbar ${['Memorize','Play'].includes(state.workspace)?'training-toolbar':''}"><div><button data-action="root" aria-label="First position">|‹</button><button data-action="back" aria-label="Previous position">‹</button><button data-action="next" aria-label="Next position">›</button><button data-action="end" aria-label="Last position">›|</button></div><span data-testid="position-label" id="position-label"></span><button class="text-button" data-action="copy-fen">Copy FEN</button></div><section class="inspector" aria-label="Position analysis" ${['Memorize','Play'].includes(state.workspace)?'hidden':''}><div id="insight">${renderInsight()}</div><div class="insight-actions"><button data-action="evaluate" ${state.busy?'disabled':''}>Analyze position <span>↗</span></button><button data-action="theory" ${state.busy?'disabled':''}>Check theory <span>↗</span></button><button data-action="maia" ${state.busy?'disabled':''}>Maia predictions</button></div></section></section>
    <section class="command-panel" aria-label="${state.workspace} tools">${({Backsolve:renderBacksolve,Browse:renderBrowse,Memorize:renderMemorize,Play:renderPlay,Export:renderExport})[state.workspace]()}</section></div>
    <footer><span>Saved on this device</span><button class="text-button" data-action="sources">Help & credits</button></footer></main>
    <dialog id="maia-dialog" aria-label="Maia predictions"><h2>Maia predictions</h2><p>Download about ${Math.round((MAIA_MODEL_BYTES+MAIA_RUNTIME_BYTES)/1_000_000)} MB to predict human moves on this device.</p><p>Maia estimates move popularity, not move quality. Early openings are outside its training range.</p><div class="dialog-actions"><button data-action="close-dialog">Cancel</button><button class="primary" data-action="load-maia">Load Maia</button></div></dialog><dialog id="settings-dialog" aria-label="Settings">${settingsMarkup()}</dialog><dialog id="promotion-dialog"><div class="eyebrow">CHOOSE A PIECE</div><h2>Promote your pawn</h2><div id="promotion-options"></div><button data-action="close-dialog">Cancel</button></dialog><dialog id="sources-dialog"><div class="eyebrow">TRANSPARENT BY DESIGN</div><h2>Help & credits</h2><p>Build a repertoire from your games, review the first mistake and best reply, then practice the resulting cards. Stockfish scores are from the side to move and depend on search depth.</p><p><a href="./credits.html" target="_blank" rel="noopener">Open-source licenses and engine source ↗</a></p><p>Use your own games, public game databases, or PGN material you have permission to use. No textbook content is bundled.</p><div class="source-links"><a href="https://lichess.org/study" target="_blank" rel="noopener">Lichess studies ↗</a><a href="https://www.pgnmentor.com/files.html" target="_blank" rel="noopener">PGN Mentor game collections ↗</a><a href="https://database.lichess.org/" target="_blank" rel="noopener">Lichess open database ↗</a><a href="https://maiachess.com/" target="_blank" rel="noopener">About Maia Chess ↗</a></div><h3>Maia-2 and Stockfish</h3><p>Maia predicts human moves; Stockfish evaluates move quality and identifies repertoire mistakes.</p><p>User books retain actual mainline game results for WDL theory filtering. Unknown results and analysis variations contribute frequencies only; their playing strength is not inferred.</p><button data-action="close-dialog">Close</button></dialog>`;
  renderBoard(); renderNotice(); bind();
}
function renderInsight() {
  const key=positionKey(boardFen());const stored=state.graph.nodes[key];const data=state.inspection?.key===key?state.inspection:stored;
  if (!data?.analysis && !data?.theory && !data?.maia) return '';
  const a=data.analysis, t=data.theory;
  const maia=data.maia?`<section><b>Maia-2 · ${MAIA_RATING} vs ${MAIA_RATING}</b><ol class="maia-results">${data.maia.slice(0,5).map(m=>`<li><b>${esc(uciSan(boardFen(),m.uci))}</b><span>${(100*m.probability).toFixed(1)}%</span></li>`).join('')}</ol>${data.maia.length?'':'<p>No legal moves.</p>'}</section>`:'';
  return `${a?`<div class="evaluation"><strong>${a.mate!==undefined?`M${esc(a.mate)}`:(a.scoreCp/100).toFixed(2)}</strong><div>Stockfish · depth ${esc(a.depth)}<small>Best move ${esc(uciSan(boardFen(),a.bestMove))} · side to move</small></div></div>`:''}${t? t.userBook?`<p><b>User-supplied book</b> · ${esc(t.total)} observations</p><p class="fine-print">Move frequencies only. Only recorded game results, never occurrence counts, inform WDL theory skipping.</p>${t.moves.length?t.moves.map(m=>`<div class="theory-row"><b>${esc(m.san)}</b><span>${esc(m.count)} observations · ${Math.round(m.count/t.total*100)}%</span></div>`).join(''):'<p>No matching moves in your user-supplied book.</p>'}`:`<p><b>${esc(t.source||state.source)} opening database</b> · ${esc((t.white||0)+(t.draws||0)+(t.black||0))} games</p>${(t.moves||[]).slice(0,8).map(m=>`<div class="theory-row"><b>${esc(m.san||m.uci)}</b><span>${esc(m.white)} W / ${esc(m.draws)} D / ${esc(m.black)} L</span></div>`).join('')||'<p>No matching games: out of theory in this source.</p>'}`:''}${maia}`;
}
const timeControls = [['bullet','Bullet'],['blitz','Blitz'],['rapid','Rapid'],['classical','Standard / classical']];
function archiveMarkup() {
  const a=state.archive||{platform:'lichess',username:state.settings.username,history:'all',minMoves:0,timeControls:timeControls.map(([key])=>key),from:'',to:''};
  return `<details class="import-online" ${state.archive?'open':''}><summary>Import by username</summary><form id="archive-form"><fieldset ${state.busy?'disabled':''}><div class="form-row"><label>Platform<select name="platform"><option value="lichess">Lichess</option><option value="chesscom" ${a.platform==='chesscom'?'selected':''}>Chess.com</option></select></label><label>Game history<select name="history">${[['all','All matching games'],['100','Latest 100 matches'],['500','Latest 500 matches']].map(([key,label])=>`<option value="${key}" ${a.history===key?'selected':''}>${label}</option>`).join('')}</select></label></div><label>Player username<input name="username" value="${esc(a.username)}" required autocomplete="off" maxlength="30"></label><label>More than this many moves<input name="minMoves" type="number" min="0" max="1024" step="1" value="${esc(a.minMoves)}" required></label><fieldset class="speed-picker"><legend>Time controls</legend>${timeControls.map(([key,label])=>`<label><input type="checkbox" name="speed" value="${key}" ${a.timeControls.includes(key)?'checked':''}>${label}</label>`).join('')}</fieldset><div class="form-row"><label>From date (optional)<input name="from" type="date" value="${esc(a.from)}"></label><label>To date (optional)<input name="to" type="date" value="${esc(a.to)}"></label></div><button type="submit">Fetch &amp; import games</button></fieldset></form></details>`;
}
function renderBacksolve() {
  return `<div class="section-heading"><h2>Games</h2></div><label class="sr-only" for="pgn">PGN notation</label><textarea id="pgn" placeholder="Paste PGN here" ${state.busy?'disabled':''}>${esc(state.draft)}</textarea><div class="import-actions"><button class="primary" data-action="import" ${state.busy?'disabled':''}>Import PGN</button><label class="button" for="pgn-file">Upload file<input id="pgn-file" type="file" accept=".pgn,.txt" class="sr-only" ${state.busy?'disabled':''}></label>${!state.graph.games?`<button class="text-button" data-action="sample" ${state.busy?'disabled':''}>Load sample</button>`:''}</div>${archiveMarkup()}<div class="divider"></div><div class="section-heading"><h2>Analysis</h2></div><div class="run-row"><button class="primary" data-action="backsolve" ${state.busy||!state.graph.games?'disabled':''}>${state.busy?'Working…':'Backsolve repertoire'} <span aria-hidden="true">→</span></button></div><div id="progress" class="progress-status">${esc(state.progress||(!state.graph.games?'Import games to begin.':''))}</div>${state.cards.length?'<button class="text-button" data-workspace="Memorize">Practice cards →</button>':''}`;
}
function renderBrowse() {
  const node=currentNode(),edges=visibleEdges();
  const roots=[...new Set((state.graph.lines||[]).map(line=>line.root))];
  return `<div class="section-heading"><h2>Repertoire branches</h2><span class="tag">${Object.keys(state.graph.nodes).length} POSITIONS</span></div>${roots.length>1?`<label>Starting position<select id="root-select">${roots.map(key=>`<option value="${esc(key)}" ${key===state.graph.root?'selected':''}>${esc(key)}</option>`).join('')}</select></label>`:''}<div class="position-breadcrumb">${state.path.length?'Ply '+state.path.length:'Starting position'} · ${esc(new Chess(node.fen).turn()==='w'?'White':'Black')} to move</div><div class="move-options">${edges.length?edges.map(e=>`<button data-to="${esc(e.to)}"><b>${esc(e.san)}</b><span>${e.manual?'manual':`${e.count} played`} →</span></button>`).join(''):'<p class="muted">End of this line. Play a legal move on the board to extend it.</p>'}</div><div class="section-heading tree-heading"><h3>Line explorer</h3><button class="text-button" data-action="root">Back to start</button></div><div class="line-tree">${renderTree(state.graph.root,new Set(),0,{count:0})}</div><details><summary>Position FEN</summary><code>${esc(node.fen)}</code></details><button class="danger text-button" data-action="reset" ${state.busy?'disabled':''}>Clear repertoire & cards</button>`;
}
function renderTree(key,seen,depth,budget,path=[]) {
  if(depth>32 || budget.count>300) return '<span class="muted">…</span>';
  const n=state.graph.nodes[key]; if(!n)return '';
  const nextSeen=new Set(seen).add(key);
  return `<ul>${visibleEdges(key,path).map(e=>{if(++budget.count>300)return ''; const repeated=nextSeen.has(e.to); const incoming=Object.values(state.graph.nodes).filter(n=>n.edges.some(x=>x.to===e.to)).length; return `<li><button class="tree-move ${currentKey()===e.to?'current':''}" data-jump="${esc(JSON.stringify([...path,e.to]))}"><span>${depth%2===0?`${Math.floor(depth/2)+1}.`:'…'} <b>${esc(e.san)}</b></span><small>${incoming>1||repeated?'↪ ':''}${e.manual?'edited':e.count}</small></button>${!repeated?renderTree(e.to,nextSeen,depth+1,budget,[...path,e.to]):''}</li>`;}).join('')}</ul>`;
}
function replyToDrill() {
  const d=state.drill;
  if(d && !d.outcome && d.turn!==d.side) {
    const reply=chooseDrillReply(drillChoices(d));
    if(reply)state.drill=advanceDrill(d,reply);
  }
}
function renderPlay() {
  const d=state.drill;
  const roots=[...new Set((state.graph.lines||[]).filter(l=>l.moves.length).map(l=>l.root||state.graph.root))];
  const messages={exhausted:'Repertoire exhausted.',refutation:'You found the refutation.',refuted:'Your move was refuted.', 'off-book':'Move outside the repertoire.', 'missed-refutation':'You missed the recorded refutation.'};
  const expected=d?.expected.map(uci=>uciSan(d.previousFen,uci)).join(', ');
  return `<div class="section-heading"><h2>Repertoire drill</h2></div>${!roots.length?'<p class="muted">Import games to start a drill.</p>':`<label>Play as<select id="drill-side"><option value="w" ${state.drillSide==='w'?'selected':''}>White</option><option value="b" ${state.drillSide==='b'?'selected':''}>Black</option></select></label>${roots.length>1?`<label>Starting position<select id="drill-root">${roots.map((key,i)=>`<option value="${esc(key)}" ${key===(state.drillRoot||state.graph.root)?'selected':''}>${i+1}. ${esc(key)}</option>`).join('')}</select></label>`:''}<button class="primary" data-action="start-drill" ${state.busy?'disabled':''}>${d?'Restart drill':'Start drill'}</button><p id="drill-status" role="status">${d ? messages[d.outcome]||'Your move.' : 'Follow a line from your repertoire.'}${expected?` Expected: ${esc(expected)}.`:''}</p>${d?.moves.length?`<ol class="drill-moves" aria-label="Moves played">${d.moves.map(m=>`<li>${esc(m.san)}</li>`).join('')}</ol>`:''}`}`;
}
function renderMemorize() {
  const c=review(), due=dueCards().length;
  return `<div class="section-heading"><h2>Daily practice</h2><span class="tag">${due} DUE</span></div><div class="review-stats"><div><b>${state.cards.length}</b><span>Total cards</span></div><div><b>${due}</b><span>Ready now</span></div><div><b>${esc(state.cards.reduce((n,c)=>n+(c.repetitions||0),0))}</b><span>Repetitions</span></div></div>${c?`<div class="practice-card"><div class="eyebrow">${new Chess(c.fen).turn()==='w'?'WHITE':'BLACK'} TO MOVE</div><h2>${state.revealed?'Answer':'Find the move'}</h2>${state.revealed?'':'<p class="muted">Play it on the board.</p>'}${state.revealed?`<div class="answer">${esc(c.san)} <small>${esc(c.uci)}</small></div><p class="fine-print">Source: ${esc(c.source)}. Rate your recall, not the position.</p><div class="grade-buttons">${['again','hard','good','easy'].map(g=>`<button data-grade="${g}">${g[0].toUpperCase()+g.slice(1)}</button>`).join('')}</div>`:'<button class="primary" data-action="reveal">Reveal answer <span>↗</span></button>'}</div>`:`<div class="empty-state"><span>♘</span><h3>${state.cards.length?'Practice complete.':'No cards yet.'}</h3><p>${state.cards.length?`Next review ${new Date(Math.min(...state.cards.map(c=>c.due))).toLocaleString()}.`:'Import games and backsolve a repertoire to generate real training positions.'}</p><button data-workspace="Backsolve">Return to Backsolve →</button></div>`}`;
}
function renderExport() { return `<div class="section-heading"><h2>Downloads</h2></div><div class="export-list"><div><span class="file-icon">PGN</span><div><h3>Repertoire notation</h3><p>Legal lines and variations, ready for a chess study.</p></div><button data-action="export-pgn">Download PGN</button></div><div><span class="file-icon">ANKI</span><div><h3>Spaced-repetition deck</h3><p>${state.cards.length} positions with answers. Import into Anki.</p></div><button data-action="export-anki" ${!state.cards.length?'disabled':''}>Download Anki</button></div><div><span class="file-icon">CSV</span><div><h3>Training data</h3><p>Card positions, moves and analysis sources.</p></div><button data-action="export-csv" ${!state.cards.length?'disabled':''}>Download CSV</button></div><div><span class="file-icon">JSON</span><div><h3>Full workspace backup</h3><p>Graph, book, settings and your review history.</p></div><button data-action="backup">Download JSON backup</button></div></div><div class="restore-box"><h3>Restore a workspace</h3><p class="muted">Replace this device’s repertoire with a saved JSON backup. You’ll be asked to confirm.</p><label class="button" for="restore-file">Choose backup<input id="restore-file" type="file" accept=".json" hidden ${state.busy?'disabled':''}></label></div>`; }
function settingsMarkup() {
  const fields=[['mistakeCp','Mistake threshold (centipawns)',1,500,1],['depth','Stockfish depth (ply)',4,20,1],['maxPly','Maximum analysis ply',2,160,1],['theoryPlies','Theory look-up ply',0,40,1],['minTheoryGames','Minimum theory games',1,1000000,1],['maxTheoryDrop','Maximum expected-score drop',0,0.5,0.01]];
  return `<form id="settings-form"><div class="eyebrow">TUNE YOUR WORKSPACE</div><h2>Settings</h2><label for="theory-source">Opening reference</label><select id="theory-source" ${state.busy?'disabled':''}><option value="masters" ${state.source==='masters'?'selected':''}>Lichess Masters · WDL statistics</option><option value="lichess" ${state.source==='lichess'?'selected':''}>Lichess players · WDL statistics</option><option value="book" ${state.source==='book'?'selected':''}>User-supplied PGN · recorded results</option><option value="none" ${state.source==='none'?'selected':''}>No theory skip · engine only</option></select><div class="book-import"><label class="text-button" for="book-file">+ Import your own book PGN<input type="file" id="book-file" accept=".pgn,.txt" class="sr-only" ${state.busy?'disabled':''}></label><span class="fine-print">${state.book?`${state.book.games} book games saved`:'No user book loaded'}</span></div><details class="advanced-settings" open><summary>Analysis & practice</summary><div class="settings-grid">${fields.map(([k,label,min,max,step])=>`<label>${label}<input name="${k}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(state.settings[k])}" required></label>`).join('')}</div><label>Train side<select name="trainSide">${['both','white','black'].map(s=>`<option ${state.settings.trainSide===s?'selected':''}>${s}</option>`).join('')}</select></label><label>Training username<input name="username" maxlength="40" value="${esc(state.settings.username)}" placeholder="Optional · only train this player’s side"></label></details><div class="dialog-actions"><button type="button" data-action="close-dialog">Cancel</button><button class="primary" type="submit" ${state.busy?'disabled':''}>Save settings</button></div></form>`;
}
function renderBoard() {
  const chess=new Chess(boardFen()); const flipped=boardFlipped(state.workspace,review()?chess.turn():null,state.flipped,state.drill?.side||state.drillSide); const ranks=flipped?[1,2,3,4,5,6,7,8]:[8,7,6,5,4,3,2,1]; const files=flipped?'hgfedcba':'abcdefgh';
  const legal=state.selected?chess.moves({square:state.selected,verbose:true}):[];
  $('#board').innerHTML=ranks.map((rank,ri)=>[...files].map((file,fi)=>{ const sq=file+rank,p=chess.get(sq),target=legal.some(m=>m.to===sq); return `<button class="square ${(rank+file.charCodeAt(0))%2===0?'dark':'light'} ${state.selected===sq?'selected':''} ${target?'legal':''} ${p?'piece-'+p.color:''}" data-square="${sq}" aria-label="${sq} ${p?`${p.color==='w'?'white':'black'} ${pieceNames[p.type]}`:'empty'}">${fi===0?`<span class="rank-label">${rank}</span>`:''}<span class="piece">${p?glyphs[p.color+p.type]:''}</span>${ri===7?`<span class="file-label">${file}</span>`:''}${target?'<span class="move-dot"></span>':''}</button>`; }).join('')).join('');
  $('#position-label').textContent=`${chess.turn()==='w'?'White':'Black'} to move${chess.isCheck()?' · check':''}`;
  $('#board').querySelectorAll('[data-square]').forEach(b=>b.onclick=()=>onSquare(b.dataset.square));
}
function uciSan(fen,uci) { try { const c=new Chess(fen); return c.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]})?.san||uci; } catch { return uci; } }
function navigate(key) { if(!state.graph.nodes[key])return; state.path.push(key); state.selected=null; state.inspection=null; render(); }
async function onSquare(square) {
  if(state.busy || (state.workspace==='Play' && (!state.drill || state.drill.outcome || state.drill.turn!==state.drill.side)) || (state.workspace==='Memorize' && (!review() || state.revealed)))return;
  const c=new Chess(boardFen()); const moves=state.selected?c.moves({square:state.selected,verbose:true}).filter(m=>m.to===square):[];
  if(moves.length) {
    if(moves.some(m=>m.promotion)) { $('#promotion-options').innerHTML=moves.map(m=>`<button data-promotion="${m.promotion}">${glyphs[c.turn()+m.promotion]} ${pieceNames[m.promotion]}</button>`).join(''); $('#promotion-options').querySelectorAll('button').forEach(b=>b.onclick=()=>{ $('#promotion-dialog').close(); playMove(state.selected+square+b.dataset.promotion); }); $('#promotion-dialog').showModal(); }
    else await playMove(state.selected+square);
    return;
  }
  const p=c.get(square);state.selected=p?.color===c.turn()?square:null; renderBoard();
}
function preserveManualPath(graph,key,uci) {
  const source=structuredClone(state.sourceGraph||graph);
  const root=graph.root;let previous=root;const moves=[];
  for(const target of state.path){const edge=graph.nodes[previous].edges.find(e=>e.to===target);if(!edge)throw new Error('Invalid active path');moves.push(edge.uci);previous=target;}
  moves.push(uci);
  const chess=new Chess(graph.nodes[root].fen);
  for(const token of moves){const from=positionKey(chess.fen());if(!source.nodes[from])source.nodes[from]={key:from,fen:chess.fen(),visits:0,edges:[]};const m=chess.move({from:token.slice(0,2),to:token.slice(2,4),promotion:token[4]});const to=positionKey(chess.fen());if(!source.nodes[to])source.nodes[to]={key:to,fen:chess.fen(),visits:0,edges:[]};if(!source.nodes[from].edges.some(e=>e.uci===token))source.nodes[from].edges.push({uci:token,san:m.san,to,count:0,manual:true});}
  source.lines||=[];source.lines.push({root,fen:graph.nodes[root].fen,moves,white:'',black:'',manual:true});return source;
}
async function playMove(uci) { try { if(state.workspace==='Play'){state.drill=advanceDrill(state.drill,uci);state.selected=null;replyToDrill();render();return;} if(state.workspace==='Memorize'){const card=review();if(!card||state.revealed)return;state.reviewId=card.id;state.revealed=true;state.selected=null;render();notify(uci===card.uci?'Correct. '+card.san+' is the repertoire move.':'Not the repertoire move. The answer is '+card.san+'.');return;} const key=currentKey();state.graph=addMove(state.graph,key,uci);state.sourceGraph=preserveManualPath(state.graph,key,uci);const edge=state.graph.nodes[key].edges.find(e=>e.uci===uci);navigate(edge.to);await save(); } catch(e){notify(e.message,true);} }
async function importText(text,isBook=false) { if(state.busy)return; try { if(isBook&&state.book&&!confirm('Replace your existing reference book?'))return; const result=importPgn(text,isBook?undefined:(state.sourceGraph||state.graph)); if(result.games<=(isBook?0:state.graph.games))throw new Error(`No valid new games found. ${result.warnings?.at(-1)||'Check the PGN notation.'}`); if(isBook)state.book=result; else { state.sourceGraph=result;state.graph=result;state.path=[];state.inspection=null; } state.selected=null;render();await save();notify(`${isBook?'Book':'PGN'} imported. ${result.warnings?.length?result.warnings.join(' '):'Saved on this device.'}`); } catch(e){notify(`Import failed: ${e.message}`,true);} }
function progressText(p) { if(typeof p==='string')return p;if(!p)return 'Analyzing…';return Object.entries(p).filter(([,v])=>typeof v!=='object').map(([k,v])=>`${k}: ${v}`).join(' · ')||'Analyzing…'; }
function updateProgress(p) { state.progress=progressText(p); const el=$('#progress');if(el)el.textContent=state.progress; }
async function task(fn) {
  if(state.busy)return;state.busy=true;state.controller=new AbortController();state.progress='Starting…';state.error='';render();
  try { await fn(state.controller.signal); }
  catch(e) { notify(state.controller?.signal.aborted?'Cancelled. Your saved repertoire was not replaced.':e.message,true); }
  finally { state.engine?.close();state.engine=null;state.busy=false;state.controller=null;render(); }
}
async function engine(signal) {
  if(state.engine)return state.engine;
  let listener;
  const cancelled=new Promise((_,reject)=>{listener=()=>reject(new DOMException('Cancelled','AbortError'));signal.addEventListener('abort',listener,{once:true});});
  const loading=createEngine(message=>{if(!signal.aborted)updateProgress(message);}).then(e=>{if(signal.aborted){e.close();throw new DOMException('Cancelled','AbortError');}state.engine=e;return e;});
  try{return await Promise.race([loading,cancelled]);}finally{signal.removeEventListener('abort',listener);}
}
function bookTheory(fen) {
  const node=state.book?.nodes[positionKey(fen)];
  const moves=(node?.edges||[]).map(e=>({...e,white:e.white||0,draws:e.draws||0,black:e.black||0}));
  return {source:'User PGN results',white:moves.reduce((n,m)=>n+m.white,0),draws:moves.reduce((n,m)=>n+m.draws,0),black:moves.reduce((n,m)=>n+m.black,0),moves};
}
async function reference(fen,source,signal){try{return await getTheory(fen,source,signal);}catch(e){throw new Error(`Theory unavailable (${source}): ${e.message}`);}}
async function runBacksolve() {
  if(!state.graph.games)return;
  await task(async signal=>{
    if(state.source==='book'&&!state.book)throw new Error('No user-supplied book loaded. Import a book PGN or choose another reference.');
    const e=await engine(signal); if(signal.aborted)throw new Error('Cancelled');
    const settings={...state.settings}; const source=state.source;
    // Only actual mainline PGN game results establish user-book WDL.
    if(source==='none')settings.theoryPlies=0;
    const result=await backsolve(state.sourceGraph||state.graph,{settings,signal,evaluate:async(fen,s)=>{if(signal.aborted)throw new Error('Cancelled');return e.evaluate(fen,s);},theory:fen=>source==='book'?bookTheory(fen):reference(fen,source,signal),onProgress:updateProgress});
    if(signal.aborted)throw new Error('Cancelled');
    const old=new Map(state.cards.map(c=>[c.id,c]));state.graph=result.graph;state.cards=result.cards.map(c=>old.has(c.id)&&old.get(c.id).uci===c.uci?{...c,...old.get(c.id),fen:c.fen,uci:c.uci,san:c.san}:c);state.path=[];state.inspection=null;await save();state.progress=`Complete · ${state.cards.length} training cards · ${progressText(result.stats)}`;notify('Backsolve complete. Browse your lines or start a recall session.');
  });
}
async function inspectMaia() {
  const fen=boardFen(),key=positionKey(fen);
  await task(async signal=>{
    notify('Loading Maia and predicting moves…');
    const maia=await predictMaia(fen,{signal});
    signal.throwIfAborted();
    const previous=state.inspection?.key===key?state.inspection:state.graph.nodes[key];
    state.inspection={key,theory:previous?.theory,analysis:previous?.analysis,maia};
    notify('');
  });
}
async function inspect(kind) {
  const fen=boardFen(),key=positionKey(fen);
  await task(async signal=>{const result={...(state.inspection?.key===key?state.inspection:{key})};if(kind==='evaluate'){const e=await engine(signal);if(signal.aborted)throw new Error('Cancelled');result.analysis=await e.evaluate(fen,state.settings);}else if(state.source==='book'){const node=state.book?.nodes[positionKey(fen)];if(!state.book)throw new Error('Theory unavailable: no user book loaded.');result.theory={userBook:true,total:node?.edges.reduce((s,e)=>s+e.count,0)||0,moves:node?.edges||[]};}else {if(state.source==='none')throw new Error('Theory is disabled. Choose a reference in Backsolve.');result.theory=await reference(fen,state.source,signal);}if(signal.aborted)return;state.inspection=result;if(state.graph.nodes[key]){Object.assign(state.graph.nodes[key],{...(result.analysis?{analysis:result.analysis}:{}),...(result.theory?{theory:result.theory}:{})});await save();}state.progress='Position inspection complete.';});
}
async function importRemote() {
  const form=$('#archive-form'), data=new FormData(form);
  const platform=data.get('platform'), username=String(data.get('username')).trim();
  const maxGames=data.get('history')==='all'?Infinity:Number(data.get('history'));
  const minMoves=Number(data.get('minMoves')), timeControls=data.getAll('speed');
  const dates=['from','to'].map(k=>data.get(k)||'');
  const since=dates[0]?Date.parse(dates[0]+'T00:00:00Z'):undefined;
  const until=dates[1]?Date.parse(dates[1]+'T23:59:59.999Z'):undefined;
  if(!username||!timeControls.length||since>until) return notify('Enter a username, choose a time control and check the date range.',true);
  state.archive={platform,username,history:data.get('history'),minMoves,timeControls,from:dates[0],to:dates[1]};
  await task(async signal=>{
    const before=state.sourceGraph||state.graph;
    let graph=structuredClone(before);
    try {
      const result=await fetchGames(platform,username,{maxGames,minMoves,timeControls,since,until,signal,
        onProgress:p=>updateProgress(`Scanned ${p.scanned} · ${p.matched} matching`),
        onBatch:async text=>{
          signal.throwIfAborted();
          graph=importPgn(text,graph,{deduplicate:true,maxStoredPlies:Math.max(80,state.settings.maxPly),mutate:true,strict:true});
          await new Promise(resolve=>setTimeout(resolve,0));
        }});
      signal.throwIfAborted();
      const added=graph.games-before.games;
      if(added){await persist({graph,sourceGraph:graph});state.sourceGraph=graph;state.graph=graph;state.path=[];state.inspection=null;state.drill=null;}
      state.progress=`${result.scanned} scanned · ${result.matched} matched`;
      notify(added ? `Imported ${added} new ${added===1?'game':'games'}.` : 'No new matching games.');
    }catch(error){if(/limit exceeded/i.test(error.message))throw new Error('The archive exceeds workspace limits. Try a narrower date range or a fresh workspace. Your saved games were not changed.');throw error;}
  });
}
function validateGraph(g) {
  if(!g||g.version!==1||!g.nodes||!g.nodes[g.root]||!Number.isInteger(g.games)||g.games<0)throw new Error('Invalid repertoire graph.');
  const entries=Object.entries(g.nodes);if(entries.length>200000)throw new Error('Backup exceeds the 200,000-position limit.');
  if(g.lines!==undefined && (!Array.isArray(g.lines)||g.lines.length>100000))throw new Error('Invalid repertoire lines.');
  for(const line of g.lines||[]){
    if(!line||!g.nodes[line.root||g.root]||!Array.isArray(line.moves)||line.moves.length>2048||line.moves.some(uci=>typeof uci!=='string'||!/^([a-h][1-8]){2}[qrbn]?$/.test(uci)))throw new Error('Invalid repertoire line.');
    if(!Number.isInteger(line.mistakePly)||line.mistakePly<0||line.mistakePly>=line.moves.length)delete line.mistakePly;
  }
  for(const [key,n]of entries){delete n.analysis;delete n.theory;delete n.maia;new Chess(n.fen);if(key!==positionKey(n.fen)||!Array.isArray(n.edges))throw new Error('Invalid position key or edges.');for(const e of n.edges){if(!Number.isInteger(e.count)||e.count<0||typeof e.san!=='string'||!/^([a-h][1-8]){2}[qrbn]?$/.test(e.uci))throw new Error('Invalid move data.');if(!g.nodes[e.to])throw new Error('Broken graph link.');const c=new Chess(n.fen);c.move({from:e.uci.slice(0,2),to:e.uci.slice(2,4),promotion:e.uci[4]});if(positionKey(c.fen())!==e.to)throw new Error('Illegal graph transition.');}}
}
async function restore(file) {
  if(state.busy)return;
  try { if(file.size>25*1024*1024)throw new Error('Backup limit is 25 MB.');const data=JSON.parse(await file.text());if(data.format!=='repertoire-forge'||data.version!==1)throw new Error('Not a supported Repertoire Forge backup.');validateGraph(data.graph);if(data.sourceGraph)validateGraph(data.sourceGraph);if(data.book)validateGraph(data.book);if(!Array.isArray(data.cards)||data.cards.length>100000)throw new Error('Invalid cards.');for(const c of data.cards){new Chess(c.fen);if(c.id!==positionKey(c.fen))throw new Error('Invalid card position identity.');if(!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(c.uci)||!Number.isFinite(c.due)||!Number.isFinite(c.interval)||!Number.isFinite(c.ease)||!Number.isFinite(c.repetitions)||!Number.isFinite(c.lapses))throw new Error('Invalid review card.');const chess=new Chess(c.fen);chess.move({from:c.uci.slice(0,2),to:c.uci.slice(2,4),promotion:c.uci[4]});}const settings=boundedSettings(data.settings||DEFAULT_SETTINGS);if(!confirm('Replace your repertoire, book and review progress with this backup?'))return;Object.assign(state,{graph:data.graph,sourceGraph:data.sourceGraph||data.graph,cards:data.cards,book:data.book||null,settings,path:[],inspection:null,selected:null});await save();render();notify('Backup restored and saved locally.'); }catch(e){notify(`Restore failed: ${e.message}`,true);}
}
function boundedSettings(s) {
  const out={...DEFAULT_SETTINGS};const bounds={mistakeCp:[1,500],depth:[4,20],maxPly:[2,160],theoryPlies:[0,40],minTheoryGames:[1,1000000],maxTheoryDrop:[0,0.5]};
  for(const[k,[min,max]]of Object.entries(bounds)){const v=Number(s[k]);if(!Number.isFinite(v)||v<min||v>max||(k!=='maxTheoryDrop'&&!Number.isInteger(v)))throw new Error(`Invalid setting: ${k}. Expected ${min}–${max}.`);out[k]=v;}
  if(!['both','white','black'].includes(s.trainSide))throw new Error('Invalid training side.');out.trainSide=s.trainSide;out.username=String(s.username||'').trim().slice(0,40);return out;
}
function bind() {
  if($('#archive-form'))$('#archive-form').onsubmit=e=>{e.preventDefault();importRemote();};
  if($('#pgn'))$('#pgn').oninput=e=>{state.draft=e.target.value;};
  document.querySelectorAll('[data-workspace]').forEach(b=>b.onclick=()=>{if(state.workspace!==b.dataset.workspace)state.drill=null;state.workspace=b.dataset.workspace;state.selected=null;state.revealed=false;state.reviewId=null;render();});
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>runAction(b.dataset.action));
  document.querySelectorAll('[data-to]').forEach(b=>b.onclick=()=>navigate(b.dataset.to));document.querySelectorAll('[data-jump]').forEach(b=>b.onclick=()=>{state.path=JSON.parse(b.dataset.jump);state.selected=null;state.inspection=null;render();});
  document.querySelectorAll('[data-grade]').forEach(b=>b.onclick=async()=>{const card=review();if(!card||!state.revealed)return;state.cards=state.cards.map(c=>c.id===card.id?reviewCard(c,b.dataset.grade):c);state.revealed=false;state.reviewId=null;await save();render();});
  for(const[id,book]of [['pgn-file',false],['book-file',true]])if($('#'+id))$('#'+id).onchange=async e=>{const f=e.target.files[0];if(!f)return;if(f.size>10*1024*1024)return notify('PGN limit is 10 MB. Split the file before importing.',true);await importText(await f.text(),book);if(book&&!$('#settings-dialog').open)$('#settings-dialog').showModal();};
  if($('#restore-file'))$('#restore-file').onchange=e=>{if(e.target.files[0])restore(e.target.files[0]);};
  if($('#drill-side'))$('#drill-side').onchange=e=>{state.drillSide=e.target.value;if(!state.drill)renderBoard();};
  if($('#drill-root'))$('#drill-root').onchange=e=>{state.drillRoot=e.target.value;};
  if($('#root-select'))$('#root-select').onchange=e=>{state.graph={...state.graph,root:e.target.value};state.path=[];state.selected=null;state.inspection=null;render();};
  $('#settings-form').onsubmit=async e=>{e.preventDefault();try{state.settings=boundedSettings(Object.fromEntries(new FormData(e.target)));state.source=$('#theory-source').value;await save();render();$('[data-action="settings"]').focus();notify('Settings saved for the next analysis.');}catch(error){notify(error.message,true);}};
}
async function runAction(action) {
  const actions={
    'start-drill':()=>{if(state.busy)return;state.drill=startDrill(state.graph,$('#drill-side').value,$('#drill-root')?.value||state.graph.root);state.selected=null;state.notice='';replyToDrill();render();},
    maia:()=>state.maiaAllowed?inspectMaia():$('#maia-dialog').showModal(),
    'load-maia':()=>{state.maiaAllowed=true;return inspectMaia();},
    settings:()=>$('#settings-dialog').showModal(),sources:()=>$('#sources-dialog').showModal(),'close-dialog':()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()),
    flip:()=>{state.flipped=!state.flipped;renderBoard();},root:()=>{state.path=[];state.selected=null;state.inspection=null;render();},back:()=>{state.path.pop();state.selected=null;state.inspection=null;render();},next:()=>{const e=visibleEdges()[0];if(e)navigate(e.to);},end:()=>{const seen=new Set(state.path);let e;while((e=visibleEdges()[0])&&!seen.has(e.to)&&state.path.length<200){state.path.push(e.to);seen.add(e.to);}state.selected=null;state.inspection=null;render();},
    import:()=>importText($('#pgn').value),sample:()=>importText(SAMPLE),fetch:importRemote,backsolve:runBacksolve,cancel:()=>{state.controller?.abort();state.engine?.close();state.engine=null;updateProgress('Cancelling…');},evaluate:()=>inspect('evaluate'),theory:()=>inspect('theory'),reveal:()=>{state.reviewId=review()?.id;state.revealed=true;render();},
    'copy-fen':async()=>{await navigator.clipboard.writeText(boardFen());notify('FEN copied.');},
    'export-pgn':()=>download('repertoire.pgn',exportPgn(state.graph),'application/x-chess-pgn'),'export-csv':()=>download('repertoire-cards.csv',exportCsv(state.cards),'text/csv'),
    'export-anki':async()=>{const data=await exportAnki(state.cards);download('repertoire-forge.apkg',data,'application/octet-stream');notify('Anki deck downloaded.');},
    backup:()=>download('repertoire-forge.json',JSON.stringify({format:'repertoire-forge',version:1,createdAt:new Date().toISOString(),graph:state.graph,sourceGraph:state.sourceGraph,cards:state.cards,book:state.book,settings:state.settings},null,2),'application/json'),
    reset:async()=>{if(state.busy)return;if(confirm('Delete the saved repertoire and all training cards? Export a backup first if needed.')){state.graph=blankGraph();state.sourceGraph=null;state.cards=[];state.path=[];state.inspection=null;await save();render();notify('Repertoire and cards cleared. Your book and settings were kept.');}}
  };
  try { await actions[action]?.(); } catch(e){notify(e.message,true);}
}
document.addEventListener('keydown',e=>{if(['Memorize','Play'].includes(state.workspace)||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)||document.querySelector('dialog[open]'))return;if(e.key==='ArrowLeft'){e.preventDefault();runAction('back');}if(e.key==='ArrowRight'){e.preventDefault();runAction('next');}});
async function init() {
  let storageError;
  try { db=await openStore();const data=await new Promise((resolve,reject)=>{const req=db.transaction('state').objectStore('state').get('workspace');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});if(data){validateGraph(data.graph);if(data.sourceGraph)validateGraph(data.sourceGraph);if(data.book)validateGraph(data.book);state.draft=data.draft||'';state.graph=data.graph;state.sourceGraph=data.sourceGraph||data.graph;state.cards=data.cards||[];state.book=data.book||null;state.settings=boundedSettings({...DEFAULT_SETTINGS,...data.settings});state.source=['masters','lichess','book','none'].includes(data.source)?data.source:'masters';} }catch(e){storageError=`Local storage unavailable: ${e.message}. Export backups before closing.`;}
  if(storageError)state.storageError=storageError;render();
  if('serviceWorker'in navigator && import.meta.env.PROD){try{const registration=await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;const offlineAssets=['engine/stockfish-17.1-lite-single-03e3232.js','engine/stockfish-17.1-lite-single-03e3232.wasm','vendor/sql-wasm.wasm'].map(path=>new URL(path,location.href).href);const assets=[...offlineAssets,...[...document.querySelectorAll('script[src],link[rel="stylesheet"],link[rel="modulepreload"]')].map(el=>el.src||el.href)];const worker=registration.active||registration.waiting||registration.installing;worker?.postMessage({type:'CACHE_ASSETS',urls:assets});}catch(e){notify(`Offline cache unavailable: ${e.message}. App remains usable online.`,true);}}
}
if('serviceWorker'in navigator)navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='CACHE_STATUS'&&event.data.failed?.length)notify('Offline cache incomplete. Keep internet connected and reload to cache the engine and export assets.',true);});
init();
