import { z } from "zod";
import { AnalysisError } from "../runtime";
const resultSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  raw_content: z.string().nullish(),
  content: z.string().nullish(),
  published_date: z.string().nullish(),
  score: z.number().optional(),
});
const responseSchema = z.object({
  results: z.array(resultSchema),
  failed_results: z.array(z.object({ url: z.string() })).optional(),
  usage: z.object({ credits: z.number().nonnegative() }).optional(),
});
export type TavilyResult = z.infer<typeof resultSchema>;
export async function callTavily(
  endpoint: "search" | "extract",
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const key = process.env.TAVILY_API_KEY;
  if (!key)
    throw new AnalysisError(
      "TAVILY_CONFIG_MISSING",
      "尚未配置 Tavily 密钥，请运行启动脚本或设置 TAVILY_API_KEY。",
      503,
    );
  const configured = Number(process.env.TAVILY_TIMEOUT_MS ?? 60000);
  const timeout = AbortSignal.timeout(
    Number.isFinite(configured)
      ? Math.max(1000, Math.min(configured, 90000))
      : 60000,
  );
  try {
    const response = await fetch(
      `${(process.env.TAVILY_BASE_URL ?? "https://api.tavily.com").replace(/\/$/, "")}/${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        cache: "no-store",
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status))
        throw new AnalysisError(
          "TAVILY_AUTH_FAILED",
          "Tavily 密钥无效或权限不足，请检查后端配置。",
          503,
        );
      if ([429, 432, 433].includes(response.status))
        throw new AnalysisError(
          "TAVILY_LIMIT",
          "Tavily 请求速率或额度受限，请稍后重试并检查额度。",
          429,
        );
      throw new AnalysisError(
        "TAVILY_UPSTREAM",
        `Tavily 服务返回错误（HTTP ${response.status}），请稍后重试。`,
      );
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new AnalysisError(
        "TAVILY_FORMAT",
        "Tavily 返回格式无法识别，请重试。",
      );
    return parsed.data;
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    if (signal?.aborted)
      throw new AnalysisError("CANCELLED", "分析已取消。", 499);
    if (timeout.aborted)
      throw new AnalysisError(
        "TAVILY_TIMEOUT",
        "Tavily 检索或提取超时，请重试。",
        504,
      );
    throw new AnalysisError(
      "TAVILY_CONNECTION",
      "暂时无法连接 Tavily，请检查网络后重试。",
    );
  }
}
export const searchTavily = (
  query: string,
  signal?: AbortSignal,
  excludeDomains: string[] = [],
) =>
  callTavily(
    "search",
    {
      query,
      search_depth: "advanced",
      max_results: 15,
      include_raw_content: "markdown",
      include_answer: false,
      auto_parameters: false,
      include_usage: true,
      include_published_date: true,
      exclude_domains: excludeDomains,
    },
    signal,
  );
export const extractTavily = (urls: string[], signal?: AbortSignal) =>
  callTavily(
    "extract",
    {
      urls,
      extract_depth: "advanced",
      format: "markdown",
      include_usage: true,
      timeout: 30,
    },
    signal,
  );
