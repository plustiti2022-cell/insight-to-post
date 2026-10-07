"use client";
import { useEffect, useRef } from "react";
import { X, ArrowUpRight, FileText } from "lucide-react";
import type { PublicSource, Reference } from '@/core/contracts';
import { sourceStatusLabels } from '@/core/sources';
export type Selection = { source: PublicSource; quotes: Reference[] };
export function SourceSheet({ selection, close }: { selection: Selection | null; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!selection || !element) return;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { element.close(); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, [selection]);
  if (!selection) return null;
  const { source, quotes } = selection;
  return <dialog ref={dialog} className="source-dialog" aria-labelledby="source-title" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="sheet-content"><div className="sheet-handle"/><div className="sheet-top"><span className="eyebrow"><FileText size={15}/> 来源 {source.id.replace("S", "")}</span><button autoFocus className="icon-button" aria-label="关闭来源" onClick={close}><X size={20}/></button></div>
    <h2 id="source-title">{source.title || "标题未知"}</h2><p className="source-domain">{new URL(source.url).hostname}</p>
    <div className="source-meta"><span>{source.sourceType}</span><span>{sourceStatusLabels[source.status]}</span><span>{source.publishedAt || "发布日期未知"}</span></div>
    <p className="muted">{source.statusReason}</p>
    <h3 className="quote-heading">{quotes.length ? "支持此结论的证据片段" : "证据状态"}</h3>
    {quotes.length ? [...new Set(quotes.map(ref => ref.quote))].map(quote => <blockquote key={quote}>{quote}</blockquote>) : null}
    <p className="sheet-note">{quotes.length ? "片段来自本次网页提取。请打开原文核对上下文、统计范围和数据时间。" : "此来源没有被本次最终报告引用；仍可打开原文自行查看。"}</p>
    <a className="primary-link" href={source.url} target="_blank" rel="noopener noreferrer">打开原文 <ArrowUpRight size={18}/></a></div>
  </dialog>;
}
