import type { SocialGenerationResult, SocialPreviewEvent, SocialStreamEvent } from "../core/contracts";
import { readEventStream } from "./event-stream";

// 首次分析和独立重生成使用相同的段落顺序契约。
export function socialPreviewReader() {
  let started = false, index = 0;
  return (event: SocialPreviewEvent) => {
    if (event.type === "social-start") {
      if (started) throw new Error("文案轮次格式异常，请重试。");
      started = true;
    } else {
      if (!started || event.index !== index || typeof event.text !== "string" || !event.text.trim())
        throw new Error("文案段落格式异常，请重试。");
      index++;
    }
  };
}

export async function readSocialStream(response: Response, onEvent: (event: SocialPreviewEvent) => void): Promise<SocialGenerationResult> {
  let result: SocialGenerationResult | undefined;
  const preview = socialPreviewReader();
  await readEventStream(response, raw => {
    const event = raw as SocialStreamEvent;
    if (!event || typeof event !== "object" || result) throw new Error("文案数据格式异常，请重试。");
    if (event.type === "error") throw new Error(event.error?.message || "文案生成失败，请重试。");
    if (event.type === "social-start" || event.type === "social-block") {
      preview(event); onEvent(event);
    } else if (event.type === "social-result") {
      const content = event.result?.socialContent;
      if (!content || !["ready", "failed", "insufficient"].includes(content.status) || typeof content.text !== "string" || !content.coverage)
        throw new Error("文案数据格式异常，请重试。");
      result = event.result;
    } else throw new Error("文案数据格式异常，请重试。");
  });
  if (!result) throw new Error("连接中断，文案未完整完成，请重试。");
  return result;
}
