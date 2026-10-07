import { eligibleForGeneration } from "../../core/sources";
import type { NodeId, WorkflowState } from "./state";

export const START: NodeId = "search";
export const END = "end";
type Edge = (state: Readonly<WorkflowState>) => NodeId | typeof END;

// 只读取状态、选择下一步；五篇是补搜触发条件，不是输出门槛。
export const edges: Record<NodeId, Edge> = {
  search: (state) =>
    eligibleForGeneration(state.research).length < 5 &&
    state.research.searchCalls < 2
      ? "supplement"
      : "prepareEvidence",
  supplement: () => "prepareEvidence",
  prepareEvidence: (state) =>
    eligibleForGeneration(state.research).length
      ? "generate"
      : "completeReport",
  generate: (state) => (state.reportFailed ? "completeReport" : "validate"),
  validate: (state) =>
    !state.reportFailed && !state.draft.summary.length
      ? "recoverAnswer"
      : "completeReport",
  recoverAnswer: () => "completeReport",
  completeReport: () => "social",
  social: () => END,
};
