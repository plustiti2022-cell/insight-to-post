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
          model: process.env.QWEN_MODEL ?? "qwen3.8-flash",
          input,
          reasoning: { effort: "none" },
          store: false,
          max_output_tokens: 7000,
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
    const data = (await response.json()) as QwenResponse;
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
