import {
  searchTavily,
  extractTavily,
  type TavilyResult,
} from "../providers/tavily";
import { canonicalUrl, sourceType } from "../../core/sources";
import type { Source, Research } from "../../core/contracts";
import { AnalysisError } from "../runtime";

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
  query: string,
  signal?: AbortSignal,
  prior?: Research,
) {
  const research: Research = prior
    ? structuredClone(prior)
    : {
        sources: [],
        searchCalls: 0,
        extractorCalls: 0,
        credits: 0,
        warnings: [],
      };
  const result = await searchTavily(query.slice(0, 600), signal);
  research.searchCalls++;
  research.credits += result.usage?.credits ?? 0;
  mergeResults(research, result.results);
  const missing = research.sources
    .filter((s) => s.extractionStatus !== "available")
    .slice(0, 8);
  if (missing.length) {
    research.extractorCalls++;
    try {
      const extracted = await extractTavily(
        missing.map((s) => s.url),
        signal,
      );
      research.credits += extracted.usage?.credits ?? 0;
      for (const source of missing) {
        const item = extracted.results.find(
          (item) => canonicalUrl(item.url) === source.url,
        );
        applyContent(source, item?.raw_content, "extract_raw_content");
        if (!item && source.extractionStatus !== "available")
          source.extractionReason = "Tavily Extract 未成功返回该 URL 的正文。";
      }
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof AnalysisError && error.code === "CANCELLED")
      )
        throw error;
      research.warnings.push(
        error instanceof AnalysisError ? error.message : "补充正文提取失败。",
      );
      for (const source of missing)
        if (source.extractionStatus !== "available")
          source.extractionReason =
            "已调用 Tavily Extract，但请求失败；不使用搜索摘要代替正文。";
    }
  }
  return research;
}
