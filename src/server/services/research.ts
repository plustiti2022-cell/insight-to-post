import {
  searchTavily,
  extractTavily,
  type TavilyResult,
} from "../providers/tavily";
import { canonicalUrl, sourceType } from "../../core/sources";
import { evidenceRegistry } from "../../core/evidence";
import type { Source, Research } from "../../core/contracts";
import { AnalysisError, parseModelJson, rethrowCancellation } from "../runtime";
import { callQwen, outputText } from "../providers/qwen";
import { searchQueryPrompt, searchReviewPrompt } from "../prompts";
import { z } from "zod";
import { createLogger, failureDetails } from "../logger";
const logger = createLogger("research");

export function applyContent(
  source: Source,
  content: string | null | undefined,
  origin: Source["contentOrigin"] = "search_raw_content",
) {
  if (typeof content !== "string" || !content.trim()) {
    if (source.extractionStatus !== "available") {
      source.extractionStatus = "failed";
      source.extractionReason = "已请求正文提取，但该 URL 未返回正文。";
    }
    return;
  }
  const text = content.trim();
  const blocked =
    /^[#\s]*(?:access denied|request blocked|verify you are human|enable javascript and cookies|captcha)|errors\.edgesuite\.net/i.test(
      text,
    );
  if (text.length < 100 || blocked) {
    if (source.extractionStatus !== "available") {
      source.extractionStatus = "unusable";
      source.extractionReason = blocked
        ? "返回访问拒绝或验证页面，不能作为正文。"
        : "正文过短，不能建立可核验的证据。";
    }
    return;
  }
  source.extractedContent = text.slice(0, 25000);
  source.extractionStatus = "available";
  source.extractionReason = "Tavily 已返回可关联到此 URL 的原文正文。";
  source.provider = "tavily";
  source.contentOrigin = origin;
}
export function mergeResults(research: Research, results: TavilyResult[]) {
  for (const item of results) {
    const url = canonicalUrl(item.url);
    if (!url) continue;
    let source = research.sources.find((s) => s.url === url);
    if (!source) {
      source = {
        id: `S${research.sources.length + 1}`,
        url,
        title: item.title?.slice(0, 300) || null,
        sourceType: sourceType(url),
        publishedAt:
          item.published_date &&
          Number.isFinite(Date.parse(item.published_date))
            ? new Date(item.published_date).toISOString().slice(0, 10)
            : null,
        extractedContent: "",
        extractionStatus: "failed",
        extractionReason: "搜索已请求正文，尚未取得可用内容。",
        provider: "tavily",
      };
      research.sources.push(source);
    }
    applyContent(source, item.raw_content);
  }
}
export async function researchWithTavily(
  idea: string,
  signal?: AbortSignal,
  prior?: Research,
) {
  return logger.run("research", { ideaLength: idea.length, supplement: Boolean(prior) }, async () => {
    const research: Research = prior
      ? structuredClone(prior)
      : {
          sources: [],
          searchCalls: 0,
          extractorCalls: 0,
          credits: 0,
          warnings: [],
        };
    research.searchSteps ??= [];
    research.modelCalls ??= 0;
    research.totalTokens ??= 0;
    signal?.throwIfAborted();
    let query = prior?.followUpQuery ?? idea.slice(0, 600);
    delete research.followUpQuery;
    // 用户给出的 URL 直接提取，搜索引擎不必再发现一次同一篇文章。
    const urls = prior ? [] : [...new Set((idea.match(/https?:\/\/[^\s<>"，。；！？）]+/g) ?? [])
      .map((url) => canonicalUrl(url.replace(/[.,;!?)\]}]+$/, ""))).filter((url): url is string => Boolean(url)))];
    if (urls.length) {
      logger.info("directUrls", { urlCount: urls.length });
      mergeResults(research, urls.map((url) => ({ url })));
    } else {
      if (!prior) {
        try {
          research.modelCalls++;
          logger.info("queryPlanning.started");
          const result = await callQwen(searchQueryPrompt({
            idea,
            currentDate: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date()),
          }), signal);
          research.totalTokens += result.usage?.total_tokens ?? 0;
          query = z.object({ query: z.string().trim().min(5).max(600) })
            .parse(parseModelJson(outputText(result))).query;
          logger.info("queryPlanning.completed", { queryLength: query.length, totalTokens: research.totalTokens });
        } catch (error) {
          rethrowCancellation(error, signal);
          logger.warn("queryPlanning.fallback", failureDetails(error));
          research.warnings.push("检索词规划未完成，使用原始问题继续搜索。");
        }
      }
      if (research.searchSteps.some((step) => sameQuery(step.query, query))) {
        logger.info("search.skipped", { reason: "duplicate_query" });
        return research;
      }
      research.searchCalls++;
      try {
        logger.info("search.started", { attempt: research.searchCalls, queryLength: query.length });
        const result = await searchTavily(query, signal);
        logger.info("search.completed", { resultCount: result.results.length, credits: result.usage?.credits ?? 0 });
        research.credits += result.usage?.credits ?? 0;
        mergeResults(research, result.results);
        const urls = new Set(result.results.map((item) => canonicalUrl(item.url)));
        research.searchSteps.push({ query, resultCount: result.results.length, extractedCount: 0,
          sourceIds: research.sources.filter((source) => urls.has(source.url)).map((source) => source.id) });
      } catch (error) {
        rethrowCancellation(error, signal);
        logger.warn("search.fallback", failureDetails(error));
        research.searchSteps.push({ query, resultCount: 0, extractedCount: 0, sourceIds: [] });
        research.warnings.push(error instanceof Error ? error.message : "本次检索请求未完成。");
        return research;
      }
    }
    // 只对未取得可用正文的 URL 重试一次，成功文章不重复请求。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const missing = research.sources.filter((s) => s.extractionStatus !== "available");
      // Extract 每批最多 20 个 URL。
      for (let offset = 0; offset < missing.length; offset += 20) {
        const batch = missing.slice(offset, offset + 20);
        signal?.throwIfAborted();
        research.extractorCalls++;
        try {
          logger.info("extract.started", { attempt, batch: research.extractorCalls, urlCount: batch.length });
          const extracted = await extractTavily(
            batch.map((s) => s.url),
            signal,
          );
          research.credits += extracted.usage?.credits ?? 0;
          for (const source of batch) {
            const item = extracted.results.find(
              (item) => canonicalUrl(item.url) === source.url,
            );
            applyContent(source, item?.raw_content, "extract_raw_content");
            if (!item && source.extractionStatus !== "available")
              source.extractionReason = attempt === 2
                ? "Tavily Extract 重试后仍未返回该 URL 的正文。"
                : "Tavily Extract 未成功返回该 URL 的正文，准备重试。";
          }
          logger.info("extract.completed", { attempt, batch: research.extractorCalls, availableCount: batch.filter((source) => source.extractionStatus === "available").length });
        } catch (error) {
          rethrowCancellation(error, signal);
          logger.warn("extract.failed", { attempt, batch: research.extractorCalls, ...failureDetails(error) });
          if (attempt === 2) research.warnings.push(
            error instanceof AnalysisError ? error.message : "补充正文提取重试后仍失败。",
          );
          for (const source of batch)
            if (source.extractionStatus !== "available")
              source.extractionReason = attempt === 2
                ? "Tavily Extract 请求在重试后仍失败；不使用搜索摘要代替正文。"
                : "Tavily Extract 请求失败，准备重试；不使用搜索摘要代替正文。";
        }
      }
    }
    const available = research.sources.filter((source) => source.extractionStatus === "available");
    const step = research.searchSteps.at(-1);
    if (step) step.extractedCount = available.filter((source) => step.sourceIds.includes(source.id)).length;
    // 有限预算：第一次检索后评估问题覆盖；补搜后直接进入回答。
    if (!prior && !urls.length) {
      try {
        research.modelCalls++;
        logger.info("coverageReview.started", { availableCount: available.length });
        const records = evidenceRegistry(available, idea);
        const result = await callQwen(searchReviewPrompt({
          idea, query,
          sources: research.sources.map((source) => ({
            id: source.id, title: source.title, status: source.extractionStatus,
            passages: records.filter((record) => record.sourceId === source.id)
              .map((record) => record.text).join("\n\n").slice(0, 1800),
          })),
        }), signal);
        research.totalTokens += result.usage?.total_tokens ?? 0;
        const { followUpQuery } = z.object({ followUpQuery: z.string().trim().min(5).max(600).nullable() })
          .parse(parseModelJson(outputText(result)));
        if (followUpQuery && !sameQuery(followUpQuery, query)) research.followUpQuery = followUpQuery;
        logger.info("coverageReview.completed", { needsSupplement: Boolean(research.followUpQuery) });
      } catch (error) {
        rethrowCancellation(error, signal);
        logger.warn("coverageReview.fallback", failureDetails(error));
        research.warnings.push("检索覆盖评估未完成，保留已有文章并继续回答。");
      }
    }
    signal?.throwIfAborted();
    logger.info("research.result", { sourceCount: research.sources.length, availableCount: available.length, searchCalls: research.searchCalls, extractorCalls: research.extractorCalls, modelCalls: research.modelCalls, totalTokens: research.totalTokens, warningCount: research.warnings.length });
    return research;
  }, signal);
}

function sameQuery(first: string, second: string) {
  return first.toLowerCase().replace(/\s+/g, " ").trim() === second.toLowerCase().replace(/\s+/g, " ").trim();
}
