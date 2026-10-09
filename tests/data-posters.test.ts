import { test } from "node:test";
import assert from "node:assert/strict";
import { readDataObservations, readStaticPosterSvg } from "../src/core/data-posters";
import { DATA_POSTER_INSTRUCTIONS, dataExtractionPrompt, dataPosterPrompt } from "../src/server/prompts";
import { generateDataPosters } from "../src/server/services/data-posters";
import type { DataPosters } from "../src/core/contracts";

const svg = '<svg width="768" height="1024" viewBox="0 0 768 1024"><rect width="768" height="1024" fill="#102235"/><text x="48" y="100" font-family="Arial, Microsoft YaHei, sans-serif" font-size="32" fill="#fff">增长20% &amp; 范围限定</text></svg>';
const success = (text: string) => Response.json({ status: "completed", output_text: text, usage: { total_tokens: 13 } });
async function mocked(run: () => Promise<void>) {
  const original = globalThis.fetch;
  const key = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-only";
  try { await run(); } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = key;
  }
}

test("extraction returns all independent numeric observations without a count cap", () => {
  const items = Array.from({ length: 35 }, (_, index) => `对象${index}增加20%，仅限样本。`);
  assert.deepEqual(readDataObservations([...items, items[0], ` ${items[1]} `]), items);
  assert.deepEqual(readDataObservations([]), []);
  for (const invalid of [{ items }, ["不含任何数据"], [42], [""]]) assert.throws(() => readDataObservations(invalid));
});

test("prompt1 accepts edits and only sends the completed research; prompt2 is immutable", () => {
  const coreObservation = '样本比例从20%到30%，增加10个百分点。\n保留"限定"。';
  const prompt = dataExtractionPrompt({ coreObservation, instructions: "只提取比例变化" });
  assert.ok(prompt.startsWith("只提取比例变化\n"));
  assert.equal(JSON.parse(prompt.split("研究回答：")[1]), coreObservation);
  assert.match(dataExtractionPrompt({ coreObservation }), /^从此问答中提取出包含具体数据的内容，不要重复，json输出/);
  assert.equal(dataPosterPrompt({ text: coreObservation }), `${DATA_POSTER_INSTRUCTIONS}\n\n\n\n${coreObservation}`);
  assert.match(DATA_POSTER_INSTRUCTIONS, /相对变化、占比和百分点不得混淆/);
  assert.match(DATA_POSTER_INSTRUCTIONS, /width="768" height="1024" viewBox="0 0 768 1024"/);
});

