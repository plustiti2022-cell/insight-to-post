import type {
  Coverage,
  Draft,
  PublicSource,
  Research,
  Source,
  SourceStatus,
  SourceType,
} from "./contracts";

export function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.includes(":") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host)
    )
      return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (key.startsWith("utm_") || key === "fbclid")
        url.searchParams.delete(key);
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
export function supplementQuery(idea: string) {
  const names = [
    ...new Set(idea.match(/AI Scientist|[A-Za-z][A-Za-z0-9-]{2,}/g) ?? []),
  ];
  const years = [...new Set(idea.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
  return names.length
    ? `${names.join(" ")} ${years.join(" ")} research paper official report findings capabilities limitations`.slice(
        0,
        600,
      )
    : `${idea.slice(0, 480)} research paper official statistics institutional report evidence`;
}
export function sourceType(url: string): SourceType {
  const parsed = new URL(url),
    host = parsed.hostname;
  const at = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (
    [
      "arxiv.org",
      "nature.com",
      "science.org",
      "nejm.org",
      "acm.org",
      "openreview.net",
      "pnas.org",
      "sciencedirect.com",
    ].some(at)
  )
    return "研究论文";
  if (
    [
      "bls.gov",
      "stats.gov.cn",
      "ec.europa.eu",
      "ons.gov.uk",
      "census.gov",
    ].some(at)
  )
    return "官方统计";
  if (
    [
      "stanford.edu",
      "mckinsey.com",
      "oecd.org",
      "worldbank.org",
      "imf.org",
      "weforum.org",
      "ilo.org",
      "metr.org",
      "iea.org",
      "anthropic.com",
      "openai.com",
      "deepmind.google",
      "microsoft.com",
      "research.google",
      "economics.mit.edu",
      "sakana.ai",
    ].some(at)
  )
    return "机构报告";
  if (
    [
      "reuters.com",
      "apnews.com",
      "bbc.com",
      "ft.com",
      "bloomberg.com",
      "techcrunch.com",
      "theverge.com",
      "technologyreview.com",
      "cnbc.com",
      "theguardian.com",
      "businessinsider.com",
    ].some(at)
  )
    return "新闻";
  return "未知";
}
export function countCoverage(sources: Source[], citedIds: string[]): Coverage {
  const eligible = sources.filter(
    (source) =>
      source.extractionStatus === "available" && source.extractedContent,
  );
  const cited = eligible.filter((source) => citedIds.includes(source.id));
  const types = [
    ...new Set(
      cited
        .map((s) => s.sourceType)
        .filter((type) => type !== "未知" && type !== "其他"),
    ),
  ];
  return {
    requiredSources: eligible.length,
    eligibleSourceCount: eligible.length,
    citedSourceCount: cited.length,
    citedSourceTypes: types,
    requirementMet: eligible.every((source) => citedIds.includes(source.id)),
  };
}
export function reportCoverage(report: Draft, sources: Source[]) {
  return countCoverage(
    sources,
    [
      ...report.summary.flatMap((s) => s.references),
      ...report.cards.flatMap((c) => c.references),
    ].map((ref) => ref.sourceId),
  );
}
export function assignClaimIds(report: Draft): Draft {
  return {
    ...report,
    summary: report.summary.map((s, i) => ({
      ...s,
      claimId: `summary-${i + 1}`,
    })),
    cards: report.cards.map((c, i) => ({ ...c, claimId: `card-${i + 1}` })),
  };
}
export const sourceStatusLabels: Record<SourceStatus, string> = {
  not_attempted: "未尝试提取",
  extraction_failed: "提取失败",
  unusable: "内容不可用",
  referenced: "内容已引用",
  extracted_unused: "已提取未引用",
};

export function publicSources(
  sources: Source[],
  report: Draft,
): PublicSource[] {
  const referenced = new Set(
    [...report.cards, ...report.summary].flatMap((item) =>
      item.references.map((ref) => ref.sourceId),
    ),
  );
  return sources.map(
    ({ extractedContent, extractionStatus, extractionReason, ...source }) => {
      const hasEvidence = Boolean(extractedContent);
      const status: SourceStatus = hasEvidence
        ? referenced.has(source.id)
          ? "referenced"
          : "extracted_unused"
        : extractionStatus === "failed"
          ? "extraction_failed"
          : extractionStatus === "unusable"
            ? "unusable"
            : "not_attempted";
      const statusReason =
        status === "referenced"
          ? "正文证据已被本次最终报告的指标卡或总结引用。"
          : status === "extracted_unused"
            ? "已取得可用正文，但本次最终报告没有引用该来源。"
            : extractionReason;
      return { ...source, hasEvidence, status, statusReason };
    },
  );
}
export function eligibleForGeneration(research: Research) {
  return research.sources.filter(
    (source) =>
      source.extractionStatus === "available" && source.extractedContent,
  );
}
