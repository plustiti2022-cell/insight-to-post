"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, RefreshCw, Download } from "lucide-react";
import type { SocialImage as Image } from "@/core/contracts";
import { VersionCarousel } from "./version-carousel";

export function SocialImage({ text, disabled = false }: { text: string; disabled?: boolean }) {
  const [versions, setVersions] = useState<{ items: Image[]; index: number }>({ items: [], index: 0 });
  const image = versions.items[versions.index];
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const initialText = useRef(text);
  const generate = useCallback(async (text: string) => {
    if (controller.current) return;
    const active = new AbortController();
    controller.current = active;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/social-image", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
        signal: AbortSignal.any([active.signal, AbortSignal.timeout(400000)]),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "配图生成失败，请重试。");
      if (controller.current === active && !active.signal.aborted) {
        setVersions(current => ({ items: [...current.items, data.image], index: current.items.length }));
      }
    } catch (error) {
      if (controller.current === active && !active.signal.aborted) setError(error instanceof Error ? error.message : "配图生成失败，请重试。");
    } finally {
      if (controller.current === active) { controller.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    // Defer until after effect setup so Strict Mode's discarded mount sends no request.
    const timer = setTimeout(() => { void generate(initialText.current); }, 0);
    return () => {
      clearTimeout(timer);
      controller.current?.abort();
      controller.current = null;
    };
  }, [generate]);
  const extension = image?.dataUrl.startsWith("data:image/jpeg") ? "jpg" : image?.dataUrl.startsWith("data:image/webp") ? "webp" : "png";
  return <div className="social-image-panel" aria-busy={loading}>
    <h4>社交配图</h4>
    <p className="social-description">首次文案完成后自动配图；重新生成保留历史图片，可左右切换。新配图使用当前选中的文案。</p>
    <button className="social-retry" disabled={loading || disabled} onClick={() => { void generate(text); }}>
      {loading ? <LoaderCircle size={16} className="spin"/> : image ? <RefreshCw size={16}/> : <ImagePlus size={16}/>}
      {loading ? "正在生成配图…" : image ? "重新生成配图" : "生成配图"}
    </button>
    {loading && <div className="social-image-loading" role="status" aria-live="polite">
      <LoaderCircle size={32} className="spin" aria-hidden="true"/>
      <p>正在绘制与文案主题对应的插画，请稍候…</p>
    </div>}
    {error && <p className="social-feedback" role="alert">{error}</p>}
    <VersionCarousel label="配图" count={versions.items.length} index={versions.index} onSelect={index => setVersions(current => ({ ...current, index }))}>
    {image && <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="social-image" src={image.dataUrl} alt="根据社交文案生成的 Corporate Memphis 和 Alegria 风格插画"/>
      <a className="social-retry" href={image.dataUrl} download={`social-image.${extension}`}><Download size={16}/> 下载配图</a>
      <details className="image-prompt"><summary>查看配图提示词</summary><p>{image.prompt}</p></details>
    </>}
    </VersionCarousel>
  </div>;
}
