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
import { streamOpening } from "../services/opening";
import type { Observer } from "../runtime";
import { createLogger } from "../logger";
import { edges, START, END } from "./edges";
import { nodes } from "./nodes";
import {
  initialState,
  type AnalysisDependencies,
  type AnalysisInput,
  type NodeId,
  type WorkflowState,
} from "./state";

// 唯一组装点：新增供应商只需要替换能力实现，不改节点和边。
export const analysisDependencies: AnalysisDependencies = {
  streamOpening,
  research: researchWithTavily,
  generateReport,
  validateReport,
  generateSocialContent,
  signSocialSnapshot,
};
export type { AnalysisDependencies } from "./state";
const logger = createLogger("workflow");

// 配图由用户独立触发；在此组装服务，与研究图共用取消边界。
export async function createSocialImage(
  text: string,
  signal?: AbortSignal,
  generate: (text: string, signal?: AbortSignal) => Promise<SocialImageResult> = generateSocialImage,
) {
  return logger.run("socialImage", { textLength: text.length }, async () => {
    signal?.throwIfAborted();
    const result = await generate(text, signal);
    signal?.throwIfAborted();
    return result;
  }, signal);
}

export async function runAnalysisGraph(
  input: AnalysisInput,
  deps: AnalysisDependencies = analysisDependencies,
): Promise<Analysis> {
  return logger.run("analysis", { ideaLength: input.idea.length, targetLength: input.socialTargetLength }, async () => {
    const context = { ...input, start: Date.now(), deps };
    input.signal?.throwIfAborted();
    // 开场仅为流式展示。结束后丢弃，原图始终只接收原始问题。
    if (input.onEvent) {
      await deps.streamOpening(input.idea, input.signal, async text => {
        input.signal?.throwIfAborted();
        await input.onEvent!({ type: "opening", text });
      });
      input.signal?.throwIfAborted();
    }
    let state = initialState(input.idea, input.validateCoreContent);
    const generatedAt = new Date().toISOString();
    let current: NodeId | typeof END = START;
    // 有限工作流；未来增加回边时，必须显式声明预算，避免意外无限调用。
    const visited = new Set<NodeId>();
    while (current !== END) {
      input.signal?.throwIfAborted();
      if (visited.has(current))
        throw new Error(`Workflow cycle without a budget: ${current}`);
      visited.add(current);
      const node: NodeId = current;
      await input.onEvent?.({ type: "progress", stage: node });
      if (node === "generate" || node === "recoverAnswer") {
        await input.onEvent?.({ type: "report-start", attempt: node === "generate" ? 1 : 2,
          coreValidation: state.validateCoreContent,
          sources: publicSources(eligibleForGeneration(state.research), { ...state.draft, summary: [], cards: [] }),
        });
      }
      input.signal?.throwIfAborted();
      current = await logger.run("node", { node }, async () => {
        state = { ...state, ...(await nodes[node](state, context)) };
        input.signal?.throwIfAborted();
        if (node === "completeReport") {
          await input.onEvent?.({
            type: "report",
            analysis: publicAnalysis(state, input, context.start, generatedAt, deps),
          });
          input.signal?.throwIfAborted();
        }
        const nextNode = edges[node](state);
        logger.info("node.transition", {
          node, nextNode, sourceCount: state.research.sources.length,
          summaryCount: state.draft.summary.length, reportFailed: state.reportFailed,
          warningCount: state.warnings.length + state.research.warnings.length,
          modelCalls: state.modelCalls, totalTokens: state.totalTokens,
        });
        return nextNode;
      }, input.signal);
    }
    if (!state.social) throw new Error("Workflow ended without social content");
    return publicAnalysis(state, input, context.start, generatedAt, deps);
  }, input.signal);
}

function publicAnalysis(
  state: WorkflowState,
  input: AnalysisInput,
  start: number,
  generatedAt: string,
  deps: AnalysisDependencies,
): Analysis {
  const { draft, research, social } = state;
  const sources = eligibleForGeneration(research);
  const coverage = reportCoverage(draft, sources);
  return {
    coreValidation: state.validateCoreContent,
    status: social?.socialContent.status === "ready" ? "complete" : "partial",
    report: {
      ...draft,
      title:
        input.idea.length > 150 ? `${input.idea.slice(0, 147)}…` : input.idea,
      generatedAt,
    },
    sources: publicSources(research.sources, draft),
    searchSteps: research.searchSteps ?? [],
    warnings: [...new Set([...state.warnings, ...research.warnings])],
    coverage,
    socialContent: social?.socialContent,
    ...(social && coverage.requirementMet
      ? {
          socialRetryToken: deps.signSocialSnapshot(
            draft,
            sources,
            input.socialTargetLength,
          ),
        }
      : {}),
    diagnostics: {
      durationMs: Date.now() - start,
      searchCalls: research.searchCalls,
      extractorCalls: research.extractorCalls,
      modelCalls: state.modelCalls,
      totalTokens: state.totalTokens,
      sourceTypes: coverage.citedSourceTypes.length,
      tavilyCredits: research.credits,
      socialDurationMs: social?.durationMs,
    },
  };
}

export function analyze(
  idea: string,
  signal?: AbortSignal,
  observe?: Observer,
  socialTargetLength = targetLength(Number(process.env.X_TARGET_LENGTH ?? 280)),
  onEvent?: AnalysisInput["onEvent"],
) {
  // 此实验分支默认关闭核心校验；只有显式设为 true 才恢复严格模式。
  return runAnalysisGraph({ idea, signal, observe, socialTargetLength, onEvent,
    validateCoreContent: process.env.REPORT_CORE_VALIDATION === "true",
  });
}
