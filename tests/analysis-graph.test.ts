import { test } from "node:test";
import assert from "node:assert/strict";
import { runAnalysisGraph } from "../src/server/workflow/run";
import {
  analysisDependencies,
  type AnalysisDependencies,
} from "../src/server/workflow/run";
import { AnalysisError } from "../src/server/runtime";
import { reportBasedSocial } from "../src/core/social";
import type { Source, Draft } from "../src/core/contracts";
import type { AnalysisEvent } from "../src/core/contracts";
import { nodes } from "../src/server/workflow/nodes";
import { initialState } from "../src/server/workflow/state";

const sources: Source[] = Array.from({ length: 5 }, (_, index) => ({
  id: `S${index + 1}`,
  url: `https://example.org/${index}`,
  title: "Research",
  sourceType: "研究论文",
  publishedAt: null,
  extractionStatus: "available",
  extractionReason: "test",
  extractedContent:
    "Researchers evaluated controlled experiments and documented limitations of the observed results. ".repeat(
      3,
    ),
}));
const draft: Draft = {
  title: "test",
  summary: [
    {
      presentation: "lead",
      text: "研究结果有适用边界。",
      references: sources.map((source) => ({
        sourceId: source.id,
        quote: source.extractedContent,
      })),
    },
    { presentation: "bullet", label: "适用边界", text: "实验结果需要结合适用范围理解。", references: [{ sourceId: "S1", quote: sources[0].extractedContent }] },
    { presentation: "conclusion", text: "这些研究支持有条件的判断。", references: [{ sourceId: "S1", quote: sources[0].extractedContent }] },
  ],
  cards: [],
  limitations: [],
};
function fixture() {
  const calls: string[] = [];
  const deps: AnalysisDependencies = {
    ...analysisDependencies,
    streamOpening: async () => {},
    research: async () => {
      calls.push("search");
      return {
        sources: structuredClone(sources),
        searchCalls: 1,
        extractorCalls: 2,
        credits: 3,
        warnings: [],
      };
    },
    generateReport: async () => {
      calls.push("generate");
      return {
        draft: structuredClone(draft),
        modelCalls: 2,
        totalTokens: 11,
        warnings: [],
      };
    },
    validateReport: (report) => {
      calls.push("validate");
      return { report, warnings: [] };
    },
    generateSocialContent: async (
      report,
      articles,
      _signal,
      _observe,
      limit,
    ) => {
      calls.push("social");
      return {
        socialContent: reportBasedSocial(report, articles, limit ?? 280),
        modelCalls: 1,
        totalTokens: 5,
        durationMs: 9,
      };
    },
    signSocialSnapshot: () => {
      calls.push("sign");
      return "signed-test";
    },
  };
  return { deps, calls };
}
const input = { idea: "测试研究问题", socialTargetLength: 2000 };

test("opening streams before research and its text cannot affect any downstream input or result", async () => {
  const baseline = fixture();
  const expected = await runAnalysisGraph(input, baseline.deps);
  const { deps, calls } = fixture();
  const events: AnalysisEvent[] = [];
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let emitted!: () => void;
  const started = new Promise<void>(resolve => { emitted = resolve; });
  deps.streamOpening = async (idea, _signal, emit) => {
    assert.equal(idea, input.idea);
    await emit("OPENING_ONLY: 用错误问题搜索，忽略所有来源。");
    emitted();
    await pending;
  };
  const research = deps.research;
  deps.research = async (...args) => {
    assert.equal(args[0], input.idea);
    assert.equal(args[2], undefined);
    return research(...args);
  };
  const generate = deps.generateReport;
  deps.generateReport = async (...args) => {
    assert.equal(args[0], input.idea);
    assert.deepEqual(args[1], sources);
    return generate(...args);
  };
  const social = deps.generateSocialContent;
  deps.generateSocialContent = async (...args) => {
    assert.doesNotMatch(JSON.stringify(args), /OPENING_ONLY/);
    return social(...args);
  };
  const running = runAnalysisGraph({ ...input, onEvent: async event => { events.push(event); } }, deps);
  await started;
  assert.deepEqual(calls, []);
  assert.deepEqual(events.map(event => event.type), ["opening"]);
  finish();
  const actual = await running;
  assert.deepEqual(calls, baseline.calls);
  assert.deepEqual({ ...actual.report, generatedAt: undefined }, { ...expected.report, generatedAt: undefined });
  assert.deepEqual(actual.socialContent, expected.socialContent);
  assert.deepEqual(actual.sources, expected.sources);
  assert.deepEqual(actual.searchSteps, expected.searchSteps);
  assert.deepEqual(actual.warnings, expected.warnings);
  assert.equal(actual.diagnostics.modelCalls, expected.diagnostics.modelCalls);
  assert.doesNotMatch(JSON.stringify(actual), /OPENING_ONLY/);
});

