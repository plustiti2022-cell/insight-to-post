import { socialImageInputSchema } from "@/core/contracts";
import { jsonEndpoint } from "@/server/http";
import { createSocialImage } from "@/server/workflow/run";

export const runtime = "nodejs";
export const maxDuration = 400;
export const POST = jsonEndpoint(socialImageInputSchema, (input, signal) => createSocialImage(input.text, signal), {
  maxChars: 12000,
  busyMessage: "配图生成任务较多，请稍后重试。",
  invalidMessage: "请提供当前社交文案。",
  tooLargeMessage: "配图请求过长。",
  failureMessage: "配图生成失败，请重试。",
});
