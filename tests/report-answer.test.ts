import { test } from "node:test";
import assert from "node:assert/strict";
import { generateReport } from "../src/server/services/report";
import { includeEveryArticle } from "../src/core/report";
import { reportBasedSocial } from "../src/core/social";
import { statementSchema, type Source } from "../src/core/contracts";
import { demo } from "../src/client/demo";

const source: Source = {
  id: "S1", url: "https://example.org/research", title: "Research",
  sourceType: "研究论文", publishedAt: null,
  extractedContent: "Coding task performance alone does not establish changes in overall employment or junior hiring.",
  extractionStatus: "available", extractionReason: "test",
};
const answer = "AI编程可能改变初级岗位的工作内容和招聘需求。\n\n但仅凭编码任务表现，还不能判断整个市场的岗位数量已经减少。";
const raw = { title: "AI编程与初级岗位", summary: [{ text: answer, references: [{ sourceId: "S1", evidenceId: "S1-E1" }] }], cards: [], limitations: [] };

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
      assert.equal(result.draft.summary[0].text, answer);
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
      assert.equal(result.draft.summary[0].text, answer);
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
  const social = reportBasedSocial(completed, [source], 2000);
  assert.doesNotMatch(social.text, /比起急着下结论|判断与选择/);
});

test("metric explanations cannot stand in for a missing answer", () => {
  const completed = includeEveryArticle({ ...demo.report, summary: [] }, [source]);
  assert.match(completed.summary[0].text, /未能完成.*请重新分析/);
  assert.ok(!completed.summary[0].text.includes(demo.report.cards[0].explanation));
  assert.equal(completed.cards.length, demo.report.cards.length);
});
