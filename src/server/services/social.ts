import { callQwen, outputText } from "../providers/qwen";
import { AnalysisError, parseModelJson, rethrowCancellation } from "../runtime";
import { socialContentPrompt, socialContentOutputInstructions } from "../prompts";
import { emptySocial, normalizeSocialText, readSocialForDisplay, targetLength } from "../../core/social";
import { modelObjectArrayReader } from "../model-stream";
import type { Draft, Source } from "../../core/contracts";
import { createLogger, failureDetails } from "../logger";
const logger = createLogger("social");

export async function generateSocialContent(
  report: Draft,
  sources: Source[],
  signal?: AbortSignal,
  observe?: (stage: string, data: unknown) => Promise<void>,
  selectedLength?: number,
  options: { originalPrompt?: string; template?: 2 | 3; onBlock?: (text: string, index: number) => Promise<void> } = {},
) {
  return logger.run("generate", { sourceCount: sources.length, replay: options.originalPrompt !== undefined }, async () => {
    const start = Date.now();
    let modelCalls = 0, totalTokens = 0;
    const limit = targetLength(selectedLength ?? Number(process.env.X_TARGET_LENGTH ?? 280));
    const failed = (warning: string) => ({
      socialContent: emptySocial("failed", warning, sources, limit),
      modelCalls, totalTokens, durationMs: Date.now() - start,
    });
    signal?.throwIfAborted();
    if (!sources.length) return failed("缺少可用依据，暂时无法生成文案。");
    // 独立写作只接收已完成研究简报的全文，不把报告当作文案兜底。
    const coreObservation = report.summary[0]?.text ?? "";
    let stage = "request";
    try {
      let index = 0;
      const readBlock = modelObjectArrayReader("paragraphs", async raw => {
        if (!raw || typeof raw !== "object" || !("text" in raw) || typeof raw.text !== "string")
          throw new Error("文案段落格式异常");
        const text = normalizeSocialText(raw.text);
        signal?.throwIfAborted();
        if (text) await options.onBlock?.(text, index++);
      });
      modelCalls++;
      logger.info("model.started", { attempt: 1, maxAttempts: 1, targetLength: limit });
      const response = await callQwen(socialContentPrompt({
        coreObservation, targetLength: limit, originalPrompt: options.originalPrompt, template: options.template,
      }), signal, { instructions: socialContentOutputInstructions(), ...(options.onBlock ? { onDelta: readBlock } : {}) });
      totalTokens += response.usage?.total_tokens ?? 0;
      logger.info("model.completed", { attempt: 1, outputLength: outputText(response).length, totalTokens });
      await observe?.("social-draft-0", { text: outputText(response) });
      signal?.throwIfAborted();
      stage = "json";
      const raw = parseModelJson(outputText(response));
      stage = "content";
      const socialContent = readSocialForDisplay(raw, report, sources, limit);
      logger.info("content.decoded", { validation: false, textLength: socialContent.text.length });
      return { socialContent, modelCalls, totalTokens, durationMs: Date.now() - start };
    } catch (error) {
      rethrowCancellation(error, signal);
      const details = stage === "json" ? { errorCode: "INVALID_SOCIAL_JSON" }
        : stage === "content" ? { errorCode: "INVALID_SOCIAL_CONTENT" } : failureDetails(error);
      logger.warn("generate.failed", { ...details, stage,
        errorType: error instanceof SyntaxError ? "SyntaxError" : error instanceof Error && error.name === "ZodError" ? "ZodError" : "Other" });
      return failed(error instanceof AnalysisError ? error.message : stage === "json"
        ? "模型返回的文案不是有效 JSON，请重新生成文案。研究简报已保留。"
        : stage === "content" ? "模型返回的文案段落结构无效或内容为空，请重新生成文案。研究简报已保留。"
        : "文案生成未完成或无法解析，请重新生成文案。研究简报已保留。");
    }
  }, signal);
}
