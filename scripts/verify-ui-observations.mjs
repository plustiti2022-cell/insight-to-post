import {chromium,devices} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.TEST_BASE_URL||'http://localhost:3001';
const browser=await chromium.launch();const context=await browser.newContext({...devices['iPhone 13']});
await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
try{
  await mkdir('.local',{recursive:true});await page.goto(base);
  await page.getByRole('textbox',{name:'研究问题'}).fill('AI 如何参与 AI 研发？结合 AlphaEvolve 和 AI Scientist 观察真实案例及局限。');
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/api/analyze')&&response.request().method()==='POST',{timeout:600000});
  await page.getByRole('button',{name:'开始分析'}).click();console.log('真实研究请求已提交。');
  const response=await responsePromise;const data=await response.json();await writeFile('.local/observations-live.json',JSON.stringify(data,null,2));
  assert.equal(response.status(),200);assert.equal(data.status,'complete');assert.equal(data.report.summary.length,1);assert.ok(!/提供的原文线索|这段材料可与|《[^》]+》/.test(data.report.summary[0].text));assert.ok(!/提供的原文线索|这段材料可与|《[^》]+》|https?:\/\//.test(data.socialContent.text));assert.equal(data.socialContent.status,'ready');
  const articles=data.sources.filter(source=>source.hasEvidence);
  const reportIds=new Set([...data.report.summary,...data.report.cards].flatMap(item=>item.references.map(ref=>ref.sourceId)));
  const socialIds=new Set(data.socialContent.claimReferences.map(ref=>ref.sourceId));
  assert.ok(articles.every(source=>reportIds.has(source.id)&&socialIds.has(source.id)&&source.status==='referenced'));
  assert.equal(data.coverage.citedSourceCount,articles.length);assert.equal(data.socialContent.coverage.citedSourceCount,articles.length);
  await page.getByTestId('social-text').waitFor();assert.equal(await page.locator('.summary-box .summary-item p').count(),1);await page.getByRole('button',{name:'一键复制',exact:true}).click();await page.getByRole('button',{name:'已复制',exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),data.socialContent.text);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await page.screenshot({path:'.local/observations-mobile.png',fullPage:true});
  const {socialRetryToken,...publicData}=data;await writeFile('artifacts/example-observations-report.json',JSON.stringify(publicData,null,2));
  console.log(JSON.stringify({articles:articles.length,reportReferences:reportIds.size,socialReferences:socialIds.size,copyVerified:true,diagnostics:data.diagnostics}));
}finally{await context.close();await browser.close();}
