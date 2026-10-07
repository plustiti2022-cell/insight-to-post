import { chromium, devices } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
// 使用真实 API，单次运行会产生模型和工具费用；不会伪造响应。
await mkdir(".local",{recursive:true});
const browser=await chromium.launch();
const context=await browser.newContext({...devices["iPhone 13"],recordVideo:{dir:".local/live-video",size:{width:390,height:844}}});
const base=process.env.TEST_BASE_URL||'http://localhost:3001';
await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
const page=await context.newPage();
const errors=[];page.on("pageerror",error=>errors.push(error.message));
try{
  await page.goto(base);
  const idea=process.argv.slice(2).join(" ") || "AI 如何参与 AI 研发？结合 AlphaEvolve、AI Scientist、自动化机器学习的真实案例说明能力和局限。";
  await page.getByRole("textbox",{name:"研究问题"}).fill(idea);
  const responsePromise=page.waitForResponse(r=>r.url().endsWith("/api/analyze")&&r.request().method()==="POST",{timeout:600000});
  await page.getByRole("button",{name:"开始分析"}).click();console.log("浏览器真实请求已提交，等待研究报告。");
  const response=await responsePromise;const result=await response.json();
  await writeFile(".local/browser-live-report.json",JSON.stringify(result,null,2));
  assert.equal(response.status(),200);assert.ok(result.coverage?.requirementMet,'report requires at least five final references and two types');assert.ok(result.diagnostics.searchCalls>0);
  assert.equal(result.socialContent?.status,'ready');assert.ok(result.socialContent.coverage.requirementMet);
  await page.getByRole("heading",{name:idea,exact:true}).waitFor();
  await page.screenshot({path:".local/live-mobile-report.png",fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole("button",{name:/查看来源 .* 的证据/}).first().click();
  await page.getByRole("dialog").waitFor();await page.screenshot({path:".local/live-mobile-source.png"});
  const link=await page.getByRole("link",{name:"打开原文"}).getAttribute("href");assert.ok(result.sources.some(s=>s.url===link));
  await page.getByRole("button",{name:"关闭来源"}).click();await page.getByRole("dialog").waitFor({state:"detached"});assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'一键复制',exact:true}).click();await page.getByRole('button',{name:'已复制',exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),result.socialContent.text);
  await page.getByTestId('social-text').scrollIntoViewIfNeeded();await page.screenshot({path:'.local/live-mobile-social.png'});
  console.log(JSON.stringify({status:result.status,cards:result.report.cards.length,coverage:result.coverage,socialCoverage:result.socialContent.coverage,weightedLength:result.socialContent.weightedLength,diagnostics:result.diagnostics,sourceLink:link}));
}finally{await context.close();await browser.close();}
