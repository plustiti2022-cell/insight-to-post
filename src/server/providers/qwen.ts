import { AnalysisError } from "../runtime";

export type QwenResponse = {
  status?: string;
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  output_text?: string;
  usage?: { total_tokens?: number };
};
export async function callQwen(
  input: string,
  signal?: AbortSignal,
  options?: { model?: string; maxOutputTokens?: number; instructions?: string; onDelta?: (text: string) => Promise<void> },
): Promise<QwenResponse> {
  const key = process.env.QWEN_API_KEY;
  if (!key)
    throw new AnalysisError(
      "CONFIG_MISSING",
      "尚未配置千问密钥，请在服务器 .env.local 中设置 QWEN_API_KEY。",
      503,
    );
  const configured = Number(process.env.QWEN_TIMEOUT_MS ?? 150000);
  const timeout = AbortSignal.timeout(
    Number.isFinite(configured)
      ? Math.max(1000, Math.min(configured, 180000))
      : 150000,
  );
  try {
    const response = await fetch(
      `${(process.env.QWEN_BASE_URL ?? "https://maas.qianwenaiapi.com/compatible-mode/v1").replace(/\/$/, "")}/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options?.model ?? process.env.QWEN_MODEL ?? "qwen3.8-flash",
          input,
          reasoning: { effort: "none" },
          store: false,
          max_output_tokens: options?.maxOutputTokens ?? 7000,
          ...(options?.instructions ? { instructions: options.instructions } : {}),
          ...(options?.onDelta ? { stream: true } : {}),
        }),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        cache: "no-store",
      },
    );
    if (!response.ok) {
      // 不将上游原始错误（可能包含请求信息）传给客户端。
      await response.body?.cancel();
      if ([401, 403].includes(response.status))
        throw new AnalysisError(
          "AUTH_FAILED",
          "千问密钥无效或账号没有模型、工具权限，请检查后端配置。",
          503,
        );
      if (response.status === 429)
        throw new AnalysisError(
          "RATE_LIMITED",
          "千问请求额度或速率受限，请稍后重试并检查账号额度。",
          429,
        );
      throw new AnalysisError(
        "UPSTREAM_ERROR",
        `千问服务返回错误（HTTP ${response.status}），请稍后重试。`,
      );
    }
    const data = options?.onDelta
      ? await readQwenStream(response, options.onDelta, signal)
      : (await response.json()) as QwenResponse;
    if (data.status && data.status !== "completed")
      throw new AnalysisError(
        "INCOMPLETE",
        "研究未完整完成，请缩小问题范围后重试。",
      );
    return data;
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    if (timeout.aborted)
      throw new AnalysisError(
        "TIMEOUT",
        "联网研究耗时过长，请缩小问题范围后重试。",
        504,
      );
    if (signal?.aborted)
      throw new AnalysisError("CANCELLED", "分析已取消。", 499);
    throw new AnalysisError(
      "CONNECTION_FAILED",
      "暂时无法连接千问服务，请检查网络后重试。",
    );
  }
}

// Responses 协议只转发文字增量；思考、工具事件与响应 ID 不进入公开流。
async function readQwenStream(
  response: Response,
  onDelta: (text: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<QwenResponse> {
  if (!response.body) throw new AnalysisError("INCOMPLETE", "模型回复未完整完成。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", completed: QwenResponse | undefined, hasText = false;
  let ended = false;
  let text = "";
  async function frame(raw: string) {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    signal?.throwIfAborted();
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta !== "string") throw new AnalysisError("INCOMPLETE", "模型回复格式异常。");
      if (event.delta) { hasText = true; text += event.delta; await onDelta(event.delta); }
    } else if (event.type === "response.completed") {
      completed = event.response;
    } else if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
      throw new AnalysisError("UPSTREAM_ERROR", "模型未完成回复，请重试。", 502,
        { modelCalls: 1, totalTokens: event.response?.usage?.total_tokens ?? 0 });
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        await frame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (done) { ended = true; break; }
    }
    if (buffer.trim() || !completed || !hasText)
      throw new AnalysisError("INCOMPLETE", "模型回复未完整完成。", 502,
        { modelCalls: 1, totalTokens: completed?.usage?.total_tokens ?? 0 });
    // 以实际增量组成的内容为准；完成事件可能只携带状态和用量。
    return { ...completed, output_text: text };
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function outputText(data: QwenResponse) {
  return typeof data.output_text === "string" && data.output_text.trim()
    ? data.output_text
    : (data.output ?? [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === "output_text")
        .map((item) => item.text ?? "")
        .join("\n");
}
