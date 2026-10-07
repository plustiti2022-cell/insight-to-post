import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const example = JSON.parse(await readFile('artifacts/social-image-example/result.json', 'utf8'));
const text = example.text;
const coverage = { requiredSources: 0, eligibleSourceCount: 0, citedSourceCount: 0, citedSourceTypes: [], requirementMet: true };
const fixture = {
  status: 'complete', report: { title: '社交配图交互测试', summary: [{ text, references: [] }], cards: [], limitations: [], generatedAt: new Date().toISOString() },
  sources: [], warnings: [], coverage, socialRetryToken: 'ui-mock-token',
  socialContent: { status: 'ready', text, characterCount: text.length, weightedLength: 90, targetLength: 280, warnings: [], claimReferences: [], coverage },
  diagnostics: { durationMs: 1, searchCalls: 0, extractorCalls: 0, modelCalls: 0, totalTokens: 0, sourceTypes: 0 },
};
const imageBytes = await readFile('artifacts/social-image-example/image.jpg');
const dataUrl = `data:image/jpeg;base64,${imageBytes.toString('base64')}`;
const prompt = example.prompt;
const result = { image: { dataUrl, prompt, model: 'image-01', generatedAt: new Date().toISOString() }, attempts: 1, durationMs: 100 };
await mkdir('.local', { recursive: true });
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/analyze', route => route.fulfill({ json: fixture }));
  let requests = 0;
  await page.route('**/api/social-image', async route => {
    requests++;
    assert.deepEqual(route.request().postDataJSON(), { text });
    await route.fulfill(requests === 2 ? { status: 502, json: { error: { message: '模拟配图失败，请重试。' } } } : { json: result });
  });
  await page.goto(base);
  await page.getByRole('textbox', { name: '研究问题' }).fill('如何安排人和 AI 的协作');
  await page.getByRole('button', { name: '开始分析' }).click();
  await page.getByRole('button', { name: '生成配图', exact: true }).waitFor();
  assert.equal(requests, 0, 'image usage requires the generate action');
  await page.getByRole('button', { name: '生成配图', exact: true }).click();
  const image = page.locator('img.social-image');
  await image.waitFor();
  assert.equal(await image.count(), 1);
  assert.equal(await image.getAttribute('src'), dataUrl);
  await image.evaluate(element => element.decode());
  assert.equal(await image.evaluate(element => element.naturalWidth), 1024);
  const download = page.getByRole('link', { name: '下载配图' });
  assert.equal(await download.getAttribute('download'), 'social-image.jpg');
  const downloaded = page.waitForEvent('download');
  await download.click();
  const savedDownload = await downloaded;
  assert.equal(savedDownload.suggestedFilename(), 'social-image.jpg');
  assert.deepEqual(await readFile(await savedDownload.path()), imageBytes, 'download must preserve every image byte');
  await page.getByText('查看配图提示词', { exact: true }).click();
  assert.equal(await page.locator('.image-prompt p').innerText(), prompt);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.screenshot({ path: '.local/social-image-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '重新生成配图', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '模拟配图失败' }).waitFor();
  assert.equal(await image.count(), 0, 'error must not keep a substitute or previous image');
  assert.equal(await page.getByTestId('social-text').innerText(), text, 'image failure preserves the current text');
  assert.equal(await page.getByRole('link', { name: '下载配图' }).count(), 0);
  await page.getByRole('button', { name: '生成配图', exact: true }).click();
  await image.waitFor();
  assert.equal(requests, 3);
  await page.route('**/api/social-content', route => route.fulfill({ json: { socialContent: { ...fixture.socialContent, text: '新的文案，更关注人类的判断。' } } }));
  await page.getByRole('button', { name: '重新生成文案', exact: true }).click();
  await page.getByTestId('social-text').filter({ hasText: '新的文案' }).waitFor();
  assert.equal(await image.count(), 0, 'new text must clear an image generated for old text');
  await page.unroute('**/api/social-image');
  let observed, release;
  const started = new Promise(resolve => { observed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/social-image', async route => { observed(); await gate; await route.fulfill({ json: result }).catch(() => {}); });
  await page.getByRole('button', { name: '生成配图', exact: true }).click();
  await started;
  assert.equal(await page.getByRole('button', { name: '正在生成配图…', exact: true }).isDisabled(), true);
  const abandoned = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/api/social-image') });
  await page.getByRole('textbox', { name: '研究问题' }).fill('切换到另一个研究问题');
  release(); await abandoned;
  assert.equal(await image.count(), 0, 'late image response cannot restore old results');
  await page.getByRole('button', { name: '体验示例' }).click();
  assert.equal(await page.getByRole('button', { name: '生成配图', exact: true }).count(), 0, 'demo cannot use the real image API');
  assert.deepEqual(errors, []);
  console.log('Image UI passed: one image, exact current text, prompt, download, retry/error, cleared on new copy, stale cancellation, demo disabled, 390/320px.');
} finally { await browser.close(); }
