import type { z } from "zod";
import type { AnalysisEvent, SocialStreamEvent } from "../core/contracts";
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
  streamExecute?: (
    input: T,
    signal: AbortSignal,
    emit: (event: AnalysisEvent | SocialStreamEvent) => Promise<void>,
  ) => Promise<Extract<AnalysisEvent | SocialStreamEvent, { type: "result" | "social-result" }>>,
) {
  let active = 0;
  return async (request: Request): Promise<Response> => {
    if (active >= 2)
      return Response.json(
        { error: { code: "BUSY", message: options.busyMessage } },
        { status: 429, headers },
      );
    active++;
    let streaming = false;
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
      request.signal.throwIfAborted();
      if (streamExecute && request.headers.get("accept")?.includes("text/event-stream")) {
        const controller = new AbortController();
        const signal = AbortSignal.any([request.signal, controller.signal]);
        const encoder = new TextEncoder();
        let closed = false;
        let closeStream = () => {};
        const stream = new ReadableStream<Uint8Array>({
          start(output) {
            closeStream = () => {
              if (closed) return;
              closed = true;
              output.close();
            };
            const abort = () => { controller.abort(); closeStream(); };
            request.signal.addEventListener("abort", abort, { once: true });
            const emit = async (event: AnalysisEvent | SocialStreamEvent) => {
              signal.throwIfAborted();
              if (closed) throw new AnalysisError("CANCELLED", "分析已取消。", 499);
              output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            output.enqueue(encoder.encode(": connected\n\n"));
            const heartbeat = setInterval(() => {
              if (!closed) output.enqueue(encoder.encode(": keepalive\n\n"));
            }, 15000);
            // 响应头已返回后，错误通过事件发送；并发额度直到任务结束才释放。
            void Promise.resolve().then(async () => {
              signal.throwIfAborted();
              await emit(await streamExecute(input.data, signal, emit));
            }).catch(async (error: unknown) => {
              if (!closed && !signal.aborted) {
                const known = endpointError(error, signal, options);
                await emit({ type: "error", error: { code: known.code, message: known.message } });
              }
            }).finally(() => {
              clearInterval(heartbeat);
              request.signal.removeEventListener("abort", abort);
              closeStream();
              active--;
            });
          },
          cancel() {
            closed = true;
            controller.abort();
          },
        });
        streaming = true;
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-store, no-transform",
            "X-Accel-Buffering": "no",
          },
        });
      }
      return Response.json(await execute(input.data, request.signal), {
        headers,
      });
    } catch (error) {
      const known = endpointError(error, request.signal, options);
      return Response.json(
        { error: { code: known.code, message: known.message } },
        { status: known.status, headers },
      );
    } finally {
      if (!streaming) active--;
    }
  };
}

function endpointError(error: unknown, signal: AbortSignal, options: EndpointOptions) {
  return signal.aborted
    ? new AnalysisError("CANCELLED", "分析已取消。", 499)
    : error instanceof AnalysisError
      ? error
      : new AnalysisError("INTERNAL", options.failureMessage, 500);
}
