import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createSocialImage } from "../src/server/workflow/run";
import { AnalysisError } from "../src/server/runtime";

// 默认文案是专门编写的演示输入，不额外调用研究或写作 API。
const text = process.argv[2] ? (await readFile(process.argv[2], "utf8")).trim() :
  "天啊，AI 写代码越来越快，我们反而更需要想清楚要做什么。\n\n把重复实现交给工具，把时间留给定义问题、核查结果和理解真实需求。\n\n你最想让 AI 接手哪一部分，又想把哪一种判断留在自己手里？";
const directory = "artifacts/social-image-example";
try {
  const result = await createSocialImage(text);
  const match = result.image.dataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
  if (!match) throw new Error("图片格式无效。");
  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/social.txt`, text + "\n");
  await writeFile(`${directory}/prompt.txt`, result.image.prompt + "\n");
  await writeFile(`${directory}/image.${extension}`, Buffer.from(match[2], "base64"));
  await writeFile(`${directory}/result.json`, JSON.stringify({ text, prompt: result.image.prompt, model: result.image.model, generatedAt: result.image.generatedAt, attempts: result.attempts, durationMs: result.durationMs, image: `image.${extension}` }, null, 2) + "\n");
  console.log(`真实图片验证完成：${directory}/image.${extension}，尝试 ${result.attempts} 次，耗时 ${(result.durationMs / 1000).toFixed(1)} 秒。`);
} catch (error) {
  // 未知异常的原始消息也可能含请求信息，不在真实验证中打印。
  console.error(error instanceof AnalysisError ? error.message : "真实图片验证失败，请检查 MiniMax 配置、权限及额度；未保存替代图片。");
  process.exitCode = 1;
}
