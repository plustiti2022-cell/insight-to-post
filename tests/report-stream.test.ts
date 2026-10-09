import { test } from "node:test";
import assert from "node:assert/strict";
import { reportBlockReader } from "../src/server/report-stream";
import { generateReport } from "../src/server/services/report";
import { AnalysisError } from "../src/server/runtime";
import { analysisDependencies, runAnalysisGraph, type AnalysisDependencies } from "../src/server/workflow/run";
import { reportBasedSocial } from "../src/core/social";
import { completeReport } from "../src/core/report";
import type { AnswerBlock, AnalysisEvent, Source } from "../src/core/contracts";

const source: Source = {
  id: "S1", url: "https://example.org/research", title: "Research", sourceType: "研究论文", publishedAt: null,
  extractedContent: "Coding task performance alone does not establish changes in overall employment or junior hiring.",
  extractionStatus: "available", extractionReason: "test",
};
const references = [{ sourceId: "S1", evidenceId: "S1-E1" }];
const raw = { title: "研究问题", summary: [
  { presentation: "lead", text: "研究结果有适用边界。", references },
  { presentation: "bullet", label: "任务范围", text: "**任务表现**不能直接说明整体就业变化。", references },
  { presentation: "conclusion", text: "需要结合适用范围理解这些结果。", references },
], cards: [], limitations: [] };
const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
function responseFor(value: unknown, completed = true) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return new Response(new ReadableStream({ start(output) {
    for (let i = 0; i < text.length; i += 7) output.enqueue(frame({ type: "response.output_text.delta", delta: text.slice(i, i + 7) }));
    if (completed) output.enqueue(frame({ type: "response.completed", response: { status: "completed", usage: { total_tokens: 37 } } }));
    output.close();
  } }));
}
async function mocked(run: () => Promise<void>) {
  const fetch = globalThis.fetch;
  const names = ["QWEN_API_KEY", "QWEN_MODEL", "QWEN_REPORT_MODEL"] as const;
  const prior = names.map(name => process.env[name]);
  process.env.QWEN_API_KEY = "test-only";
  process.env.QWEN_MODEL = "general-model-must-not-override-report";
  delete process.env.QWEN_REPORT_MODEL;
  try { await run(); }
  finally {
    globalThis.fetch = fetch;
    names.forEach((name, index) => {
      if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index];
    });
  }
}
function dependencies(): AnalysisDependencies {
  return {
    ...analysisDependencies, streamOpening: async () => {},
    research: async () => ({ sources: [source], searchCalls: 1, extractorCalls: 0, credits: 0, warnings: [] }),
    generateSocialContent: async (draft, sources) => ({ socialContent: reportBasedSocial(draft, sources, 2000), modelCalls: 0, totalTokens: 0, durationMs: 0 }),
    signSocialSnapshot: () => "mock-snapshot",
  };
}

test("incremental report parser respects nested JSON, escaped strings, field order and every character boundary", async () => {
  const values: unknown[] = [];
  const read = reportBlockReader(async (item, index) => { assert.equal(index, values.length); values.push(item); });
  const items = [{ text: '引号"、反斜线\\和括号 } ] { ，不会结束段落。', references, presentation: "lead" }, raw.summary[1]];
  const json = JSON.stringify({ cards: [{ summary: ["not the answer"] }], title: "标题", summary: items });
  for (const char of `\n\`\`\`json\n${json}\n\`\`\``) await read(char);
  assert.deepEqual(values, items);
  const unicode: unknown[] = [];
  const unicodeRead = reportBlockReader(async item => { unicode.push(item); });
  for (const char of '{"summary":[{"text":"\\u7814\\u7a76"}]}') await unicodeRead(char);
  assert.deepEqual(unicode, [{ text: "研究" }]);
  await assert.rejects(read('{"summary":[]}'), /重复summary/);
});

