import type { Analysis, AnalysisEvent, AnalysisStage } from "../core/contracts";
import { dataPostersSchema, displayStatementSchema } from "../core/contracts";
import { readEventStream } from "./event-stream";
import { socialPreviewReader } from "./social-stream";

export const analysisProgress: Record<AnalysisStage, string> = {
  search: "正在规划检索、提取正文并评估覆盖",
  supplement: "正在针对资料缺口补充检索",
  prepareEvidence: "正在整理文章依据",
  generate: "正在生成核心观察",
  validate: "正在核对回答与引用",
  recoverAnswer: "正在补写简短总结并校验",
  completeReport: "正在整理研究报告",
  social: "核心观察已生成，正在生成社交文案",
};

// fetch 支持 POST 与 AbortSignal；事件可能跨网络块、UTF-8 字节和换行边界。
export async function readAnalysisStream(
  response: Response,
  onEvent: (event: AnalysisEvent) => void,
): Promise<Analysis> {
  let result: Analysis | undefined;
  const socialPreview = socialPreviewReader();
  let attempt = 0, blockIndex = 0, confirmed = false;
  function frame(raw: unknown) {
    const event = raw as AnalysisEvent;
    if (!event || typeof event !== "object" || result)
      throw new Error("分析数据格式异常，请重试。");
    if (event.type === "error") throw new Error(event.error?.message || "分析失败，请重试。");
    if (event.type === "opening") {
      if (typeof event.text !== "string") throw new Error("开场数据格式异常，请重试。");
    } else if (event.type === "progress") {
      if (!Object.hasOwn(analysisProgress, event.stage)) throw new Error("分析进度格式异常，请重试。");
    } else if (event.type === "report-start") {
      if (confirmed || ![1, 2].includes(event.attempt) || event.attempt !== attempt + 1 || !Array.isArray(event.sources))
        throw new Error("报告轮次格式异常，请重试。");
      attempt = event.attempt; blockIndex = 0;
    } else if (event.type === "report-block") {
      // 已被替换的轮次不能恢复到页面。
      if (event.attempt < attempt || confirmed) return;
      if (!attempt || event.attempt !== attempt || event.index !== blockIndex || !displayStatementSchema.safeParse(event.block).success)
        throw new Error("报告段落格式异常，请重试。");
      blockIndex++;
    } else if (event.type === "social-start" || event.type === "social-block") {
      if (!confirmed) throw new Error("文案不能先于报告生成，请重试。");
      socialPreview(event);
    } else if (event.type === "data-posters") {
      if (!confirmed || !dataPostersSchema.safeParse(event.dataPosters).success)
        throw new Error("数据海报格式异常，请重试。");
    } else if (event.type === "social") {
      if (!confirmed || !event.socialContent || typeof event.socialContent.text !== "string" || !Array.isArray(event.socialContent.warnings))
        throw new Error("社交文案格式异常，请重试。");
    } else if (event.type === "report" || event.type === "result") {
      if (!event.analysis?.report || !Array.isArray(event.analysis.sources) || !event.analysis.diagnostics)
        throw new Error("分析数据格式异常，请重试。");
      if (event.type === "result") result = event.analysis;
      confirmed = true;
    } else throw new Error("分析数据格式异常，请重试。");
    onEvent(event);
  }
  await readEventStream(response, frame);
  if (!result) throw new Error("连接中断，分析未完整完成，请重试。");
  return result;
}
