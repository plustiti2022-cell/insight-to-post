import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnalysisEvent, Draft, SocialPreviewEvent, Source } from "../src/core/contracts";
import { generateSocialContent } from "../src/server/services/social";
import { readSocialStream } from "../src/client/social-stream";
import { readAnalysisStream } from "../src/client/analysis-stream";
import { analysisDependencies, runAnalysisGraph } from "../src/server/workflow/run";
import { signSocialSnapshot, readSocialSnapshot } from "../src/server/services/snapshot";
import { POST } from "../src/app/api/social-content/route";
import { socialContentPrompt } from "../src/server/prompts";

const sources: Source[] = [{ id: "S1", url: "https://example.org/article", title: "原文", sourceType: "研究论文",
  publishedAt: null, extractedContent: "Research findings depend on task scope.", extractionStatus: "available", extractionReason: "test" }];
const report: Draft = { title: "研究问题", summary: [{ text: "研究简报的完整正文。", references: [{ sourceId: "S1", quote: sources[0].extractedContent }] }], cards: [], limitations: [] };
const paragraphs = [{ text: '  模型写作的第一段，含引号"和括号 } ]、emoji🌱。  ' }, { text: " " }, { text: "第二段\n换行也保留。" }];
const expected = '模型写作的第一段，含引号"和括号 } ]、emoji🌱。\n\n第二段\n换行也保留。';
const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`);
const completion = { type: "response.completed", response: { status: "completed", usage: { total_tokens: 37 } } };
function upstream(raw: string, complete = true) {
  return new Response(new ReadableStream({ start(output) {
    for (const char of raw) output.enqueue(frame({ type: "response.output_text.delta", delta: char }));
    if (complete) output.enqueue(frame(completion));
    output.close();
  } }));
}
async function mocked(run: () => Promise<void>) {
  const fetch = globalThis.fetch;
  const names = ["QWEN_API_KEY", "SOCIAL_TOKEN_SECRET"];
  const previous = names.map(name => process.env[name]);
  process.env.QWEN_API_KEY = "test-only";
  process.env.SOCIAL_TOKEN_SECRET = "test-signing-key";
  try { await run(); } finally {
    globalThis.fetch = fetch;
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    });
  }
}

test("social streams only closed normalized paragraphs before model completion, preserving order and usage", () => mocked(async () => {
  let output!: ReadableStreamDefaultController<Uint8Array>, first!: () => void;
  const received = new Promise<void>(resolve => { first = resolve; });
  let finished = false, calls = 0;
  const blocks: string[] = [];
  globalThis.fetch = async (_url, init) => {
    calls++; assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(new ReadableStream({ start(controller) { output = controller; } }));
  };
  const pending = generateSocialContent(report, sources, undefined, undefined, 2000, { onBlock: async (text, index) => {
    assert.equal(index, blocks.length); blocks.push(text); first();
  } }).then(result => { finished = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  output.enqueue(frame({ type: "response.reasoning_text.delta", delta: "private reasoning" }));
  const firstObject = JSON.stringify(paragraphs[0]);
  output.enqueue(frame({ type: "response.output_text.delta", delta: '{"metadata":{"paragraphs":[]},"paragraphs":[' + firstObject.slice(0, -1) }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(blocks, []);
  output.enqueue(frame({ type: "response.output_text.delta", delta: "}" }));
  await received;
  assert.equal(finished, false);
  for (const char of ',' + JSON.stringify(paragraphs[1]) + ',' + JSON.stringify(paragraphs[2]) + ']}')
    output.enqueue(frame({ type: "response.output_text.delta", delta: char }));
  output.enqueue(frame(completion)); output.close();
  const result = await pending;
  assert.equal(result.socialContent.text, expected);
  assert.equal(blocks.join("\n\n"), expected);
  assert.equal(result.totalTokens, 37); assert.equal(calls, 1);
}));

test("social streaming failures never publish a successful partial draft or retry", () => mocked(async () => {
  for (const [raw, complete] of [
    ['{"paragraphs":[{"text":"已收到的预览。"}]}', false],
    ['{"paragraphs":[{"text":"已收到的预览。"}', true],
    ['{"paragraphs":[{"text":"已收到的预览。"},{"text":9}]}', true],
    ['{"paragraphs":[{"text":"已收到的预览。"}],"paragraphs":[]}', true],
  ] as const) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return upstream(raw, complete); };
    const result = await generateSocialContent(report, sources, undefined, undefined, 2000, { onBlock: async () => {} });
    assert.equal(result.socialContent.status, "failed"); assert.equal(result.socialContent.text, ""); assert.equal(calls, 1);
  }
}));

test("cancelling from a social preview propagates instead of producing a business failure", () => mocked(async () => {
  const controller = new AbortController();
  globalThis.fetch = async () => upstream(JSON.stringify({ paragraphs }));
  await assert.rejects(generateSocialContent(report, sources, controller.signal, undefined, 2000,
    { onBlock: async () => { controller.abort(); } }));
}));

test("workflow streams social after confirmed report and JSON analysis keeps its one-call behavior", () => mocked(async () => {
  globalThis.fetch = async (_url, init) => JSON.parse(String(init?.body)).stream
    ? upstream(JSON.stringify({ paragraphs })) : Response.json({ output_text: JSON.stringify({ paragraphs }) });
  const deps = { ...analysisDependencies, streamOpening: async () => {},
    generateDataPosters: async () => ({ dataPosters: { status: "complete" as const, items: [] }, modelCalls: 0, totalTokens: 0, durationMs: 0 }),
    research: async () => ({ sources, searchCalls: 0, extractorCalls: 0, credits: 0, warnings: [] }),
    generateReport: async () => ({ draft: report, warnings: [], modelCalls: 0, totalTokens: 0 }),
    signSocialSnapshot: () => "test-token" };
  const events: AnalysisEvent[] = [];
  const input = { idea: "社交流式测试问题", socialTargetLength: 2000, validateCoreContent: false };
  const analysis = await runAnalysisGraph({ ...input, onEvent: async event => { events.push(event); } }, deps);
  assert.equal(events.filter(event => event.type === "social-block").length, 2);
  assert.ok(events.findIndex(event => event.type === "report") < events.findIndex(event => event.type === "social-start"));
  assert.equal(analysis.socialContent?.text, expected);
  const json = await runAnalysisGraph(input, deps);
  assert.equal(json.socialContent?.text, expected); assert.equal(json.diagnostics.modelCalls, 1);
  const response = new Response(events.concat({ type: "result", analysis }).map(event => new TextDecoder().decode(frame(event))).join(""));
  assert.equal((await readAnalysisStream(response, () => {})).socialContent?.text, expected);
}));

test("signed regeneration endpoint streams the unchanged prompt, keeps JSON fallback and rejects invalid signatures", () => mocked(async () => {
  const token = signSocialSnapshot(report, sources, 2000);
  const originalPrompt = readSocialSnapshot(token).prompt;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body)); assert.equal(body.input, originalPrompt);
    return body.stream ? upstream(JSON.stringify({ paragraphs })) : Response.json({ output_text: JSON.stringify({ paragraphs }) });
  };
  const request = (stream: boolean, value = token) => new Request("https://local.test/api/social-content", {
    method: "POST", headers: { Accept: stream ? "text/event-stream" : "application/json" }, body: JSON.stringify({ token: value }),
  });
  const events: SocialPreviewEvent[] = [];
  const result = await readSocialStream(await POST(request(true)), event => events.push(event));
  assert.deepEqual(events.map(event => event.type), ["social-start", "social-block", "social-block"]);
  assert.equal(result.socialContent.text, expected); assert.equal(result.totalTokens, 37);
  assert.equal((await (await POST(request(false))).json()).socialContent.text, expected);
  await assert.rejects(readSocialStream(await POST(request(true, "invalid-token")), () => {}));
  assert.equal(calls, 2);
}));

test("template regeneration uses the signed brief in JSON and SSE with one model call", () => mocked(async () => {
  const token = signSocialSnapshot(report, sources, 2000);
  let calls = 0;
  for (const template of [2, 3] as const) {
    for (const stream of [false, true]) {
      globalThis.fetch = async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.input, socialContentPrompt({ coreObservation: report.summary[0].text, targetLength: 2000, template }));
        return body.stream ? upstream(JSON.stringify({ paragraphs })) : Response.json({ output_text: JSON.stringify({ paragraphs }) });
      };
      const response = await POST(new Request("https://local.test/api/social-content", {
        method: "POST", headers: { Accept: stream ? "text/event-stream" : "application/json" }, body: JSON.stringify({ token, template }),
      }));
      const result = stream ? await readSocialStream(response, () => {}) : await response.json();
      assert.equal(result.socialContent.text, expected);
      assert.equal(result.socialContent.targetLength, 2000);
    }
  }
  assert.equal(calls, 4);
}));

test("social client handles byte-split UTF-8 and rejects truncation, malformed order and errors", () => mocked(async () => {
  globalThis.fetch = async () => Response.json({ output_text: JSON.stringify({ paragraphs }) });
  const result = await generateSocialContent(report, sources);
  const events = [{ type: "social-start" }, { type: "social-block", index: 0, text: "流式🌱文字" }, { type: "social-result", result }];
  const bytes = new TextEncoder().encode(events.map(event => new TextDecoder().decode(frame(event))).join(""));
  let index = 0;
  const response = new Response(new ReadableStream({ pull(output) {
    if (index === bytes.length) output.close(); else output.enqueue(bytes.slice(index, ++index));
  } }));
  assert.equal((await readSocialStream(response, () => {})).socialContent.text, expected);
  for (const events of [
    [{ type: "social-start" }],
    [{ type: "social-block", index: 0, text: "文字" }],
    [{ type: "social-start" }, { type: "social-block", index: 1, text: "文字" }],
    [{ type: "social-start" }, { type: "social-start" }],
    [{ type: "error", error: { code: "INTERNAL", message: "文案失败。" } }],
  ]) await assert.rejects(readSocialStream(new Response(events.map(event => new TextDecoder().decode(frame(event))).join("")), () => {}));
}));
