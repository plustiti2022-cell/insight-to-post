import type { Draft, Source } from "./contracts";
import { evidenceRegistry } from "./evidence";
import { assignClaimIds } from "./sources";

export function completeReport(draft: Draft, sources: Source[]): Draft {
  const report = includeEveryArticle(draft, sources);
  return {
    ...report,
    limitations: [
      ...new Set([
        ...report.limitations,
        "引用已进行来源、片段和数值锚点的本地检查；翻译、时间口径和推断仍需对照原文人工核验。",
        "未由工具返回的来源标题和发布日期显示未知；生成时间不代表资料发布时间。",
        "信源类型按已识别的域名保守归类，同一类型的多个网站不算多类。",
      ]),
    ],
  };
}

export function includeEveryArticle(draft: Draft, sources: Source[]): Draft {
  const records = evidenceRegistry(sources);
  const references = [...draft.summary.flatMap((item) => item.references)];
  const used = new Set(references.map((ref) => ref.sourceId));
  for (const source of sources)
    if (!used.has(source.id)) {
      const record = records.find((item) => item.sourceId === source.id);
      if (!record) continue;
      references.push({ sourceId: source.id, quote: record.text });
    }
  const ideas = draft.summary
    .filter((item) => !isArticleExcerpt(item.text))
    .map((item) => plain(item.text));
  const text =
    ideas.filter(Boolean).join("\n\n") ||
    (sources.length
      ? "本次未能完成对这个问题的回答，请重新分析。已提取的文章保留在下方，可打开原文查看。"
      : "本轮检索未取得可用正文，暂时无法依据资料回答这个问题。请重新检索，或补充具体的时间、地区和讨论范围。");
  const summary: Draft["summary"] = [{ text, references }];
  return assignClaimIds({
    ...draft,
    title: draft.title.slice(0, 150),
    summary,
  });
}
function isArticleExcerpt(text: string) {
  return /提供的原文线索|这段材料可与本次问题|值得关注的原文片段/.test(text);
}
function plain(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[#*`|\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
