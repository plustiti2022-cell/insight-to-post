import { AnalysisError } from "../runtime";

// 只处理 MiniMax 协议；次数预算与提示词由业务服务管理。
export async function callMiniMaxImage(prompt: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new AnalysisError("CONFIG_MISSING", "请在服务器配置 MINIMAX_API_KEY。", 503);
  const configured = Number(process.env.MINIMAX_TIMEOUT_MS ?? 120000);
  const timeout = AbortSignal.timeout(Number.isFinite(configured) ? Math.max(1000, Math.min(configured, 180000)) : 120000);
  const model = "image-01";
  try {
    const response = await fetch(`${(process.env.MINIMAX_BASE_URL ?? "https://api.minimax.cn/v1").replace(/\/$/, "")}/image_generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: "3:4", response_format: "base64", prompt_optimizer: false }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new AnalysisError("IMAGE_AUTH_FAILED", "MiniMax 图片密钥无效或无权限。", 503);
      if (response.status === 429) throw new AnalysisError("IMAGE_RATE_LIMITED", "MiniMax 图片请求受限，请稍后重试。", 429);
      throw new AnalysisError("IMAGE_UPSTREAM_ERROR", `图片生成失败（HTTP ${response.status}）。`);
    }
    const data = await response.json();
    signal?.throwIfAborted();
    const status = data?.base_resp?.status_code;
    if (status !== 0) {
      if ([1004, 2049].includes(status)) throw new AnalysisError("IMAGE_AUTH_FAILED", "MiniMax 图片密钥无效或无权限。", 503);
      if (status === 1008) throw new AnalysisError("IMAGE_BALANCE", "MiniMax 图片账户余额不足。", 503);
      if (status === 1002) throw new AnalysisError("IMAGE_RATE_LIMITED", "MiniMax 图片请求受限，请稍后重试。", 429);
      // 不输出上游 status_msg，避免将请求信息或密钥带入页面与日志。
      throw new AnalysisError("IMAGE_UPSTREAM_ERROR", "MiniMax 未完成图片生成。");
    }
    const images = data?.data?.image_base64;
    if (!Array.isArray(images) || images.length !== 1 || typeof images[0] !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(images[0]) || images[0].length % 4 !== 0)
      throw new AnalysisError("INVALID_IMAGE", "MiniMax 未返回一张有效图片。");
    const bytes = Buffer.from(images[0], "base64");
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
    if (!mime) throw new AnalysisError("INVALID_IMAGE", "MiniMax 图片格式无效。");
    return { dataUrl: `data:${mime};base64,${images[0]}`, model };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof AnalysisError) throw error;
    if (timeout.aborted) throw new AnalysisError("IMAGE_TIMEOUT", "图片生成超时，请重试。", 504);
    throw new AnalysisError("IMAGE_CONNECTION_FAILED", "无法完成 MiniMax 图片请求，请重试。");
  }
}
