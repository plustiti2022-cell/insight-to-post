"use client";
import { useEffect, useState } from "react";
import type { Analysis, ReportPreview } from "@/core/contracts";
import { CoreAnswer } from "./core-answer";

// 每轮使用独立 key 挂载。只有已通过段落检查的完整文本会进入播放队列。
export function ReportPreviewView({ preview, title, confirmed, onComplete }: {
  preview: ReportPreview; title: string; confirmed: Analysis | null; onComplete: () => void;
}) {
  const [playback, setPlayback] = useState({ index: 0, characters: 0 });
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(query.matches);
    change(); query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => setPlayback(current => {
      const block = preview.blocks[current.index];
      if (!block) return current;
      const length = Array.from(block.text).length;
      if (current.characters >= length) {
        return current.index + 1 < preview.blocks.length ? { index: current.index + 1, characters: 0 } : current;
      }
      // 通常每20毫秒一个字；长段落加快播放，单段最多约5秒。
      return { ...current, characters: Math.min(length, current.characters + Math.max(1, Math.ceil(length / 250))) };
    }), 20);
    return () => clearInterval(timer);
  }, [preview.blocks, reducedMotion]);
  const finished = reducedMotion || !preview.blocks.length ||
    (playback.index === preview.blocks.length - 1 && playback.characters >= Array.from(preview.blocks[playback.index].text).length);
  useEffect(() => {
    if (!confirmed) return;
    const blocks = confirmed.report.answerBlocks ?? confirmed.report.summary;
    const matches = blocks.length === preview.blocks.length && blocks.every((block, index) => {
      const prior = preview.blocks[index];
      return block.text === prior.text && block.label === prior.label && block.presentation === prior.presentation &&
        JSON.stringify(block.references) === JSON.stringify(prior.references);
    });
    // 正式结果具有最终决定权；相同时播放完再切换，不突然跳出整篇文字。
    if (finished || !matches) onComplete();
  }, [confirmed, finished, onComplete, preview.blocks]);
  return <section className="report report-preview" data-testid="report-preview" aria-labelledby="preview-title">
    <div className="report-header"><span className="eyebrow">RESEARCH BRIEF / 研究简报</span>
      <span className="status-badge partial">{confirmed ? "正在展示报告" : preview.attempt === 2 ? "正在重新生成" : "正在生成"}</span></div>
    <h2 id="preview-title">{title}</h2>
    <p className="report-preview-status" role="status">{confirmed ? "完整报告已通过校验。" :
      preview.blocks.length ? "段落已核对引用，完整报告仍在生成与校验中。" :
        preview.attempt === 2 ? "部分内容未通过校验，正在重新生成。" : "正在生成并核对第一段内容…"}</p>
    {preview.blocks.length > 0 && <CoreAnswer report={{ summary: preview.blocks }} sources={preview.sources}
      playback={reducedMotion ? undefined : playback}/>}
  </section>;
}
