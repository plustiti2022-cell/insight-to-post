import { z } from "zod";
import twitterText from "twitter-text";
import type { Draft, Source, SocialContent } from "./contracts";
import { countCoverage } from "./sources";
import { normalize, evidenceRegistry } from "./evidence";
import { includeEveryArticle } from "./report";

const socialDraftSchema = z.object({
  paragraphs: z
    .array(
      z.object({
        text: z.string().min(1).max(1800),
        claimIds: z.array(z.string()).max(30),
      }),
    )
    .min(3)
    .max(30),
});
export function targetLength(selected?: number) {
  const n = selected ?? 280;
  return Number.isFinite(n) && n >= 100 && n <= 25000 ? Math.floor(n) : 280;
}
export function normalizeSocialText(text: string) {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function emptySocial(
  status: SocialContent["status"],
  warning: string,
  sources: Source[] = [],
  limit = targetLength(),
): SocialContent {
  return {
    status,
    text: "",
    characterCount: 0,
    weightedLength: 0,
    targetLength: limit,
    warnings: [warning],
    claimReferences: [],
    coverage: countCoverage(sources, []),
  };
}
export function validateSocialDraft(
  raw: unknown,
  report: Draft,
  sources: Source[],
  limit = targetLength(),
) {
  const parsed = socialDraftSchema.parse(raw);
  const claims = [...report.summary, ...report.cards].map((item) => ({
    id: item.claimId,
    references: item.references,
    text:
      "text" in item
        ? item.text
        : [
            item.label,
            item.value,
            item.unit,
            item.explanation,
            item.period,
            item.scope,
          ].join(" "),
  }));
  const problems: string[] = [];
  const evidence = evidenceRegistry(sources);
  const references: SocialContent["claimReferences"] = [];
  const paragraphs = parsed.paragraphs.map((paragraph, paragraphIndex) => {
    const text = normalizeSocialText(paragraph.text);
    if (
      /\n|\t|[\u0000-\u0008\u000b\u000c\u000e-\u001f]|```|\*\*|<[^>]+>|^#{1,6}\s|^[-*•]\s|^\d+[.)、]\s|\bS\d+-E\d+\b|\[S\d+\]|以下是.*文案/.test(
        text,
      )
    )
      problems.push(`第 ${paragraphIndex + 1} 段不是干净的纯文字。`);
    if (
      paragraph.claimIds.some((id) => !claims.some((claim) => claim.id === id))
    )
      problems.push("文案引用了不存在或已移除的结论。");
    const selected = claims.filter(
      (claim) => claim.id && paragraph.claimIds.includes(claim.id),
    );
    const claimText = selected.map((claim) => claim.text).join(" ");
    const quotes = selected
      .flatMap((c) => c.references)
      .map((ref) => ref.quote)
      .join(" ");
    const numbers = (normalize(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(
      (n) => n.replace(/,/g, ""),
    );
    const evidenceNumbers = (
      normalize(quotes).match(/\d[\d,]*(?:\.\d+)?/g) ?? []
    ).map((n) => n.replace(/,/g, ""));
    if (numbers.some((number) => !evidenceNumbers.includes(number)))
      problems.push(`第 ${paragraphIndex + 1} 段包含未支持的数字。`);
    if (numbers.length) {
      // A cited summary can combine several metrics. Matrix scope is needed
      // only for its matrix metric, not an unrelated percentage in that summary.
      const matrixClauses = claimText
        .split(/[，。；;\n]/)
        .filter((clause) => /\d+\s*[x×]\s*\d+/i.test(clause));
      const matrixNumbers = matrixClauses.flatMap((clause) =>
        (
          clause
            .replace(/\d+\s*[x×]\s*\d+/gi, "")
            .match(/\d[\d,]*(?:\.\d+)?/g) ?? []
        ).map((number) => number.replace(/,/g, "")),
      );
      const usesMatrixMetric =
        /矩阵|标量乘法|matrix|matrices|scalar multiplications/i.test(text) ||
        numbers.some((number) => matrixNumbers.includes(number));
      const dimensions = usesMatrixMetric
        ? (claimText.match(/\d+\s*[x×]\s*\d+/gi) ?? [])
        : [];
      for (const dimension of dimensions)
        if (
          !text
            .replace(/\s/g, "")
            .toLowerCase()
            .replace(/×/g, "x")
            .includes(
              dimension.replace(/\s/g, "").toLowerCase().replace(/×/g, "x"),
            )
        )
          problems.push(
            `第 ${paragraphIndex + 1} 段遗漏量化结论的矩阵尺寸或适用范围。`,
          );
      if (
        dimensions.length &&
        /复数/.test(claimText) &&
        !/复数|复值|complex/i.test(text)
      )
        problems.push(`第 ${paragraphIndex + 1} 段遗漏复数矩阵这一限定。`);
      if (/受访/.test(claimText) && !/受访|调查|调研|样本/.test(text))
        problems.push(`第 ${paragraphIndex + 1} 段遗漏调查样本限定。`);
      if (/事前预测|预估/.test(claimText) && !/预测|预估|事前/.test(text))
        problems.push(`第 ${paragraphIndex + 1} 段将预测表述成实测结果。`);
      if (/事后感知|自评/.test(claimText) && !/感知|自评|感受/.test(text))
        problems.push(`第 ${paragraphIndex + 1} 段将主观感受表述成实测结果。`);
    }
    for (const stronger of ["定论", "不可替代", "完全取代", "行业共识", "必然"])
      if (text.includes(stronger) && !claimText.includes(stronger))
        problems.push(
          `第 ${paragraphIndex + 1} 段新增未经报告支持的强断言“${stronger}”。`,
        );
    for (const claim of selected)
      for (const ref of claim.references) {
        const source = sources.find((s) => s.id === ref.sourceId);
        if (
          !source ||
          !normalize(source.extractedContent).includes(normalize(ref.quote))
        ) {
          problems.push("文案依据无法定位到来源正文。");
          continue;
        }
        const existing = references.find(
          (r) =>
            r.paragraphIndex === paragraphIndex &&
            r.sourceId === ref.sourceId &&
            r.quote === ref.quote,
        );
        if (existing) {
          if (!existing.reportClaimIds.includes(claim.id!))
            existing.reportClaimIds.push(claim.id!);
        } else
          references.push({
            paragraphIndex,
            reportClaimIds: [claim.id!],
            sourceId: ref.sourceId,
            evidenceIds: evidence
              .filter(
                (record) =>
                  record.sourceId === ref.sourceId && record.text === ref.quote,
              )
              .map((record) => record.id),
            quote: ref.quote,
          });
      }
    return text;
  });
  const text = paragraphs.join("\n\n");
  const weightedLength = twitterText.parseTweet(text).weightedLength;
  const coverage = countCoverage(
    sources,
    references.map((ref) => ref.sourceId),
  );
  if (!coverage.requirementMet)
    problems.push("文案需要覆盖本轮全部已提取文章；一段可以引用多个信源。");
  if (weightedLength > limit)
    problems.push(
      `X 加权长度 ${weightedLength} 超过目标 ${limit}，需压缩；不得截断。`,
    );
  if (paragraphs.some((p) => !p)) problems.push("段落不可为空。");
  return {
    content: {
      status: "ready" as const,
      text,
      characterCount: [...text].length,
      weightedLength,
      targetLength: limit,
      warnings: [],
      claimReferences: references,
      coverage,
    },
    problems,
  };
}
// 只解码可显示文字；不做事实、数字、引用、段数或长度审批。
export function readSocialForDisplay(
  raw: unknown,
  report: Draft,
  sources: Source[],
  limit: number,
): SocialContent {
  const parsed = z.object({ paragraphs: z.array(z.object({ text: z.string() })) }).parse(raw);
  const paragraphs = parsed.paragraphs.map(item => normalizeSocialText(item.text)).filter(Boolean);
  if (!paragraphs.length) throw new Error("模型未返回可显示的社交文案。");
  const text = paragraphs.join("\n\n");
  // 依据仅在后台沿用研究简报及全部已提取文章，不要求写作模型输出引用编号。
  const completed = includeEveryArticle(report, sources, false);
  const claims = [...completed.summary];
  const records = evidenceRegistry(sources);
  const references = claims.flatMap((claim) =>
    claim.references.map((ref) => ({
      paragraphIndex: -1,
      reportClaimIds: [claim.claimId!],
      sourceId: ref.sourceId,
      quote: ref.quote,
      evidenceIds: records
        .filter(
          (record) =>
            record.sourceId === ref.sourceId && record.text === ref.quote,
        )
        .map((record) => record.id),
    })),
  );
  const weightedLength = twitterText.parseTweet(text).weightedLength;
  return {
    status: "ready",
    text,
    characterCount: [...text].length,
    weightedLength,
    targetLength: limit,
    claimReferences: references,
    coverage: countCoverage(
      sources,
      references.map((ref) => ref.sourceId),
    ),
    warnings: [
      ...(weightedLength > limit
        ? ["文案超过所选长度；未截断。请使用长帖或复制后自行调整。"]
        : []),
    ],
  };
}
