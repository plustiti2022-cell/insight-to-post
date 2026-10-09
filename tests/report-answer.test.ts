import { test } from "node:test";
import assert from "node:assert/strict";
import { generateReport } from "../src/server/services/report";
import { includeEveryArticle, hasOpeningSummary, answerStructureIssues } from "../src/core/report";
import { readSocialForDisplay } from "../src/core/social";
import { statementSchema, type Source } from "../src/core/contracts";
import { demo } from "../src/client/demo";
import { validateReport } from "../src/core/evidence";
import { draftSchema, ANSWER_LEAD_MAX_LENGTH } from "../src/core/contracts";

const source: Source = {
  id: "S1", url: "https://example.org/research", title: "Research",
  sourceType: "研究论文", publishedAt: null,
  extractedContent: "Coding task performance alone does not establish changes in overall employment or junior hiring.",
  extractionStatus: "available", extractionReason: "test",
};
const answer = "AI编程可能改变初级岗位的工作内容和招聘需求。\n\n但仅凭编码任务表现，还不能判断整个市场的岗位数量已经减少。\n\n应区分任务表现与整体就业变化。";
const raw = { title: "AI编程与初级岗位", summary: answer.split("\n\n").map((text, index) => ({ presentation: index === 0 ? "lead" : index === 1 ? "bullet" : "conclusion", ...(index === 1 ? { label: "证据边界" } : {}), text, references: [{ sourceId: "S1", evidenceId: "S1-E1" }] })), cards: [], limitations: [] };

test("an empty or malformed answer is repaired with the original question and evidence", async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-only";
  try {
    for (const summary of [[], [{ ...raw.summary[0], text: "   " }], [{ ...raw.summary[0], references: [{ sourceId: "S1", evidenceId: "S1-NONEXISTENT" }] }]]) {
      const prompts: string[] = [];
      globalThis.fetch = async (_url, init) => {
        prompts.push(JSON.parse(String(init?.body)).input);
        return Response.json({ status: "completed", output_text: JSON.stringify(prompts.length === 1 ? { ...raw, summary } : raw), usage: { total_tokens: 10 } });
      };
      const question = "AI编程会不会减少当前初级岗位的数量";
      const result = await generateReport(question, [source]);
      assert.equal(prompts.length, 2);
      assert.match(prompts[1], /上次格式未通过校验/);
      assert.ok(prompts[1].includes(question));
      assert.ok(prompts[1].includes(source.extractedContent));
      assert.equal(result.draft.summary.map((item) => item.text).join("\n\n"), answer);
      assert.equal(result.totalTokens, 20);
      assert.equal(result.modelCalls, 2);
      assert.ok(!("kind" in result.draft.summary[0]));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = originalKey;
  }
});

test("answer recovery has one generation call even for invalid JSON", async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-only";
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ status: "completed", output_text: "invalid JSON" }); };
  try {
    await assert.rejects(generateReport("研究问题", [source], undefined, undefined, { answerOnly: true, answerFeedback: ["没有回答问题"] }));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = originalKey;
  }
});

test("initial and recovery model requests exclude source metadata while keeping the question and body", async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-only";
  const article = { ...source, title: "PRIVATE_SOURCE_TITLE", author: "PRIVATE_AUTHOR", url: "https://private-source.example/research", sourceType: "机构报告" as const };
  const before = structuredClone(article);
  const question = "AI编程会不会减少当前初级岗位的数量";
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const prompt = JSON.parse(String(init?.body)).input as string;
    const input = JSON.parse(prompt.split("\n输入：")[1]);
    assert.equal(input.idea, question);
    assert.deepEqual(input.sources, [{ id: "S1", evidence: [{ id: "S1-E1", sourceId: "S1", text: source.extractedContent }] }]);
    for (const excluded of [article.title, article.author, article.url, article.sourceType]) assert.ok(!prompt.includes(excluded));
    return Response.json({ status: "completed", output_text: JSON.stringify(raw) });
  };
  try {
    for (const options of [undefined, { answerOnly: true, answerFeedback: ["重新回答用户问题"] }]) {
      const result = await generateReport(question, [article], undefined, undefined, options);
      assert.equal(result.draft.summary.map((item) => item.text).join("\n\n"), answer);
      assert.equal(result.draft.summary[0].references[0].quote, source.extractedContent);
    }
    assert.equal(calls, 2);
    assert.deepEqual(article, before, "metadata remains available to the source UI");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = originalKey;
  }
});

