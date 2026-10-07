"use client";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, RefreshCw, Download } from "lucide-react";
import type { SocialImage as Image } from "@/core/contracts";

export function SocialImage({ text }: { text: string }) {
  const [image, setImage] = useState<Image | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
  async function generate() {
    if (controller.current) return;
    const active = new AbortController();
    controller.current = active;
    setLoading(true); setError(""); setImage(null);
    try {
      const response = await fetch("/api/social-image", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
        signal: AbortSignal.any([active.signal, AbortSignal.timeout(400000)]),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "配图生成失败，请重试。");
      if (controller.current === active && !active.signal.aborted) setImage(data.image);
    } catch (error) {
      if (controller.current === active && !active.signal.aborted) setError(error instanceof Error ? error.message : "配图生成失败，请重试。");
    } finally {
      if (controller.current === active) { controller.current = null; setLoading(false); }
    }
  }
  const extension = image?.dataUrl.startsWith("data:image/jpeg") ? "jpg" : image?.dataUrl.startsWith("data:image/webp") ? "webp" : "png";
  return <div className="social-image-panel">
    <h4>社交配图</h4>
    <p className="social-description">根据当前文案生成 1 张 Corporate Memphis / Alegria 插画</p>
    <button className="social-retry" disabled={loading} onClick={generate}>
      {loading ? <LoaderCircle size={16} className="spin"/> : image ? <RefreshCw size={16}/> : <ImagePlus size={16}/>}
      {loading ? "正在生成配图…" : image ? "重新生成配图" : "生成配图"}
    </button>
    {loading && <p className="social-feedback" role="status">正在绘制与文案主题对应的插画。</p>}
    {error && <p className="social-feedback" role="alert">{error}</p>}
    {image && <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="social-image" src={image.dataUrl} alt="根据当前社交文案生成的 Corporate Memphis 和 Alegria 风格插画"/>
      <a className="social-retry" href={image.dataUrl} download={`social-image.${extension}`}><Download size={16}/> 下载配图</a>
      <details className="image-prompt"><summary>查看配图提示词</summary><p>{image.prompt}</p></details>
    </>}
  </div>;
}
