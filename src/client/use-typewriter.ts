"use client";
import { useEffect, useState } from "react";

// 累计已收到的文字逐字播放；新增网络块与完成确认都不会跳过排队文字。
export function useTypewriter(text: string, paused = false) {
  const [characters, setCharacters] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(query.matches);
    change(); query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const letters = Array.from(text);
  useEffect(() => {
    if (reducedMotion || paused || characters >= letters.length) return;
    const timer = setInterval(() => setCharacters(value =>
      Math.min(letters.length, value + Math.max(1, Math.ceil(letters.length / 250)))), 20);
    return () => clearInterval(timer);
  }, [text, reducedMotion, paused, characters, letters.length]);
  const visible = reducedMotion ? text : letters.slice(0, characters).join("");
  return { text: visible, finished: reducedMotion || characters >= letters.length };
}
