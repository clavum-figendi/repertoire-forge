import {test,expect} from '@playwright/test';
import {importPgn,DEFAULT_SETTINGS} from '../src/core.js';
const url=process.env.UI_URL||'http://127.0.0.1:4274';
test('cloud processing uses resumable steps and downloads a training backup',async({page})=>{
 const requests=[];
 await page.route('https://repertoire-forge-api.clavum-figendi.workers.dev/**',route=>{
  const r=route.request(),p=new URL(r.url()).pathname;requests.push(p);
  if(p==='/jobs')return route.fulfill({json:{id:'testjob',token:'local-test-capability'}});
  expect(r.headers().authorization).toBe('Bearer local-test-capability');
  if(p.endsWith('/step'))return route.fulfill({json:{status:'done',games:1}});
  if(p.endsWith('/result'))return route.fulfill({json:{format:'repertoire-forge',version:1,graph:importPgn('1. e4 e5 *'),cards:[],settings:DEFAULT_SETTINGS}});
 });
 await page.goto(url);
 await page.getByRole('button',{name:'Settings'}).click();
 await page.getByLabel('Cloud backend URL').fill('https://repertoire-forge-api.clavum-figendi.workers.dev');
 await page.getByRole('button',{name:'Save settings'}).click();
 await page.getByText('Import by username',{exact:true}).click();await page.getByLabel('Player username').fill('tester');await page.getByRole('combobox',{name:'Processing',exact:true}).selectOption('cloud');
 const d=page.waitForEvent('download');await page.getByRole('button',{name:'Fetch & import games'}).click();expect((await d).suggestedFilename()).toBe('cloud-repertoire.json');
 await expect(page.getByRole('status')).toContainText('Cloud repertoire downloaded');
 expect(requests).toEqual(['/jobs','/jobs/testjob/step','/jobs/testjob/result']);
});
