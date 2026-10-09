"use client";
import { useEffect, useRef, useState } from "react";
import type { Analysis, ReportPreview } from "@/core/contracts";
import { analysisProgress, readAnalysisStream } from "./analysis-stream";

// 请求生命周期集中管理：取消、超时、卸载与过期响应只作用于自己的请求。
export function useAnalysis() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState("");
  const [opening, setOpening] = useState("");
  const [socialPreview, setSocialPreview] = useState<string | null>(null);
  const [reportPreview, setReportPreview] = useState<ReportPreview | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!loading) return;
    const started = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [loading]);

  async function start(idea: string, socialTargetLength: number) {
    if (controller.current) return;
    const active = new AbortController();
    controller.current = active;
    setLoading(true);
    setError("");
    setElapsed(0);
    setAnalysis(null);
    setReportPreview(null);
    setIsDemo(false);
    setOpening("");
    setSocialPreview(null);
    setProgress("正在理解问题");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ idea: idea.trim(), socialTargetLength }),
        signal: AbortSignal.any([active.signal, AbortSignal.timeout(600000)]),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message ?? "分析失败，请重试。");
      }
      const data = response.headers.get("content-type")?.includes("text/event-stream")
        ? await readAnalysisStream(response, event => {
            if (controller.current !== active || active.signal.aborted) return;
            if (event.type === "opening") setOpening(value => value + event.text);
            if (event.type === "progress") setProgress(analysisProgress[event.stage]);
            if (event.type === "report-start") setReportPreview({ attempt: event.attempt, blocks: [], sources: event.sources, coreValidation: event.coreValidation });
            if (event.type === "report-block") setReportPreview(value =>
              value?.attempt === event.attempt && value.blocks.length === event.index
                ? { ...value, blocks: [...value.blocks, event.block] } : value);
            if (event.type === "report") setAnalysis(event.analysis);
            if (event.type === "social-start") setSocialPreview("");
            if (event.type === "social-block") setSocialPreview(value => value ? `${value}\n\n${event.text}` : event.text);
          })
        : await response.json();
      if (controller.current === active && !active.signal.aborted) {
        if (data.socialContent?.status !== "ready") setSocialPreview(null);
        setAnalysis(data);
        setIsDemo(false);
      }
    } catch (err) {
      if (controller.current !== active) return;
      setReportPreview(null);
      setSocialPreview(null);
      setError(
        active.signal.aborted
          ? "分析已取消。问题已保留，可以再次开始。"
          : err instanceof Error && err.name === "TimeoutError"
            ? "等待报告超时，请缩小问题范围后重试。"
            : err instanceof Error && err.name === "TypeError"
              ? "网络连接中断，请检查连接后重试。"
              : err instanceof Error
                ? err.message
                : "分析失败，请重试。",
      );
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setLoading(false);
      }
    }
  }
  function clear() {
    setAnalysis(null);
    setReportPreview(null);
    setOpening("");
    setSocialPreview(null);
    setError("");
  }
  function showDemo(value: Analysis) {
    setReportPreview(null);
    setAnalysis(value);
    setIsDemo(true);
  }
  return {
    analysis,
    isDemo,
    loading,
    error,
    elapsed,
    progress,
    opening,
    reportPreview,
    socialPreview,
    finishReportPreview: () => setReportPreview(null),
    start,
    clear,
    showDemo,
    setError,
    cancel: () => controller.current?.abort(),
  };
}
