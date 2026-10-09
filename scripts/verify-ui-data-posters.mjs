import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const coverage = { requiredSources: 0, eligibleSourceCount: 0, citedSourceCount: 0, citedSourceTypes: [], requirementMet: true };
const partial = { status: 'partial', report: { title: '研究数据自动海报测试', summary: [{ text: '销量增长20%，份额下降5个百分点，仅限研究样本。', references: [] }], cards: [], limitations: [], generatedAt: '2026-10-09T00:00:00Z' }, sources: [], warnings: [], coverage,
  dataPosters: { status: 'extracting', items: [] }, diagnostics: { durationMs: 100, searchCalls: 1, extractorCalls: 0, modelCalls: 1, totalTokens: 10, sourceTypes: 0 } };
const socialContent = { status: 'ready', text: '数据海报仍在生成，这篇独立社交文案已经完成。', characterCount: 24, weightedLength: 48, targetLength: 2000, warnings: [], claimReferences: [], coverage };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024"><rect width="768" height="1024" fill="#102235"/><text x="56" y="100" fill="#f7f1e7" font-family="Arial, Microsoft YaHei, sans-serif" font-size="32">研究样本销量</text><text x="56" y="330" fill="#d9e8ec" font-family="Arial, Microsoft YaHei, sans-serif" font-size="100" font-weight="700">+20%</text><line x1="56" y1="780" x2="712" y2="780" stroke="#d9e8ec" stroke-width="2"/><text x="56" y="840" fill="#f7f1e7" font-family="Arial, Microsoft YaHei, sans-serif" font-size="24">仅限研究样本，变化幅度</text></svg>';
const items = [{ id: 'D1', text: '销量增长20%，仅限研究样本。', status: 'generating' }, { id: 'D2', text: '份额下降5个百分点。', status: 'pending' }, { id: 'D3', text: '费用减少10%。', status: 'pending' }];
const requests = [];
let notify;
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, accept');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.write(': connected\n\n');
  requests.push({ res, body: JSON.parse(body) });
  notify?.();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const mockUrl = `http://127.0.0.1:${server.address().port}/api/analyze`;
async function nextRequest() {
  if (!requests.length) await new Promise(resolve => { notify = resolve; });
  notify = undefined;
  return requests.shift();
}
function send(res, event) { res.write(`data: ${JSON.stringify(event)}\n\n`); }
await mkdir('.local', { recursive: true });
const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
  let imageCalls = 0;
  await context.route('**/api/social-image', route => {
    imageCalls++;
    return route.fulfill({ status: 503, json: { error: { message: '已有社交配图模拟错误。' } } });
  });
  await context.addInitScript(url => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => original(input === '/api/analyze' ? url : input, init);
  }, mockUrl);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const field = page.getByRole('textbox', { name: '研究问题' });
  const start = page.getByRole('button', { name: '开始分析' });
  await field.fill('研究数据自动海报测试');
  await page.getByText('数据海报 · 修改提取提示词', { exact: true }).click();
  await page.getByRole('textbox', { name: '提示词 1（可修改）' }).fill('提取完整比例和变化幅度，不要重复');
  await start.click();
  let { res, body } = await nextRequest();
  assert.equal(body.dataExtractionPrompt, '提取完整比例和变化幅度，不要重复');
  send(res, { type: 'report', analysis: partial });
  await page.getByText('正在提取研究回答中的数据…', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('social-text').count(), 0);
  send(res, { type: 'data-posters', dataPosters: { status: 'generating', items } });
  await page.getByTestId('data-poster-card').nth(2).waitFor();
  send(res, { type: 'social', socialContent });
  await page.getByTestId('social-text').waitFor();
  assert.equal(await page.getByTestId('social-text').innerText(), socialContent.text);
  assert.equal(await page.getByRole('button', { name: '取消', exact: true }).count(), 1);
  await page.getByRole('alert').filter({ hasText: '已有社交配图模拟错误。' }).waitFor();
  assert.equal(imageCalls, 1);
  const progressive = [{ ...items[0], status: 'ready', svg }, { ...items[1], status: 'generating' }, { ...items[2], status: 'failed', error: '千问服务返回错误（HTTP 503），请稍后重试。' }];
  send(res, { type: 'data-posters', dataPosters: { status: 'generating', items: progressive } });
  const image = page.getByTestId('data-poster-image');
  await image.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="data-poster-image"]')?.naturalWidth === 768);
  assert.equal(await image.evaluate(img => img.naturalHeight), 1024);
  await page.getByRole('alert').filter({ hasText: '海报生成失败：千问服务返回错误（HTTP 503）' }).waitFor();
  await page.getByText('查看提取 JSON', { exact: true }).click();
  assert.deepEqual(JSON.parse(await page.getByTestId('data-json').innerText()), items.map(item => item.text));
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 SVG' }).click();
  const download = await downloaded;
  await download.saveAs('.local/data-poster-download.svg');
  assert.equal(await readFile('.local/data-poster-download.svg', 'utf8'), svg);
  await page.locator('.data-posters').screenshot({ path: '.local/data-posters-desktop.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.data-posters').screenshot({ path: '.local/data-posters-mobile.png' });
  // An unsafe SVG in a received frame cannot become executable markup or a displayed image.
  const completeItems = [progressive[0], { ...items[1], status: 'ready', svg: svg.replace('</svg>', '<script>window.posterInjected=true</script></svg>') }, progressive[2]];
  const dataPosters = { status: 'complete', items: completeItems };
  send(res, { type: 'data-posters', dataPosters });
  send(res, { type: 'result', analysis: { ...partial, status: 'complete', socialContent, dataPosters } });
  res.end();
  await page.getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('alert').filter({ hasText: '海报 SVG 格式错误' }).waitFor();
  assert.equal(await page.getByTestId('data-poster-image').count(), 1);
  assert.equal(await page.evaluate(() => window.posterInjected), undefined);
  // New questions clear previous data; extraction errors are displayed without another request.
  await field.fill('数据提取失败的另一个问题');
  assert.equal(await page.locator('.data-posters').count(), 0);
  await start.click();
  ({ res } = await nextRequest());
  send(res, { type: 'report', analysis: partial });
  const failed = { status: 'failed', items: [], error: '数据提取返回的 JSON 无法解析。' };
  send(res, { type: 'data-posters', dataPosters: failed });
  send(res, { type: 'result', analysis: { ...partial, dataPosters: failed } });
  res.end();
  await page.getByRole('alert').filter({ hasText: '数据提取失败：数据提取返回的 JSON 无法解析。' }).waitFor();
  assert.equal(await page.getByTestId('data-poster-image').count(), 0);
  assert.equal(requests.length, 0);
  // Cancel keeps completed posters; late events cannot restore results after changing the question.
  await field.fill('数据海报取消测试问题');
  await start.click();
  ({ res } = await nextRequest());
  send(res, { type: 'report', analysis: partial });
  send(res, { type: 'data-posters', dataPosters: { status: 'generating', items: progressive } });
  await page.getByTestId('data-poster-image').waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '数据海报流程已中断' }).waitFor();
  assert.equal(await page.getByTestId('data-poster-image').count(), 1);
  await field.fill('换到全新的问题');
  send(res, { type: 'data-posters', dataPosters }); res.end();
  assert.equal(await page.locator('.data-posters').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Data posters UI passed: editable prompt, automatic streaming, parallel social, rendered SVG/download, mobile layout, explicit errors, cancellation and stale results.');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
