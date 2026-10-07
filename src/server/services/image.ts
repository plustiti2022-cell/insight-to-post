import type { SocialImageResult } from "../../core/contracts";
import { socialImagePrompt } from "../prompts";
import { callMiniMaxImage } from "../providers/minimax";
import { AnalysisError, rethrowCancellation } from "../runtime";

export async function generateSocialImage(text: string, signal?: AbortSignal): Promise<SocialImageResult> {
  const start = Date.now();
  const prompt = socialImagePrompt({ text });
  if (prompt.length > 1500) throw new AnalysisError("IMAGE_PROMPT_TOO_LONG", "配图提示词超过 1500 字符，请精简文案后重试。", 400);
  for (let attempt = 1; attempt <= 2; attempt++) {
    signal?.throwIfAborted();
    try {
      const image = await callMiniMaxImage(prompt, signal);
      signal?.throwIfAborted();
      return { image: { ...image, prompt, generatedAt: new Date().toISOString() }, attempts: attempt, durationMs: Date.now() - start };
    } catch (error) {
      rethrowCancellation(error, signal);
      if (attempt === 2 || (error instanceof AnalysisError && ["CONFIG_MISSING", "IMAGE_AUTH_FAILED", "IMAGE_BALANCE"].includes(error.code))) throw error;
    }
  }
  throw new Error("Image retry budget exhausted");
}
