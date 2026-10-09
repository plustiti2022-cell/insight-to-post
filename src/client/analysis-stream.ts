import type { Analysis, AnalysisEvent, AnalysisStage } from "../core/contracts";
import { displayStatementSchema } from "../core/contracts";

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
  if (!response.body) throw new Error("未收到分析数据，请重试。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: Analysis | undefined;
  let ended = false;
  let attempt = 0, blockIndex = 0, confirmed = false;
  function frame(text: string) {
    const data = text.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    let event: AnalysisEvent;
    try { event = JSON.parse(data); }
    catch { throw new Error("分析数据格式异常，请重试。"); }
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
    } else if (event.type === "report" || event.type === "result") {
      if (!event.analysis?.report || !Array.isArray(event.analysis.sources) || !event.analysis.diagnostics)
        throw new Error("分析数据格式异常，请重试。");
      if (event.type === "result") result = event.analysis;
      confirmed = true;
    } else throw new Error("分析数据格式异常，请重试。");
    onEvent(event);
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (done) { ended = true; break; }
    }
    if (buffer.trim() || !result) throw new Error("连接中断，分析未完整完成，请重试。");
    return result;
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
