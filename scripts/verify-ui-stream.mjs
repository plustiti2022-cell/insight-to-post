import { chromium, devices } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const coverage = { requiredSources: 0, eligibleSourceCount: 0, citedSourceCount: 0, citedSourceTypes: [], requirementMet: true };
const partial = { status: 'partial', report: { title: '分阶段流式研究测试', summary: [{ presentation: 'lead', text: '核心观察已经通过校验。', references: [] }], answerBlocks: [{ presentation: 'lead', text: '核心观察已经通过校验。', references: [] }], cards: [], limitations: [], generatedAt: '2026-10-07T00:00:00Z' }, sources: [], warnings: [], coverage, diagnostics: { durationMs: 100, searchCalls: 1, extractorCalls: 0, modelCalls: 1, totalTokens: 10, sourceTypes: 0 } };
const complete = { ...partial, status: 'complete', socialContent: { status: 'ready', text: '稍后返回的社交文案。', characterCount: 11, weightedLength: 22, targetLength: 2000, warnings: [], claimReferences: [], coverage } };
const requests = [];
let notify;
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, accept');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  assert.match(req.headers.accept, /text\/event-stream/);
  for await (const _ of req) { /* Consume body before responding. */ }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
  res.write(': connected\n\n');
  requests.push(res);
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
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  // Route only analysis fetch to a local mock HTTP server that sends real incremental bytes.
  await context.addInitScript(url => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => originalFetch(input === '/api/analyze' ? url : input, init);
  }, mockUrl);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const field = page.getByRole('textbox', { name: '研究问题' });
  const start = page.getByRole('button', { name: '开始分析' });
  await field.fill('分阶段流式返回的测试问题');
  await start.click();
  let response = await nextRequest();
  send(response, { type: 'progress', stage: 'search' });
  await page.getByText('正在规划检索、提取正文并评估覆盖', { exact: true }).waitFor();
  assert.equal(await page.locator('.report').count(), 0);
  send(response, { type: 'report', analysis: partial });
  send(response, { type: 'progress', stage: 'social' });
  await page.getByText('核心观察已经通过校验。', { exact: true }).waitFor();
  await page.getByText('核心观察已生成，正在生成社交文案…', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('social-text').count(), 0);
  assert.equal(await page.getByRole('button', { name: '取消', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.report').screenshot({ path: '.local/stream-report-before-social.png' });
  // Split a Chinese UTF-8 character across writes to exercise the browser decoder.
  const bytes = Buffer.from(`data: ${JSON.stringify({ type: 'result', analysis: complete })}\n\n`);
  const split = bytes.indexOf(Buffer.from('稍')) + 1;
  response.write(bytes.subarray(0, split));
  response.end(bytes.subarray(split));
  await page.getByTestId('social-text').waitFor();
  assert.equal(await page.getByTestId('social-text').innerText(), complete.socialContent.text);
  await page.getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await field.fill('流式错误保留核心观察的测试');
  await start.click();
  response = await nextRequest();
  send(response, { type: 'report', analysis: partial });
  await page.getByText('核心观察已经通过校验。', { exact: true }).waitFor();
  send(response, { type: 'error', error: { code: 'INTERNAL', message: '模拟流式中途失败。' } });
  response.end();
  await page.getByRole('alert').filter({ hasText: '模拟流式中途失败。' }).waitFor();
  assert.equal(await page.locator('.report').count(), 1);
  assert.equal(await page.getByTestId('social-text').count(), 0);
  await page.getByText('文案尚未完成，可重新分析。', { exact: true }).waitFor();

  await field.fill('流式取消后旧结果不能恢复');
  await start.click();
  response = await nextRequest();
  send(response, { type: 'report', analysis: partial });
  await page.getByText('核心观察已经通过校验。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '分析已取消。' }).waitFor();
  await field.fill('切换到一个完全不同的问题');
  send(response, { type: 'result', analysis: complete });
  response.end();
  assert.equal(await page.locator('.report').count(), 0);

  await start.click();
  response = await nextRequest();
  send(response, { type: 'report', analysis: partial });
  response.end();
  await page.getByRole('alert').filter({ hasText: '连接中断，分析未完整完成，请重试。' }).waitFor();
  assert.equal(await page.locator('.report').count(), 1);
  assert.equal(await page.getByTestId('social-text').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('Streaming UI passed: incremental HTTP progress, report before social, split UTF-8, 390/320px, error retention, cancellation, stale results and truncated stream.');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
