"use client";
import { useTypewriter } from "@/client/use-typewriter";

export function OpeningMessage({ text, paused }: { text: string; paused: boolean }) {
  const playback = useTypewriter(text, paused);
  return <div className="opening-message" data-testid="opening-text" aria-live="polite">
    {playback.text}{!playback.finished && !paused && <span className="answer-cursor" aria-hidden="true">▍</span>}
  </div>;
}
