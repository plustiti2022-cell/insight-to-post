import { z } from "zod";
import { readSocialSnapshot } from "@/server/services/snapshot";
import { generateSocialContent } from "@/server/services/social";
import { jsonEndpoint } from "@/server/http";

export const runtime = "nodejs";
export const maxDuration = 600;
const inputSchema = z.object({
  token: z.string({ error: "请从当前报告重试文案。" }),
});
export const POST = jsonEndpoint(
  inputSchema,
  async (input, signal) => {
    const snapshot = readSocialSnapshot(input.token);
    return generateSocialContent(
      snapshot.report,
      snapshot.sources,
      signal,
      undefined,
      snapshot.targetLength,
      { fallback: "fail", originalPrompt: snapshot.prompt },
    );
  },
  {
    maxChars: 1000000,
    busyMessage: "文案生成任务较多，请稍后重试。",
    invalidMessage: "文案重试数据无效。",
    tooLargeMessage: "重试数据过长。",
    failureMessage: "文案重试失败，请稍后重试。",
  },
);
