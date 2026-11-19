import {test,expect} from '@playwright/test';
test('real bundled Stockfish emits legal finite scored moves and stops',async({page})=>{
 await page.goto('/tests/engine.html'); await page.waitForFunction(()=>window.ready);
 const result=await page.evaluate(async()=>{const engine=await window.createEngine();try{return await engine.evaluate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',{depth:8});}finally{engine.close();}});
 expect(result.bestMove).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);expect(result.depth).toBe(8);expect(Number.isFinite(result.scoreCp)).toBe(true);expect(result.source).toBe('stockfish');
});
