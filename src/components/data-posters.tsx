import { Download, LoaderCircle } from "lucide-react";
import type { DataPosters as Posters } from "@/core/contracts";
import { readStaticPosterSvg } from "@/core/data-posters";

export function DataPosters({ result, pending }: { result?: Posters; pending: boolean }) {
  if (!result) return null;
  const running = pending && ["extracting", "generating"].includes(result.status);
  return <section className="data-posters" aria-labelledby="data-posters-title">
    <div className="section-heading"><h3 id="data-posters-title">数据海报</h3><span>{result.items.length} 条数据</span></div>
    <p className="social-description">从研究回答提取数据，每条自动生成一张海报。</p>
    {running && <p className="social-state" role="status"><LoaderCircle size={16} className="spin"/>
      {result.status === "extracting" ? "正在提取研究回答中的数据…" : "正在生成数据海报，完成后逐张展示…"}</p>}
    {!pending && ["extracting", "generating"].includes(result.status) && <p className="social-feedback" role="alert">数据海报流程已中断，已完成的结果保留。</p>}
    {result.error && <p className="social-feedback" role="alert">数据提取失败：{result.error}</p>}
    {result.status === "complete" && !result.items.length && <p className="social-state">研究回答中没有可提取的数据。</p>}
    {result.items.length > 0 && <details className="data-json"><summary>查看提取 JSON</summary><pre data-testid="data-json">{JSON.stringify(result.items.map(item => item.text), null, 2)}</pre></details>}
    <div className="data-poster-grid">{result.items.map((item, index) => {
      let url: string | undefined, error = item.error;
      if (item.status === "ready") {
        try {
          url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(readStaticPosterSvg(item.svg ?? ""))}`;
        } catch { error = "海报 SVG 格式错误，无法展示。"; }
      }
      return <article className="data-poster-card" key={item.id} data-testid="data-poster-card">
        <h4>数据 {index + 1}</h4><p className="data-poster-copy">{item.text}</p>
        {url && <>
          {/* img 对 SVG 进行图片隔离，不执行或嵌入模型生成的 DOM。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} width={768} height={1024} alt={`数据海报 ${index + 1}：${item.text}`} data-testid="data-poster-image"/>
          <a className="social-retry" href={url} download={`研究数据海报-${index + 1}.svg`}><Download size={15}/> 下载 SVG</a>
          <details><summary>查看 SVG 代码</summary><pre>{item.svg}</pre></details>
        </>}
        {error && <p className="social-feedback" role="alert">海报生成失败：{error}</p>}
        {["pending", "generating"].includes(item.status) && <p className="social-state" role="status">{!pending ? "生成已中断。" : item.status === "pending" ? "等待生成…" : "正在生成 SVG 海报…"}</p>}
      </article>;
    })}</div>
  </section>;
}
