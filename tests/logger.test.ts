import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/server/logger";
import { AnalysisError } from "../src/server/runtime";
import { analysisDependencies, createSocialImage, runAnalysisGraph } from "../src/server/workflow/run";
import { generateSocialContent } from "../src/server/services/social";
import type { Source } from "../src/core/contracts";

type Entry = Record<string, string | number | boolean>;
async function capture(action: (entries: Entry[]) => Promise<void>) {
  const saved = { info: console.info, warn: console.warn, error: console.error };
  const entries: Entry[] = [];
  for (const level of ["info", "warn", "error"] as const)
    console[level] = (line: string) => entries.push(JSON.parse(line));
  try { await action(entries); } finally { Object.assign(console, saved); }
}

test("concurrent operations isolate run IDs while nested async logs retain their parent ID", async () => capture(async (entries) => {
  const logger = createLogger("test");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await Promise.all([
    logger.run("first", {}, async () => {
      await gate;
      await logger.run("nested", {}, async () => { await Promise.resolve(); logger.info("inside"); });
    }),
    logger.run("second", {}, async () => { release(); await Promise.resolve(); }),
  ]);
  const first = entries.find((entry) => entry.event === "first.started")!;
  const second = entries.find((entry) => entry.event === "second.started")!;
  assert.notEqual(first.runId, second.runId);
  for (const entry of entries.filter((entry) => !String(entry.event).startsWith("second"))) {
    assert.equal(entry.runId, first.runId);
    assert.ok(Number.isFinite(Date.parse(String(entry.timestamp))));
  }
  assert.equal(typeof entries.find((entry) => entry.event === "first.completed")?.durationMs, "number");
}));

test("failures and cancellation retain the thrown error and never log raw error contents", async () => capture(async (entries) => {
  const logger = createLogger("test");
  const known = new AnalysisError("AUTH_FAILED", "secret-key prompt body");
  const unknown = new Error("secret-key upstream response");
  const cancelled = new DOMException("secret-key cancellation", "AbortError");
  for (const [event, error] of [["known", known], ["unknown", unknown], ["cancel", cancelled]] as const)
    await assert.rejects(logger.run(event, {}, () => { throw error; }), (thrown) => thrown === error);
  assert.equal(entries.find((entry) => entry.event === "known.failed")?.errorCode, "AUTH_FAILED");
  assert.equal(entries.find((entry) => entry.event === "unknown.failed")?.errorCode, "UNKNOWN");
  assert.equal(entries.find((entry) => entry.event === "cancel.cancelled")?.level, "info");
  assert.ok(!JSON.stringify(entries).includes("secret-key"));
  assert.equal(entries.filter((entry) => String(entry.event).endsWith("completed")).length, 0);
}));

