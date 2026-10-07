import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Insight — 让想法有据可循", description: "从一个问题出发，联网查找资料，生成可追溯的数据报告。" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
