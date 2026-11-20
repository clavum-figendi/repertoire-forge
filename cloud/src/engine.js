import factory from '../generated/stockfish.js';
import wasm from './stockfish.wasm';
export async function createEngine() {
 let listener=()=>{};
 const module=await factory({listener:line=>listener(line),instantiateWasm(imports,receive){const instance=new WebAssembly.Instance(wasm,imports);receive(instance,wasm);return instance.exports;}});
 const command=text=>module.ccall('command',null,['string'],[text],{async:true});
 await command('uci'); await command('setoption name Hash value 16'); await command('setoption name Threads value 1');
 return {get memoryBytes(){return module.HEAPU8.byteLength;},async evaluate(fen,{depth=10,nodes=5000}={}) {
  let scoreCp, mate, bestMove, actualDepth=0, seenNodes=0;
  listener=line=>{
   let m;if((m=/\bnodes (\d+)/.exec(line)))seenNodes=Number(m[1]);
   // A bound is not an exact centipawn evaluation: retain the most recent
   // completed non-bound PV when a node-limited search is interrupted.
   if(!/\b(?:lowerbound|upperbound)\b/.test(line)){
    const cp=/\bscore cp (-?\d+)/.exec(line),mt=/\bscore mate (-?\d+)/.exec(line);
    if(cp||mt){scoreCp=cp?Number(cp[1]):undefined;mate=mt?Number(mt[1]):undefined;if((m=/\bdepth (\d+)/.exec(line)))actualDepth=Number(m[1]);}
   }
   if((m=/^bestmove (\S+)/.exec(line)))bestMove=m[1];
  };
  await command('position fen '+fen); await command(`go depth ${depth} nodes ${nodes}`);
  listener=()=>{};
  if(bestMove==='(none)'||bestMove==='0000')bestMove=undefined;
  if(!Number.isFinite(scoreCp)&&!Number.isFinite(mate))throw Error('Stockfish returned no score');
  return {source:'stockfish',bestMove,...(Number.isFinite(mate)?{mate}:{scoreCp}),depth:actualDepth,nodes:seenNodes,nodeLimited:true,nodeBudget:nodes,requestedDepth:depth,scorePerspective:'side-to-move'};
 }};
}
