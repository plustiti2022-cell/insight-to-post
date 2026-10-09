import type { DataPoster, DataPosters, DataPostersResult } from "../../core/contracts";
import { readDataObservations, readStaticPosterSvg } from "../../core/data-posters";
import { dataExtractionPrompt, dataPosterPrompt } from "../prompts";
import { callQwen, outputText } from "../providers/qwen";
import { parseModelJson, rethrowCancellation } from "../runtime";
import { createLogger, failureDetails } from "../logger";

const logger = createLogger("data-posters");
const POSTER_CONCURRENCY = 2;

export async function generateDataPosters(
  coreObservation: string,
  signal?: AbortSignal,
  onUpdate?: (result: DataPosters) => Promise<void>,
  instructions?: string,
): Promise<DataPostersResult> {
  return logger.run("generate", { textLength: coreObservation.length }, async () => {
    const start = Date.now();
    let modelCalls = 0, totalTokens = 0;
    const result = (dataPosters: DataPosters): DataPostersResult => ({ dataPosters, modelCalls, totalTokens, durationMs: Date.now() - start });
    const publish = async (dataPosters: DataPosters) => {
      signal?.throwIfAborted();
      await onUpdate?.(structuredClone(dataPosters));
    };
    await publish({ status: "extracting", items: [] });
    let observations: string[];
    try {
      signal?.throwIfAborted();
      modelCalls++;
      const response = await callQwen(dataExtractionPrompt({ coreObservation, instructions }), signal,
        { model: "qwen3.8-flash", maxOutputTokens: 14000 });
      totalTokens += response.usage?.total_tokens ?? 0;
      signal?.throwIfAborted();
      observations = readDataObservations(parseModelJson(outputText(response)));
      logger.info("extraction.completed", { itemCount: observations.length, totalTokens });
    } catch (error) {
      rethrowCancellation(error, signal);
      logger.warn("extraction.failed", failureDetails(error));
      const failed: DataPosters = { status: "failed", items: [], error: error instanceof SyntaxError ? "数据提取返回的 JSON 无法解析。" : error instanceof Error ? error.message : "数据提取未完成。" };
      await publish(failed);
      return result(failed);
    }
    const items: DataPoster[] = observations.map((text, index) => ({ id: `D${index + 1}`, text, status: "pending" }));
    await publish({ status: items.length ? "generating" : "complete", items });
    let next = 0;
    async function worker() {
      while (next < items.length) {
        signal?.throwIfAborted();
        const index = next++;
        items[index] = { ...items[index], status: "generating" };
        await publish({ status: "generating", items });
        try {
          signal?.throwIfAborted();
          modelCalls++;
          const response = await callQwen(dataPosterPrompt({ text: items[index].text }), signal,
            { model: "qwen3.8-max", maxOutputTokens: 14000 });
          totalTokens += response.usage?.total_tokens ?? 0;
          signal?.throwIfAborted();
          items[index] = { ...items[index], status: "ready", svg: readStaticPosterSvg(outputText(response)) };
          logger.info("poster.completed", { index, outputLength: items[index].svg!.length });
        } catch (error) {
          rethrowCancellation(error, signal);
          logger.warn("poster.failed", { index, ...failureDetails(error) });
          items[index] = { ...items[index], status: "failed", error: error instanceof Error ? error.message : "SVG 生成失败。" };
        }
        await publish({ status: "generating", items });
      }
    }
    // 有限并发覆盖所有条目；单张失败仍继续，取消则等待所有在途任务退出。
    const workers = await Promise.allSettled(Array.from({ length: Math.min(POSTER_CONCURRENCY, items.length) }, () => worker()));
    for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
    signal?.throwIfAborted();
    const completed: DataPosters = { status: "complete", items };
    await publish(completed);
    return result(completed);
  }, signal);
}