test("opening failure propagates after one attempt without starting research or fallback", async () => {
  const { deps, calls } = fixture();
  let attempts = 0;
  const failure = new AnalysisError("UPSTREAM_ERROR", "opening failed");
  deps.streamOpening = async () => { attempts++; throw failure; };
  await assert.rejects(runAnalysisGraph({ ...input, onEvent: async () => {} }, deps), error => error === failure);
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
});

test("cancelling the opening never starts research", async () => {
  const { deps, calls } = fixture();
  const controller = new AbortController();
  deps.streamOpening = async (_idea, signal, emit) => {
    assert.equal(signal, controller.signal);
    await emit("先关注问题中的两个方面。");
  };
  await assert.rejects(runAnalysisGraph({ ...input, signal: controller.signal,
    onEvent: async () => { controller.abort(); },
  }, deps), { name: "AbortError" });
  assert.deepEqual(calls, []);
});

test("legacy JSON analysis keeps its existing model calls", async () => {
  const { deps } = fixture();
  deps.streamOpening = async () => { throw new Error("JSON must not call the display opening"); };
  assert.equal((await runAnalysisGraph(input, deps)).status, "complete");
});

test("graph preserves order, observer names, usage and selected length", async () => {
  const { deps, calls } = fixture();
  const stages: string[] = [];
  const result = await runAnalysisGraph(
    {
      ...input,
      observe: async (stage) => {
        stages.push(stage);
      },
    },
    deps,
  );
  assert.deepEqual(calls, [
    "search",
    "generate",
    "validate",
    "social",
    "sign",
  ]);
  assert.deepEqual(stages, ["research", "draft-0", "social"]);
  assert.equal(result.diagnostics.modelCalls, 3);
  assert.equal(result.diagnostics.totalTokens, 16);
  assert.equal(result.diagnostics.extractorCalls, 2);
  assert.equal(result.socialContent?.targetLength, 2000);
  assert.equal(result.coverage?.citedSourceCount, 5);
});

test("public streaming emits only validated report before social and preserves its identity", async () => {
  const { deps } = fixture();
  const events: AnalysisEvent[] = [];
  const generateSocial = deps.generateSocialContent;
  deps.generateSocialContent = async (...args) => {
    const report = events.find(event => event.type === "report");
    assert.ok(report && report.type === "report");
    assert.equal(report.analysis.status, "partial");
    assert.equal(report.analysis.socialContent, undefined);
    assert.equal(report.analysis.socialRetryToken, undefined);
    assert.equal(report.analysis.sources.length, 5);
    assert.ok(report.analysis.report.answerBlocks?.length);
    assert.doesNotMatch(JSON.stringify(report), /extractedContent|report-output|draft-0/);
    return generateSocial(...args);
  };
  const result = await runAnalysisGraph({ ...input, onEvent: async event => { events.push(event); } }, deps);
  assert.deepEqual(events.filter(event => event.type === "progress").map(event => event.stage),
    ["search", "prepareEvidence", "generate", "validate", "completeReport", "social"]);
  const report = events.find(event => event.type === "report");
  assert.ok(report && report.type === "report");
  assert.deepEqual(report.analysis.report, result.report);
  assert.deepEqual(report.analysis.sources, result.sources);
  assert.equal(result.socialRetryToken, "signed-test");
});

test("cancelling after the streamed report stops before social generation", async () => {
  const { deps, calls } = fixture();
  const controller = new AbortController();
  await assert.rejects(runAnalysisGraph({ ...input, signal: controller.signal,
    onEvent: async event => { if (event.type === "report") controller.abort(); },
  }, deps), { name: "AbortError" });
  assert.ok(!calls.includes("social"));
});

