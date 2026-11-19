import {test,expect} from '@playwright/test';
const url=process.env.UI_URL||'http://127.0.0.1:4274';
test('archive UI offers all games, strict length and mixed time controls',async({page})=>{
 await page.goto(url);await page.getByText('Import by username',{exact:true}).click();
 await expect(page.getByLabel('Game history')).toHaveValue('all');
 await page.getByLabel('More than this many moves').fill('24');
 await page.getByLabel('Bullet',{exact:true}).uncheck();
 await expect(page.getByLabel('Blitz',{exact:true})).toBeChecked();
 await expect(page.getByLabel('Rapid',{exact:true})).toBeChecked();
 await expect(page.getByLabel('Standard / classical',{exact:true})).toBeChecked();
});

test('all-history import persists matching games and does not duplicate them',async({page})=>{
 const row=(id,speed,moves)=>({id,speed,moves,variant:'standard',status:'resign',pgn:`[Event "Archive test"]\n[Result "1-0"]\n\n${moves} 1-0`});
 const rows=[row('abcdefgh','blitz','e4 e5 Nf3 Nc6 Bb5'),row('abcdEfgh','blitz','e4 e5 Nf3 Nc6'),row('abCdefgh','bullet','e4 e5 Nf3 Nc6 Bb5')];
 await page.route('https://lichess.org/api/games/user/tester?*',route=>{
  const query=new URL(route.request().url()).searchParams;
  expect(query.has('max')).toBe(false);
  expect(query.get('perfType').split(',')).toEqual(['blitz']);
  return route.fulfill({contentType:'application/x-ndjson',body:rows.map(r=>JSON.stringify(r)).join('\n')+'\n'});
 });
 await page.goto(url);await page.getByText('Import by username',{exact:true}).click();
 await page.getByLabel('Player username').fill('tester');await page.getByLabel('More than this many moves').fill('2');
 for(const control of ['Bullet','Rapid','Standard / classical'])await page.getByLabel(control,{exact:true}).uncheck();
 const submit=page.getByRole('button',{name:'Fetch & import games'});
 await submit.click();await expect(page.getByRole('status')).toContainText('Imported 1 new game');
 await submit.click();await expect(page.getByRole('status')).toContainText('No new matching games');
 await page.reload();await expect(page.getByTestId('graph-summary')).toContainText('1 game · 6 positions');
});
