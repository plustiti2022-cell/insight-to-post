import type { Analysis, SocialImageResult } from "../../core/contracts";
import { targetLength } from "../../core/social";
import {
  eligibleForGeneration,
  publicSources,
  reportCoverage,
} from "../../core/sources";
import { validateReport } from "../../core/evidence";
import { researchWithTavily } from "../services/research";
import { generateReport } from "../services/report";
import { generateSocialContent } from "../services/social";
import { signSocialSnapshot } from "../services/snapshot";
import { generateSocialImage } from "../services/image";
import type { Observer } from "../runtime";
import { edges, START, END } from "./edges";
import { nodes } from "./nodes";
import {
  initialState,
  type AnalysisDependencies,
  type AnalysisInput,
  type NodeId,
} from "./state";

// 唯一组装点：新增供应商只需要替换能力实现，不改节点和边。
export const analysisDependencies: AnalysisDependencies = {
  research: researchWithTavily,
  generateReport,
  validateReport,
  generateSocialContent,
  signSocialSnapshot,
};
export type { AnalysisDependencies } from "./state";

// 配图由用户独立触发；在此组装服务，与研究图共用取消边界。
export async function createSocialImage(
  text: string,
  signal?: AbortSignal,
  generate: (text: string, signal?: AbortSignal) => Promise<SocialImageResult> = generateSocialImage,
) {
  signal?.throwIfAborted();
  const result = await generate(text, signal);
  signal?.throwIfAborted();
  return result;
}

export async function runAnalysisGraph(
  input: AnalysisInput,
  deps: AnalysisDependencies = analysisDependencies,
): Promise<Analysis> {
  let state = initialState(input.idea);
  const context = { ...input, start: Date.now(), deps };
  let current: NodeId | typeof END = START;
  // 有限工作流；未来增加回边时，必须显式声明预算，避免意外无限调用。
  const visited = new Set<NodeId>();
  while (current !== END) {
    input.signal?.throwIfAborted();
    if (visited.has(current))
      throw new Error(`Workflow cycle without a budget: ${current}`);
    visited.add(current);
    state = { ...state, ...(await nodes[current](state, context)) };
    input.signal?.throwIfAborted();
    current = edges[current](state);
  }
  if (!state.social) throw new Error("Workflow ended without social content");
  const { draft, research, social } = state;
  const sources = eligibleForGeneration(research);
  const coverage = reportCoverage(draft, sources);
  return {
    status: "complete",
    report: {
      ...draft,
      title:
        input.idea.length > 150 ? `${input.idea.slice(0, 147)}…` : input.idea,
      generatedAt: new Date().toISOString(),
    },
    sources: publicSources(research.sources, draft),
    searchSteps: research.searchSteps ?? [],
    warnings: [...new Set([...state.warnings, ...research.warnings])],
    coverage,
    socialContent: social.socialContent,
    ...(coverage.requirementMet
      ? {
          socialRetryToken: deps.signSocialSnapshot(
            draft,
            sources,
            input.socialTargetLength,
          ),
        }
      : {}),
    diagnostics: {
      durationMs: Date.now() - context.start,
      searchCalls: research.searchCalls,
      extractorCalls: research.extractorCalls,
      modelCalls: state.modelCalls,
      totalTokens: state.totalTokens,
      sourceTypes: coverage.citedSourceTypes.length,
      tavilyCredits: research.credits,
      socialDurationMs: social.durationMs,
    },
  };
}

export function analyze(
  idea: string,
  signal?: AbortSignal,
  observe?: Observer,
  socialTargetLength = targetLength(Number(process.env.X_TARGET_LENGTH ?? 280)),
) {
  return runAnalysisGraph({ idea, signal, observe, socialTargetLength });
}
