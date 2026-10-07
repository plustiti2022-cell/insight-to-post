import type { Analysis } from "../core/contracts";
// 虚构数据只用于布局预览，不调用服务、不冒充真实研究。
export const demo: Analysis = {
  status: "partial",
  report: {
    title: "一份报告，如何让数据有据可循？",
    generatedAt: "2026-10-06T06:00:00Z",
    summary: [
      {
        text: "每张指标卡都有独立的证据入口。这里展示的是虚构的界面示例，你可以点击引用体验原文片段查看。",
        references: [
          {
            sourceId: "S1",
            quote:
              "此段仅为界面演示：在虚构的 2025 年演示调查中，100 名示例受访者有 42% 选择了示例选项。",
          },
        ],
      },
    ],
    cards: [
      {
        label: "示例选项的选择比例",
        value: "42",
        unit: "%",
        explanation:
          "仅用于展示指标卡排版。该数字是虚构数据，不代表任何实际调查结果。",
        period: "2025 年（虚构）",
        scope: "100 名示例受访者（虚构）",
        valueEvidence: "42",
        unitEvidence: "%",
        timeEvidence: "2025",
        references: [
          {
            sourceId: "S1",
            quote:
              "此段仅为界面演示：在虚构的 2025 年演示调查中，100 名示例受访者有 42% 选择了示例选项。",
          },
        ],
      },
    ],
    limitations: [
      "这是一份虚构数据的界面预览。输入问题并开始分析后，系统才会进行真实联网研究。",
    ],
  },
  sources: [
    {
      id: "S1",
      url: "https://example.org",
      title: "虚构的界面演示资料",
      sourceType: "其他",
      publishedAt: null,
      hasEvidence: true,
      status: "referenced",
      statusReason: "此虚构证据已被界面示例引用，仅用于演示。",
    },
  ],
  warnings: ["示例模式 · 所有数字和证据均为虚构，仅用于体验界面。"],
  diagnostics: {
    durationMs: 0,
    searchCalls: 0,
    extractorCalls: 0,
    modelCalls: 0,
    totalTokens: 0,
    sourceTypes: 0,
  },
};
