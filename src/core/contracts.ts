import { z } from "zod";

export const ANSWER_LEAD_MAX_LENGTH = 120;

export const referenceSchema = z.object({
  sourceId: z.string().max(12),
  quote: z.string().min(15).max(4000),
});
export const statementSchema = z.object({
  claimId: z.string().optional(),
  presentation: z.enum(["lead", "bullet", "paragraph", "conclusion"]).optional(),
  label: z.string().trim().max(100).optional(),
  text: z.string().trim().min(1).max(3000),
  references: z.array(referenceSchema).max(60),
});
export const cardSchema = z.object({
  claimId: z.string().optional(),
  label: z.string().min(1).max(100),
  value: z
    .string()
    .regex(/^\d[\d,]*(?:\.\d+)?$/)
    .max(30),
  unit: z.string().min(1).max(30),
  explanation: z.string().min(1).max(400),
  period: z.string().min(1).max(100),
  scope: z.string().min(1).max(250),
  // 原文锚点用于约束数字、时间和统计口径；中文解释仍需人工核验。
  valueEvidence: z
    .string()
    .regex(/^\d[\d,]*(?:\.\d+)?$/)
    .max(80),
  unitEvidence: z.string().min(1).max(80),
  timeEvidence: z.string().regex(/\d{4}/).max(200),
  references: z.array(referenceSchema).min(1).max(3),
});
export const draftSchema = z.object({
  title: z.string().min(1).max(150),
  // 单个生成段落仍由 statementSchema 限制；归并后的社交输入保留完整回答。
  summary: z.array(statementSchema.extend({ text: z.string().trim().min(1).max(200000) })).max(60),
  answerBlocks: z.array(statementSchema).max(60).optional(),
  cards: z.array(cardSchema).max(5),
  limitations: z.array(z.string().max(400)).max(8),
});
export type Reference = z.infer<typeof referenceSchema>;
export type Card = z.infer<typeof cardSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type SourceType =
  "研究论文" | "官方统计" | "机构报告" | "新闻" | "其他" | "未知";
export type ExtractionStatus =
  "not_attempted" | "failed" | "unusable" | "available";
export type SourceStatus =
  | "not_attempted"
  | "extraction_failed"
  | "unusable"
  | "referenced"
  | "extracted_unused";
export type Source = {
  id: string;
  url: string;
  title: string | null;
  sourceType: SourceType;
  publishedAt: string | null;
  extractedContent: string;
  extractionStatus: ExtractionStatus;
  extractionReason: string;
  provider?: "tavily";
  contentOrigin?: "search_raw_content" | "extract_raw_content";
};
export type Coverage = {
  requiredSources: number;
  eligibleSourceCount: number;
  citedSourceCount: number;
  citedSourceTypes: SourceType[];
  requirementMet: boolean;
};
export type SocialContent = {
  status: "ready" | "failed" | "insufficient" | "skipped";
  text: string;
  characterCount: number;
  weightedLength: number;
  targetLength: number;
  warnings: string[];
  claimReferences: {
    paragraphIndex: number;
    reportClaimIds: string[];
    sourceId: string;
    evidenceIds: string[];
    quote: string;
  }[];
  coverage: Coverage;
};
export type PublicSource = Omit<
  Source,
  "extractedContent" | "extractionStatus" | "extractionReason"
> & { hasEvidence: boolean; status: SourceStatus; statusReason: string };
export const socialImageInputSchema = z.object({
  text: z.string().trim().min(1, "请先生成社交文案。").max(1200, "配图文案最多 1200 字符，请精简后重试。"),
});
export type SocialImage = {
  dataUrl: string;
  prompt: string;
  model: string;
  generatedAt: string;
};
export type SocialImageResult = {
  image: SocialImage;
  attempts: number;
  durationMs: number;
};
export type Analysis = {
  status: "complete" | "partial" | "insufficient";
  report: Draft & { generatedAt: string };
  sources: PublicSource[];
  warnings: string[];
  coverage?: Coverage;
  socialContent?: SocialContent;
  socialRetryToken?: string;
  searchSteps?: SearchStep[];
  diagnostics: {
    durationMs: number;
    searchCalls: number;
    extractorCalls: number;
    modelCalls: number;
    totalTokens: number;
    sourceTypes: number;
    tavilyCredits?: number;
    socialDurationMs?: number;
  };
};
export type AnalysisStage =
  | "search" | "supplement" | "prepareEvidence" | "generate"
  | "validate" | "recoverAnswer" | "completeReport" | "social";
// 对外事件只包含进度与已完成校验的公开结果，不传输模型原始输出。
export type AnalysisEvent =
  | { type: "opening"; text: string }
  | { type: "progress"; stage: AnalysisStage }
  | { type: "report"; analysis: Analysis }
  | { type: "result"; analysis: Analysis }
  | { type: "error"; error: { code: string; message: string } };
export const inputSchema = z.object({
  idea: z
    .string()
    .trim()
    .min(5, "请至少输入 5 个字。")
    .max(1000, "问题最多 1000 个字。"),
  socialTargetLength: z.union([z.literal(280), z.literal(2000)]).optional(),
});

export type Research = {
  sources: Source[];
  searchCalls: number;
  extractorCalls: number;
  credits: number;
  warnings: string[];
  searchSteps?: SearchStep[];
  followUpQuery?: string;
  modelCalls?: number;
  totalTokens?: number;
};
export type SearchStep = {
  query: string;
  resultCount: number;
  extractedCount: number;
  sourceIds: string[];
};