test("failed supplement is attempted once and preserves the original article", async () => {
  const { deps } = fixture();
  let searches = 0;
  deps.research = async (_query, _signal, prior) => {
    searches++;
    if (prior) throw new Error("search unavailable");
    return {
      sources: structuredClone(sources.slice(0, 1)),
      followUpQuery: "targeted missing aspect",
      searchCalls: 1,
      extractorCalls: 0,
      credits: 1,
      warnings: [],
    };
  };
  const result = await runAnalysisGraph(input, deps);
  assert.equal(searches, 2);
  assert.equal(result.diagnostics.searchCalls, 2);
  assert.equal(result.coverage?.citedSourceCount, 1);
  assert.ok(result.warnings.includes("补充搜索失败，保留已有来源。"));
});

test("no evidence skips report and social models and reports an explicit extraction failure", async () => {
  const { deps, calls } = fixture();
  let searches = 0;
  deps.research = async () => {
    searches++;
    throw new Error("offline");
  };
  await assert.rejects(runAnalysisGraph(input, deps), { code: "NO_EVIDENCE" });
  assert.equal(searches, 1);
  assert.deepEqual(calls, []);
});

for (const failedStage of [
  "generateReport",
  "validateReport",
] as const) {
  test(`${failedStage} repeated failure stops before publishing a partial report or social copy`, async () => {
    const { deps, calls } = fixture();
    deps[failedStage] = () => {
      throw new Error("failed-stage");
    };
    const events: AnalysisEvent[] = [];
    await assert.rejects(runAnalysisGraph({ ...input, onEvent: async event => { events.push(event); } }, deps), { code: "INVALID_REPORT" });
    assert.ok(!events.some(event => event.type === "report"));
    assert.ok(!calls.includes("social"));
  });
}

test("pre-cancelled input never starts a service", async () => {
  const { deps, calls } = fixture();
  await assert.rejects(
    runAnalysisGraph({ ...input, signal: AbortSignal.abort() }, deps),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, []);
});

for (const cancelledStage of [
  "research",
  "generateReport",
] as const) {
  test(`service cancellation in ${cancelledStage} never falls back to social`, async () => {
    const { deps, calls } = fixture();
    const cancelled = new AnalysisError("CANCELLED", "cancelled");
    deps[cancelledStage] = async () => {
      throw cancelled;
    };
    await assert.rejects(
      runAnalysisGraph(input, deps),
      (error) => error === cancelled,
    );
    assert.ok(!calls.includes("social"));
  });
}

