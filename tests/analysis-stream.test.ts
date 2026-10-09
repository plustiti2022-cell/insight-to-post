import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Analysis, AnalysisEvent } from "../src/core/contracts";
import { jsonEndpoint } from "../src/server/http";
import { readAnalysisStream } from "../src/client/analysis-stream";
import { AnalysisError } from "../src/server/runtime";

const analysis: Analysis = {
  status: "complete", report: { title: "流式测试", summary: [], cards: [], limitations: [], generatedAt: "2026-10-07T00:00:00Z" },
  sources: [], warnings: [],
  diagnostics: { durationMs: 1, searchCalls: 1, extractorCalls: 0, modelCalls: 1, totalTokens: 1, sourceTypes: 0 },
};
const options = { maxChars: 100, busyMessage: "busy", invalidMessage: "invalid", tooLargeMessage: "large", failureMessage: "failed" };
const schema = z.object({ idea: z.string().min(1) });
function request(signal?: AbortSignal, stream = true, body = '{"idea":"test"}') {
  return new Request("https://local.test/api", { method: "POST", headers: { Accept: stream ? "text/event-stream" : "application/json" }, body, signal });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const encoded = (event: AnalysisEvent) => `data: ${JSON.stringify(event)}\n\n`;

test("stream delivers progress before completion, shares JSON capacity and releases on completion", async () => {
  const pending = gate();
  const entered = gate();
  const endpoint = jsonEndpoint(schema, async () => analysis, options, async (_input, _signal, emit) => {
    await emit({ type: "progress", stage: "search" });
    entered.release();
    await pending.promise;
    return analysis;
  });
  const first = await endpoint(request());
  const second = await endpoint(request());
  assert.match(first.headers.get("content-type")!, /text\/event-stream/);
  assert.match(first.headers.get("cache-control")!, /no-transform/);
  await entered.promise;
  assert.equal((await endpoint(request(undefined, false))).status, 429);
  const reader = first.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  assert.match(new TextDecoder().decode((await reader.read()).value), /"stage":"search"/);
  pending.release();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"result"/);
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
  assert.equal((await readAnalysisStream(second, () => {})).status, "complete");
  assert.equal((await endpoint(request(undefined, false))).status, 200);
});

test("stream validates input before headers and sanitizes errors after headers", async () => {
  let calls = 0;
  const endpoint = jsonEndpoint(schema, async () => analysis, options, async () => {
    calls++;
    throw new Error("private upstream body");
  });
  assert.equal((await endpoint(request(undefined, true, "invalid"))).status, 400);
  assert.equal((await endpoint(request(undefined, true, "{}"))).status, 400);
  assert.equal((await endpoint(request(undefined, true, "x".repeat(101)))).status, 413);
  assert.equal(calls, 0);
  const response = await endpoint(request());
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"type":"error","error":\{"code":"INTERNAL","message":"failed"\}/);
  assert.doesNotMatch(text, /private upstream/);
  const known = jsonEndpoint(schema, async () => analysis, options, async () => { throw new AnalysisError("TIMEOUT", "timed out", 504); });
  await assert.rejects(readAnalysisStream(await known(request()), () => {}), /timed out/);
});

for (const cancellation of ["request", "reader"] as const) {
  test(`${cancellation} cancellation aborts upstream without a result and frees capacity`, async () => {
    const stopped = gate();
    const entered = gate();
    let calls = 0;
    const endpoint = jsonEndpoint(schema, async () => analysis, options, async (_input, signal) => {
      calls++;
      if (calls > 1) return analysis;
      entered.release();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped.release(); resolve(); }, { once: true }));
      signal.throwIfAborted();
      return analysis;
    });
    const controller = new AbortController();
    const response = await endpoint(request(controller.signal));
    await entered.promise;
    if (cancellation === "request") controller.abort();
    else await response.body!.cancel();
    await stopped.promise;
    if (cancellation === "request") assert.doesNotMatch(await response.text(), /"type":"result"/);
    await new Promise<void>(resolve => setImmediate(resolve));
    const next = await endpoint(request());
    assert.equal(next.status, 200);
    assert.equal((await readAnalysisStream(next, () => {})).status, "complete");
  });
}

test("client parses split UTF-8, CRLF frames and heartbeats, preserving report before result", async () => {
  const report = { ...analysis, status: "partial" as const };
  const bytes = new TextEncoder().encode(": keepalive\r\n\r\n" +
    encoded({ type: "opening", text: "先关注问题的范围。" }) +
    encoded({ type: "progress", stage: "generate" }).replaceAll("\n", "\r\n") +
    encoded({ type: "report", analysis: report }) + encoded({ type: "result", analysis }));
  let index = 0;
  const events: AnalysisEvent[] = [];
  const response = new Response(new ReadableStream({ pull(controller) {
    if (index === bytes.length) controller.close();
    else controller.enqueue(bytes.slice(index, ++index));
  } }));
  assert.deepEqual(await readAnalysisStream(response, event => events.push(event)), analysis);
  assert.deepEqual(events.map(event => event.type), ["opening", "progress", "report", "result"]);
  assert.equal(events[0].type === "opening" && events[0].text, "先关注问题的范围。");
  assert.equal(events[2].type === "report" && events[2].analysis.report.title, "流式测试");
});

test("client detects truncated streams and cancels malformed or failed streams", async () => {
  const events: AnalysisEvent[] = [];
  await assert.rejects(readAnalysisStream(new Response(encoded({ type: "report", analysis })), event => events.push(event)), /连接中断/);
  assert.equal(events.length, 1);
  await assert.rejects(readAnalysisStream(new Response(encoded({ type: "result", analysis }).trimEnd()), () => {}), /未完整完成/);
  for (const data of ['data: not-json\n\n', 'data: {"type":"progress","stage":"secret"}\n\n', encoded({ type: "error", error: { code: "INTERNAL", message: "failed" } })]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); }, cancel() { cancelled = true; } }));
    await assert.rejects(readAnalysisStream(response, () => {}));
    assert.equal(cancelled, true);
  }
});

test("client resets paragraph ordering per attempt and ignores stale or post-confirmation blocks", async () => {
  const block = { presentation: "lead" as const, text: "已完成段落检查。", references: [] };
  const start = (attempt: 1 | 2): AnalysisEvent => ({ type: "report-start", attempt, sources: [] });
  const paragraph = (attempt: 1 | 2, index = 0): AnalysisEvent => ({ type: "report-block", attempt, index, block });
  const events: AnalysisEvent[] = [];
  await readAnalysisStream(new Response([
    start(1), paragraph(1), start(2), paragraph(1, 1), paragraph(2),
    { type: "report", analysis }, paragraph(2, 1), { type: "result", analysis },
  ].map(event => encoded(event as AnalysisEvent)).join("")), event => events.push(event));
  assert.deepEqual(events.map(event => event.type), ["report-start", "report-block", "report-start", "report-block", "report", "result"]);
  for (const invalid of [[paragraph(1)], [start(2)], [start(1), paragraph(1, 1)], [start(1), start(1)]]) {
    await assert.rejects(readAnalysisStream(new Response([...invalid, { type: "result", analysis } as AnalysisEvent].map(encoded).join("")), () => {}), /格式异常/);
  }
});
