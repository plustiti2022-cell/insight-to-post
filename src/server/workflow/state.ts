import type {
  Draft,
  Research,
  Source,
  SocialContent,
  AnalysisEvent,
  AnalysisStage,
} from "../../core/contracts";
import type { Observer } from "../runtime";

// 工作流声明需要的能力，不引用具体服务或供应商。
type ModelUsage = { modelCalls: number; totalTokens: number };
export type SocialResult = ModelUsage & {
  socialContent: SocialContent;
  durationMs: number;
};
export type AnalysisDependencies = {
  research(
    query: string,
    signal?: AbortSignal,
    prior?: Research,
  ): Promise<Research>;
  generateReport(
    idea: string,
    sources: Source[],
    signal?: AbortSignal,
    observe?: Observer,
    options?: { answerOnly?: boolean; answerFeedback?: readonly string[] },
  ): Promise<ModelUsage & { draft: Draft; warnings: string[] }>;
  validateReport(
    draft: Draft,
    sources: Source[],
  ): { report: Draft; warnings: string[] };
  generateSocialContent(
    report: Draft,
    sources: Source[],
    signal?: AbortSignal,
    observe?: Observer,
    length?: number,
  ): Promise<SocialResult>;
  signSocialSnapshot(
    report: Draft,
    sources: Source[],
    length: number,
  ): string;
};
export type AnalysisInput = {
  idea: string;
  signal?: AbortSignal;
  observe?: Observer;
  onEvent?: (event: AnalysisEvent) => Promise<void>;
  socialTargetLength: number;
};
export type WorkflowState = {
  research: Research;
  draft: Draft;
  reportFailed: boolean;
  answerFeedback: string[];
  warnings: string[];
  modelCalls: number;
  totalTokens: number;
  social?: SocialResult;
};
export type NodeId = AnalysisStage;
export type NodeContext = AnalysisInput & {
  start: number;
  deps: AnalysisDependencies;
};
export type Node = (
  state: Readonly<WorkflowState>,
  context: NodeContext,
) => Partial<WorkflowState> | Promise<Partial<WorkflowState>>;

export function emptyDraft(idea: string): Draft {
  return { title: idea, summary: [], cards: [], limitations: [] };
}
export function initialState(idea: string): WorkflowState {
  return {
    research: {
      sources: [],
      searchCalls: 0,
      extractorCalls: 0,
      credits: 0,
      warnings: [],
    },
    draft: emptyDraft(idea),
    reportFailed: false,
    answerFeedback: [],
    warnings: [],
    modelCalls: 0,
    totalTokens: 0,
  };
}
