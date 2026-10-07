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
      text: "研究结果有适用边界。",
      references: sources.map((source) => ({
        sourceId: source.id,
        quote: source.extractedContent,
      })),
    },
  ],
  cards: [],
  limitations: [],
};
function fixture() {
  const calls: string[] = [];
  const deps: AnalysisDependencies = {
    ...analysisDependencies,
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

test("no evidence skips report models and still returns honest fallback outputs", async () => {
  const { deps, calls } = fixture();
  let searches = 0;
  deps.research = async () => {
    searches++;
    throw new Error("offline");
  };
  const result = await runAnalysisGraph(input, deps);
  assert.equal(searches, 1);
  assert.deepEqual(calls, ["social", "sign"]);
  assert.match(result.report.summary[0].text, /未取得/);
  // 保留现有规则：空来源集合也满足“全部文章已引用”，仍提供重生成快照。
  assert.equal(result.socialRetryToken, "signed-test");
});

for (const failedStage of [
  "generateReport",
  "validateReport",
] as const) {
  test(`${failedStage} failure still covers every article without incomplete claims`, async () => {
    const { deps, calls } = fixture();
    deps[failedStage] = () => {
      throw new Error("failed-stage");
    };
    const result = await runAnalysisGraph(input, deps);
    assert.ok(result.warnings.includes("failed-stage"));
    assert.equal(result.coverage?.citedSourceCount, 5);
    assert.ok(
      !result.report.summary.some((item) =>
        item.text.includes("研究结果有适用边界"),
      ),
    );
    assert.ok(calls.includes("social"));
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
  first.deps.generateReport = async () => {
    throw new Error("first-only");
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
  const answer = 'AI编程可能减少部分重复性编码岗位的招聘需求。\n\n但任务效率的变化还不能直接证明整个市场的初级岗位已经减少。';
  let generated = 0, validated = 0;
  deps.generateReport = async (idea, articles, signal, observe, options) => {
    generated++;
    const result = await originalGenerate(idea, articles, signal, observe);
    if (generated === 2) {
      assert.equal(idea, question);
      assert.deepEqual(articles, sources);
      assert.equal(options?.answerOnly, true);
      assert.ok(options?.answerFeedback?.includes('回答包含未支持的数字。'));
      result.draft.summary[0].text = answer;
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
  const result = await runAnalysisGraph(input, deps);
  assert.equal(validations, 2);
  assert.equal(calls.filter(call => call === 'generate').length, 2);
  assert.match(result.report.summary[0].text, /未能完成.*请重新分析/);
  assert.doesNotMatch(result.report.summary[0].text, /我更倾向于|评价标准|人来承担/);
  assert.equal(result.coverage?.citedSourceCount, 5);
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
