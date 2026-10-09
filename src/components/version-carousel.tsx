"use client";
import { useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function VersionCarousel({ label, count, index, onSelect, children }: {
  label: string;
  count: number;
  index: number;
  onSelect: (index: number) => void;
  children: ReactNode;
}) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  function select(next: number) {
    if (next >= 0 && next < count && next !== index) onSelect(next);
  }
  return <div className="version-carousel" role="region" aria-label={`${label}版本`}>
    {count > 1 && <div className="version-navigation" onKeyDown={event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); select(index + (event.key === "ArrowLeft" ? -1 : 1));
      }
    }}>
      <button aria-label={`上一个${label}`} disabled={index === 0} onClick={() => select(index - 1)}><ChevronLeft size={18}/></button>
      <span role="status" aria-live="polite">{label} {index + 1} / {count}</span>
      <button aria-label={`下一个${label}`} disabled={index === count - 1} onClick={() => select(index + 1)}><ChevronRight size={18}/></button>
      <small>左右滑动切换</small>
    </div>}
    <div className="version-content" key={index} onTouchStart={event => {
      touch.current = null;
      if (count < 2 || event.touches.length !== 1 || (event.target as Element).closest("button, a, textarea, summary")) return;
      touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }} onTouchEnd={event => {
      const start = touch.current; touch.current = null;
      if (!start || event.touches.length || !event.changedTouches.length) return;
      const dx = event.changedTouches[0].clientX - start.x;
      const dy = event.changedTouches[0].clientY - start.y;
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) select(index + (dx < 0 ? 1 : -1));
    }} onTouchCancel={() => { touch.current = null; }}>{children}</div>
  </div>;
}