test("completion preserves the actual answer and paragraphs without rewriting attribution or adding labels", () => {
  const text = "根据《劳动市场报告》，这个结论仅适用于调查样本。\n\n其他场景还需要进一步验证。";
  const statement = statementSchema.parse({ text, kind: "inference", references: [{ sourceId: "S1", quote: source.extractedContent }] });
  assert.ok(!("kind" in statement), "legacy classification is discarded");
  const completed = includeEveryArticle({ title: "研究", summary: [statement], cards: [], limitations: [] }, [source]);
  assert.equal(completed.summary[0].text, text);
  const social = readSocialForDisplay({ paragraphs: [{ text: "模拟模型改写后的社交文案。" }] }, completed, [source], 2000);
  assert.doesNotMatch(social.text, /比起急着下结论|判断与选择/);
});

test("metric explanations cannot stand in for a missing answer", () => {
  const completed = includeEveryArticle({ ...demo.report, summary: [] }, [source]);
  assert.match(completed.summary[0].text, /未能完成.*请重新分析/);
  assert.ok(!completed.summary[0].text.includes(demo.report.cards[0].explanation));
  assert.equal(completed.cards.length, demo.report.cards.length);
});

test("paragraph references survive completion while unused articles only join social evidence metadata", () => {
  const second = { ...source, id: "S2", url: "https://example.org/second" };
  const unused = { ...source, id: "S3", url: "https://example.org/unused" };
  const completed = includeEveryArticle({ title: "AI就业", cards: [], limitations: [], summary: [
    { presentation: "lead", text: "部分岗位需求可能变化。", references: [{ sourceId: "S1", quote: source.extractedContent }] },
    { presentation: "bullet", label: "岗位转型", text: "需要区分任务效率与就业变化。", references: [{ sourceId: "S2", quote: second.extractedContent }] },
  ] }, [source, second, unused]);
  assert.deepEqual(completed.answerBlocks?.map((block) => block.references.map((ref) => ref.sourceId)), [["S1"], ["S2"]]);
  assert.equal(completed.summary.length, 1);
  assert.equal(completed.summary[0].text, "部分岗位需求可能变化。\n\n岗位转型：需要区分任务效率与就业变化。");
  assert.deepEqual(completed.summary[0].references.map((ref) => ref.sourceId), ["S1", "S2", "S3"]);
  assert.equal(completed.summary[0].claimId, "summary-1");
  assert.equal(readSocialForDisplay({ paragraphs: [{ text: "模拟模型改写后的社交文案。" }] }, completed, [source, second, unused], 2000).coverage.citedSourceCount, 3);
});

test("unsupported numbers in a bold point label cannot bypass evidence validation", () => {
  const result = validateReport({ title: "研究", cards: [], limitations: [], summary: [
    { presentation: "bullet", label: "减少99%", text: "岗位发生变化。", references: [{ sourceId: "S1", quote: source.extractedContent }] },
  ] }, [source]);
  assert.equal(result.report.summary.length, 0);
});

test("a complete multi-paragraph answer remains valid in the social snapshot contract", () => {
  const completed = includeEveryArticle({ title: "研究", cards: [], limitations: [], summary: [
    { text: "岗位需求可能变化。".repeat(180), references: [{ sourceId: "S1", quote: source.extractedContent }] },
    { text: "任务效率与就业变化需要区分。".repeat(180), references: [{ sourceId: "S1", quote: source.extractedContent }] },
  ] }, [source]);
  assert.ok(completed.summary[0].text.length > 3000);
  assert.equal(draftSchema.parse(completed).summary[0].text, completed.summary[0].text);
});

const longLead = "AI正在显著减少部分领域的初级岗位，尤其是那些以重复性认知任务为主的工作，如基础编码、数据录入和初级行政。但这种减少并非均匀发生，目前观察到的就业下滑可能混合了宏观经济因素。数据显示，科技行业年轻从业者的失业率有所上升，入门级职位发布量有所下降；然而，也有研究指出，初级岗位衰退早于企业级AI工具的广泛部署，利率敏感型行业招聘冻结可能是更主要的初期驱动力。因此，AI确实通过自动化学习环节压缩了初级岗位的入口，但短期内不能将所有岗位流失完全归因于AI技术本身。";

