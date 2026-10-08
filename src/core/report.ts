import { ANSWER_LEAD_MAX_LENGTH, type Draft, type Source } from "./contracts";
import { evidenceRegistry } from "./evidence";
import { assignClaimIds } from "./sources";

export function hasOpeningSummary(draft: Pick<Draft, "summary">) {
  const opening = draft.summary[0];
  return Boolean(opening && opening.presentation === "lead" &&
    opening.text.trim().length <= ANSWER_LEAD_MAX_LENGTH && opening.text.trim() &&
    !/[\r\n]/.test(opening.text.trim()) && !opening.label?.trim());
}

export function answerStructureIssues(summary: Draft["summary"]): string[] {
  const issues: string[] = [];
  if (!hasOpeningSummary({ summary }))
    issues.push(`开篇总结格式无效：summary[0]的presentation须为lead、无label、单段，且text最多${ANSWER_LEAD_MAX_LENGTH}字符。`);
  if (summary.slice(1).some((item) => item.presentation === "lead"))
    issues.push("后续内容包含重复lead，黑体首答位置或数量无效。");
  if (summary.some((item) => item.presentation === "bullet" && !item.label?.trim()))
    issues.push("bullet缺少简短要点标题label。");
  if (!summary.slice(1).some((item) => item.presentation === "bullet"))
    issues.push("展开内容缺少分点bullet，详细解释不能全部输出为普通段落。");
  if (summary.at(-1)?.presentation !== "conclusion")
    issues.push("回答缺少末尾conclusion，须在要点后完整给出结论。");
  return issues;
}

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
  const contentBlocks = draft.summary
    .filter((item) => !isArticleExcerpt(item.text))
    .map((item, index) => ({
      ...item,
      text: plain(item.text),
      ...(item.label ? { label: plain(item.label) } : {}),
      presentation: item.presentation ?? (index === 0 && item.text.trim().length <= ANSWER_LEAD_MAX_LENGTH && !/[\r\n]/.test(item.text.trim()) ? "lead" as const : "paragraph" as const),
    }))
    .filter((item) => item.text);
  const ideas = contentBlocks.map((item) => item.label ? `${item.label}：${item.text}` : item.text);
  const text =
    ideas.filter(Boolean).join("\n\n") ||
    (sources.length
      ? "本次未能完成对这个问题的回答，请重新分析。已提取的文章保留在下方，可打开原文查看。"
      : "本轮检索未取得可用正文，暂时无法依据资料回答这个问题。请重新检索，或补充具体的时间、地区和讨论范围。");
  const summary: Draft["summary"] = [{ text, references }];
  const answerBlocks: Draft["summary"] = contentBlocks.length
    ? hasOpeningSummary({ summary: contentBlocks })
      ? contentBlocks.map((item, index) => index > 0 && item.presentation === "lead" ? { ...item, presentation: "paragraph" } : item)
      : [
          { text: "本次未能生成简短总结，以下保留已核验的具体内容。", references: [], presentation: "lead" },
          ...contentBlocks.map((item) => item.presentation === "lead" ? { ...item, presentation: "paragraph" as const } : item),
        ]
    : [{ text, references: [], presentation: "lead" }];
  return assignClaimIds({
    ...draft,
    title: draft.title.slice(0, 150),
    summary,
    // 页面保留各段真实引用；完整纯文字与全部文章依据仍供既有社交逻辑使用。
    answerBlocks,
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
