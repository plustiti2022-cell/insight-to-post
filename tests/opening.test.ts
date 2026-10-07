import { test } from "node:test";
import assert from "node:assert/strict";
import { streamOpening } from "../src/server/services/opening";
import { AnalysisError } from "../src/server/runtime";

const encoder = new TextEncoder();
const frame = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\r\n\r\n`);
function mockEnvironment() {
  const names = ["QWEN_API_KEY", "QWEN_MODEL", "QWEN_OPENING_MODEL"];
  const previous = names.map(name => process.env[name]);
  const fetch = globalThis.fetch;
  process.env.QWEN_API_KEY = "test-only";
  process.env.QWEN_MODEL = "research-model-only";
  delete process.env.QWEN_OPENING_MODEL;
  return () => {
    globalThis.fetch = fetch;
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  };
}

test("opening delivers the first split UTF-8 delta before completion using a short independent flash request", async () => {
  const restore = mockEnvironment();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let emitted!: () => void;
  const first = new Promise<void>(resolve => { emitted = resolve; });
  let calls = 0, complete = false;
  const parts: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.match(String(url), /\/responses$/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal(body.model, "qwen3.8-flash");
    assert.deepEqual(body.reasoning, { effort: "none" });
    assert.equal(body.max_output_tokens, 160);
    assert.equal(body.store, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.previous_response_id, undefined);
    assert.ok(body.input.length < 100);
    return new Response(new ReadableStream({ start(controller) { output = controller; } }));
  };
  try {
    const pending = streamOpening("AI会改变初级岗位吗？", undefined, async text => {
      parts.push(text); emitted();
    }).then(() => { complete = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    output.enqueue(frame({ type: "response.reasoning_text.delta", delta: "private reasoning" }));
    const bytes = frame({ type: "response.output_text.delta", delta: "先看岗位需求。" });
    for (const byte of bytes) output.enqueue(new Uint8Array([byte]));
    await first;
    assert.deepEqual(parts, ["先看岗位需求。"]);
    assert.equal(complete, false);
    output.enqueue(frame({ type: "response.output_text.delta", delta: "再看任务变化。" }));
    output.enqueue(frame({ type: "response.completed", response: { status: "completed", usage: { total_tokens: 31 } } }));
    output.close();
    await pending;
    assert.equal(parts.join(""), "先看岗位需求。再看任务变化。");
    assert.equal(calls, 1);
  } finally { restore(); }
});

test("opening honors its own model setting and propagates an upstream failure without retries", async () => {
  const restore = mockEnvironment();
  process.env.QWEN_OPENING_MODEL = "opening-model-only";
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).model, "opening-model-only");
    return new Response("private error", { status: 429 });
  };
  try {
    await assert.rejects(streamOpening("研究问题", undefined, async () => { assert.fail("no placeholder"); }),
      error => error instanceof AnalysisError && error.code === "RATE_LIMITED");
    assert.equal(calls, 1);
  } finally { restore(); }
});

test("opening rejects empty, failed and truncated streams without inventing text", async () => {
  const restore = mockEnvironment();
  try {
    for (const events of [
      [{ type: "response.completed", response: { status: "completed" } }],
      [{ type: "response.failed", response: { error: "private details" } }],
      [{ type: "response.output_text.delta", delta: "已收到问题。" }],
    ]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(new ReadableStream({ start(output) {
        events.forEach(event => output.enqueue(frame(event))); output.close();
      } })); };
      await assert.rejects(streamOpening("研究问题", undefined, async () => {}),
        error => error instanceof AnalysisError && !error.message.includes("private"));
      assert.equal(calls, 1);
    }
  } finally { restore(); }
});

test("opening cancellation aborts its upstream reader and never substitutes text", async () => {
  const restore = mockEnvironment();
  const controller = new AbortController();
  let upstreamAborted = false, calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    return new Response(new ReadableStream({ start(output) {
      output.enqueue(frame({ type: "response.output_text.delta", delta: "已收到问题。" }));
      init?.signal?.addEventListener("abort", () => { upstreamAborted = true; output.error(init.signal!.reason); }, { once: true });
    } }));
  };
  try {
    await assert.rejects(streamOpening("研究问题", controller.signal, async () => { controller.abort(); }),
      error => error instanceof AnalysisError && error.code === "CANCELLED");
    assert.equal(calls, 1);
    assert.equal(upstreamAborted, true);
  } finally { restore(); }
});
