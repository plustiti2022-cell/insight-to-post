import { z } from "zod";
import {
  draftSchema,
  cardSchema,
  statementSchema,
  type Source,
} from "../../core/contracts";
import { callQwen, outputText } from "../providers/qwen";
import { AnalysisError, parseModelJson } from "../runtime";
import { reportPrompt } from "../prompts";
import { evidenceRegistry, hydrateReferences } from "../../core/evidence";
import { answerStructureIssues } from "../../core/report";

export async function generateReport(
  idea: string,
  sources: Source[],
  signal?: AbortSignal,
  observe?: (stage: string, data: unknown) => Promise<void>,
  options: { answerOnly?: boolean; answerFeedback?: readonly string[] } = {},
) {
  const records = evidenceRegistry(sources, idea);
  const evidence = sources
    .filter((source) => source.extractedContent)
    .map((source) => ({
      id: source.id,
      evidence: records.filter((record) => record.sourceId === source.id),
    }));
  let totalTokens = 0;
  let correction = "";
  const attempts = options.answerOnly ? 1 : 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await callQwen(
      reportPrompt({
        idea,
        sources: evidence,
        formatCorrection: attempt ? correction : undefined,
        ...options,
      }),
      signal,
    );
    totalTokens += result.usage?.total_tokens ?? 0;
    await observe?.(`report-output-${attempt}`, { text: outputText(result) });
    try {
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
      const structureIssues = answerStructureIssues(summary);
      if (structureIssues.length) throw new Error(structureIssues.join("；"));
      return {
        draft: draftSchema.parse({ ...input, summary, cards, answerBlocks: undefined }),
        warnings,
        modelCalls: attempt + 1,
        totalTokens,
      };
    } catch (error) {
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
    "模型未能生成包含有效回答的报告，请重试。",
  );
}
