import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import initSqlJs from 'sql.js';
import {exportAnki,exportCsv} from '../src/export.js';
const card={id:'position',fen:'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',uci:'e2e4',san:'e4',source:'stockfish'};
test('CSV uses safe escaped columns',()=>{assert.match(exportCsv([{...card,san:'=1+1'}]),/"'=1\+1"/);});
test('Anki package contains real sqlite collection, cards and legal answer',async()=>{const bytes=await exportAnki([card]);const files=unzipSync(bytes);assert.equal(strFromU8(files.media),'{}');const SQL=await initSqlJs();const db=new SQL.Database(files['collection.anki2']);assert.equal(db.exec('select count(*) from notes')[0].values[0][0],1);assert.equal(db.exec('select count(*) from cards')[0].values[0][0],1);assert.match(db.exec('select flds from notes')[0].values[0][0],/e4/);assert.ok(JSON.parse(db.exec('select models from col')[0].values[0][0]));db.close();});
