import { ArrowUpRight } from "lucide-react";
import type { Card, Reference } from '@/core/contracts';
export function Citation({ references, onSource }: { references: Reference[]; onSource: (id: string, refs: Reference[]) => void }) {
  return <span className="citation-list">{[...new Set(references.map(ref => ref.sourceId))].map(id => <button className="citation" key={id} onClick={() => onSource(id, references)} aria-label={`查看来源 ${id.replace("S", "")} 的证据`}>[{id.replace("S", "")}] <ArrowUpRight size={12}/></button>)}</span>;
}
export function MetricCard({ card, index, onSource }: { card: Card; index: number; onSource: (id: string, refs: Reference[]) => void }) {
  const prefix = ["$", "€", "£", "¥"].find(symbol => card.references.some(ref => ref.quote.includes(`${symbol}${card.value}`))) || "";
  return <article className="metric-card"><div className="metric-top"><span className="metric-index">METRIC / {String(index + 1).padStart(2, "0")}</span><span className="evidence-label"><i/> 证据可回溯</span></div>
    <h3>{card.label}</h3><div className="metric-value">{prefix}{card.value}<span>{card.unit}</span></div><p className="metric-explanation">{card.explanation}</p>
    <dl className="metric-context"><div><dt>数据时间</dt><dd>{card.period}</dd></div><div><dt>统计范围</dt><dd>{card.scope}</dd></div></dl>
    <div className="metric-footer"><span>查看依据</span><Citation references={card.references} onSource={onSource}/></div>
  </article>;
}
