"use client";
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, RefreshCw, MessageCircle } from 'lucide-react';
import type { Analysis, Reference, SocialContent as Content } from '@/core/contracts';
import { Citation } from './metric-card';
import { SocialImage } from './social-image';
import { VersionCarousel } from './version-carousel';
export function SocialContent({ analysis, isDemo, onSource }: { analysis: Analysis; isDemo: boolean; onSource: (id: string, refs: Reference[]) => void }) {
  const [versions, setVersions] = useState<{ items: Content[]; index: number }>(() => ({
    items: analysis.socialContent?.status === 'ready' && analysis.socialContent.coverage.requirementMet ? [analysis.socialContent] : [], index: 0,
  }));
  const content = versions.items[versions.index] ?? analysis.socialContent;
  const [retryError, setRetryError] = useState('');
  const [copyStatus, setCopyStatus] = useState(''); const [loading, setLoading] = useState(false); const [manual, setManual] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null); const controller = useRef<AbortController | null>(null); const copyVersion = useRef(0);
  useEffect(() => () => { controller.current?.abort(); copyVersion.current++; }, []);
  const ready = content?.status === 'ready' && content.coverage.requirementMet && !isDemo;
  const [imageStarted, setImageStarted] = useState(Boolean(ready));
  function selectVersion(index: number) {
    setVersions(current => ({ ...current, index }));
    setCopyStatus(''); setManual(false); copyVersion.current++;
  }
  async function copy() {
    if (!ready || !content || loading) return;
    const version = ++copyVersion.current;
    setCopyStatus('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(content.text);
      if (version === copyVersion.current) { setCopyStatus('已复制'); setManual(false); }
    } catch {
      if (version === copyVersion.current) { setCopyStatus('浏览器未允许自动复制，请全选下方文字后手动复制。'); setManual(true); requestAnimationFrame(() => { field.current?.focus(); field.current?.select(); }); }
    }
  }
  async function retry() {
    if (!analysis.socialRetryToken || loading || isDemo) return;
    const active = new AbortController(); controller.current = active; setLoading(true); setRetryError(''); setCopyStatus(''); setManual(false); copyVersion.current++;
    try {
      const response = await fetch('/api/social-content', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: analysis.socialRetryToken }), signal: AbortSignal.any([active.signal, AbortSignal.timeout(600000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || '文案重试失败。');
      if (!active.signal.aborted) {
        if (data.socialContent.status === 'ready' && data.socialContent.coverage.requirementMet) {
          setVersions(current => ({ items: [...current.items, data.socialContent], index: current.items.length }));
          setCopyStatus(''); setManual(false); copyVersion.current++;
          setImageStarted(true);
        } else setRetryError((data.socialContent.warnings ?? ['本次未生成可用文案。']).join(' ') || '本次未生成可用文案。');
      }
    } catch (error) {
      if (!active.signal.aborted) setRetryError(error instanceof Error ? error.message : '文案重试失败。');
    } finally { if (!active.signal.aborted) setLoading(false); controller.current = null; }
  }
  return <section className="social-panel" aria-labelledby="social-title">
    <div className="section-heading"><h3 id="social-title"><MessageCircle size={17}/> 社交媒体文案</h3><span>03 / 表达与分享</span></div>
    <p className="social-description">适合 X 的纯文字草稿 · 重新生成保留历史版本，可左右切换选择</p>
    {loading && <p className="social-state" role="status"><LoaderCircle size={16} className="spin"/> 正在重新生成文案，已有版本已保留。</p>}
    <VersionCarousel label="文案" count={versions.items.length} index={versions.index} onSelect={selectVersion}>
    {ready && content ? <>
      <div className="social-text" data-testid="social-text">{content.text}</div>
      <div className="social-meta"><span>{content.characterCount} 个字符 · X 加权 {content.weightedLength} / {content.targetLength}</span><span>实际依据 {content.coverage.citedSourceCount} 个来源 · {content.coverage.citedSourceTypes.length} 类</span></div>
      {content.warnings.length>0 && <p className="social-feedback">{content.warnings.join(' ')}</p>}
      <details className="social-evidence"><summary>查看文案依据</summary>{[...new Set(content.claimReferences.map(ref => ref.paragraphIndex))].map(index => <div key={index}><span>{index<0 ? "综合观点依据" : `第 ${index+1} 段`}</span><Citation references={content.claimReferences.filter(ref => ref.paragraphIndex === index).map(ref => ({ sourceId: ref.sourceId, quote: ref.quote }))} onSource={onSource}/></div>)}</details>
    </> : <div className="social-state">{isDemo ? '界面示例为虚构数据，不生成待发布文案。' : (content?.warnings ?? ['本次未生成可用文案。']).join(' ')}</div>}
    </VersionCarousel>
    {retryError && <p className="social-feedback" role="alert">{retryError}</p>}
    <div className="social-actions"><button className="submit-button" disabled={!ready || loading} onClick={copy}>{copyStatus === '已复制' ? <Check size={16}/> : <Copy size={16}/>} {copyStatus === '已复制' ? '已复制' : '一键复制'}</button>{analysis.socialRetryToken && !isDemo && <button className="social-retry" disabled={loading} onClick={retry}><RefreshCw size={15}/> 重新生成文案</button>}</div>
    {imageStarted && content && <SocialImage text={content.text} disabled={!ready || loading}/>}
    {copyStatus && <p className="social-feedback" role="status" aria-live="polite">{copyStatus}</p>}
    {manual && ready && content && <div className="manual-copy"><label htmlFor="manual-copy">手动复制文字</label><textarea id="manual-copy" ref={field} readOnly value={content.text}/><button className="social-retry" onClick={() => {field.current?.focus();field.current?.select();}}>全选文字</button></div>}
    {ready && <p className="social-footnote">{content && content.targetLength > 280 ? '长文需要 X 账号支持长帖。' : ''}发布前请核对原文；生成内容仍可能出错。</p>}
  </section>;
}
