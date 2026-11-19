import {Chess} from 'chess.js';

export function boardFlipped(view, recallTurn, preference, drillSide) {
  if (view === 'Memorize' && recallTurn) return recallTurn === 'b';
  if (view === 'Play' && drillSide) return drillSide === 'b';
  return preference;
}

export function startDrill(graph, side, root = graph.root) {
  if (!['w','b'].includes(side)) throw new Error('Choose White or Black.');
  const fen = graph.nodes[root]?.fen;
  if (!fen) throw new Error('Unknown starting position.');
  const lines = (graph.lines || []).filter(line => (line.root || graph.root) === root && line.moves.length);
  return { side, fen, turn:new Chess(fen).turn(), lines, moves:[], outcome:lines.length ? null : 'exhausted', expected:[] };
}

export function drillChoices(session) {
  if (session.outcome) return [];
  const ply = session.moves.length, choices = new Map();
  const candidates = session.lines.filter(line => line.moves.length > ply);
  const replies = candidates.filter(line => line.mistakePly === ply-1);
  for (const line of replies.length ? replies : candidates) {
    const uci = line.moves[ply];
    const previous = choices.get(uci);
    choices.set(uci,{uci,weight:(previous?.weight||0)+1,refutation:replies.length>0});
  }
  return [...choices.values()];
}

export function advanceDrill(session, uci) {
  if (session.outcome) return session;
  const board = new Chess(session.fen);
  const move = board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]});
  const choices = drillChoices(session), accepted = choices.find(m=>m.uci===uci);
  const ply = session.moves.length;
  const lines = session.lines.filter(line=>line.moves[ply]===uci);
  let outcome = !accepted ? choices.some(m=>m.refutation) ? 'missed-refutation' : 'off-book'
    : accepted.refutation ? session.turn === session.side ? 'refutation' : 'refuted'
    : !lines.some(line=>line.moves.length>ply+1) ? 'exhausted' : null;
  return {...session,fen:board.fen(),turn:board.turn(),lines,moves:[...session.moves,{uci,san:move.san}],outcome,expected:!accepted?choices.map(m=>m.uci):[],previousFen:session.fen};
}

export function chooseDrillReply(choices, random = Math.random) {
  let pick = random()*choices.reduce((total,move)=>total+move.weight,0);
  for (const move of choices) if ((pick-=move.weight)<0) return move.uci;
  return choices.at(-1)?.uci;
}
