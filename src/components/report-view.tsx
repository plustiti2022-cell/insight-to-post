import { CircleAlert, BookOpen, Clock3 } from "lucide-react";
import type { Analysis, Reference } from '@/core/contracts';
import { MetricCard } from "./metric-card";
import { CoreAnswer } from "./core-answer";
import { SocialContent } from './social-content';
export function ReportView({ analysis, isDemo, onSource, pending = false }: { analysis: Analysis; isDemo: boolean; onSource: (id: string, refs: Reference[]) => void; pending?: boolean }) {
  const { report, sources, diagnostics } = analysis;
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(report.generatedAt));
  return <section className="report" aria-labelledby="report-title"><div className="report-header"><span className="eyebrow">{isDemo ? "INTERFACE PREVIEW / 界面示例" : "RESEARCH BRIEF / 研究简报"}</span><span className={`status-badge ${analysis.status}`}>{isDemo ? "虚构数据" : "研究观察已生成"}</span></div>
    {analysis.searchSteps?.length ? <div className="search-process">{analysis.searchSteps.map((step, index) => <details className="search-step" key={index}><summary><span className="search-query">{step.query}</span><span className="search-count">{step.resultCount} 个结果</span></summary><div className="search-links">{sources.filter(source => step.sourceIds.includes(source.id)).map(source => <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer">{source.title || new URL(source.url).hostname}</a>)}</div></details>)}</div> : null}
    <h2 id="report-title">{report.title}</h2><div className="report-meta"><span><Clock3 size={14}/>生成于 {time}</span><span><BookOpen size={14}/>{sources.filter(s => s.hasEvidence).length} 个有正文的来源</span></div>
    {!isDemo && analysis.coverage && <p className="coverage met">已引用 {analysis.coverage.citedSourceCount} / 本轮提取 {analysis.coverage.eligibleSourceCount} 篇文章 · {analysis.coverage.citedSourceTypes.length} 类</p>}
    <CoreAnswer report={report} sources={sources}/>
    {report.cards.length > 0 && <><div className="section-heading"><h3>让数据说话</h3><span>{String(report.cards.length).padStart(2,"0")} 项指标</span></div><div className="metrics">{report.cards.map((card, index) => <MetricCard key={`${card.label}-${index}`} card={card} index={index} onSource={onSource}/>)}</div></>}
    <div className="limitations"><div className="section-heading"><h3><CircleAlert size={17}/> 阅读边界</h3></div>{analysis.warnings.length > 0 && <ul className="warnings">{analysis.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}<ul>{report.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></div>
    {analysis.socialContent || isDemo ? <SocialContent key={report.generatedAt} analysis={analysis} isDemo={isDemo} onSource={onSource}/> : <p className="social-state" role="status">{pending ? "核心观察已生成，正在生成社交文案…" : "文案尚未完成，可重新分析。"}</p>}
    {!isDemo && <p className="diagnostics">本次研究 · {(diagnostics.durationMs/1000).toFixed(1)} 秒 · Tavily {diagnostics.searchCalls} 次搜索 / {diagnostics.extractorCalls} 次补取 · {diagnostics.tavilyCredits ?? 0} credits · 千问 {diagnostics.modelCalls} 次调用 / {diagnostics.totalTokens.toLocaleString()} tokens</p>}
    <p className="report-footnote">AI 辅助生成 · 引用可追溯，结论请结合原文核验。</p>
  </section>;
}
