export class AnalysisError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 502,
    public modelUsage?: { modelCalls: number; totalTokens: number },
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

export type Observer = (stage: string, data: unknown) => Promise<void>;

export function rethrowCancellation(
  error: unknown,
  signal?: AbortSignal,
): void {
  if (
    signal?.aborted ||
    (error instanceof AnalysisError && error.code === "CANCELLED")
  )
    throw error;
}

// 所有模型返回都经过同一 JSON 边界；结构和事实校验由各业务规则负责。
export function parseModelJson(text: string): unknown {
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, ""),
  );
}
