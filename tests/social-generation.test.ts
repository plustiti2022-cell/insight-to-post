import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSocialContent } from "../src/server/services/social";
import { analysisDependencies, runAnalysisGraph } from "../src/server/workflow/run";
import { completeReport } from "../src/core/report";
import type { Draft, Source } from "../src/core/contracts";

const sources: Source[] = ["S1", "S2"].map((id, index) => ({
  id, url: `https://example.org/article-${index}`, title: "原文标题", sourceType: "研究论文",
  publishedAt: null, extractedContent: "Research findings depend on the task and the scope of the evaluation.",
  extractionStatus: "available", extractionReason: "mock",
}));
const draft: Draft = { title: "研究简报", cards: [], limitations: [], summary: [
  { presentation: "lead", text: "工具改变了部分任务，仍需结合场景判断。", references: [{ sourceId: "S1", quote: sources[0].extractedContent }] },
  { presentation: "bullet", label: "培养方式", text: "完整展开内容：新人需要学会检查结果，而不只是写出代码。", references: [] },
] };
const report = completeReport(draft, sources, false);
const modelCopy = { paragraphs: [
  { text: "天啊，写代码的起点正在变化。" },
  { text: "比起只看代码写得快不快，我们更需要讨论如何培养能判断结果的人。" },
  { text: "团队会怎样安排新人的第一份任务？" },
] };

async function mocked(run: () => Promise<void>) {
  const priorFetch = globalThis.fetch, priorKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-only";
  try { await run(); } finally {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = priorKey;
  }
}

test("social writer receives the full completed brief and publishes only its own rewrite", () => mocked(async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const prompt = JSON.parse(String(init?.body)).input;
    assert.equal(JSON.parse(prompt.split("\n核心观察：")[1]), report.summary[0].text);
    assert.match(prompt, /完整展开内容/);
    assert.match(prompt, /不要逐段照搬简报/);
    assert.doesNotMatch(prompt, /claimIds|上次问题|原文标题|https:\/\/example/);
    return Response.json({ output_text: JSON.stringify(modelCopy), usage: { total_tokens: 27 } });
  };
  const result = await generateSocialContent(report, sources, undefined, undefined, 2000);
  assert.equal(calls, 1);
  assert.equal(result.totalTokens, 27);
  assert.equal(result.socialContent.text, modelCopy.paragraphs.map(item => item.text).join("\n\n"));
  assert.notEqual(result.socialContent.text, report.summary[0].text);
  assert.equal(result.socialContent.coverage.citedSourceCount, 2);
  assert.ok(result.socialContent.claimReferences.every(ref => ref.paragraphIndex === -1));
}));

test("social content has no numeric, claim, scope, paragraph-count or length gate", () => mocked(async () => {
  for (const text of ["新数字999%，无引用也直接显示。", "一段模型文案。", "长文".repeat(2000)]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ output_text: JSON.stringify({ paragraphs: [{ text, claimIds: ["unknown"] }] }) }); };
    const result = await generateSocialContent(report, sources, undefined, undefined, 280);
    assert.equal(calls, 1);
    assert.equal(result.socialContent.status, "ready");
    assert.equal(result.socialContent.text, text);
    assert.equal(result.socialContent.coverage.requirementMet, true);
  }
}));

test("broken, empty and unreadable model output cannot be replaced by the research brief", () => mocked(async () => {
  for (const raw of ["invalid JSON", "{}", '{"paragraphs":[]}', '{"paragraphs":[{"text":"  "}]}', '{"paragraphs":[{"text":9}]}']) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ output_text: raw, usage: { total_tokens: 12 } }); };
    const result = await generateSocialContent(report, sources);
    assert.equal(calls, 1);
    assert.equal(result.socialContent.status, "failed");
    assert.equal(result.socialContent.text, "");
    assert.equal(result.totalTokens, 12);
  }
}));

test("manual regeneration replays the signed writing prompt once without correction or copied fallback", () => mocked(async () => {
  const originalPrompt = "原始写作提示词，仅使用已经完成的简报。";
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).input, originalPrompt);
    throw new Error("private upstream data");
  };
  const result = await generateSocialContent(report, sources, undefined, undefined, 2000, { originalPrompt });
  assert.equal(calls, 1);
  assert.equal(result.socialContent.status, "failed");
  assert.equal(result.socialContent.text, "");
  assert.doesNotMatch(result.socialContent.warnings.join(" "), /private/);
}));

test("cancelling social generation propagates instead of returning a copied draft", () => mocked(async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ output_text: JSON.stringify(modelCopy) }); };
  await assert.rejects(generateSocialContent(report, sources, controller.signal, async () => { controller.abort(); }));
  assert.equal(calls, 1);
}));

test("workflow continues from unchecked report into a separate successful writing call", () => mocked(async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.match(JSON.parse(String(init?.body)).input, /完整展开内容/);
    return Response.json({ output_text: JSON.stringify(modelCopy) });
  };
  const result = await runAnalysisGraph({ idea: "测试独立社交写作的研究问题", socialTargetLength: 2000, validateCoreContent: false }, {
    ...analysisDependencies,
    research: async () => ({ sources, searchCalls: 1, extractorCalls: 0, credits: 0, warnings: [] }),
    generateReport: async () => ({ draft, warnings: [], modelCalls: 1, totalTokens: 0 }),
    validateReport: () => { assert.fail("core validation must stay off"); },
    signSocialSnapshot: () => "mock-signed-token",
  });
  assert.equal(calls, 1);
  assert.equal(result.socialContent?.text, modelCopy.paragraphs.map(item => item.text).join("\n\n"));
  assert.match(result.report.summary[0].text, /完整展开内容/);
  assert.equal(result.socialRetryToken, "mock-signed-token");
}));