test("the screenshot's dense bold introduction is regenerated as a short lead with preserved bullet detail", async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-only";
  const refs = raw.summary[0].references;
  const detail = "任务效率改善不能直接证明整体就业已经减少，需要区分任务、岗位与招聘需求。";
  const corrected = { ...raw, summary: [
    { presentation: "lead", text: "会减少部分岗位需求，但行业影响并不均匀，短期就业变化也不能全部归因于AI。", references: refs },
    { presentation: "bullet", label: "岗位入口", text: "重复任务的自动化会改变初级岗位的工作内容与培养路径。", references: refs },
    { presentation: "bullet", label: "证据边界", text: detail, references: refs },
    { presentation: "conclusion", text: "需要结合招聘资料判断岗位变化。", references: refs },
  ] };
  const prompts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(String(init?.body)).input);
    return Response.json({ output_text: JSON.stringify(prompts.length === 1 ? { ...corrected, summary: [{ presentation: "lead", text: longLead, references: refs }, corrected.summary[2]] } : corrected), usage: { total_tokens: 10 } });
  };
  try {
    assert.ok(longLead.length > ANSWER_LEAD_MAX_LENGTH);
    const result = await generateReport("AI会减少初级岗位吗？", [source]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /开篇总结格式无效/);
    assert.match(prompts[1], /详细论据与数字保留在后续bullet中，不截断正文/);
    assert.equal(result.draft.summary[0].text, corrected.summary[0].text);
    assert.equal(result.draft.summary.filter((item) => item.presentation === "lead").length, 1);
    assert.equal(result.draft.summary[2].text, detail);
    assert.deepEqual(answerStructureIssues(result.draft.summary), []);
    const completed = includeEveryArticle(result.draft, [source]);
    assert.equal(completed.answerBlocks?.[0].text, corrected.summary[0].text);
    assert.ok(completed.summary[0].text.includes(detail), "social observation retains full detail");
    assert.equal(result.modelCalls, 2);
    assert.equal(result.totalTokens, 20);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = originalKey;
  }
});

test("lead layout rules reject long or misplaced leads, newlines, lead labels and untitled bullets", () => {
  const opening = { presentation: "lead" as const, text: "岗位内容会变化，但需要区分任务效率与整体就业。", references: [] };
  for (const summary of [
    [{ ...opening, text: longLead }],
    [{ ...opening, text: "简短总结。\n另一段。" }],
    [{ ...opening, label: "详细数据" }],
    [{ ...opening, presentation: "bullet" as const, label: "要点" }],
    [opening, opening],
    [opening, { ...opening, presentation: "bullet" as const }],
    [opening, { ...opening, presentation: "paragraph" as const, text: "具体数据应归入要点。" }],
  ]) assert.ok(answerStructureIssues(summary).length);
  assert.equal(hasOpeningSummary({ summary: [opening] }), true);
  assert.equal(hasOpeningSummary({ summary: [{ ...opening, text: "字".repeat(ANSWER_LEAD_MAX_LENGTH) }] }), true);
  assert.equal(hasOpeningSummary({ summary: [{ ...opening, text: "字".repeat(ANSWER_LEAD_MAX_LENGTH + 1) }] }), false);
});

test("repeated dense lead failure is bounded to the existing generation budget", async () => {
  const originalFetch = globalThis.fetch, originalKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-only";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ output_text: JSON.stringify({ ...raw, summary: [{ ...raw.summary[0], presentation: "lead", text: longLead }] }) });
  };
  try {
    await assert.rejects(generateReport("AI会减少初级岗位吗？", [source]), (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_REPORT");
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(generateReport("AI会减少初级岗位吗？", [source], undefined, undefined, { answerOnly: true }));
    assert.equal(calls, 1, "answer recovery cannot start another layout repair loop");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = originalKey;
  }
});

test("missing or invalid short lead never promotes detailed text or modifies social input", () => {
  for (const summary of [
    [{ presentation: "bullet" as const, label: "证据边界", text: "需要区分任务效率与整体就业。", references: [{ sourceId: "S1", quote: source.extractedContent }] }],
    [{ presentation: "lead" as const, text: longLead, references: [{ sourceId: "S1", quote: source.extractedContent }] }],
  ]) {
    const completed = includeEveryArticle({ title: "研究", cards: [], limitations: [], summary }, [source]);
    assert.match(completed.answerBlocks?.[0].text ?? "", /未能生成简短总结/);
    assert.equal(completed.answerBlocks?.[1].text, summary[0].text);
    assert.notEqual(completed.answerBlocks?.[1].presentation, "lead");
    assert.ok(!completed.summary[0].text.includes("未能生成简短总结"));
    assert.ok(completed.summary[0].text.includes(summary[0].text));
  }
});
