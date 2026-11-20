import {test,expect} from '@playwright/test';
const url=process.env.UI_URL||'http://127.0.0.1:4274';
test('archive capacity retains earlier games and leaves backsolve usable',async({page})=>{
 const good={id:'abcdefgh',speed:'blitz',variant:'standard',status:'resign',moves:'e4 e5',pgn:'[Site "https://lichess.org/abcdefgh"]\n\n1. e4 e5 1-0'};
 const moves=Array(514).fill('Nf3 Nf6 Ng1 Ng8').join(' ');
 const large={...good,id:'abcdEfgh',moves,pgn:'[Site "https://lichess.org/abcdEfgh"]\n\n'+moves+' 1/2-1/2'};
 await page.route('https://lichess.org/api/games/user/tester?*',r=>r.fulfill({contentType:'application/x-ndjson',body:[good,large].map(x=>JSON.stringify(x)).join('\n')+'\n'}));
 await page.goto(url);await page.getByText('Import by username',{exact:true}).click();await page.getByLabel('Player username').fill('tester');await page.getByRole('button',{name:'Fetch & import games'}).click();
 await expect(page.getByRole('status')).toContainText('Kept 1 new games');
 await expect(page.getByTestId('graph-summary')).toContainText('1 game');
 await expect(page.getByRole('button',{name:'Backsolve repertoire'})).toBeEnabled();
 await page.reload();await expect(page.getByTestId('graph-summary')).toContainText('1 game');
});