test("SVG accepts static native text and geometry and supplies its image namespace", () => {
  const decoded = readStaticPosterSvg(svg);
  assert.match(decoded, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.equal(readStaticPosterSvg(decoded), decoded);
  assert.match(readStaticPosterSvg(svg.replace("增长20%", "<tspan>增长20%</tspan>")), /<tspan>/);
  assert.match(readStaticPosterSvg('<!-- poster -->' + svg), /<svg xmlns=/);
});

test("SVG rejects execution, remote assets, wrong canvas, transparent background and broken XML", () => {
  const attacks = [
    '<script>alert(1)</script>', '<image href="https://remote.test"/>', '<foreignObject/>', '<use href="#x"/>',
    '<style>text{fill:red}</style>', '<animate/>', '<filter/>', '<rect onload="alert(1)"/>',
    '<path style="fill:red"/>', '<rect fill="url(https://remote.test)"/>', '<text font-family="remote">x</text>',
    '<g><text>x</g></text>', '<rect width="2" width="3"/>', '<text>&bogus;</text>', '<text>&#0;</text>', '<!DOCTYPE svg>',
  ];
  for (const attack of attacks) assert.throws(() => readStaticPosterSvg(svg.replace("</svg>", attack + "</svg>")), attack);
  for (const invalid of [svg.replace('width="768"', 'width="800"'), svg.replace('<svg ', '<svg fill-opacity="0" '), svg.replace('fill="#102235"', 'fill="none"'), svg.replace('<rect width="768"', '<rect opacity="0.5" width="768"'), svg.replace('</svg>', ''), svg + svg, '```svg\n' + svg + '\n```'])
    assert.throws(() => readStaticPosterSvg(invalid));
});

test("Flash extracts JSON then Max requests exactly one SVG for every unique item with progressive updates", () => mocked(async () => {
  const observations = ["销量增加20%，仅限2025年样本。", "份额从30%降至25%，下降5个百分点。", "费用降低12%。"];
  const calls: { model: string; input: string }[] = [];
  const updates: DataPosters[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    if (calls.length === 1) {
      assert.equal(body.model, "qwen3.8-flash");
      assert.match(body.input, /^自定义提取规则/);
      return success(JSON.stringify([...observations, observations[0]]));
    }
    assert.equal(body.model, "qwen3.8-max");
    return success(svg);
  };
  const result = await generateDataPosters("完整研究回答20%。", undefined, async update => { updates.push(update); }, "自定义提取规则");
  assert.equal(calls.length, 4);
  assert.equal(result.modelCalls, 4);
  assert.equal(result.totalTokens, 52);
  assert.deepEqual(calls.slice(1).map(call => call.input), observations.map(text => dataPosterPrompt({ text })));
  assert.equal(result.dataPosters.status, "complete");
  assert.ok(result.dataPosters.items.every(item => item.status === "ready" && item.svg));
  assert.equal(updates[0].status, "extracting");
  assert.equal(updates[1].items[0].status, "pending", "published state must not mutate later");
  assert.ok(updates.some(update => update.items.some(item => item.status === "ready") && update.items.some(item => item.status !== "ready")));
}));

test("malformed extraction and upstream errors display failure once without posters, retries or substitutes", () => mocked(async () => {
  for (const response of [() => success("broken JSON"), () => success('{"wrong":[]}'), () => new Response("private details", { status: 503 })]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return response(); };
    const result = await generateDataPosters("研究回答20%。");
    assert.equal(calls, 1);
    assert.equal(result.dataPosters.status, "failed");
    assert.deepEqual(result.dataPosters.items, []);
    assert.ok(result.dataPosters.error);
    assert.doesNotMatch(JSON.stringify(result), /private details/);
  }
}));

test("one failed SVG displays its error and keeps all other items without retrying it", () => mocked(async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const input = JSON.parse(String(init?.body)).input;
    if (calls === 1) return success('["增长20%","减少10%","增加30%"]');
    return success(input.endsWith("减少10%") ? '<svg><script/></svg>' : svg);
  };
  const result = await generateDataPosters("研究回答。");
  assert.equal(calls, 4);
  assert.deepEqual(result.dataPosters.items.map(item => item.status), ["ready", "failed", "ready"]);
  assert.equal(result.dataPosters.items[1].svg, undefined);
  assert.match(result.dataPosters.items[1].error!, /静态 SVG/);
}));

test("no data is a successful empty extraction and never calls Max", () => mocked(async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return success("[]"); };
  const result = await generateDataPosters("纯观点。");
  assert.equal(calls, 1);
  assert.deepEqual(result.dataPosters, { status: "complete", items: [] });
}));

test("cancellation during extraction never becomes a failure result or starts Max", () => mocked(async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => { calls++; controller.abort(); return success('["增长20%"]'); };
  await assert.rejects(generateDataPosters("研究回答。", controller.signal));
  assert.equal(calls, 1);
}));

test("poster requests have bounded concurrency and cancellation stops queued work without publishing failures", () => mocked(async () => {
  const controller = new AbortController();
  const updates: DataPosters[] = [];
  let calls = 0, active = 0, maxActive = 0;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls === 1) return success('["增长20%","减少10%","增加30%","增加40%"]');
    active++; maxActive = Math.max(maxActive, active);
    if (active === 2) entered();
    await new Promise<void>(resolve => init!.signal!.addEventListener("abort", () => { active--; resolve(); }, { once: true }));
    init!.signal!.throwIfAborted();
    return success(svg);
  };
  const pending = generateDataPosters("研究回答。", controller.signal, async update => { updates.push(update); });
  await started;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(maxActive, 2);
  assert.equal(active, 0);
  assert.equal(calls, 3);
  assert.ok(updates.every(update => update.status !== "failed" && update.items.every(item => item.status !== "failed")));
}));
