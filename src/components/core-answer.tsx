import type { Draft, PublicSource, Reference } from "@/core/contracts";
import { canonicalUrl } from "@/core/sources";
import { hasOpeningSummary } from "@/core/report";

function SourceLinks({ references, sources }: { references: Reference[]; sources: PublicSource[] }) {
  const ids = [...new Set(references.map((reference) => reference.sourceId))];
  return <>{ids.map((id) => {
    const source = sources.find((item) => item.id === id);
    const url = source && canonicalUrl(source.url);
    if (!source || !url || !source.hasEvidence) return null;
    const host = new URL(url).hostname.replace(/^www\./, "");
    const label = host.replace(/\.(?:com|org|edu|gov|net)$/, "");
    return <a key={id} className="answer-source" href={url} target="_blank" rel="noopener noreferrer"
      title={source.title ? `${source.title} · ${host}` : host}
      aria-label={`打开信源 ${host}：${source.title || id}`}>{label}</a>;
  })}</>;
}

export function CoreAnswer({ report, sources, playback }: { report: Pick<Draft, "summary" | "answerBlocks">; sources: PublicSource[];
  playback?: { index: number; characters: number } }) {
  const allBlocks = report.answerBlocks ?? report.summary;
  const blocks = playback ? allBlocks.slice(0, playback.index + 1) : allBlocks;
  const content = (item: Draft["summary"][number], index: number, opening = false) => {
    const letters = Array.from(item.text);
    const typing = playback?.index === index && playback.characters < letters.length;
    const text = typing ? letters.slice(0, playback.characters).join("") : item.text;
    return <>
    {item.label && <strong>{item.label}： </strong>}
    {opening ? <strong className="answer-opening">{text}</strong> : text}{" "}
    {typing ? <span className="answer-cursor" aria-hidden="true">▍</span> : <SourceLinks references={item.references} sources={sources}/>}
  </>; };
  const elements = [];
  for (let index = 0; index < blocks.length; index++) {
    const item = blocks[index];
    const opening = index === 0 && hasOpeningSummary({ summary: [{ ...item, presentation: item.presentation ?? "lead" }] });
    if (item.presentation === "bullet") {
      const bullets = [];
      const start = index;
      while (index < blocks.length && blocks[index].presentation === "bullet") {
        bullets.push(<li key={index}>{content(blocks[index], index)}</li>);
        index++;
      }
      index--;
      elements.push(<ul className="answer-points" key={start}>{bullets}</ul>);
    } else {
      elements.push(<div key={index} className={`summary-item answer-${opening ? "lead" : item.presentation === "lead" ? "paragraph" : item.presentation ?? "paragraph"}`}>
        <p>{content(item, index, opening)}</p>
      </div>);
    }
  }
  return <div className="summary-box" aria-label="核心观察">
    {elements.length ? elements : <p>本次未能完成回答，请重新分析。</p>}
  </div>;
}
