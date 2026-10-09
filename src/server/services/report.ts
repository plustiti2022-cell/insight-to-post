import { z } from "zod";
import {
  draftSchema,
  cardSchema,
  statementSchema,
  type AnswerBlock,
  type Source,
} from "../../core/contracts";
import { callQwen, outputText } from "../providers/qwen";
import { AnalysisError, parseModelJson, rethrowCancellation } from "../runtime";
import { reportPrompt } from "../prompts";
import { evidenceRegistry, hydrateReferences, validAnswerEvidence } from "../../core/evidence";
import { answerStructureIssues, hasOpeningSummary, presentAnswerBlock, readAnswerForDisplay, readReportForDisplay } from "../../core/report";
import { reportBlockReader } from "../report-stream";
import { createLogger, failureDetails } from "../logger";
const logger = createLogger("report");

export async function generateReport(
  idea: string,
  sources: Source[],
  signal?: AbortSignal,
  observe?: (stage: string, data: unknown) => Promise<void>,
  options: { answerOnly?: boolean; answerFeedback?: readonly string[]; singleAttempt?: boolean; validateCoreContent?: boolean;
    onBlock?: (block: AnswerBlock, index: number) => Promise<void> } = {},
) {
  return logger.run("generate", { sourceCount: sources.length, answerOnly: Boolean(options.answerOnly) }, async () => {
    const records = evidenceRegistry(sources, idea);
    const evidence = sources
      .filter((source) => source.extractedContent)
      .map((source) => ({
        id: source.id,
        evidence: records.filter((record) => record.sourceId === source.id),
      }));
    let totalTokens = 0;
    let correction = "";
    const validateCoreContent = options.validateCoreContent !== false;
    const attempts = !validateCoreContent || options.answerOnly || options.singleAttempt || options.onBlock ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let streamIssue = "";
      const readBlock = reportBlockReader(async (raw, index) => {
        if (!validateCoreContent) {
          signal?.throwIfAborted();
          await options.onBlock?.(readAnswerForDisplay(raw, records, index), index);
          return;
        }
        const hydrated = hydrateReferences({ summary: [raw], cards: [] }, records) as { summary: unknown[] };
        const item = statementSchema.parse(hydrated.summary[0]);
        const block = presentAnswerBlock(item, index);
        if (!block || !validAnswerEvidence(item, sources) || !validAnswerEvidence(block, sources) ||
            (index === 0 && (!hasOpeningSummary({ summary: [item] }) || !hasOpeningSummary({ summary: [block] }))) ||
            (index > 0 && item.presentation === "lead") ||
            (item.presentation === "bullet" && !block.label?.trim()))
          throw new Error("回答段落的结构、引用或数字未通过校验，须重新生成完整回答。");
        signal?.throwIfAborted();
        await options.onBlock?.(block, index);
      });
      logger.info("model.started", { attempt: attempt + 1, maxAttempts: attempts });
      const result = await callQwen(
        reportPrompt({
          idea,
          sources: evidence,
          formatCorrection: attempt ? correction : undefined,
          ...options,
        }),
        signal,
        {
          model: process.env.QWEN_REPORT_MODEL ?? "qwen3.8-max",
          ...(options.onBlock ? { onDelta: async (text: string) => {
            signal?.throwIfAborted();
            // 停止发布无法解析或校验失败的段落，继续读取以取得用量。
            if (streamIssue) return;
            try { await readBlock(text); }
            catch (error) {
              rethrowCancellation(error, signal);
              streamIssue = validateCoreContent
                ? "流式段落的结构、引用或数字未通过校验，须重新生成完整回答。"
                : "模型返回的流式段落无法解析。";
            }
          } } : {}),
        },
      );
      totalTokens += result.usage?.total_tokens ?? 0;
      logger.info("model.completed", { attempt: attempt + 1, outputLength: outputText(result).length, totalTokens });
      await observe?.(`report-output-${attempt}`, { text: outputText(result) });
      try {
        if (streamIssue) throw new Error(streamIssue);
        if (!validateCoreContent) {
          const draft = readReportForDisplay(parseModelJson(outputText(result)), records, idea);
          logger.info("validation.skipped", { summaryCount: draft.summary.length, cardCount: draft.cards.length });
          return { draft, warnings: [], modelCalls: attempt + 1, totalTokens };
        }
        const input = z
          .object({
            summary: z.array(z.unknown()).min(1).max(30),
            cards: z.array(z.unknown()).max(5),
          })
          .passthrough()
          .parse(parseModelJson(outputText(result)));
        const warnings: string[] = [];
        const summary = input.summary.flatMap((item: unknown) => {
          try {
            const hydrated = hydrateReferences(
              { ...input, summary: [item], cards: [] },
              records,
            ) as { summary: unknown[] };
            return [statementSchema.parse(hydrated.summary[0])];
          } catch {
            warnings.push("一条总结的结构或引用依据不完整，已移除。");
            return [];
          }
        });
        const cards = input.cards.flatMap((item: unknown) => {
          try {
            const hydrated = hydrateReferences(
              { ...input, summary: [], cards: [item] },
              records,
            ) as { cards: unknown[] };
            return [cardSchema.parse(hydrated.cards[0])];
          } catch {
            warnings.push("一张指标卡的结构、单位或引用依据不完整，已移除。");
            return [];
          }
        });
        if (!summary.length)
          throw new Error("summary没有有效回答，请提供非空正文和输入中可定位的引用编号。");
        if (summary.length !== input.summary.length)
          throw new Error("回答段落因结构或引用无效被移除，须重新生成完整回答。");
        const structureIssues = answerStructureIssues(summary);
        if (structureIssues.length) throw new Error(structureIssues.join("；"));
        logger.info("validation.completed", { attempt: attempt + 1, summaryCount: summary.length, cardCount: cards.length, warningCount: warnings.length });
        return {
          draft: draftSchema.parse({ ...input, summary, cards, answerBlocks: undefined }),
          warnings,
          modelCalls: attempt + 1,
          totalTokens,
        };
      } catch (error) {
        logger.warn(validateCoreContent ? "validation.failed" : "parsing.failed",
          { attempt: attempt + 1, willRetry: attempt + 1 < attempts, ...failureDetails(error) });
        // 只提供结构字段路径，不把无效上游原文传给下一轮。
        correction =
          error && typeof error === "object" && "issues" in error
            ? JSON.stringify(
                (error.issues as { path: unknown; code: string }[]).map(
                  (issue) => ({ path: issue.path, code: issue.code }),
                ),
              )
            : error instanceof SyntaxError
              ? "不是有效JSON"
              : error instanceof Error
                ? error.message
                : "报告字段无效";
        await observe?.(`report-format-${attempt}`, { correction });
      }
    }
    throw new AnalysisError(
      "INVALID_REPORT",
      validateCoreContent
        ? `模型未能生成包含完整回答的报告。校验问题：${correction}。`
        : "模型未返回可解析的正文，请重新分析。",
      502,
      { modelCalls: attempts, totalTokens },
    );
  }, signal);
}
