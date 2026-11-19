import { Chess } from 'chess.js';

export const DEFAULT_SETTINGS = Object.freeze({ mistakeCp: 25, depth: 14, maxPly: 40, theoryPlies: 16, minTheoryGames: 20, maxTheoryDrop: 0.05, trainSide: 'both', username: '' });
const START = new Chess().fen();
const LIMITS = { bytes: 20_000_000, tokens: 2_000_000, nodes: 200_000, lines: 100_000 };
const nodeCounts = new WeakMap();
export function positionKey(fen) { return fen.trim().split(/\s+/).slice(0, 4).join(' '); }
function emptyGraph(fen = START) { return { version: 1, root: positionKey(fen), nodes: {}, games: 0, warnings: [], lines: [] }; }
function node(graph, fen) {
  const key = positionKey(fen);
  if (!graph.nodes[key]) {
    const count = nodeCounts.get(graph) ?? Object.keys(graph.nodes).length;
    if (count >= LIMITS.nodes) throw new Error('Position limit exceeded');
    graph.nodes[key] = { key, fen, visits: 0, edges: [] };
    nodeCounts.set(graph,count + 1);
  }
  return graph.nodes[key];
}
function move(chess, uci) { return chess.move(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) ? { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] } : uci); }
function uciOf(m) { return m.from + m.to + (m.promotion || ''); }
function connect(graph, chess, token, count = 0, manual = false) {
  const from = node(graph, chess.fen());
  const m = move(chess, token);
  const to = node(graph, chess.fen());
  let edge = from.edges.find(e => e.uci === uciOf(m));
  if (!edge) { edge = { uci: uciOf(m), san: m.san, to: to.key, count }; from.edges.push(edge); }
  else edge.count += count;
  if (manual) edge.manual = true;
  return edge;
}
function parseGame(tokens, headers) {
  const fen = headers.FEN || START;
  let chess = new Chess(fen), path = [], stack = [], lines = [];
  for (let token of tokens) {
    if (token === '(') {
      if (!path.length) throw new Error('Variation without preceding move');
      stack.push({ chess, path }); path = path.slice(0, -1); chess = new Chess(fen);
      for (const uci of path) move(chess, uci);
    } else if (token === ')') {
      if (!stack.length) throw new Error('Unmatched variation close');
      lines.push(path); ({ chess, path } = stack.pop());
    } else {
      token = token.replace(/^\d+\.(?:\.\.)?/, '').replace(/[!?]+$/g, '');
      if (!token || /^\.+$|^\$\d+$|^(?:1-0|0-1|1\/2-1\/2|\*)$/.test(token)) continue;
      path = [...path, uciOf(move(chess, token))];
      if (path.length > 2048) throw new Error('Game ply limit exceeded');
    }
  }
  if (stack.length) throw new Error('Unclosed variation');
  lines.unshift(path);
  return lines.filter(p => p.length).map((moves,index) => ({ root: positionKey(fen), fen, moves, white: headers.White || '', black: headers.Black || '', result: index===0 ? (headers.Result || tokens.findLast(t=>/^(1-0|0-1|1\/2-1\/2)$/.test(t)) || '*') : '*' }));
}
const archiveIds = new WeakMap();
function canonicalGameId(site) {
  const lichess=/^https:\/\/lichess\.org\/(?:game\/)?([a-zA-Z0-9]{8})(?:\/(?:white|black))?$/.exec(site||'');
  if(lichess)return `https://lichess.org/${lichess[1]}`;
  const chesscom=/^https:\/\/(?:www\.)?chess\.com\/game\/(live|daily)\/(\d+)$/.exec(site||'');
  return chesscom ? `https://www.chess.com/game/${chesscom[1]}/${chesscom[2]}` : undefined;
}
export function importPgn(text, existingGraph, {deduplicate=false, maxStoredPlies=2048, mutate=false, strict=false} = {}) {
  if (typeof text !== 'string' || text.length > LIMITS.bytes) throw new Error('PGN input exceeds 20 MB limit');
  const graph = existingGraph ? (mutate ? existingGraph : structuredClone(existingGraph)) : emptyGraph();
  graph.lines ||= [];
  let ids;
  if(deduplicate){ids=archiveIds.get(graph)||new Set(graph.lines.map(line=>line.gameId).filter(Boolean));archiveIds.set(graph,ids);}
  const tokens = text.replace(/^\uFEFF/, '').match(/\[(?:[^"\]]|"(?:\\.|[^"\\])*")*\]|\{[^}]*\}|;[^\n]*|\(|\)|[^\s(){};]+/g) || [];
  if (tokens.length > LIMITS.tokens) throw new Error('PGN token limit exceeded');
  let headers = {}, moves = [], gameNumber = 0, variationDepth = 0, importWork = 0;
  function flush() {
    if (!moves.length) return;
    gameNumber++;
    try {
      const gameId = canonicalGameId(headers.Link)||canonicalGameId(headers.Site);
      if(gameId && ids?.has(gameId)){moves=[];headers={};variationDepth=0;return;}
      const lines = parseGame(moves, headers).map(line=>({...line,moves:line.moves.slice(0,maxStoredPlies)}));
      if (graph.lines.length + lines.length > LIMITS.lines) throw new Error('Line limit exceeded');
      const staged = emptyGraph(lines[0]?.fen);
      const seenEdges = new Set();
      importWork += lines.reduce((sum,line)=>sum+line.moves.length,0);
      if (importWork > 1_000_000) throw new Error('PGN expanded work limit exceeded');
      for (const line of lines) {
        const chess = new Chess(line.fen); node(staged, chess.fen());
        for (const uci of line.moves) {
          const from = positionKey(chess.fen()), id = from + ':' + uci;
          const fresh=!seenEdges.has(id);
          const edge=connect(staged, chess, uci, fresh ? 1 : 0);
          if(fresh && ['1-0','0-1','1/2-1/2'].includes(line.result)){
            const bucket=line.result==='1-0'?'white':line.result==='0-1'?'black':'draws';
            edge[bucket]=(edge[bucket]||0)+1;
          }
          seenEdges.add(id);
        }
      }
      const added = Object.keys(staged.nodes).filter(key=>!graph.nodes[key]).length;
      if ((nodeCounts.get(graph) ?? Object.keys(graph.nodes).length) + added > LIMITS.nodes) throw new Error('Position limit exceeded');
      for (const incoming of Object.values(staged.nodes)) {
        const target = node(graph,incoming.fen); target.visits++;
        for (const edge of incoming.edges) {
          const existing = target.edges.find(e=>e.uci===edge.uci);
          if (existing) { existing.count += edge.count; for(const k of ['white','draws','black'])existing[k]=(existing[k]||0)+(edge[k]||0); }
          else target.edges.push(edge);
        }
      }
      graph.lines.push(...lines.map(line=>({...line,game:graph.games,...(gameId?{gameId}:{})})));
      if(gameId)ids?.add(gameId);
      if (!graph.games && lines.length) graph.root = lines[0].root;
      graph.games++;
    } catch (error) { if(strict)throw error;graph.warnings.push(`Game ${gameNumber}: ${error.message}`); }
    moves = []; headers = {}; variationDepth = 0;
  }
  for (const token of tokens) {
    if (token.startsWith('{') || token.startsWith(';')) continue;
    if (token.startsWith('[')) {
      if (moves.length) flush();
      const match = token.match(/^\[(\w+)\s+"((?:\\.|[^"\\])*)"\]$/);
      if (match) headers[match[1]] = match[2].replace(/\\(["\\])/g, '$1');
    } else {
      moves.push(token);
      if (token === '(') variationDepth++;
      if (token === ')') variationDepth--;
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token) && variationDepth === 0) flush();
    }
  }
  flush();
  node(graph, graph.nodes[graph.root]?.fen || START);
  return graph;
}

function abort(signal) {
  if (signal?.aborted) throw new DOMException('Backsolve cancelled', 'AbortError');
}
async function interruptible(operation, signal) {
  abort(signal);
  let timer, listener;
  const boundary = new Promise((_, reject) => {
    listener = () => reject(new DOMException('Backsolve cancelled', 'AbortError'));
    signal?.addEventListener('abort', listener, {once:true});
    timer = setTimeout(() => reject(new Error('Analysis/theory request timed out after 120 seconds')),120000);
  });
  try { return await Promise.race([Promise.resolve().then(operation),boundary]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort',listener); }
}
function bounded(value, fallback, min, max) {
  return Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}
function settingsFor(settings = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  s.maxPly = Math.floor(bounded(s.maxPly, 40, 1, 512));
  s.depth = Math.floor(bounded(s.depth, 14, 1, 64));
  s.mistakeCp = bounded(s.mistakeCp, 25, 0, 100000);
  s.theoryPlies = Math.floor(bounded(s.theoryPlies, 16, 0, 512));
  s.minTheoryGames = bounded(s.minTheoryGames, 20, 1, 1e9);
  s.maxTheoryDrop = bounded(s.maxTheoryDrop, 0.05, 0, 1);
  if (!['both', 'white', 'black'].includes(s.trainSide)) throw new Error('Invalid training side');
  return s;
}
function score(evaluation) {
  if (Number.isFinite(evaluation.mate)) {
    if (evaluation.mate === 0) return -1e9;
    return Math.sign(evaluation.mate) * (1e9 - Math.min(Math.abs(evaluation.mate), 10000) * 1000);
  }
  return evaluation.scoreCp;
}
function allowedSide(line, turn, settings) {
  if (settings.trainSide !== 'both' && settings.trainSide[0] !== turn) return false;
  const user = settings.username.trim().toLowerCase();
  return !user || (turn === 'w' ? line.white : line.black)?.toLowerCase() === user;
}
function sourceLines(graph, maxPly) {
  if (graph.lines) return graph.lines;
  const lines = [];
  function walk(key, moves, visited, fen) {
    if (lines.length >= 10000) throw new Error('Traversal line limit exceeded');
    const edges = graph.nodes[key]?.edges || [];
    if (!edges.length || visited.has(key) || moves.length >= maxPly) { lines.push({root:graph.root, fen, moves}); return; }
    const next = new Set(visited); next.add(key);
    for (const edge of edges) walk(edge.to, [...moves, edge.uci], next, fen);
  }
  walk(graph.root, [], new Set(), graph.nodes[graph.root].fen);
  return lines;
}
function theorySkip(data, uci, turn, settings) {
  const total = entry => entry.white + entry.draws + entry.black;
  if (!data || !Array.isArray(data.moves) || !['white','draws','black'].every(k => Number.isFinite(data[k]) && data[k] >= 0)) throw new Error('Invalid theory response');
  const candidate = data.moves.find(m => m.uci === uci);
  if (!candidate || !['white','draws','black'].every(k=>Number.isFinite(candidate[k]) && candidate[k]>=0)) return false;
  if (total(data) < settings.minTheoryGames || total(candidate) < settings.minTheoryGames) return false;
  const expected = entry => (entry[turn === 'w' ? 'white' : 'black'] + entry.draws / 2) / total(entry);
  return expected(data) - expected(candidate) <= settings.maxTheoryDrop;
}
export async function backsolve(input, { settings = {}, evaluate, theory, onProgress, signal } = {}) {
  const s = settingsFor(settings);
  if (typeof evaluate !== 'function') throw new Error('A real engine evaluator is required');
  abort(signal);
  const lines = sourceLines(input, s.maxPly);
  const output = emptyGraph(input.nodes[input.root]?.fen || START);
  output.games = input.games; output.warnings = [...(input.warnings || [])];
  const cache = new Map(), theoryCache = new Map(), cards = new Map();
  const stats = { analyzed: 0, theorySkipped: 0, mistakes: 0, lines: 0, cards: 0, truncated: 0 };
  let work = 0;
  async function analyze(fen) {
    abort(signal);
    const key = positionKey(fen);
    if (!cache.has(key)) {
      if (cache.size >= 20000) throw new Error('Analysis position limit exceeded');
      const value = await interruptible(() => evaluate(fen, s), signal); abort(signal);
      if (!value || value.source !== 'stockfish' || (!Number.isFinite(value.scoreCp) && !Number.isFinite(value.mate))) throw new Error('Invalid Stockfish evaluation');
      const chess = new Chess(fen);
      if (chess.moves().length) {
        if (!value.bestMove || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value.bestMove)) throw new Error('Engine omitted a legal UCI best move');
        move(chess, value.bestMove);
      }
      cache.set(key, structuredClone(value)); stats.analyzed++;
    }
    const evaluation = cache.get(key);
    node(output, fen).analysis = evaluation;
    return evaluation;
  }
  function card(fen, evaluation, line, source = 'stockfish') {
    const chess = new Chess(fen);
    if (!evaluation.bestMove || !allowedSide(line, chess.turn(), s)) return;
    const m = move(chess, evaluation.bestMove), key = positionKey(fen);
    if (!cards.has(key)) cards.set(key, {id:key, fen, uci:uciOf(m), san:m.san, source, due:Date.now(), interval:0, repetitions:0, ease:2.5, lapses:0});
  }
  for (const line of lines) {
    abort(signal);
    const chess = new Chess(line.fen || input.nodes[line.root || input.root].fen);
    const resultLine = {...line, moves:[]}, seen = new Set();
    delete resultLine.mistakePly;
    node(output, chess.fen());
    for (const uci of line.moves.slice(0,s.maxPly)) {
      abort(signal);
      if (++work > 200000) throw new Error('Backsolve work limit exceeded');
      if (work % 128 === 0) { await new Promise(resolve=>setTimeout(resolve,0)); abort(signal); }
      const fen = chess.fen(), key = positionKey(fen), ply = resultLine.moves.length;
      if (seen.has(key)) { stats.truncated++; break; }
      seen.add(key);
      let skip = false;
      if (theory && ply < s.theoryPlies) {
        if (!theoryCache.has(key)) {
          const data = await interruptible(() => theory(fen), signal); abort(signal);
          theoryCache.set(key, data);
        }
        const data = theoryCache.get(key);
        skip = theorySkip(data, uci, chess.turn(), s);
        node(output, fen).theory = structuredClone(data);
      }
      const parent = skip ? null : await analyze(fen);
      const edge = connect(output, chess, uci, 1);
      resultLine.moves.push(edge.uci);
      if (skip) { stats.theorySkipped++; continue; }
      card(fen, parent, line);
      const child = await analyze(chess.fen());
      const loss = score(parent) + score(child);
      if (edge.uci !== parent.bestMove && loss > s.mistakeCp) {
        stats.mistakes++;
        resultLine.mistakePly = ply;
        if (child.bestMove && chess.moves().length) {
          card(chess.fen(), child, line);
          const refutation = connect(output, chess, child.bestMove, 1);
          refutation.refutation = true;
          resultLine.moves.push(refutation.uci);
        }
        break;
      }
    }
    if (line.moves.length > s.maxPly) stats.truncated++;
    output.lines.push(resultLine); stats.lines++;
    onProgress?.({...stats});
  }
  // Position identity is global; lines are the authoritative path provenance.
  // Consumers must traverse lines, not recombine edges, after pruning.
  for (const n of Object.values(output.nodes)) n.visits = input.nodes[n.key]?.visits || 0;
  stats.cards = cards.size;
  onProgress?.({...stats});
  abort(signal);
  return {graph:output, cards:[...cards.values()], stats};
}

export function reviewCard(card, grade, now = Date.now()) {
  if (!['again','hard','good','easy'].includes(grade)) throw new Error('Invalid review grade');
  if (!Number.isFinite(now)) throw new Error('Invalid review timestamp');
  const next = {...card};
  const interval = bounded(card.interval, 0, 0, 36500), ease = bounded(card.ease, 2.5, 1.3, 4);
  next.repetitions = Math.max(0, card.repetitions || 0) + 1;
  next.lapses = Math.max(0, card.lapses || 0);
  if (grade === 'again') {
    next.interval = 1 / 144; next.repetitions = 0; next.lapses++; next.ease = Math.max(1.3, ease - 0.2);
  } else if (grade === 'hard') {
    next.interval = Math.max(0.5, interval * 1.2); next.ease = Math.max(1.3, ease - 0.15);
  } else if (grade === 'good') {
    next.interval = interval < 1 ? 1 : interval < 3 ? 3 : interval * ease; next.ease = ease;
  } else {
    next.interval = Math.max(4, interval * ease * 1.3); next.ease = Math.min(4, ease + 0.15);
  }
  next.interval = Math.min(36500, next.interval);
  next.due = now + next.interval * 86400000;
  return next;
}
export function addMove(input, key, uci) {
  if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Manual move must be UCI');
  if (!input.nodes[key]) throw new Error('Unknown position');
  const graph = structuredClone(input), chess = new Chess(input.nodes[key].fen);
  const edge = connect(graph, chess, uci, 0, true);
  const lines = sourceLines(input, 512), additions = [];
  for (const line of lines) {
    const board = new Chess(line.fen || input.nodes[line.root || input.root].fen);
    for (let i = 0; i <= line.moves.length; i++) {
      if (positionKey(board.fen()) === key) {
        additions.push({...line, moves:[...line.moves.slice(0,i),edge.uci], manual:true});
        break;
      }
      if (i < line.moves.length) move(board,line.moves[i]);
    }
  }
  if (!additions.length) additions.push({root:key,fen:input.nodes[key].fen,moves:[edge.uci],manual:true});
  graph.lines = [...lines, ...additions];
  return graph;
}
export function exportPgn(graph) {
  const groups = new Map();
  let work = 0;
  for (const line of sourceLines(graph,512)) {
    const fen = line.fen || graph.nodes[line.root || graph.root].fen;
    let trie = groups.get(fen);
    if (!trie) { trie = new Map(); groups.set(fen,trie); }
    const chess = new Chess(fen), seen = new Set();
    for (const uci of line.moves.slice(0,512)) {
      if (++work > 200000) throw new Error('Export work limit exceeded');
      const key = positionKey(chess.fen());
      if (seen.has(key)) break;
      seen.add(key);
      const m = move(chess,uci);
      if (!trie.has(uciOf(m))) trie.set(uciOf(m), new Map());
      trie = trie.get(uciOf(m));
    }
  }
  function render(trie, fen) {
    const entries = [...trie.entries()];
    if (!entries.length) return '';
    function branch([uci, children], includeTail = true) {
      const chess = new Chess(fen), fields = fen.split(' ');
      const prefix = fields[5] + (chess.turn() === 'w' ? '. ' : '... ');
      const m = move(chess,uci);
      return { text: prefix + m.san, tail: includeTail ? render(children,chess.fen()) : '', fen:chess.fen() };
    }
    const main = branch(entries[0],false);
    const variations = entries.slice(1).map(entry => { const b = branch(entry); return `(${b.text}${b.tail ? ' ' + b.tail : ''})`; });
    const tail = render(entries[0][1], main.fen);
    return [main.text,...variations,tail].filter(Boolean).join(' ');
  }
  return [...groups].map(([fen,trie]) => {
    const setup = fen === START ? '' : `\n[SetUp "1"]\n[FEN "${fen}"]`;
    return `[Event "Repertoire Forge"]\n[Result "*"]${setup}\n\n${render(trie,fen)} *`;
  }).join('\n\n');
}

