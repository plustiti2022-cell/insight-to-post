import { chromium, devices } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const coverage = { requiredSources: 0, eligibleSourceCount: 0, citedSourceCount: 0, citedSourceTypes: [], requirementMet: true };
const partial = { status: 'partial', report: { title: '分阶段流式研究测试', summary: [{ presentation: 'lead', text: '核心观察已经通过校验。', references: [] }], answerBlocks: [{ presentation: 'lead', text: '核心观察已经通过校验。', references: [] }], cards: [], limitations: [], generatedAt: '2026-10-07T00:00:00Z' }, sources: [], warnings: [], coverage, diagnostics: { durationMs: 100, searchCalls: 1, extractorCalls: 0, modelCalls: 1, totalTokens: 10, sourceTypes: 0 } };
const socialText = '稍后返回的社交文案。' + '新工具改变部分任务，也让判断结果和培养新人变得更重要。'.repeat(3);
const complete = { ...partial, status: 'complete', socialRetryToken: 'mock-stream-token', socialContent: { status: 'ready', text: socialText, characterCount: socialText.length, weightedLength: socialText.length * 2, targetLength: 2000, warnings: [], claimReferences: [], coverage } };
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
  let imageRequests = 0;
  await context.route('**/api/social-image', route => {
    imageRequests++;
    assert.deepEqual(route.request().postDataJSON(), { text: complete.socialContent.text });
    return route.fulfill({ status: 503, json: { error: { message: '流式配图测试使用模拟响应。' } } });
  });
  // Route only analysis fetch to a local mock HTTP server that sends real incremental bytes.
  await context.addInitScript(url => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => originalFetch(input === '/api/analyze' || input === '/api/social-content' ? url : input, init);
  }, mockUrl);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const field = page.getByRole('textbox', { name: '研究问题' });
  const start = page.getByRole('button', { name: '开始分析' });
  await field.fill('分阶段流式返回的测试问题');
  const clickedAt = performance.now();
  await start.click();
  let response = await nextRequest();
  // Only received model text is visible; no canned text is used to meet TTFT.
  assert.equal(await page.getByTestId('opening-text').count(), 0);
  const openingText = '我先看看这个问题。' + '先关注岗位需求，再看任务如何变化，并结合不同资料的适用范围来判断。'.repeat(4);
  const openingBytes = Buffer.from(`data: ${JSON.stringify({ type: 'opening', text: openingText })}\n\n`);
  const openingSplit = openingBytes.indexOf(Buffer.from('我')) + 1;
  response.write(openingBytes.subarray(0, openingSplit));
  response.write(openingBytes.subarray(openingSplit));
  await page.waitForFunction(() => document.querySelector('[data-testid="opening-text"]')?.textContent?.includes('我'));
  const firstTextMs = Math.round(performance.now() - clickedAt);
  assert.ok(firstTextMs < 2000, `mock click-to-first-text took ${firstTextMs}ms`);
  const firstOpening = await page.getByTestId('opening-text').textContent();
  assert.ok(firstOpening.length < openingText.length, 'a large upstream chunk must be played progressively');
  await page.waitForFunction(text => document.querySelector('[data-testid="opening-text"]')?.textContent === text, openingText);
  assert.equal(await page.locator('.report').count(), 0);
  send(response, { type: 'opening', text: '\n先关注岗位需求，再看任务变化。' });
  await page.getByTestId('opening-text').filter({ hasText: '先关注岗位需求，再看任务变化。' }).waitFor();
  await page.locator('.input-panel').screenshot({ path: '.local/stream-opening.png' });
  send(response, { type: 'progress', stage: 'search' });
  await page.getByText('正在规划检索、提取正文并评估覆盖', { exact: true }).waitFor();
  assert.equal(await page.locator('.report').count(), 0);
  send(response, { type: 'report', analysis: partial });
  send(response, { type: 'progress', stage: 'social' });
  await page.getByText('核心观察已经通过校验。', { exact: true }).waitFor();
  await page.getByText('核心观察已生成，正在生成社交文案…', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('social-text').count(), 0);
  assert.equal(imageRequests, 0, 'partial report must not generate images before social text completes');
  assert.equal(await page.getByRole('button', { name: '取消', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.report').screenshot({ path: '.local/stream-report-before-social.png' });
  send(response, { type: 'social-start' });
  send(response, { type: 'social-block', index: 0, text: socialText });
  await page.getByTestId('social-preview').locator('.answer-cursor').waitFor();
  assert.ok((await page.getByTestId('social-preview').textContent()).length < socialText.length);
  assert.equal(await page.getByTestId('social-text').count(), 0);
  assert.equal(imageRequests, 0);
  await page.getByRole('button', { name: '一键复制', exact: true }).isDisabled().then(disabled => assert.equal(disabled, true));
  await page.locator('.social-panel').screenshot({ path: '.local/stream-social-typing.png' });
  // Split a Chinese UTF-8 character across writes to exercise the browser decoder.
  const bytes = Buffer.from(`data: ${JSON.stringify({ type: 'result', analysis: complete })}\n\n`);
  const split = bytes.indexOf(Buffer.from('稍')) + 1;
  response.write(bytes.subarray(0, split));
  response.end(bytes.subarray(split));
  assert.equal(await page.getByTestId('social-preview').count(), 1, 'completion preserves queued animation');
  await page.getByTestId('social-text').waitFor();
  assert.equal(await page.getByTestId('social-text').innerText(), complete.socialContent.text);
  await page.getByRole('alert').filter({ hasText: '流式配图测试使用模拟响应。' }).waitFor();
  assert.equal(imageRequests, 1, 'completed streamed social text automatically generates one image');
  await page.getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  // Independent regeneration uses real incremental HTTP, preserving history and images.
  await page.getByRole('button', { name: '重新生成文案', exact: true }).click();
  response = await nextRequest();
  const retryText = '重新生成的社交文案。' + '理解资料以后，也可以从团队协作和检查结果的角度组织表达。'.repeat(3);
  send(response, { type: 'social-start' });
  send(response, { type: 'social-block', index: 0, text: retryText });
  await page.getByTestId('social-preview').locator('.answer-cursor').waitFor();
  assert.equal(await page.getByTestId('social-text').innerText(), socialText, 'old version stays available while new draft streams');
  assert.equal(imageRequests, 1);
  send(response, { type: 'social-result', result: { socialContent: { ...complete.socialContent, text: retryText }, modelCalls: 1, totalTokens: 12, durationMs: 20 } });
  response.end();
  assert.equal(await page.getByTestId('social-text').innerText(), socialText, 'confirmation does not reveal the entire new version at once');
  await page.getByTestId('social-preview').waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('social-text').innerText(), retryText);
  assert.equal(imageRequests, 1, 'regeneration does not automatically regenerate images');
  await page.getByRole('button', { name: '重新生成文案', exact: true }).click();
  response = await nextRequest();
  send(response, { type: 'social-start' });
  send(response, { type: 'social-block', index: 0, text: retryText });
  await page.getByTestId('social-preview').waitFor();
  send(response, { type: 'error', error: { code: 'INCOMPLETE', message: '模拟文案流式失败。' } }); response.end();
  await page.getByRole('alert').filter({ hasText: '模拟文案流式失败。' }).waitFor();
  assert.equal(await page.getByTestId('social-preview').count(), 0);
  assert.equal(await page.getByTestId('social-text').innerText(), retryText);
  await page.locator('.social-panel').screenshot({ path: '.local/stream-social-retry-preserved.png' });

  await field.fill('流式错误保留核心观察的测试');
  assert.equal(await page.getByTestId('opening-text').count(), 0);
  await start.click();
  response = await nextRequest();
  send(response, { type: 'report', analysis: partial });
  await page.getByText('核心观察已经通过校验。', { exact: true }).waitFor();
  send(response, { type: 'social-start' });
  send(response, { type: 'social-block', index: 0, text: socialText });
  await page.getByTestId('social-preview').waitFor();
  send(response, { type: 'error', error: { code: 'INTERNAL', message: '模拟流式中途失败。' } });
  response.end();
  await page.getByRole('alert').filter({ hasText: '模拟流式中途失败。' }).waitFor();
  assert.equal(await page.locator('.report').count(), 1);
  assert.equal(await page.getByTestId('social-text').count(), 0);
  assert.equal(await page.getByTestId('social-preview').count(), 0);
  await page.getByText('文案尚未完成，可重新分析。', { exact: true }).waitFor();

  await field.fill('流式取消后旧结果不能恢复');
  await start.click();
  response = await nextRequest();
  send(response, { type: 'report', analysis: partial });
  await page.getByText('核心观察已经通过校验。', { exact: true }).waitFor();
  send(response, { type: 'opening', text: openingText });
  send(response, { type: 'social-start' });
  send(response, { type: 'social-block', index: 0, text: socialText });
  await page.getByTestId('social-preview').waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '分析已取消。' }).waitFor();
  const cancelledOpening = await page.getByTestId('opening-text').textContent();
  await page.waitForTimeout(100);
  assert.equal(await page.getByTestId('opening-text').textContent(), cancelledOpening, 'cancel freezes the opening playback queue');
  assert.equal(await page.getByTestId('social-preview').count(), 0);
  await field.fill('切换到一个完全不同的问题');
  send(response, { type: 'opening', text: '迟到的旧开场文字' });
  send(response, { type: 'result', analysis: complete });
  response.end();
  assert.equal(await page.locator('.report').count(), 0);
  assert.equal(await page.getByTestId('opening-text').count(), 0);

  await start.click();
  response = await nextRequest();
  send(response, { type: 'report', analysis: partial });
  send(response, { type: 'social-start' });
  send(response, { type: 'social-block', index: 0, text: socialText });
  response.end();
  await page.getByRole('alert').filter({ hasText: '连接中断，分析未完整完成，请重试。' }).waitFor();
  assert.equal(await page.locator('.report').count(), 1);
  assert.equal(await page.getByTestId('social-text').count(), 0);
  assert.equal(await page.getByTestId('social-preview').count(), 0);
  // Opening failure is surfaced directly, without placeholder research results.
  await field.fill('开场模型失败的测试问题');
  await start.click();
  response = await nextRequest();
  send(response, { type: 'error', error: { code: 'UPSTREAM_ERROR', message: '模拟开场失败。' } });
  response.end();
  await page.getByRole('alert').filter({ hasText: '模拟开场失败。' }).waitFor();
  assert.equal(await page.getByTestId('opening-text').count(), 0);
  assert.equal(await page.locator('.report').count(), 0);

  // Validated paragraphs arrive before whole-report confirmation and play one by one.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const previewSource = { id: 'S1', url: 'https://example.org/research', title: '段落引用测试', sourceType: '研究论文', publishedAt: null,
    hasEvidence: true, status: 'referenced', statusReason: '模拟已取得正文' };
  const previewRefs = [{ sourceId: 'S1', quote: '这是用于检查段落播放和信源链接的完整模拟证据片段。' }];
  const blocks = [
    { presentation: 'lead', text: '这段内容已经通过段落检查，页面会逐字展示完整回答，然后才显示能够点击的信源标签。整篇回答仍然需要等待最终结构检查，不能提前当成完成的报告。', references: previewRefs },
    { presentation: 'bullet', label: '具体依据', text: '这一段紧随首答显示，检查文字和引用是否保持对应。', references: previewRefs },
    { presentation: 'conclusion', text: '结论需要结合研究的适用范围理解。', references: previewRefs },
  ];
  const previewAnalysis = { ...partial, sources: [previewSource], report: { ...partial.report, summary: blocks, answerBlocks: blocks } };
  const begin = async (question, coreValidation) => {
    await field.fill(question);
    await start.click();
    const res = await nextRequest();
    send(res, { type: 'report-start', attempt: 1, sources: [previewSource], coreValidation });
    await page.getByTestId('report-preview').waitFor();
    return res;
  };
  response = await begin('完整段落校验后逐字展示的测试');
  assert.equal(await page.locator('.answer-source').count(), 0);
  send(response, { type: 'report-block', attempt: 1, index: 0, block: blocks[0] });
  await page.waitForFunction(full => {
    const text = document.querySelector('.answer-opening')?.textContent || '';
    return text.length > 0 && text.length < full.length;
  }, blocks[0].text);
  assert.equal(await page.locator('.answer-source').count(), 0, 'source label waits for the paragraph animation');
  assert.equal(await page.getByTestId('social-text').count(), 0);
  await page.getByTestId('report-preview').screenshot({ path: '.local/stream-paragraph-typing.png' });
  await page.locator('.answer-source').waitFor();
  assert.equal(await page.locator('.answer-opening').textContent(), blocks[0].text);
  assert.equal(await page.locator('.answer-source').getAttribute('href'), previewSource.url);
  assert.equal(await page.locator('.answer-source').getAttribute('target'), '_blank');
  send(response, { type: 'report-block', attempt: 1, index: 1, block: blocks[1] });
  send(response, { type: 'report-block', attempt: 1, index: 2, block: blocks[2] });
  send(response, { type: 'report', analysis: previewAnalysis });
  await page.getByText('完整报告已通过校验。', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('report-preview').count(), 1, 'confirmation must not skip queued typing');
  send(response, { type: 'result', analysis: { ...complete, report: previewAnalysis.report, sources: previewAnalysis.sources } });
  response.end();
  await page.getByTestId('report-preview').waitFor({ state: 'detached' });
  await page.getByTestId('social-text').waitFor();
  assert.equal(await page.locator('.answer-source').count(), 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.report').screenshot({ path: '.local/stream-paragraphs-confirmed.png' });
  await page.getByRole('alert').filter({ hasText: '流式配图测试使用模拟响应。' }).waitFor();
  assert.equal(imageRequests, 2);

  response = await begin('重新生成必须清空第一轮播放队列');
  send(response, { type: 'report-block', attempt: 1, index: 0, block: blocks[0] });
  await page.locator('.answer-cursor').waitFor();
  send(response, { type: 'report-start', attempt: 2, sources: [previewSource] });
  await page.getByText('部分内容未通过校验，正在重新生成。', { exact: true }).waitFor();
  assert.equal(await page.locator('.answer-opening').count(), 0);
  send(response, { type: 'report-block', attempt: 1, index: 1, block: blocks[1] });
  send(response, { type: 'report-block', attempt: 2, index: 0, block: { ...blocks[0], text: '第二轮生成的回答已经通过段落检查。' } });
  await page.getByText('第二轮生成的回答已经通过段落检查。', { exact: true }).waitFor();
  assert.equal(await page.getByText('具体依据：', { exact: true }).count(), 0, 'stale first-attempt block is ignored');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '分析已取消。' }).waitFor();
  assert.equal(await page.locator('.report').count(), 0, 'unconfirmed preview is cleared on cancellation');
  response.end();

  for (const failure of ['error', 'truncated']) {
    response = await begin(`段落播放中失败清理的测试 ${failure}`);
    send(response, { type: 'report-block', attempt: 1, index: 0, block: blocks[0] });
    await page.locator('.answer-cursor').waitFor();
    if (failure === 'error') send(response, { type: 'error', error: { code: 'INVALID_REPORT', message: '第二轮报告仍未通过校验。' } });
    response.end();
    await page.getByRole('alert').filter({ hasText: failure === 'error' ? '第二轮报告仍未通过校验。' : '连接中断，分析未完整完成，请重试。' }).waitFor();
    assert.equal(await page.locator('.report').count(), 0, 'failed preview and animation are removed');
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  response = await begin('减少动态效果时完整显示校验段落');
  send(response, { type: 'opening', text: openingText });
  await page.waitForFunction(text => document.querySelector('[data-testid="opening-text"]')?.textContent === text, openingText);
  blocks.forEach((block, index) => send(response, { type: 'report-block', attempt: 1, index, block }));
  await page.getByText(blocks[2].text, { exact: false }).waitFor();
  assert.equal(await page.locator('.answer-cursor').count(), 0);
  assert.equal(await page.locator('.answer-source').count(), 3);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '分析已取消。' }).waitFor();
  response.end();
  // Experimental mode keeps incomplete layouts and long text without claiming validation.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  response = await begin('关闭核心校验后仍播放正文和真实信源', false);
  const unchecked = { presentation: 'paragraph', text: '模型给出的99%没有本地数字核验，缺少首答和结论也继续展示。完整段落收到后逐字播放，结束后出现原文标签。', references: previewRefs };
  await page.getByText('正在生成正文…', { exact: true }).waitFor();
  send(response, { type: 'report-block', attempt: 1, index: 0, block: unchecked });
  await page.locator('.answer-cursor').waitFor();
  assert.equal(await page.locator('.answer-source').count(), 0);
  assert.doesNotMatch(await page.getByTestId('report-preview').innerText(), /通过校验|已核对引用|生成与校验/);
  await page.locator('.answer-source').waitFor();
  assert.equal(await page.locator('.answer-source').getAttribute('href'), previewSource.url);
  await page.getByTestId('report-preview').screenshot({ path: '.local/stream-unvalidated.png' });
  const uncheckedAnalysis = { ...partial, coreValidation: false, sources: [previewSource], report: {
    ...partial.report, summary: [unchecked], answerBlocks: [unchecked], limitations: ['本实验分支已关闭核心内容校验。'],
  } };
  send(response, { type: 'report', analysis: uncheckedAnalysis });
  send(response, { type: 'result', analysis: uncheckedAnalysis });
  response.end();
  await page.getByTestId('report-preview').waitFor({ state: 'detached' });
  await page.getByText(unchecked.text, { exact: false }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual((await page.getByRole('alert').allTextContents()).filter(text => text.trim()), []);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  response = await begin('关闭校验后长段落和长标题可直接展示', false);
  const longBlock = { ...unchecked, presentation: 'bullet', label: '长标题'.repeat(40), text: '实验长正文。'.repeat(600) };
  send(response, { type: 'report-block', attempt: 1, index: 0, block: longBlock });
  await page.getByText(longBlock.text, { exact: false }).waitFor();
  assert.equal(await page.locator('.answer-source').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '分析已取消。' }).waitFor();
  response.end();
  assert.deepEqual(errors, []);
  assert.equal(imageRequests, 2, 'unconfirmed, failed and cancelled previews cannot trigger images');
  await context.close();
  console.log(`Streaming UI passed: mock first text ${firstTextMs}ms, opening and social typing, streamed regeneration and preserved versions, paragraph typing in both validation modes, delayed source labels, queued confirmation, reduced motion, split UTF-8, 390/320px, cancellation, stale events and truncated streams.`);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
