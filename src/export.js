import initSqlJs from 'sql.js';
import {zipSync,strToU8} from 'fflate';
import {Chess} from 'chess.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function boardHtml(fen) {
  const chess=new Chess(fen);const pieces={wk:'♔',wq:'♕',wr:'♖',wb:'♗',wn:'♘',wp:'♙',bk:'♚',bq:'♛',br:'♜',bb:'♝',bn:'♞',bp:'♟'};
  return '<table class="chess" role="img" aria-label="Chess position">'+chess.board().map((rank,r)=>'<tr>'+rank.map((p,c)=>`<td style="background:${(r+c)%2?'#8aa083':'#eee9d9'}">${p?pieces[p.color+p.type]:''}</td>`).join('')+'</tr>').join('')+'</table><small>'+ (chess.turn()==='w'?'White':'Black')+' to move</small>';
}
export function exportCsv(cards) {
  const cell=v=>'"'+(/^[=+\-@\t\r]/.test(String(v??''))?"'":'')+String(v??'').replaceAll('"','""')+'"';
  const fields=['fen','san','uci','source'];return fields.join(',')+'\r\n'+cards.map(c=>fields.map(k=>cell(c[k])).join(',')).join('\r\n');
}
export async function exportAnki(cards) {
  const options=typeof window==='undefined'?{}:{locateFile:file=>new URL((import.meta.env?.BASE_URL||'./')+'vendor/'+file,globalThis.location.href).href};
  const SQL=await initSqlJs(options);const db=new SQL.Database();
  const now=Date.now(), sec=Math.floor(now/1000), mid=1700000000001, did=1700000000002;
  const model={id:mid,name:'Repertoire Forge',type:0,mod:sec,usn:-1,sortf:0,did,tmpls:[{name:'Find the move',ord:0,qfmt:'{{Board}}',afmt:'{{FrontSide}}<hr id=answer>{{Answer}}<br><small>{{FEN}}</small>',bqfmt:'',bafmt:''}],flds:['Board','Answer','FEN'].map((name,ord)=>({name,ord,sticky:false,rtl:false,font:'Arial',size:20})),css:'.card{text-align:center;font-family:Arial;font-size:22px;color:#202720;background:#faf8f1}.chess{border-collapse:collapse;margin:12px auto}.chess td{width:38px;height:38px;text-align:center;font-family:serif;font-size:30px;line-height:38px;color:#111}small{font-size:12px}',latexPre:'',latexPost:'',req:[[0,'all',[0]]]};
  const deck={id:did,name:'Repertoire Forge',desc:'Positions and best moves from your repertoire. Engine evaluations are depth-limited.',mod:sec,usn:-1,dyn:0,collapsed:false,extendNew:0,extendRev:0,conf:1,newToday:[0,0],revToday:[0,0],lrnToday:[0,0],timeToday:[0,0]};
  try {
    db.run('CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text); CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld integer, csum integer, flags integer, data text); CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text); CREATE TABLE revlog (id integer primary key,cid integer,usn integer,ease integer,ivl integer,lastIvl integer,factor integer,time integer,type integer); CREATE TABLE graves (usn integer,oid integer,type integer); CREATE INDEX ix_notes_usn ON notes(usn); CREATE INDEX ix_cards_sched ON cards(did,queue,due); CREATE INDEX ix_cards_nid ON cards(nid);');
    db.run('INSERT INTO col VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[1,sec,now,now,11,0,-1,0,JSON.stringify({nextPos:cards.length+1,curDeck:did,activeDecks:[did]}),JSON.stringify({[mid]:model}),JSON.stringify({[did]:deck}),JSON.stringify({1:{id:1,name:'Default',mod:sec,usn:0,maxTaken:60,timer:0,autoplay:true,replayq:true,new:{delays:[1,10],ints:[1,4,0],initialFactor:2500,perDay:20,order:1},rev:{perDay:200,ease4:1.3,fuzz:0.05,ivlFct:1,maxIvl:36500,hardFactor:1.2},lapse:{delays:[10],mult:0,minInt:1,leechFails:8,leechAction:0}}}),'{}']);
    const seen=new Set();let n=0;
    for(const card of cards){if(seen.has(card.id))continue;seen.add(card.id);const chess=new Chess(card.fen);const move=chess.move({from:card.uci.slice(0,2),to:card.uci.slice(2,4),promotion:card.uci[4]});if(!move)throw new Error('Cannot export illegal flashcard');const id=now+n++;const front=boardHtml(card.fen);let hash=2166136261;for(const c of card.fen){hash^=c.charCodeAt(0);hash=Math.imul(hash,16777619);}const guid=(hash>>>0).toString(36)+'-'+n;
      db.run('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,guid,mid,sec,-1,' repertoire-forge ',[front,escapeHtml(move.san)+' · '+escapeHtml(card.source),escapeHtml(card.fen)].join('\x1f'),front,0,0,'']);
      db.run('INSERT INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,id,did,0,sec,-1,0,0,n,0,2500,0,0,0,0,0,0,'']);
    }
    return zipSync({'collection.anki2':db.export(),media:strToU8('{}')},{level:6});
  } finally {db.close();}
}
export function download(name,data,type='application/octet-stream') {
  const blob=data instanceof Blob?data:new Blob([data],{type});
  if(globalThis.Android?.saveFile){blob.arrayBuffer().then(buffer=>{const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));globalThis.Android.saveFile(name,type,btoa(binary));}).catch(error=>alert('Export failed: '+error.message));return;}
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
