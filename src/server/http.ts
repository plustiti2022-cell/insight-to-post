import type { z } from "zod";
import { AnalysisError } from "./runtime";

type EndpointOptions = {
  maxChars: number;
  busyMessage: string;
  invalidMessage: string;
  tooLargeMessage: string;
  failureMessage: string;
};
const headers = { "Cache-Control": "no-store" };

// 并发额度属于各个端点的闭包，处理失败/取消时也释放；默认仍为单进程上限 2。
export function jsonEndpoint<T>(
  schema: z.ZodType<T>,
  execute: (input: T, signal: AbortSignal) => Promise<unknown>,
  options: EndpointOptions,
) {
  let active = 0;
  return async (request: Request): Promise<Response> => {
    if (active >= 2)
      return Response.json(
        { error: { code: "BUSY", message: options.busyMessage } },
        { status: 429, headers },
      );
    active++;
    try {
      if (Number(request.headers.get("content-length")) > options.maxChars)
        throw new AnalysisError("TOO_LARGE", options.tooLargeMessage, 413);
      const text = await request.text();
      if (text.length > options.maxChars)
        throw new AnalysisError("TOO_LARGE", options.tooLargeMessage, 413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new AnalysisError("INVALID_INPUT", options.invalidMessage, 400);
      }
      const input = schema.safeParse(body);
      if (!input.success)
        throw new AnalysisError(
          "INVALID_INPUT",
          input.error.issues[0]?.message ?? options.invalidMessage,
          400,
        );
      return Response.json(await execute(input.data, request.signal), {
        headers,
      });
    } catch (error) {
      const known =
        error instanceof AnalysisError
          ? error
          : request.signal.aborted
            ? new AnalysisError("CANCELLED", "分析已取消。", 499)
            : new AnalysisError("INTERNAL", options.failureMessage, 500);
      return Response.json(
        { error: { code: known.code, message: known.message } },
        { status: known.status, headers },
      );
    } finally {
      active--;
    }
  };
}
