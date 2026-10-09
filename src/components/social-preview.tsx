"use client";
import { useEffect } from "react";
import { useTypewriter } from "@/client/use-typewriter";

export function SocialPreview({ text, confirmed, onComplete }: {
  text: string; confirmed?: string; onComplete: () => void;
}) {
  const playback = useTypewriter(text);
  useEffect(() => {
    if (confirmed !== undefined && (playback.finished || confirmed !== text)) onComplete();
  }, [confirmed, text, playback.finished, onComplete]);
  return <div className="social-text" data-testid="social-preview" aria-label="正在生成的社交文案">
    {playback.text}{!playback.finished && <span className="answer-cursor" aria-hidden="true">▍</span>}
  </div>;
}
