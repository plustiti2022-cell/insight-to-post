import { ANSWER_LEAD_MAX_LENGTH, displayStatementSchema, type Draft, type Source, type Card } from "./contracts";
import { evidenceRegistry, type EvidenceRecord } from "./evidence";
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

export function completeReport(draft: Draft, sources: Source[], validateCoreContent = true): Draft {
  const report = includeEveryArticle(draft, sources, validateCoreContent);
  return {
    ...report,
    limitations: [
      ...new Set([
        ...report.limitations,
        validateCoreContent
          ? "引用已进行来源、片段和数值锚点的本地检查；翻译、时间口径和推断仍需对照原文人工核验。"
          : "本实验分支已关闭核心内容校验；段末标签仅用于打开模型引用的真实文章。",
        "未由工具返回的来源标题和发布日期显示未知；生成时间不代表资料发布时间。",
        "信源类型按已识别的域名保守归类，同一类型的多个网站不算多类。",
      ]),
    ],
  };
}

export function includeEveryArticle(draft: Draft, sources: Source[], validateCoreContent = true): Draft {
  const records = evidenceRegistry(sources);
  const references = [...draft.summary.flatMap((item) => item.references)];
  const used = new Set(references.map((ref) => ref.sourceId));
  for (const source of sources)
    if (!used.has(source.id)) {
      const record = records.find((item) => item.sourceId === source.id);
      if (!record) continue;
      references.push({ sourceId: source.id, quote: record.text });
    }
  const contentBlocks = draft.summary.flatMap((item, index) => {
    const block = presentAnswerBlock(item, index, validateCoreContent);
    return block ? [block] : [];
  });
  const ideas = contentBlocks.map((item) => item.label ? `${item.label}：${item.text}` : item.text);
  const text =
    ideas.filter(Boolean).join("\n\n") ||
    (sources.length
      ? "本次未能完成对这个问题的回答，请重新分析。已提取的文章保留在下方，可打开原文查看。"
      : "本轮检索未取得可用正文，暂时无法依据资料回答这个问题。请重新检索，或补充具体的时间、地区和讨论范围。");
  const summary: Draft["summary"] = [{ text, references }];
  const answerBlocks: Draft["summary"] = !validateCoreContent ? contentBlocks : contentBlocks.length
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
// 预览和正式报告共享纯文字整理，避免确认报告时出现不同的正文。
export function presentAnswerBlock(item: Draft["summary"][number], index: number, validateCoreContent = true) {
  if (validateCoreContent && isArticleExcerpt(item.text)) return undefined;
  const text = plain(item.text);
  if (!text) return undefined;
  return {
    ...item, text,
    ...(item.label ? { label: plain(item.label) } : {}),
    presentation: item.presentation ?? (index === 0 && text.length <= ANSWER_LEAD_MAX_LENGTH && !/[\r\n]/.test(text) ? "lead" as const : "paragraph" as const),
  };
}
// 实验模式只解码展示字段、映射真实证据；无法映射的标签不影响正文。
function displayReferences(raw: unknown, records: EvidenceRecord[]) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(ref => {
    if (!ref || typeof ref !== "object") return [];
    const record = records.find(item => item.sourceId === ref.sourceId && item.id === ref.evidenceId);
    return record ? [{ sourceId: record.sourceId, quote: record.text }] : [];
  });
}
export function readAnswerForDisplay(raw: unknown, records: EvidenceRecord[], index: number) {
  if (!raw || typeof raw !== "object" || !("text" in raw) || typeof raw.text !== "string")
    throw new Error("报告段落缺少可显示的文字字段。");
  const item = raw as Record<string, unknown>;
  const block = displayStatementSchema.parse({
    text: item.text,
    label: typeof item.label === "string" ? item.label : undefined,
    presentation: ["lead", "bullet", "paragraph", "conclusion"].includes(String(item.presentation))
      ? item.presentation : "paragraph",
    references: displayReferences(item.references, records),
  });
  return presentAnswerBlock(block, index, false) ?? { ...block, text: "" };
}
export function readReportForDisplay(raw: unknown, records: EvidenceRecord[], idea: string): Draft {
  if (!raw || typeof raw !== "object" || !("summary" in raw) || !Array.isArray(raw.summary))
    throw new Error("报告缺少可显示的段落数组。");
  const input = raw as Record<string, unknown>;
  const summary = raw.summary.map((item, index) => readAnswerForDisplay(item, records, index));
  if (!summary.some(block => block.text.trim())) throw new Error("模型未返回正文。");
  const cards: Card[] = Array.isArray(input.cards) ? input.cards.flatMap(rawCard => {
    if (!rawCard || typeof rawCard !== "object") return [];
    const card = rawCard as Record<string, unknown>;
    const text = (key: string) => typeof card[key] === "string" || typeof card[key] === "number" ? String(card[key]) : "";
    return [{
      label: text("label"), value: text("value"), unit: text("unit"), explanation: text("explanation"),
      period: text("period"), scope: text("scope"), valueEvidence: text("valueEvidence"),
      unitEvidence: text("unitEvidence"), timeEvidence: text("timeEvidence"),
      references: displayReferences(card.references, records),
    }];
  }) : [];
  return { title: idea.slice(0, 150), summary, cards,
    limitations: Array.isArray(input.limitations) ? input.limitations.filter((item): item is string => typeof item === "string") : [],
  };
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
