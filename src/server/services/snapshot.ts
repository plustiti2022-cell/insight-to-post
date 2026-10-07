import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { draftSchema, type Draft, type Source } from "../../core/contracts";
import { AnalysisError } from "../runtime";
import { reportCoverage } from "../../core/sources";
import { socialContentPrompt } from "../prompts";
const snapshotSchema = z.object({
  report: draftSchema,
  targetLength: z.number().min(100).max(25000).default(280),
  prompt: z.string().min(1).max(20000),
  expires: z.number(),
  sources: z
    .array(
      z.object({
        id: z.string(),
        url: z.string().url(),
        title: z.string().nullable(),
        sourceType: z.enum([
          "研究论文",
          "官方统计",
          "机构报告",
          "新闻",
          "其他",
          "未知",
        ]),
        publishedAt: z.string().nullable(),
        extractedContent: z.string().max(25000),
        extractionStatus: z.literal("available"),
        extractionReason: z.string(),
      }),
    )
    .max(30),
});
function signature(payload: string) {
  return createHmac(
    "sha256",
    process.env.SOCIAL_SNAPSHOT_SECRET || process.env.QWEN_API_KEY || "",
  )
    .update(payload)
    .digest("base64url");
}
export function signSocialSnapshot(
  report: Draft,
  sources: Source[],
  targetLength = 280,
) {
  const refs = [
    ...report.summary.flatMap((s) => s.references),
    ...report.cards.flatMap((c) => c.references),
  ];
  const excerpts = sources.map((s) => ({
    ...s,
    extractedContent: (
      [
        ...new Set(
          refs.filter((ref) => ref.sourceId === s.id).map((ref) => ref.quote),
        ),
      ].join("\n\n") || s.extractedContent.slice(0, 3500)
    ).slice(0, 25000),
  }));
  const prompt = socialContentPrompt({
    coreObservation: report.summary[0]?.text ?? "",
    targetLength,
  });
  const payload = Buffer.from(
    JSON.stringify({
      report,
      sources: excerpts,
      targetLength,
      prompt,
      expires: Date.now() + 2 * 60 * 60 * 1000,
    }),
  ).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
export function readSocialSnapshot(token: string) {
  const parts = token.split(".");
  if (parts.length !== 2)
    throw new AnalysisError(
      "INVALID_SNAPSHOT",
      "文案重试数据无效，请重新分析。",
      400,
    );
  const expected = Buffer.from(signature(parts[0])),
    received = Buffer.from(parts[1]);
  if (
    !process.env.QWEN_API_KEY ||
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    throw new AnalysisError(
      "INVALID_SNAPSHOT",
      "文案重试数据已被修改，请重新分析。",
      400,
    );
  let snapshot: z.infer<typeof snapshotSchema>;
  try {
    snapshot = snapshotSchema.parse(
      JSON.parse(Buffer.from(parts[0], "base64url").toString()),
    );
  } catch {
    throw new AnalysisError(
      "INVALID_SNAPSHOT",
      "文案重试数据无效，请重新分析。",
      400,
    );
  }
  if (snapshot.expires < Date.now())
    throw new AnalysisError(
      "SNAPSHOT_EXPIRED",
      "报告已超过文案重试时限，请重新分析。",
      400,
    );
  if (!reportCoverage(snapshot.report, snapshot.sources).requirementMet)
    throw new AnalysisError(
      "INSUFFICIENT_SNAPSHOT",
      "报告证据不足，不能生成文案。",
      400,
    );
  return snapshot;
}
