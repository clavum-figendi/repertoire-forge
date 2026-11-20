import {importPgn} from './core.js';

// One game is staged atomically by the parser. Earlier completed games stay usable.
export function appendArchiveBatch(graph,text,{maxStoredPlies=80}={}) {
  try {
    importPgn(text,graph,{deduplicate:true,maxStoredPlies,mutate:true,strict:true});
    return {graph,stopped:false};
  } catch(error) {
    if(/(?:position|line|work|ply|token|input).*limit|limit exceeded/i.test(error.message))return {graph,stopped:true,reason:error.message};
    throw error;
  }
}
