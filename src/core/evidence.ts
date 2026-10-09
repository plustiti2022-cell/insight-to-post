import type { Draft, Reference, Source } from "./contracts";

export type EvidenceRecord = { id: string; sourceId: string; text: string };
export function evidenceRegistry(sources: Source[], query?: string) {
  const records: EvidenceRecord[] = [];
  for (const source of sources.filter((source) => source.extractedContent)) {
    const sourceRecords: EvidenceRecord[] = [];
    let index = 0;
    for (const paragraph of source.extractedContent
      .slice(0, 25000)
      .split(/\n\s*\n/)
      .filter((text) => text.trim().length >= 30)) {
      for (let offset = 0; offset < paragraph.length; offset += 3500) {
        const text = paragraph.slice(offset, offset + 3500).trim();
        if (text.length >= 30)
          sourceRecords.push({
            id: `${source.id}-E${++index}`,
            sourceId: source.id,
            text,
          });
      }
    }
    if (!sourceRecords.length && source.extractedContent.trim().length >= 30)
      sourceRecords.push({
        id: `${source.id}-E1`,
        sourceId: source.id,
        text: source.extractedContent.slice(0, 3500).trim(),
      });
    if (!query) {
      records.push(...sourceRecords);
      continue;
    }
    const words = [
      ...new Set(
        query.toLowerCase().match(/[a-z][a-z0-9-]{1,}|[\u4e00-\u9fff]{2}/g) ??
          [],
      ),
    ];
    const score = (record: EvidenceRecord) =>
      words.reduce(
        (sum, word) => sum + (record.text.toLowerCase().includes(word) ? 5 : 0),
        0,
      ) +
      (/\d{4}|\d+(?:\.\d+)?\s*%/.test(record.text) ? 2 : 0) +
      (/limitation|human|risk|evaluation|constraint|局限|人类|评估|限制/i.test(
        record.text,
      )
        ? 2
        : 0) -
      (/privacy policy|cookie settings|sign in|subscribe|menu/i.test(
        record.text,
      )
        ? 4
        : 0);
    let budget = 0;
    for (const record of [...sourceRecords].sort(
      (a, b) => score(b) - score(a),
    )) {
      if (budget + record.text.length > 7000 && budget > 0) continue;
      records.push(record);
      budget += record.text.length;
      if (budget >= 7000) break;
    }
  }
  return records;
}
export function hydrateReferences(raw: unknown, records: EvidenceRecord[]) {
  if (!raw || typeof raw !== "object") throw new Error("报告必须是JSON对象");
  const input = raw as Record<string, unknown>;
  const hydrate = (items: unknown) => {
    if (!Array.isArray(items)) throw new Error("summary和cards必须是数组");
    return items.map((item) => {
      if (!item || typeof item !== "object" || !Array.isArray(item.references))
        throw new Error("每个总结或卡片必须有references数组");
      return {
        ...item,
        references: item.references.map(
          (ref: { sourceId?: string; evidenceId?: string }) => {
            const record = records.find(
              (record) =>
                record.id === ref.evidenceId &&
                record.sourceId === ref.sourceId,
            );
            if (!record)
              throw new Error(
                "unknown evidence：references中的sourceId与evidenceId必须对应输入证据表的同一条记录；evidenceId是单个字符串，不可填数组，不可用没有提供的编号",
              );
            return { sourceId: record.sourceId, quote: record.text };
          },
        ),
      };
    });
  };
  return {
    ...input,
    summary: hydrate(input.summary),
    cards: hydrate(input.cards),
  };
}

export const normalize = (value: string) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim();
function numbers(value: string) {
  return (
    normalize(value)
      .match(/\d[\d,]*(?:\.\d+)?/g)
      ?.map((n) => n.replace(/,/g, "")) ?? []
  );
}
function validReferences(references: Reference[], sources: Source[]) {
  return (
    references.length > 0 &&
    references.every((ref) => {
      const source = sources.find((item) => item.id === ref.sourceId);
      return (
        source &&
        source.extractedContent &&
        normalize(source.extractedContent).includes(normalize(ref.quote))
      );
    })
  );
}
function numericMatch(text: string, evidence: string) {
  const available = numbers(evidence);
  return numbers(text).every((value) => available.includes(value));
}
export function validAnswerEvidence(item: Draft["summary"][number], sources: Source[]) {
  return validReferences(item.references, sources) && numericMatch(
    [item.label, item.text].filter(Boolean).join(" "),
    item.references.map((ref) => ref.quote).join(" "),
  );
}

export function validateReport(draft: Draft, sources: Source[]) {
  const warnings: string[] = [];
  const cards = draft.cards.filter((card) => {
    const quote = normalize(card.references.map((ref) => ref.quote).join(" "));
    const anchors = [card.valueEvidence, card.unitEvidence, card.timeEvidence];
    const paired =
      quote.includes(normalize(`${card.valueEvidence}${card.unitEvidence}`)) ||
      quote.includes(normalize(`${card.valueEvidence} ${card.unitEvidence}`));
    const valid =
      validReferences(card.references, sources) &&
      /^\d[\d,]*(?:\.\d+)?$/.test(normalize(card.value)) &&
      numbers(card.value).length === 1 &&
      paired &&
      normalize(card.value) === normalize(card.valueEvidence) &&
      normalize(card.unit) === normalize(card.unitEvidence) &&
      anchors.every((anchor) => quote.includes(normalize(anchor))) &&
      numbers(card.timeEvidence).length > 0 &&
      numericMatch(card.period, card.timeEvidence) &&
      numericMatch(
        [
          card.label,
          card.value,
          card.explanation,
          card.period,
          card.scope,
        ].join(" "),
        quote,
      );
    if (!valid)
      warnings.push(
        `“${card.label}”的证据、数值或口径锚点未通过校验，已移除。`,
      );
    return valid;
  });
  const summary = draft.summary.filter((item) => {
    const valid = validAnswerEvidence(item, sources);
    if (!valid)
      warnings.push("一条总结缺少可定位证据或包含未支持的数字，已移除。");
    return valid;
  });
  return { report: { ...draft, cards, summary }, warnings };
}
