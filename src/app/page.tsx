"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Search,
  ScanLine,
  ShieldCheck,
  LoaderCircle,
  Sparkles,
  X,
  CircleAlert,
} from "lucide-react";
import type { Reference } from "@/core/contracts";
import { demo } from "@/client/demo";
import { useAnalysis } from "@/client/use-analysis";
import { ReportView } from "@/components/report-view";
import { ReportPreviewView } from "@/components/report-preview";
import { OpeningMessage } from "@/components/opening-message";
import { SourceSheet, type Selection } from "@/components/source-sheet";
const examples = [
  "AI 编程工具会让初级工程师岗位减少吗？",
  "2025 年企业使用生成式 AI 的比例有多高？",
  "全球电动汽车销量近年发生了什么变化？",
];
export default function Home() {
  const [idea, setIdea] = useState("");
  const [socialTargetLength, setSocialTargetLength] = useState(2000);
  const [selection, setSelection] = useState<Selection | null>(null);
  const {
    analysis,
    isDemo,
    loading,
    error,
    elapsed,
    progress,
    opening,
    socialPreview,
    reportPreview,
    finishReportPreview,
    start,
    clear,
    showDemo,
    setError,
    cancel,
  } = useAnalysis();
  const result = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const reportId = Boolean(reportPreview || analysis);
  useEffect(() => {
    if (reportId)
      requestAnimationFrame(() =>
        result.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
  }, [reportId]);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    if (idea.trim().length < 5) {
      setError("请至少输入 5 个字，让问题更具体一些。");
      input.current?.focus();
      return;
    }
    setSelection(null);
    void start(idea, socialTargetLength);
  }
  function onSource(id: string, refs: Reference[]) {
    const source = analysis?.sources.find((item) => item.id === id);
    if (source)
      setSelection({
        source,
        quotes: refs.filter((ref) => ref.sourceId === id),
      });
  }
  function reset() {
    if (loading) return;
    clear();
    setError("");
    setSelection(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <button className="brand" onClick={reset} aria-label="Insight 首页">
            <span className="brand-icon">
              <i />
              <i />
              <i />
            </span>
            <span>
              insight<span className="brand-dot">.</span>
            </span>
          </button>
          <span className="header-caption">FROM QUESTION TO EVIDENCE</span>
          <span className="version">
            研究工作台 <span>v0.2</span>
          </span>
        </div>
      </header>
      <main>
        <section className={`hero ${analysis ? "hero-compact" : ""}`}>
          <div className="hero-kicker">
            <span className="live-dot" /> 一句话，开启一次有依据的研究
          </div>
          <h1>
            让想法
            <span className="hero-line">
              有据可循<span className="hero-period">。</span>
            </span>
          </h1>
          <p className="hero-description">
            把好奇交给研究，把判断留给自己。
            <br />
            从真实资料中提炼指标，每个数字都能追溯到来源。
          </p>
        </section>
        <section className="workspace">
          <div className="input-panel">
            <div className="panel-title">
              <span>
                <Sparkles size={17} /> 你想了解什么？
              </span>
              <span className="panel-number">01 / 提问</span>
            </div>
            <form onSubmit={submit}>
              <label className="sr-only" htmlFor="idea">
                研究问题
              </label>
              <textarea
                ref={input}
                id="idea"
                placeholder="例如：AI 编程工具会不会改变初级工程师的就业机会？"
                value={idea}
                onChange={(event) => {
                  setIdea(event.target.value);
                  clear();
                  setSelection(null);
                }}
                maxLength={1000}
                disabled={loading}
              />
              <div className="input-bottom">
                <span className="input-tip">
                  具体的年份、地区或人群，能让研究更准确。
                </span>
                <span className="char-count">{idea.length} / 1000</span>
              </div>
              <div className="social-option">
                <label htmlFor="social-length">X 文案长度</label>
                <select
                  id="social-length"
                  disabled={loading}
                  value={socialTargetLength}
                  onChange={(event) => {
                    setSocialTargetLength(Number(event.target.value));
                    clear();
                    setSelection(null);
                  }}
                >
                  <option value={2000}>叙述长文 · 需账号支持长帖</option>
                  <option value={280}>标准短帖 · 280 加权字符</option>
                </select>
                <small>长文采用短段落叙述；发布前确认账号支持长帖。</small>
              </div>
              <div className="submit-row">
                <span className="privacy">
                  <ShieldCheck size={14} /> Tavily 研究 · 引用全部已提取文章
                </span>
                <button
                  type="submit"
                  className="submit-button"
                  disabled={loading || idea.trim().length < 5}
                >
                  {loading ? (
                    <>
                      <LoaderCircle className="spin" size={17} /> 正在研究
                    </>
                  ) : (
                    <>
                      {error ? "重新分析" : "开始分析"}
                      <ArrowUpRight size={19} />
                    </>
                  )}
                </button>
              </div>
            </form>
            {error && (
              <div className="error-message" role="alert">
                <CircleAlert size={17} />
                <span>{error}</span>
              </div>
            )}
            {opening && (
              <OpeningMessage text={opening} paused={!loading && Boolean(error)}/>
            )}
            {loading && (
              <div className="loading-panel" role="status" aria-live="polite">
                <div className="loading-top">
                  <span>
                    <LoaderCircle size={16} className="spin" />{" "}
                    {progress || "正在联网研究并核对证据"}
                  </span>
                  <button
                    type="button"
                    onClick={() => cancel()}
                    className="cancel-button"
                  >
                    <X size={14} /> 取消
                  </button>
                </div>
                <div className="loading-track" />
                <p>
                  通常需要约 30–120 秒，复杂问题可能更久。已等待 {elapsed} 秒。
                  <br />
                  按取得的资料生成观察与文案，保留全部文章引用。
                </p>
              </div>
            )}
            <div className="examples">
              <span className="examples-label">从这些问题开始</span>
              {examples.map((example, index) => (
                <button
                  key={example}
                  disabled={loading}
                  onClick={() => {
                    setIdea(example);
                    setError("");
                    clear();
                    setSelection(null);
                    input.current?.focus();
                  }}
                >
                  <span className="example-index">0{index + 1}</span>
                  <span>{example}</span>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          </div>
          {!analysis && !reportPreview && (
            <aside className="how-it-works">
              <div className="aside-heading">
                <span className="eyebrow">A BETTER WAY TO KNOW</span>
                <h2>从问题，到有依据的判断。</h2>
              </div>
              <div className="process-item">
                <span className="process-icon">
                  <Search size={20} />
                </span>
                <div>
                  <h3>查找真实资料</h3>
                  <p>优先一手材料，尝试覆盖不同类型的信源。</p>
                </div>
              </div>
              <div className="process-item">
                <span className="process-icon">
                  <ScanLine size={20} />
                </span>
                <div>
                  <h3>提炼关键指标</h3>
                  <p>核对数字与证据，留下值得关注的信息。</p>
                </div>
              </div>
              <div className="process-item">
                <span className="process-icon">
                  <ShieldCheck size={20} />
                </span>
                <div>
                  <h3>每条依据，都能点开</h3>
                  <p>查看原文片段和统计范围，自己确认结论。</p>
                </div>
              </div>
              <div className="preview-note">
                <span>先看看报告长什么样</span>
                <button
                  disabled={loading}
                  onClick={() => {
                    showDemo(demo);
                  }}
                >
                  体验示例 <ArrowUpRight size={16} />
                </button>
                <small>虚构数据，仅用于界面预览</small>
              </div>
            </aside>
          )}
        </section>
        <div ref={result} className="result-anchor">
          {reportPreview ? <ReportPreviewView key={reportPreview.attempt} preview={reportPreview} title={idea}
            confirmed={analysis} onComplete={finishReportPreview}/> : analysis && (
            <>
              <div className="result-navigation">
                <span>{isDemo ? "报告预览" : "本次研究结果"}</span>
                <button disabled={loading} onClick={reset}>
                  开始新的研究 <ArrowUpRight size={15} />
                </button>
              </div>
              <ReportView
                analysis={analysis}
                isDemo={isDemo}
                onSource={onSource}
                pending={loading}
                socialPreview={socialPreview}
              />
            </>
          )}
        </div>
        {!analysis && !reportPreview && (
          <div className="manifesto">
            <span>LESS GUESSWORK. MORE CLARITY.</span>
            <p>好的判断，从看得见的依据开始。</p>
          </div>
        )}
      </main>
      <footer className="site-footer">
        <span>
          insight. <span>让想法有据可循</span>
        </span>
        <span>AI 辅助研究 · 请结合原文核验</span>
      </footer>
      <SourceSheet selection={selection} close={() => setSelection(null)} />
    </>
  );
}
