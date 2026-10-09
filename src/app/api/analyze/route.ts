import { inputSchema } from "@/core/contracts";
import { analyze } from "@/server/workflow/run";
import { jsonEndpoint } from "@/server/http";

export const runtime = "nodejs";
export const maxDuration = 600;
export const POST = jsonEndpoint(
  inputSchema,
  (input, signal) =>
    analyze(input.idea, signal, undefined, input.socialTargetLength),
  {
    maxChars: 12000,
    busyMessage: "当前研究任务较多，请稍后重试。",
    invalidMessage: "请输入有效的问题。",
    tooLargeMessage: "请求内容过长。",
    failureMessage: "分析遇到异常，请稍后重试。",
  },
  async (input, signal, emit) =>
    ({ type: "result", analysis: await analyze(input.idea, signal, undefined, input.socialTargetLength, emit) }),
);
