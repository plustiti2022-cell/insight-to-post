import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AnalysisError } from "./runtime";

type Details = Record<string, string | number | boolean | undefined>;
const runs = new AsyncLocalStorage<string>();

// 只记录受控错误码，不输出错误消息、堆栈或上游响应中的请求信息。
export function failureDetails(error: unknown): Details {
  return {
    errorCode: error instanceof AnalysisError && /^[A-Z_]{1,64}$/.test(error.code)
      ? error.code
      : error instanceof Error && error.name === "AbortError"
        ? "CANCELLED"
        : "UNKNOWN",
  };
}

export function createLogger(scope: string) {
  function write(level: "info" | "warn" | "error", event: string, details: Details = {}) {
    console[level](JSON.stringify({
      ...details,
      timestamp: new Date().toISOString(),
      level,
      scope,
      event,
      runId: runs.getStore(),
    }));
  }
  return {
    info: (event: string, details?: Details) => write("info", event, details),
    warn: (event: string, details?: Details) => write("warn", event, details),
    async run<T>(event: string, details: Details, action: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
      return runs.run(runs.getStore() ?? randomUUID(), async () => {
        const start = Date.now();
        write("info", `${event}.started`, details);
        try {
          const result = await action();
          write("info", `${event}.completed`, { ...details, durationMs: Date.now() - start });
          return result;
        } catch (error) {
          const failure = failureDetails(error);
          const cancelled = signal?.aborted || failure.errorCode === "CANCELLED";
          write(cancelled ? "info" : "error", `${event}.${cancelled ? "cancelled" : "failed"}`, {
            ...details, ...failure, durationMs: Date.now() - start,
          });
          throw error;
        }
      });
    },
  };
}
