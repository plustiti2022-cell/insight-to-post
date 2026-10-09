import { callQwen } from "../providers/qwen";
import { openingPrompt } from "../prompts";
import { createLogger } from "../logger";

const logger = createLogger("opening");

export async function streamOpening(
  idea: string,
  signal: AbortSignal | undefined,
  onDelta: (text: string) => Promise<void>,
): Promise<void> {
  await logger.run("generate", { ideaLength: idea.length }, async () => {
    signal?.throwIfAborted();
    const started = Date.now();
    let firstTokenMs: number | undefined;
    const response = await callQwen(openingPrompt({ idea }), signal, {
      model: process.env.QWEN_OPENING_MODEL ?? "qwen3.8-flash",
      maxOutputTokens: 400,
      onDelta: async text => {
        signal?.throwIfAborted();
        if (firstTokenMs === undefined) {
          firstTokenMs = Date.now() - started;
          logger.info("firstToken", { firstTokenMs, targetMs: 2000 });
        }
        await onDelta(text);
      },
    });
    signal?.throwIfAborted();
    logger.info("completed", { firstTokenMs, totalTokens: response.usage?.total_tokens ?? 0 });
  }, signal);
}
