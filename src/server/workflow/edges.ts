import { eligibleForGeneration } from "../../core/sources";
import { answerStructureIssues } from "../../core/report";
import type { NodeId, WorkflowState } from "./state";

export const START: NodeId = "search";
export const END = "end";
type Edge = (state: Readonly<WorkflowState>) => NodeId | typeof END;

// 只读取状态、选择下一步；补搜针对问题覆盖的缺口，与篇数无关。
export const edges: Record<NodeId, Edge> = {
  search: (state) =>
    state.research.followUpQuery &&
    state.research.searchCalls < 2
      ? "supplement"
      : "prepareEvidence",
  supplement: () => "prepareEvidence",
  prepareEvidence: (state) =>
    eligibleForGeneration(state.research).length
      ? "generate"
      : "completeReport",
  generate: (state) => (state.reportFailed ? "recoverAnswer" : "validate"),
  validate: (state) =>
    state.reportFailed || answerStructureIssues(state.draft.summary).length
      ? "recoverAnswer"
      : "completeReport",
  recoverAnswer: () => "completeReport",
  completeReport: () => "social",
  social: () => END,
};
