import type { Draft, PublicSource, Reference } from "@/core/contracts";
import { canonicalUrl } from "@/core/sources";

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

export function CoreAnswer({ report, sources }: { report: Draft; sources: PublicSource[] }) {
  const blocks = report.answerBlocks ?? report.summary;
  const content = (item: Draft["summary"][number]) => <>
    {item.label && <strong>{item.label}： </strong>}{item.text}{" "}
    <SourceLinks references={item.references} sources={sources}/>
  </>;
  const elements = [];
  for (let index = 0; index < blocks.length; index++) {
    const item = blocks[index];
    if (item.presentation === "bullet") {
      const bullets = [];
      const start = index;
      while (index < blocks.length && blocks[index].presentation === "bullet") {
        bullets.push(<li key={index}>{content(blocks[index])}</li>);
        index++;
      }
      index--;
      elements.push(<ul className="answer-points" key={start}>{bullets}</ul>);
    } else {
      elements.push(<div key={index} className={`summary-item answer-${item.presentation ?? (index === 0 ? "lead" : "paragraph")}`}>
        <p>{content(item)}</p>
      </div>);
    }
  }
  return <div className="summary-box" aria-label="核心观察">
    {elements.length ? elements : <p>本次未能完成回答，请重新分析。</p>}
  </div>;
}
