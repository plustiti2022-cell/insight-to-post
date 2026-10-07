import { z } from "zod";
import { callQwen, outputText } from "../providers/qwen";
import { AnalysisError, parseModelJson } from "../runtime";
import { socialContentPrompt } from "../prompts";
import {
  emptySocial,
  reportBasedSocial,
  targetLength,
  validateSocialDraft,
} from "../../core/social";
import type { Draft, Source } from "../../core/contracts";
import { createLogger, failureDetails } from "../logger";
const logger = createLogger("social");

export async function generateSocialContent(
  report: Draft,
  sources: Source[],
  signal?: AbortSignal,
  observe?: (stage: string, data: unknown) => Promise<void>,
  selectedLength?: number,
  options: { fallback?: "report" | "fail"; originalPrompt?: string } = {},
) {
  return logger.run("generate", { sourceCount: sources.length, replay: options.originalPrompt !== undefined }, async () => {
    const start = Date.now();
    let modelCalls = 0,
      totalTokens = 0,
      correction = "";
    const limit = targetLength(
      selectedLength ?? Number(process.env.X_TARGET_LENGTH ?? 280),
    );
    // 首次分析可展示观点整理稿；主动重生成失败时不能用整理稿覆盖已有文案。
    const fallback = (reason: string, warning: string) => {
      logger.warn("generate.fallback", { mode: options.fallback ?? "report", modelCalls, totalTokens });
      return options.fallback === "fail"
        ? emptySocial("failed", warning, sources, limit)
        : reportBasedSocial(report, sources, limit, reason);
    };
    if (!sources.length)
      return {
        socialContent: fallback("", "缺少可用依据，暂时无法重新生成文案。"),
        modelCalls: 0,
        totalTokens: 0,
        durationMs: Date.now() - start,
      };
    // 页面“核心观察”的正文；当前主流程 summary 只有一项。不混入卡片或引用。
    const coreObservation = report.summary[0]?.text ?? "";
    try {
      // 重生成只重放原提示词一次，不追加校验反馈或自动修稿指令。
      const attempts = options.originalPrompt === undefined ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        modelCalls++;
        logger.info("model.started", { attempt: attempt + 1, maxAttempts: attempts, targetLength: limit });
        const response = await callQwen(
          socialContentPrompt({
            coreObservation,
            targetLength: limit,
            correction,
            originalPrompt: options.originalPrompt,
          }),
          signal,
        );
        totalTokens += response.usage?.total_tokens ?? 0;
        logger.info("model.completed", { attempt: attempt + 1, outputLength: outputText(response).length, totalTokens });
        await observe?.(`social-draft-${attempt}`, {
          text: outputText(response),
        });
        let checked: ReturnType<typeof validateSocialDraft>;
        try {
          checked = validateSocialDraft(
            parseModelJson(outputText(response)),
            report,
            sources,
            limit,
          );
        } catch (error) {
          logger.warn("validation.failed", { attempt: attempt + 1, willRetry: attempt + 1 < attempts, ...failureDetails(error) });
          correction =
            error instanceof z.ZodError
              ? `结构字段错误：${JSON.stringify(error.issues.map((issue) => ({ path: issue.path, code: issue.code })))}`
              : error instanceof SyntaxError
                ? "JSON格式错误"
                : "文案校验异常";
          continue;
        }
        if (checked.problems.length) {
          logger.warn("validation.failed", { attempt: attempt + 1, problemCount: checked.problems.length, willRetry: attempt + 1 < attempts });
          correction = checked.problems.join("；");
          continue;
        }
        logger.info("validation.completed", { attempt: attempt + 1, status: checked.content.status, modelCalls, totalTokens });
        return {
          socialContent: checked.content,
          modelCalls,
          totalTokens,
          durationMs: Date.now() - start,
        };
      }
      return {
        socialContent: fallback(correction, "新文案未通过校验，请稍后重试。"),
        modelCalls,
        totalTokens,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof AnalysisError && error.code === "CANCELLED")
      )
        throw error;
      logger.warn("model.failed", failureDetails(error));
      return {
        socialContent: fallback(
          error instanceof Error ? error.message : "模型整理未完成",
          error instanceof AnalysisError
            ? error.message
            : "文案生成失败，请稍后重试。",
        ),
        modelCalls,
        totalTokens,
        durationMs: Date.now() - start,
      };
    }
  }, signal);
}
