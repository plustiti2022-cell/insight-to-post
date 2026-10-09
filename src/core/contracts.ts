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
// 展示与签名快照只检查可渲染的数据类型，不把正文长度/布局作为发布门槛。
export const displayStatementSchema = statementSchema.extend({
  text: z.string(),
  label: z.string().optional(),
  references: z.array(referenceSchema),
});
export const displayCardSchema = z.object({
  claimId: z.string().optional(),
  label: z.string(), value: z.string(), unit: z.string(), explanation: z.string(),
  period: z.string(), scope: z.string(), valueEvidence: z.string(),
  unitEvidence: z.string(), timeEvidence: z.string(), references: z.array(referenceSchema),
});
export const displayDraftSchema = draftSchema.extend({
  summary: z.array(displayStatementSchema),
  answerBlocks: z.array(displayStatementSchema).optional(),
  cards: z.array(displayCardSchema),
  limitations: z.array(z.string()),
});
export type Reference = z.infer<typeof referenceSchema>;
export type AnswerBlock = z.infer<typeof statementSchema>;
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
export const dataPosterSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(["pending", "generating", "ready", "failed"]),
  svg: z.string().optional(),
  error: z.string().optional(),
});
export const dataPostersSchema = z.object({
  status: z.enum(["extracting", "generating", "complete", "failed"]),
  items: z.array(dataPosterSchema),
  error: z.string().optional(),
});
export type DataPoster = z.infer<typeof dataPosterSchema>;
export type DataPosters = z.infer<typeof dataPostersSchema>;
export type DataPostersResult = {
  dataPosters: DataPosters;
  modelCalls: number;
  totalTokens: number;
  durationMs: number;
};
export type Analysis = {
  coreValidation?: boolean;
  status: "complete" | "partial" | "insufficient";
  report: Draft & { generatedAt: string };
  sources: PublicSource[];
  warnings: string[];
  coverage?: Coverage;
  socialContent?: SocialContent;
  socialRetryToken?: string;
  dataPosters?: DataPosters;
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
    dataPostersDurationMs?: number;
  };
};
export type AnalysisStage =
  | "search" | "supplement" | "prepareEvidence" | "generate"
  | "validate" | "recoverAnswer" | "completeReport" | "social";
export type SocialGenerationResult = {
  socialContent: SocialContent;
  modelCalls: number;
  totalTokens: number;
  durationMs: number;
};
export type SocialPreviewEvent =
  | { type: "social-start" }
  | { type: "social-block"; index: number; text: string };
export type SocialStreamEvent = SocialPreviewEvent
  | { type: "social-result"; result: SocialGenerationResult }
  | { type: "error"; error: { code: string; message: string } };
// 段落完整后可预览；coreValidation 标明是否执行内容校验，report 确认生成结束。
export type AnalysisEvent =
  | SocialPreviewEvent
  | { type: "opening"; text: string }
  | { type: "progress"; stage: AnalysisStage }
  | { type: "report-start"; attempt: 1 | 2; sources: PublicSource[]; coreValidation?: boolean }
  | { type: "report-block"; attempt: 1 | 2; index: number; block: AnswerBlock }
  | { type: "report"; analysis: Analysis }
  | { type: "social"; socialContent: SocialContent; socialRetryToken?: string }
  | { type: "data-posters"; dataPosters: DataPosters }
  | { type: "result"; analysis: Analysis }
  | { type: "error"; error: { code: string; message: string } };
export type ReportPreview = {
  coreValidation?: boolean;
  attempt: 1 | 2;
  blocks: AnswerBlock[];
  sources: PublicSource[];
};
export const inputSchema = z.object({
  idea: z
    .string()
    .trim()
    .min(5, "请至少输入 5 个字。")
    .max(1000, "问题最多 1000 个字。"),
  socialTargetLength: z.union([z.literal(280), z.literal(2000)]).optional(),
  dataExtractionPrompt: z.string().trim().max(2000, "数据提取提示词最多 2000 字符。").optional(),
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