test("report max model streams only complete validated paragraphs before the upstream response completes", () => mocked(async () => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let first!: () => void;
  const emitted = new Promise<void>(resolve => { first = resolve; });
  let calls = 0, done = false;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "qwen3.8-max");
    assert.equal(body.max_output_tokens, 7000);
    assert.equal(body.stream, true);
    return new Response(new ReadableStream({ start(controller) { output = controller; } }));
  };
  const blocks: AnswerBlock[] = [];
  const pending = generateReport("研究问题", [source], undefined, undefined, { singleAttempt: true,
    onBlock: async (block, index) => { assert.equal(index, blocks.length); blocks.push(block); first(); },
  }).then(result => { done = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const prefix = `{"summary":[${JSON.stringify(raw.summary[0])}`;
  output.enqueue(frame({ type: "response.output_text.delta", delta: prefix.slice(0, -1) }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(blocks.length, 0, "body text alone cannot be published before its references close");
  for (const byte of frame({ type: "response.output_text.delta", delta: "}" })) output.enqueue(new Uint8Array([byte]));
  await emitted;
  assert.equal(done, false);
  assert.equal(blocks[0].references[0].quote, source.extractedContent);
  output.enqueue(frame({ type: "response.reasoning_text.delta", delta: "private reasoning" }));
  output.enqueue(frame({ type: "response.output_text.delta", delta: `,${JSON.stringify(raw.summary[1])},${JSON.stringify(raw.summary[2])}],"title":"研究问题","cards":[],"limitations":[]}` }));
  output.enqueue(frame({ type: "response.completed", response: { status: "completed", usage: { total_tokens: 37 } } }));
  output.close();
  const result = await pending;
  const final = completeReport(result.draft, [source]);
  assert.equal(calls, 1);
  assert.equal(result.totalTokens, 37);
  assert.deepEqual(blocks.map(block => block.text), final.answerBlocks!.map(block => block.text));
  assert.doesNotMatch(JSON.stringify(blocks), /private reasoning|evidenceId|\*\*/);
}));

test("invalid references, unsupported numbers and malformed paragraphs are never emitted and known usage is retained", () => mocked(async () => {
  for (const invalid of [
    { ...raw.summary[0], references: [{ sourceId: "S1", evidenceId: "S1-missing" }] },
    { ...raw.summary[0], text: "就业下降99%。" },
    { ...raw.summary[0], text: "过长首答".repeat(40) },
    { ...raw.summary[1], label: "" },
    { ...raw.summary[1], label: "2026年", text: "没有年份依据。" },
  ]) {
    let calls = 0;
    const blocks: AnswerBlock[] = [];
    globalThis.fetch = async () => { calls++; return responseFor({ ...raw, summary: [invalid, ...raw.summary.slice(1)] }); };
    await assert.rejects(generateReport("研究问题", [source], undefined, undefined, {
      onBlock: async block => { blocks.push(block); },
    }), error => error instanceof AnalysisError && error.code === "INVALID_REPORT" && error.modelUsage?.totalTokens === 37);
    assert.equal(calls, 1, "the workflow owns the streaming retry budget");
    assert.deepEqual(blocks, []);
  }
}));

test("workflow replaces the first attempt and confirms only the complete second report", () => mocked(async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).model, "qwen3.8-max");
    return responseFor(++calls === 1 ? { ...raw, summary: [raw.summary[0], { ...raw.summary[1], text: "不支持的数字99%。" }, raw.summary[2]] } : raw);
  };
  const events: AnalysisEvent[] = [];
  const result = await runAnalysisGraph({ idea: "研究问题", socialTargetLength: 2000, onEvent: async event => { events.push(event); } }, dependencies());
  assert.equal(calls, 2);
  assert.equal(result.diagnostics.totalTokens, 74);
  assert.equal(result.diagnostics.modelCalls, 2);
  assert.deepEqual(events.filter(event => event.type === "report-start").map(event => event.attempt), [1, 2]);
  assert.deepEqual(events.filter(event => event.type === "report-block").map(event => [event.attempt, event.index]), [[1, 0], [2, 0], [2, 1], [2, 2]]);
  assert.equal(events.filter(event => event.type === "report").length, 1);
  assert.doesNotMatch(JSON.stringify(events), /extractedContent|99%|不支持的数字/);
  assert.equal(result.report.answerBlocks?.length, 3);
}));

test("missing whole-report structure and truncated streams cannot confirm a report or generate social content", () => mocked(async () => {
  for (const truncated of [false, true]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return responseFor(truncated ? raw : { ...raw, summary: [raw.summary[0]] }, !truncated); };
    const deps = dependencies();
    deps.generateSocialContent = async () => { assert.fail("invalid report cannot generate social content"); };
    const events: AnalysisEvent[] = [];
    await assert.rejects(runAnalysisGraph({ idea: "研究问题", socialTargetLength: 2000, onEvent: async event => { events.push(event); } }, deps),
      error => error instanceof AnalysisError && error.code === "INVALID_REPORT");
    assert.equal(calls, 2);
    assert.equal(events.some(event => event.type === "report"), false);
  }
}));

test("cancelling a streamed report stops without recovery or social calls", () => mocked(async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return responseFor(raw); };
  const deps = dependencies();
  deps.generateSocialContent = async () => { assert.fail("cancelled report cannot generate social content"); };
  const events: AnalysisEvent[] = [];
  await assert.rejects(runAnalysisGraph({ idea: "研究问题", socialTargetLength: 2000, signal: controller.signal, onEvent: async event => {
    events.push(event);
    if (event.type === "report-block") controller.abort();
  } }, deps));
  assert.equal(calls, 1);
  assert.equal(events.some(event => event.type === "report-start" && event.attempt === 2), false);
  assert.equal(events.some(event => event.type === "report"), false);
}));

test("JSON report requests use the independent max model without requesting SSE", () => mocked(async () => {
  for (const model of ["qwen3.8-max", "configured-report-model"]) {
    if (model !== "qwen3.8-max") process.env.QWEN_REPORT_MODEL = model;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, model);
      assert.equal(body.stream, undefined);
      return Response.json({ status: "completed", output_text: JSON.stringify(raw) });
    };
    assert.equal((await generateReport("研究问题", [source])).draft.summary.length, 3);
  }
}));
