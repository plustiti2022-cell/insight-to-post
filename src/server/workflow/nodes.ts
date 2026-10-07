import { AnalysisError, rethrowCancellation } from "../runtime";
import {
  countCoverage,
  eligibleForGeneration,
} from "../../core/sources";
import { completeReport } from "../../core/report";
import { emptyDraft, type Node, type NodeId } from "./state";

// 同一流程中的短节点集中管理；每个节点返回更新，只有执行器合并状态。
function reportNode(node: Node, attemptedCalls = 0): Node {
  return async (state, context) => {
    const counted = { ...state, modelCalls: state.modelCalls + attemptedCalls };
    try {
      return {
        modelCalls: counted.modelCalls,
        ...(await node(counted, context)),
      };
    } catch (error) {
      rethrowCancellation(error, context.signal);
      return {
        modelCalls: counted.modelCalls,
        draft: emptyDraft(context.idea),
        reportFailed: true,
        warnings: [
          ...state.warnings,
          error instanceof Error
            ? error.message
            : "本次回答未能完成，请重新分析。",
        ],
      };
    }
  };
}

export const nodes: Record<NodeId, Node> = {
  async search(state, { idea, signal, deps }) {
    try {
      const research = await deps.research(idea, signal);
      return {
        research,
        modelCalls: state.modelCalls + (research.modelCalls ?? 0),
        totalTokens: state.totalTokens + (research.totalTokens ?? 0),
      };
    } catch (error) {
      rethrowCancellation(error, signal);
      return {
        research: {
          sources: [],
          searchCalls: 1,
          extractorCalls: 0,
          credits: 0,
          warnings: [
            error instanceof Error ? error.message : "本次检索请求未完成。",
          ],
        },
      };
    }
  },
  async supplement(state, { idea, signal, deps }) {
    // 即使被注入的服务会修改输入，也不能隐式更改上一个节点的状态。
    const prior = structuredClone(state.research);
    try {
      const research = await deps.research(idea, signal, prior);
      return {
        research,
        modelCalls: state.modelCalls + (research.modelCalls ?? 0) - (state.research.modelCalls ?? 0),
        totalTokens: state.totalTokens + (research.totalTokens ?? 0) - (state.research.totalTokens ?? 0),
      };
    } catch (error) {
      rethrowCancellation(error, signal);
      return {
        research: {
          ...prior,
          searchCalls: Math.max(2, prior.searchCalls),
          warnings: [
            ...prior.warnings,
            error instanceof AnalysisError
              ? error.message
              : "补充搜索失败，保留已有来源。",
          ],
        },
      };
    }
  },
  async prepareEvidence(state, { observe, start }) {
    const sources = eligibleForGeneration(state.research);
    await observe?.("research", {
      ...state.research,
      coverage: countCoverage(
        sources,
        sources.map((source) => source.id),
      ),
      durationMs: Date.now() - start,
    });
    const warnings = [...state.warnings];
    for (const [status, label] of [
      ["not_attempted", "未尝试提取"],
      ["failed", "提取失败"],
      ["unusable", "内容不可用"],
    ] as const) {
      const count = state.research.sources.filter(
        (source) => source.extractionStatus === status,
      ).length;
      if (count)
        warnings.push(
          `${count} 个来源${label}，不用于本次报告的事实或量化指标。`,
        );
    }
    return { warnings };
  },
  generate: reportNode(async (state, { idea, signal, observe, deps }) => {
    const generated = await deps.generateReport(
      idea,
      eligibleForGeneration(state.research),
      signal,
      observe,
    );
    await observe?.("draft-0", generated.draft);
    return {
      draft: generated.draft,
      modelCalls: state.modelCalls + generated.modelCalls - 1,
      totalTokens: state.totalTokens + generated.totalTokens,
      warnings: [...state.warnings, ...generated.warnings],
    };
  }, 1),
  validate: reportNode((state, { deps }) => {
    const validated = deps.validateReport(
      state.draft,
      eligibleForGeneration(state.research),
    );
    return {
      draft: validated.report,
      answerFeedback: validated.warnings,
      warnings: [...state.warnings, ...validated.warnings],
    };
  }),
  async recoverAnswer(state, { idea, signal, observe, deps }) {
    // 只在校验删空正文后补写一次，不重新检索，不因调用失败无限重试。
    const sources = eligibleForGeneration(state.research);
    let modelCalls = state.modelCalls;
    let totalTokens = state.totalTokens;
    const warnings = [...state.warnings];
    try {
      signal?.throwIfAborted();
      modelCalls++;
      const generated = await deps.generateReport(
        idea, sources, signal,
        observe ? (stage, data) => observe(`answer-recovery-${stage}`, data) : undefined,
        { answerOnly: true, answerFeedback: state.answerFeedback },
      );
      modelCalls += generated.modelCalls - 1;
      totalTokens += generated.totalTokens;
      warnings.push(...generated.warnings);
      signal?.throwIfAborted();
      const validated = deps.validateReport({ ...generated.draft, cards: [] }, sources);
      warnings.push(...validated.warnings);
      if (!validated.report.summary.length)
        return { modelCalls, totalTokens, warnings };
      return {
        draft: { ...state.draft, summary: validated.report.summary },
        modelCalls, totalTokens, warnings,
      };
    } catch (error) {
      rethrowCancellation(error, signal);
      return {
        modelCalls, totalTokens,
        warnings: [...warnings, error instanceof Error ? error.message : "回答补写未能完成，请重新分析。"],
      };
    }
  },
  completeReport(state) {
    return {
      draft: completeReport(state.draft, eligibleForGeneration(state.research)),
    };
  },
  async social(state, { signal, observe, socialTargetLength, deps }) {
    const social = await deps.generateSocialContent(
      state.draft,
      eligibleForGeneration(state.research),
      signal,
      observe,
      socialTargetLength,
    );
    await observe?.("social", social);
    return {
      social,
      modelCalls: state.modelCalls + social.modelCalls,
      totalTokens: state.totalTokens + social.totalTokens,
    };
  },
};
