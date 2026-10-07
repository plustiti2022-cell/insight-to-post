import { chromium, devices } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { generateReport } from '../src/server/services/report.ts';
import { validateReport } from '../src/core/evidence.ts';
import { completeReport } from '../src/core/report.ts';
import { ANSWER_LEAD_MAX_LENGTH } from '../src/core/contracts.ts';

const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const source = (id, url, title) => ({ id, url, title, sourceType: '机构报告', publishedAt: null, hasEvidence: true, status: 'referenced', statusReason: '模拟正文已引用' });
const sources = [source('S1', 'https://stanford.edu/jobs', '就业研究（模拟）'), source('S2', 'https://naceweb.org/hiring', '招聘调查（模拟）'), source('S3', 'https://example.org/unused', '保留的独立文章（模拟）')];
const refs = (...ids) => ids.map(sourceId => ({ sourceId, quote: '这是用于界面测试的模拟原文片段。' }));
const blocks = [
  { presentation: 'lead', text: '会减少一部分，但更准确地说，是初级岗位中的某些任务被自动化，招聘需求和岗位内容正在改变；并非所有行业的初级工作都会消失。', references: refs('S1', 'S2') },
  { presentation: 'bullet', label: '压力较大的工作', text: '重复性强、容易标准化的任务，例如整理资料、基础文案、简单分析和部分初级编程工作。初级岗位往往包含较多这类任务，因此受到的影响可能更明显。相关研究观察到年轻人的就业出现相对下滑；不过这类观察本身不能证明下滑完全由AI造成。', references: refs('S1', 'S1') },
  { presentation: 'bullet', label: '企业确实开始调整', text: '雇主调查中，部分受访者表示，AI已减少对部分入门级任务的需求；也有企业讨论过AI能否替代早期职业员工的一些任务。', references: refs('S2') },
  { presentation: 'bullet', label: '岗位也会转型', text: '企业越来越重视能使用AI工具、检查输出质量、解决非标准问题并与人协作的新人。换句话说，AI可能压缩只做基础执行的岗位，同时提高初级员工需要具备的能力。', references: refs('S2') },
  { presentation: 'paragraph', label: '对求职者的实际建议', text: '学会把AI用于常见任务，但也要练习核查结果、专业判断、沟通和处理复杂问题；简历和作品集最好展示你如何用AI提升效率。', references: refs('S2') },
  { presentation: 'conclusion', label: '结论', text: 'AI对初级岗位的影响是真实但不均匀的：常规任务更容易减少，能够运用AI并承担判断、沟通和责任的人才仍有价值。', references: refs('S2', 'S1') },
];
// 从真实生成服务开始，模拟截图中的超长首段；不能只预填一个理想布局来验证 UI。
const articles = sources.map(source => ({ ...source,
  extractedContent: 'Researchers documented changes to entry-level tasks, hiring demand, and the scope and limitations of the observations. '.repeat(3),
  extractionStatus: 'available', extractionReason: '模拟提取正文',
}));
const modelSummary = blocks.map(block => ({ ...block, references: block.references.map(ref => ({ sourceId: ref.sourceId, evidenceId: `${ref.sourceId}-E1` })) }));
const originalFetch = globalThis.fetch, originalKey = process.env.QWEN_API_KEY;
const prompts = [];
process.env.QWEN_API_KEY = 'test-only';
globalThis.fetch = async (_url, init) => {
  prompts.push(JSON.parse(String(init?.body)).input);
  return Response.json({ output_text: JSON.stringify({ title: 'AI会减少初级岗位吗？',
    summary: prompts.length === 1 ? [{ ...modelSummary[0], text: blocks.map(block => block.text).join('') }, ...modelSummary.slice(1)] : modelSummary,
    cards: [], limitations: [],
  }) });
};
let report;
try {
  const generated = await generateReport('AI会减少初级岗位吗？', articles);
  assert.equal(prompts.length, 2, 'oversized opening must use the existing repair budget');
  assert.match(prompts[1], /开篇总结格式无效/);
  const validated = validateReport(generated.draft, articles);
  assert.deepEqual(validated.warnings, []);
  report = { ...completeReport(validated.report, articles), generatedAt: new Date().toISOString() };
  assert.equal(report.answerBlocks[0].text, blocks[0].text);
  assert.ok(report.answerBlocks[0].text.length <= ANSWER_LEAD_MAX_LENGTH);
  assert.ok(report.summary[0].text.includes(blocks[1].text), 'social input must retain detailed points');
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = originalKey;
}
const fixture = {
  status: 'complete', report, sources, warnings: [],
  searchSteps: [{ query: 'AI impact entry-level jobs junior roles employment research evidence', resultCount: 3, extractedCount: 3, sourceIds: ['S1', 'S2', 'S3'] }],
  diagnostics: { durationMs: 1000, searchCalls: 1, extractorCalls: 1, modelCalls: 4, totalTokens: 1000, sourceTypes: 1 },
};
await mkdir('.local', { recursive: true });
const browser = await chromium.launch();
const errors = [];
try {
  for (const viewport of [{ width: 1440, height: 1100 }, devices['iPhone 13'], { width: 320, height: 740 }]) {
    const context = await browser.newContext(viewport.viewport ? viewport : { viewport });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/analyze', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) }));
    await context.route('https://stanford.edu/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>模拟原文</h1>' }));
    await page.goto(base);
    await page.getByRole('textbox', { name: '研究问题' }).fill(fixture.report.title);
    await page.getByRole('button', { name: '开始分析' }).click();
    await page.getByRole('heading', { name: fixture.report.title, exact: true }).waitFor();
    const core = page.getByLabel('核心观察', { exact: true });
    assert.equal(await core.locator('li').count(), 3);
    assert.equal(await core.locator('strong').count(), 6);
    assert.equal(await core.locator('.answer-opening').count(), 1);
    assert.equal(await core.locator('.answer-opening').innerText(), blocks[0].text);
    assert.equal(await core.locator('.answer-source').count(), 8);
    assert.equal(await core.locator('li').first().locator('a').count(), 1, 'repeat references deduplicate within a paragraph');
    assert.equal(await core.locator('li').first().locator('a').innerText(), 'stanford');
    assert.equal(await core.locator('li').nth(1).locator('a').innerText(), 'naceweb');
    assert.equal(await core.getByText('example', { exact: true }).count(), 0, 'unused evidence must not become a paragraph citation');
    assert.doesNotMatch(await core.innerText(), /\*\*|\[S\d+\]|分析推断|资料事实/);
    assert.ok(Number(await core.locator('.answer-opening').evaluate(element => getComputedStyle(element).fontWeight)) >= 700);
    assert.equal(await core.locator('li').first().evaluate(element => getComputedStyle(element).fontWeight), '400');
    assert.equal(await core.locator('.answer-source').first().evaluate(element => getComputedStyle(element).fontWeight), '400');
    const leadLines = await core.locator('.answer-opening').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length;
    });
    assert.ok(leadLines <= (page.viewportSize().width > 760 ? 3 : 7), `opening became a dense content block (${leadLines} lines)`);
    assert.equal(await core.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'answer layout must fit viewport');
    const popupPromise = page.waitForEvent('popup');
    await core.locator('li').first().locator('a').click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), sources[0].url);
    assert.equal(await page.getByRole('dialog').count(), 0, 'core citation opens original URL directly');
    await popup.close();
    await page.locator('.search-step summary').click();
    assert.equal(await page.locator('.search-links a').count(), 3);
    await page.locator('.search-step summary').click();
    await page.locator('.report').screenshot({ path: `.local/answer-${page.viewportSize().width}.png` });
    await core.screenshot({ path: `.local/core-answer-${page.viewportSize().width}.png` });
    // 旧结果或异常数据也不能因位于第一项而整段加粗。
    await page.getByRole('textbox', { name: '研究问题' }).fill('旧格式超长首段展示检查');
    await page.unroute('**/api/analyze');
    const oldText = blocks.map(block => block.text).join('\n\n');
    await page.route('**/api/analyze', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...fixture, report: { ...report, answerBlocks: undefined, summary: [{ text: oldText, references: refs('S1') }] } }) }));
    await page.getByRole('button', { name: '开始分析' }).click();
    await page.getByLabel('核心观察', { exact: true }).waitFor();
    assert.equal(await page.locator('.answer-opening').count(), 0, 'legacy long text cannot be promoted to a bold opening');
    assert.equal((await page.locator('.summary-item p').innerText()).split('\n')[0], blocks[0].text);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Answer UI passed: oversized model opening repaired through report generation/validation, compact bold lead, normal-weight detailed points, original citations, legacy long-text guard, desktop/390px/320px layouts. Mock responses only.');
} finally { await browser.close(); }