test("production services log all visited nodes, recovery, social replay and image retry without content or credentials", async () => capture(async (entries) => {
  const savedFetch = globalThis.fetch;
  const names = ["QWEN_API_KEY", "TAVILY_API_KEY", "MINIMAX_API_KEY"];
  const savedKeys = names.map((name) => process.env[name]);
  names.forEach((name) => { process.env[name] = "private-test-credential"; });
  const body = "PRIVATE_ARTICLE_BODY Researchers documented limitations and the scope of the findings. ".repeat(3);
  const text = "研究结果有适用边界。";
  const rawReport = { title: "test", summary: [
    { presentation: "lead", text, references: [{ sourceId: "S1", evidenceId: "S1-E1" }] },
    { presentation: "bullet", label: "边界", text: "实验结果有适用条件。", references: [{ sourceId: "S1", evidenceId: "S1-E1" }] },
    { presentation: "conclusion", text: "应结合条件理解结果。", references: [{ sourceId: "S1", evidenceId: "S1-E1" }] },
  ], cards: [], limitations: [] };
  const rawSocial = { paragraphs: [
    { text: "这些变化值得关注。", claimIds: [] },
    { text, claimIds: ["summary-1"] },
    { text: "人的判断仍然重要。", claimIds: [] },
  ] };
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
  let imageCalls = 0;
  globalThis.fetch = async (url, init) => {
    const input = JSON.parse(String(init?.body));
    if (String(url).endsWith("/image_generation")) {
      if (++imageCalls === 1) return new Response("private-test-credential", { status: 503 });
      return Response.json({ base_resp: { status_code: 0 }, data: { image_base64: [png] } });
    }
    if (String(url).endsWith("/search")) return Response.json({ results: [{ url: "https://example.org/research" }] });
    if (String(url).endsWith("/extract")) return Response.json({ results: [{ url: "https://example.org/research", raw_content: body }] });
    const prompt = String(input.input);
    const output = prompt.startsWith("你是检索规划") ? { query: "research evidence limitations" }
      : prompt.startsWith("你是检索评估") ? { followUpQuery: "additional research scope" }
      : prompt.startsWith("你是中文社交媒体作者") ? rawSocial : rawReport;
    return Response.json({ output_text: JSON.stringify(output), usage: { total_tokens: 7 } });
  };
  try {
    let validations = 0;
    let replaySources: Source[] = [];
    const result = await runAnalysisGraph({ idea: "PRIVATE_USER_QUESTION", socialTargetLength: 2000 }, {
      ...analysisDependencies,
    generateDataPosters: async () => ({ dataPosters: { status: "complete", items: [] }, modelCalls: 0, totalTokens: 0, durationMs: 0 }),
      validateReport: (draft) => ({ report: ++validations === 1 ? { ...draft, summary: [] } : draft, warnings: [] }),
      generateSocialContent: async (...args) => { replaySources = args[1]; return generateSocialContent(...args); },
      signSocialSnapshot: () => "PRIVATE_SIGNED_TOKEN",
    });
    assert.equal(result.socialContent?.status, "ready");
    const starts = entries.filter((entry) => entry.event === "node.started");
    assert.deepEqual(starts.map((entry) => entry.node), ["search", "supplement", "prepareEvidence", "generate", "validate", "recoverAnswer", "completeReport", "social"]);
    for (const node of starts.map((entry) => entry.node)) {
      assert.ok(entries.some((entry) => entry.event === "node.completed" && entry.node === node));
      assert.ok(entries.some((entry) => entry.event === "node.transition" && entry.node === node));
    }
    const analysisId = entries[0].runId;
    assert.ok(entries.every((entry) => entry.runId === analysisId));
    for (const scope of ["research", "report", "social"])
      assert.ok(entries.some((entry) => entry.scope === scope && String(entry.event).endsWith("completed")));
    assert.ok(entries.some(entry => entry.scope === "social" && entry.event === "content.decoded" && entry.validation === false));
    assert.ok(!entries.some(entry => entry.scope === "social" && /validation|fallback/.test(String(entry.event))));
    const replayStart = entries.length;
    const replay = await generateSocialContent(result.report, replaySources, undefined, undefined, 2000, { originalPrompt: "你是中文社交媒体作者 PRIVATE_ORIGINAL_PROMPT" });
    assert.equal(replay.socialContent.status, "ready");
    assert.notEqual(entries[replayStart].runId, analysisId);
    assert.equal(entries[replayStart].replay, true);
    const imageStart = entries.length;
    await createSocialImage("PRIVATE_SOCIAL_TEXT");
    const imageEntries = entries.slice(imageStart);
    assert.ok(imageEntries.every((entry) => entry.runId === imageEntries[0].runId));
    assert.notEqual(imageEntries[0].runId, analysisId);
    assert.ok(imageEntries.some((entry) => entry.scope === "image" && entry.event === "model.failed" && entry.willRetry === true));
    assert.ok(imageEntries.some((entry) => entry.scope === "image" && entry.event === "model.completed" && entry.attempt === 2));
    for (const secret of ["private-test-credential", "PRIVATE_", png, text]) assert.ok(!JSON.stringify(entries).includes(secret));
  } finally {
    globalThis.fetch = savedFetch;
    names.forEach((name, index) => {
      if (savedKeys[index] === undefined) delete process.env[name]; else process.env[name] = savedKeys[index];
    });
  }
}));

test("cancelled workflow nodes log cancellation without a transition or fallback", async () => capture(async (entries) => {
  const controller = new AbortController();
  const error = new AnalysisError("CANCELLED", "cancelled");
  await assert.rejects(runAnalysisGraph({ idea: "测试取消", socialTargetLength: 280, signal: controller.signal }, {
    ...analysisDependencies,
    generateDataPosters: async () => ({ dataPosters: { status: "complete", items: [] }, modelCalls: 0, totalTokens: 0, durationMs: 0 }),
    research: async () => { controller.abort(); throw error; },
  }), (thrown) => thrown === error);
  assert.ok(entries.some((entry) => entry.event === "node.cancelled" && entry.node === "search"));
  assert.ok(entries.some((entry) => entry.event === "analysis.cancelled"));
  assert.ok(!entries.some((entry) => entry.event === "node.transition" || String(entry.event).includes("fallback")));
}));
