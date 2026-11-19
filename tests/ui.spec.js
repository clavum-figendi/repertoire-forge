import { test, expect } from '@playwright/test';
import { importPgn, DEFAULT_SETTINGS } from '../src/core.js';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const base = process.env.UI_URL || process.env.TEST_URL || 'http://127.0.0.1:5173';
test('sample import, legal board edit and persistent graph', async ({ page }) => {
  await page.goto(base);
  await page.getByRole('button', { name: 'Load sample' }).click();
  await expect(page.getByTestId('graph-summary')).toContainText('1 game');
  await page.getByRole('button', { name: 'Browse', exact: true }).click();
  await page.getByRole('button', { name: 'e2 white pawn', exact: true }).click();
  await page.getByRole('button', { name: 'e4 empty', exact: true }).click();
  await expect(page.getByTestId('position-label')).toContainText('Black to move');
  await page.reload();
  await expect(page.getByTestId('graph-summary')).toContainText('1 game');
});
test('invalid import is visible and backup downloads', async ({ page }) => {
  await page.goto(base);
  await page.getByLabel('PGN notation').fill('not a valid chess game');
  await page.getByRole('button', { name: 'Import PGN', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Load sample' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON backup' }).click();
  expect((await download).suggestedFilename()).toBe('repertoire-forge.json');
});
test('invalid imports never silently reuse an existing graph', async ({ page }) => {
  await page.goto(base);
  await page.getByRole('button', { name: 'Load sample' }).click();
  await page.getByLabel('PGN notation').fill('not chess');
  await page.getByRole('button', { name: 'Import PGN', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Import failed');
  await expect(page.getByTestId('graph-summary')).toContainText('1 game');
});

test('pruned path does not leak continuation through a transposition', async ({ page }) => {
  const graph=importPgn('1. Nf3 d5 2. d4 Nf6 *\n\n1. d4 Nf6 2. Nf3 d5 3. g3 *');
  const backup={format:'repertoire-forge',version:1,graph,cards:[],settings:DEFAULT_SETTINGS};
  await page.goto(base);
  await page.getByRole('button',{name:'Export',exact:true}).click();
  page.on('dialog',d=>d.accept());
  await page.locator('#restore-file').setInputFiles({name:'workspace.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await expect(page.getByTestId('graph-summary')).toContainText('2 games');
  await page.getByRole('button',{name:'Browse',exact:true}).click();
  for(let i=0;i<4;i++)await page.getByRole('button',{name:'Next position',exact:true}).click();
  await expect(page.getByText('End of this line.',{exact:false})).toBeVisible();
});

test('restored cards accept board answers, report mistakes and persist scheduling', async ({ page }) => {
  const graph=importPgn('1. e4 *'),fen=graph.nodes[graph.root].fen;
  const card={id:graph.root,fen,uci:'e2e4',san:'e4',source:'test fixture',due:0,interval:0,repetitions:0,ease:2.5,lapses:0};
  await page.goto(base);
  await page.getByRole('button',{name:'Export',exact:true}).click();
  page.on('dialog',d=>d.accept());
  await page.locator('#restore-file').setInputFiles({name:'cards.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'repertoire-forge',version:1,graph,cards:[card],settings:DEFAULT_SETTINGS}))});
  await expect(page.getByTestId('graph-summary')).toContainText('1 cards');
  await page.getByRole('button',{name:'Memorize',exact:true}).click();
  await page.getByRole('button',{name:'e2 white pawn',exact:true}).click();
  await page.getByRole('button',{name:'e3 empty',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Not the repertoire move');
  await expect(page.locator('.answer')).toContainText('e4');
  await page.getByRole('button',{name:'Good',exact:true}).click();
  await expect(page.getByText('Practice complete.',{exact:true})).toBeVisible();
  await page.reload();
  await page.getByRole('button',{name:'Memorize',exact:true}).click();
  await expect(page.getByText('Practice complete.',{exact:true})).toBeVisible();
});

test('legal promotion offers a choice and edits the position',async({page})=>{
  await page.goto(base);
  await page.getByLabel('PGN notation').fill('[SetUp "1"]\n[FEN "7k/P7/8/8/8/8/8/7K w - - 0 1"]\n\n1. a8=Q+ *');
  await page.getByRole('button',{name:'Import PGN',exact:true}).click();
  await page.getByRole('button',{name:'a7 white pawn',exact:true}).click();
  await page.getByRole('button',{name:'a8 empty',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('[data-promotion="n"]').click();
  await expect(page.getByRole('button',{name:'a8 white knight',exact:true})).toBeVisible();
});

test('real bundled engine backsolve produces trainable cards', async ({page})=>{
  test.setTimeout(90000);
  await page.goto(base);
  await page.getByRole('button',{name:'Load sample'}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.locator('[name="depth"]').fill('4');
  await page.locator('[name="maxPly"]').fill('2');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByLabel('Opening reference').selectOption('none');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.locator('[data-action="backsolve"]').click();
  await expect(page.locator('#progress')).toContainText('Complete',{timeout:60000});
  await page.getByRole('button',{name:'Memorize',exact:true}).click();
  await page.getByRole('button',{name:'Reveal answer',exact:false}).click();
  await expect(page.locator('.answer')).not.toBeEmpty();
  await expect(page.getByText('Source: stockfish.',{exact:false})).toBeVisible();
});

test('cancellation preserves imported repertoire',async({page})=>{
  await page.goto(base);
  await page.getByRole('button',{name:'Load sample'}).click();
  const before=await page.getByTestId('graph-summary').textContent();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByLabel('Opening reference').selectOption('none');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.locator('[data-action="backsolve"]').click();
  await page.getByRole('button',{name:'Cancel current task',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Cancelled');
  await expect(page.getByTestId('graph-summary')).toHaveText(before);
});

test('theory network failure is not reported as out of theory',async({page})=>{
  await page.route('https://explorer.lichess.ovh/**',route=>route.abort());
  await page.goto(base);
  await page.locator('[data-action="theory"]').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#insight')).not.toContainText('out of theory');
});

test('mobile board stays inside viewport and empty training is honest', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await expect(page.getByRole('grid', { name: 'Chess board' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Memorize', exact: true }).click();
  await expect(page.getByText('No cards yet.', { exact: false })).toBeVisible();
});