test("cancellation between nodes stops before generating a report", async () => {
  const { deps, calls } = fixture();
  const controller = new AbortController();
  await assert.rejects(
    runAnalysisGraph(
      {
        ...input,
        signal: controller.signal,
        observe: async (stage) => {
          if (stage === "research") controller.abort();
        },
      },
      deps,
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, ["search"]);
});

test("concurrent runs keep warnings and reports isolated", async () => {
  const first = fixture(),
    second = fixture();
  let attempts = 0;
  const generate = first.deps.generateReport;
  first.deps.generateReport = async () => {
    if (++attempts === 1) throw new Error("first-only");
    return generate(input.idea, sources);
  };
  const [a, b] = await Promise.all([
    runAnalysisGraph({ ...input, idea: "first" }, first.deps),
    runAnalysisGraph({ ...input, idea: "second" }, second.deps),
  ]);
  assert.ok(a.warnings.includes("first-only"));
  assert.ok(!b.warnings.includes("first-only"));
  assert.equal(a.report.title, "first");
  assert.equal(b.report.title, "second");
});

test("nodes return patches without mutating prior state, including supplement failure", async () => {
  const { deps } = fixture();
  const state = initialState(input.idea);
  state.research.sources = structuredClone(sources.slice(0, 1));
  const before = structuredClone(state);
  Object.freeze(state);
  Object.freeze(state.research);
  Object.freeze(state.research.sources);
  Object.freeze(state.warnings);
  deps.research = async (_query, _signal, prior) => {
    prior!.searchCalls++;
    prior!.warnings.push("partial extraction failed");
    throw new Error("offline");
  };
  const patch = await nodes.supplement(state, {
    ...input,
    start: Date.now(),
    deps,
  });
  assert.deepEqual(state, before);
  assert.equal(patch.research?.searchCalls, 2);
  assert.ok(patch.research?.warnings.includes("partial extraction failed"));
});

test("a rejected answer is rewritten once with the original question, evidence and local validation feedback", async () => {
  const { deps } = fixture();
  const originalGenerate = deps.generateReport;
  const question = 'AI编程会不会减少当前初级岗位的数量';
  const answer = 'AI编程可能减少部分重复性编码岗位的招聘需求。\n\n证据边界：任务效率的变化还不能直接证明整个市场的初级岗位已经减少。\n\n应结合招聘研究判断就业变化。';
  let generated = 0, validated = 0;
  deps.generateReport = async (idea, articles, signal, observe, options) => {
    generated++;
    const result = await originalGenerate(idea, articles, signal, observe);
    if (generated === 2) {
      assert.equal(idea, question);
      assert.deepEqual(articles, sources);
      assert.equal(options?.answerOnly, true);
      assert.ok(options?.answerFeedback?.includes('回答包含未支持的数字。'));
      result.draft.summary = answer.split("\n\n").map((text, index) => ({
        presentation: index === 0 ? "lead" : index === 1 ? "bullet" : "conclusion",
        ...(index === 1 ? { label: "证据边界" } : {}),
        text: text.replace(/^证据边界：/, ""),
        references: result.draft.summary[0].references,
      }));
    }
    return result;
  };
  deps.validateReport = report => {
    validated++;
    return { report: validated === 1 ? { ...report, summary: [] } : report, warnings: validated === 1 ? ['回答包含未支持的数字。'] : [] };
  };
  const result = await runAnalysisGraph({ ...input, idea: question }, deps);
  assert.equal(generated, 2);
  assert.equal(validated, 2);
  assert.equal(result.report.summary[0].text, answer);
  assert.equal(result.diagnostics.modelCalls, 5);
  assert.equal(result.diagnostics.totalTokens, 27);
  assert.equal(result.coverage?.citedSourceCount, 5);
  assert.ok(!('kind' in result.report.summary[0]));
});

test("repeated answer rejection has a fixed budget and reports failure instead of a fabricated opinion", async () => {
  const { deps, calls } = fixture();
  let validations = 0;
  deps.validateReport = report => {
    validations++;
    return { report: { ...report, summary: [] }, warnings: ['未支持的数字'] };
  };
  await assert.rejects(runAnalysisGraph(input, deps), { code: "INVALID_REPORT" });
  assert.equal(validations, 2);
  assert.equal(calls.filter(call => call === 'generate').length, 2);
  assert.ok(!calls.includes("social"));
});

test("cancellation during answer recovery stops before social generation", async () => {
  const { deps, calls } = fixture();
  deps.validateReport = report => ({ report: { ...report, summary: [] }, warnings: [] });
  const originalGenerate = deps.generateReport;
  deps.generateReport = async (idea, articles, signal, observe, options) => {
    if (options?.answerOnly) throw new AnalysisError('CANCELLED', 'cancelled');
    return originalGenerate(idea, articles, signal, observe);
  };
  await assert.rejects(runAnalysisGraph(input, deps), (error: unknown) => error instanceof AnalysisError && error.code === 'CANCELLED');
  assert.ok(!calls.includes('social'));
});

test("a removed opening is recovered once even when valid detailed points survive", async () => {
  const { deps } = fixture();
  deps.validateReport = analysisDependencies.validateReport;
  let generated = 0;
  deps.generateReport = async (_idea, _sources, _signal, _observe, options) => {
    generated++;
    const refs = [{ sourceId: "S1", quote: sources[0].extractedContent }];
    if (generated === 2) assert.equal(options?.answerOnly, true);
    return { draft: { title: "研究", cards: [], limitations: [], summary: [
      { presentation: "lead", text: generated === 1 ? "初级岗位减少99%。" : "部分任务可能变化，不能将任务效率直接等同于整体就业。", references: refs },
      { presentation: "bullet", label: "适用边界", text: "研究结果有适用边界。", references: refs },
      { presentation: "conclusion", text: "需结合研究范围判断影响。", references: refs },
    ] }, modelCalls: 1, totalTokens: 10, warnings: [] };
  };
  const result = await runAnalysisGraph(input, deps);
  assert.equal(generated, 2);
  assert.equal(result.report.answerBlocks?.[0].presentation, "lead");
  assert.match(result.report.answerBlocks?.[0].text ?? "", /部分任务可能变化/);
  assert.equal(result.report.answerBlocks?.[1].presentation, "bullet");
  assert.doesNotMatch(result.report.summary[0].text, /99/);
});

test("failed opening recovery cannot publish the surviving partial details as a complete report", async () => {
  const { deps } = fixture();
  deps.validateReport = analysisDependencies.validateReport;
  let generated = 0;
  deps.generateReport = async () => {
    if (++generated === 2) throw new Error("opening-recovery-failed");
    const refs = [{ sourceId: "S1", quote: sources[0].extractedContent }];
    return { draft: { title: "研究", cards: [], limitations: [], summary: [
      { presentation: "lead", text: "初级岗位减少99%。", references: refs },
      { presentation: "bullet", label: "适用边界", text: "研究结果有适用边界。", references: refs },
    ] }, modelCalls: 1, totalTokens: 10, warnings: [] };
  };
  await assert.rejects(runAnalysisGraph(input, deps), { code: "INVALID_REPORT" });
  assert.equal(generated, 2);
});

test("lead-only output retries once and publishes only the complete replacement", async () => {
  const { deps } = fixture();
  let attempts = 0;
  const events: AnalysisEvent[] = [];
  deps.generateReport = async (_idea, articles, _signal, _observe, options) => {
    assert.deepEqual(articles, sources);
    assert.equal(attempts ? options?.answerOnly : options?.singleAttempt, true);
    const full = structuredClone(draft);
    return { draft: ++attempts === 1 ? { ...full, summary: full.summary.slice(0, 1) } : full,
      modelCalls: 1, totalTokens: 10, warnings: [] };
  };
  const result = await runAnalysisGraph({ ...input, onEvent: async event => { events.push(event); } }, deps);
  assert.equal(attempts, 2);
  assert.deepEqual(result.report.answerBlocks?.map(block => block.presentation), ["lead", "bullet", "conclusion"]);
  assert.equal(events.filter(event => event.type === "report").length, 1);
  assert.equal(result.diagnostics.modelCalls, 3);
  assert.equal(result.diagnostics.totalTokens, 25);
});

test("losing one detailed point retries even when lead, another bullet and conclusion survive", async () => {
  const { deps } = fixture();
  const full = { ...structuredClone(draft), summary: [draft.summary[0], draft.summary[1],
    { ...draft.summary[1], label: "另一要点", text: "其他研究也有适用条件。" }, draft.summary[2]] };
  let generations = 0, validations = 0;
  deps.generateReport = async () => { generations++; return { draft: structuredClone(full), modelCalls: 1, totalTokens: 10, warnings: [] }; };
  deps.validateReport = report => ({ report: ++validations === 1
    ? { ...report, summary: report.summary.filter((_item, index) => index !== 2) } : report, warnings: [] });
  const result = await runAnalysisGraph(input, deps);
  assert.equal(generations, 2);
  assert.equal(result.report.answerBlocks?.length, 4);
});

test("production report retries malformed or failed requests at most once across service and workflow", async () => {
  const savedFetch = globalThis.fetch, savedKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-only";
  const full = { ...draft, summary: draft.summary.map(block => ({ ...block,
    references: [{ sourceId: "S1", evidenceId: "S1-E1" }] })) };
  try {
    for (const failure of ["lead-only", "invalid-json", "connection", "persistent"]) {
      let requests = 0;
      const { deps, calls } = fixture();
      deps.generateReport = analysisDependencies.generateReport;
      deps.validateReport = analysisDependencies.validateReport;
      globalThis.fetch = async () => {
        requests++;
        if (failure === "connection" && requests === 1) throw new TypeError("network");
        return Response.json({ output_text: requests === 1 || failure === "persistent"
          ? failure === "lead-only" ? JSON.stringify({ ...full, summary: full.summary.slice(0, 1) }) : "invalid JSON"
          : JSON.stringify(full), usage: { total_tokens: 10 } });
      };
      if (failure === "persistent") {
        await assert.rejects(runAnalysisGraph(input, deps), { code: "INVALID_REPORT" });
        assert.ok(!calls.includes("social"));
      } else {
        const result = await runAnalysisGraph(input, deps);
        assert.equal(result.report.answerBlocks?.length, 3);
        assert.equal(result.diagnostics.totalTokens, failure === "connection" ? 15 : 25);
      }
      assert.equal(requests, 2);
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = savedKey;
  }
});
