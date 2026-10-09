import { AnalysisError, rethrowCancellation } from "../runtime";
import { createLogger, failureDetails } from "../logger";
import {
  countCoverage,
  eligibleForGeneration,
} from "../../core/sources";
import { completeReport, answerStructureIssues } from "../../core/report";
import { emptyDraft, type Node, type NodeId } from "./state";
const logger = createLogger("workflow.nodes");

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
      logger.warn("report.retryRequired", failureDetails(error));
      return {
        modelCalls: state.modelCalls + (error instanceof AnalysisError ? error.modelUsage?.modelCalls ?? attemptedCalls : attemptedCalls),
        totalTokens: state.totalTokens + (error instanceof AnalysisError ? error.modelUsage?.totalTokens ?? 0 : 0),
        draft: emptyDraft(context.idea),
        reportFailed: true,
        answerFeedback: [error instanceof Error ? error.message : "回答生成或校验失败。"],
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
      logger.warn("search.fallback", failureDetails(error));
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
      logger.warn("supplement.fallback", failureDetails(error));
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
          `${count} 篇文章${label === "提取失败" ? "经 Tavily 正文提取重试后仍失败" : label}，未纳入事实或数字依据；报告使用其余已取得正文的文章。`,
        );
    }
    return { warnings };
  },
  generate: reportNode(async (state, { idea, signal, observe, deps, onEvent }) => {
    const generated = await deps.generateReport(
      idea,
      eligibleForGeneration(state.research),
      signal,
      observe,
      { singleAttempt: true, ...(onEvent ? { onBlock: async (block, index) => {
        signal?.throwIfAborted();
        await onEvent({ type: "report-block", attempt: 1, index, block });
      } } : {}) },
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
    const lostBlocks = validated.report.summary.length < state.draft.summary.length;
    return {
      draft: validated.report,
      reportFailed: lostBlocks,
      answerFeedback: [...validated.warnings, ...answerStructureIssues(validated.report.summary),
        ...(lostBlocks ? ["引用校验移除了回答段落，须重新生成完整回答。"] : [])],
      warnings: [...state.warnings, ...validated.warnings],
    };
  }),
  async recoverAnswer(state, { idea, signal, observe, deps, onEvent }) {
    // 生成失败或校验后结构不完整时，复用全部正文重生成一次。
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
        { answerOnly: true, answerFeedback: state.answerFeedback,
          ...(onEvent ? { onBlock: async (block, index) => {
            signal?.throwIfAborted();
            await onEvent({ type: "report-block", attempt: 2, index, block });
          } } : {}) },
      );
      modelCalls += generated.modelCalls - 1;
      totalTokens += generated.totalTokens;
      warnings.push(...generated.warnings);
      signal?.throwIfAborted();
      const validated = deps.validateReport({ ...generated.draft, cards: [] }, sources);
      warnings.push(...validated.warnings);
      if (validated.report.summary.length < generated.draft.summary.length ||
          answerStructureIssues(validated.report.summary).length) {
        logger.warn("answerRecovery.invalid", { warningCount: validated.warnings.length });
        return { modelCalls, totalTokens, warnings };
      }
      return {
        draft: { ...state.draft, summary: validated.report.summary },
        reportFailed: false,
        modelCalls, totalTokens, warnings,
      };
    } catch (error) {
      rethrowCancellation(error, signal);
      logger.warn("answerRecovery.failed", failureDetails(error));
      return {
        modelCalls: modelCalls + (error instanceof AnalysisError ? (error.modelUsage?.modelCalls ?? 1) - 1 : 0),
        totalTokens: totalTokens + (error instanceof AnalysisError ? error.modelUsage?.totalTokens ?? 0 : 0),
        warnings: [...warnings, error instanceof Error ? error.message : "回答补写未能完成，请重新分析。"],
      };
    }
  },
  completeReport(state) {
    const sources = eligibleForGeneration(state.research);
    if (!sources.length)
      throw new AnalysisError("NO_EVIDENCE", "本次未取得可用文章正文，无法完成研究报告。请重新分析或提供可公开访问的文章链接。");
    if (state.reportFailed || answerStructureIssues(state.draft.summary).length)
      throw new AnalysisError("INVALID_REPORT", "核心研究内容在自动重试一次后仍未完整生成，请重新分析。");
    const draft = completeReport(state.draft, sources);
    if (answerStructureIssues(draft.answerBlocks ?? []).length)
      throw new AnalysisError("INVALID_REPORT", "核心研究内容在自动重试一次后仍未完整生成，请重新分析。");
    return { draft };
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
