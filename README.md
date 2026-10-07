# Insight-to-Post · 研究观察与社交文案

输入问题，千问规划检索词，Tavily 搜索并提取文章，按段落呈现有信源的回答，再生成可一键复制的 X 文案；点击“生成配图”可为当前文案生成一张插画并下载。

## 最新输出规则（2026-10-07）

- 参考本地 Morphic 的问题导向检索：模型先将问题改写为语义关键词，Tavily advanced 搜索最多返回 15 个结果；全部缺失正文的 URL 按每批 20 个补取。根据已提取正文能否覆盖问题决定是否补搜一次，不再按少于五篇触发。用户直接提供公开 URL 时先提取文章。规划失败用原问题检索，覆盖评估失败保留文章继续回答。
- 核心内容按参考图展示：加粗首答、带加粗标题的要点列表、建议和结论。每段结尾显示该段实际引用的灰色域名胶囊，点击直接在新标签页打开原文；上方可展开查看检索词及结果，不再单独展示下方的研究来源列表。所有提取文章仍保留在报告数据中，不将未支持该段的文章自动贴为段末引用。
- 首答独立于详细内容：1–2 句结论和关键限定，通常 40–90 字、最多 120 字符，不带要点标题或换行；数据、行业案例、年份及原因链放入下方要点。首答过长、错位、重复或要点缺标题会使用现有的一次格式修复机会重新生成，不截断内容。首答引用校验失败时补写一次，即使仍保留有效要点；补写失败不将详细要点整段加粗冒充总结。
- 每次有效问题都返回研究观察和社交文案，不以来源数量或类型不足清空结果。
- 全部成功提取的文章均进入报告与文案引用；一个段落可以引用多个来源。独立提取的镜像文章也保留各自引用，同一来源的重复引用不增加文章数。
- 不再只挑 8 篇或只为模型保留 10 篇文章。核心观察先直接回答用户问题，再解释理由与必要限定；`answerBlocks` 保留各段的呈现方式和引用，`summary[0]` 保留完整纯文字供既有社交逻辑使用。不区分或展示事实／推断等回答标签。缺少的引用只补入依据元数据，不向正文插入文章标题或摘录。
- 模型只为回答选择相关依据，不再被要求把全部文章塞进一段话。报告不再调用模型语义复核。正文被本地校验删空时，携带原始问题、正文与失败原因补写一次并重新校验；仍失败则明确说明未能完成回答，不用万能套话或指标说明冒充答案。模型调用失败不额外重试。
- 核心回答的资料输入只发送正文片段与对应编号，加上用户问题；来源标题、作者、网址、类别等元数据不进入该提示词。来源信息仍由后台保留，用于页面展示和引用定位。
- 社交写作节点的内容输入只接收页面“核心观察”的正文（`report.summary[0].text`）与写作风格，不再混入指标卡或原始问题；文章标题、URL、原文引用留在后台依据层。模型未完成时从综合观点整理文案，不拼接文章清单。
- 文案通过本地格式、数字、引用与长度校验后直接返回，不再调用模型复核；本地校验失败最多重新生成一次。
- 无可用正文时生成检索情况的观察和文案，不虚构文章、数字或结论。
- 结尾表达交给模型，不强制问句或问号。复制保留纯文字、段落及空行。
- 优先尝试按所选长度生成；完整引用与长度冲突时保留文案、提示超长，复制后自行调整，不截断或清空。

## 启动

需要 Node.js 22/24 LTS、npm 和千问、Tavily、MiniMax 三个服务的有效密钥。配置 key.txt：

    QWEN_API_KEY=自己的千问密钥
    TAVILY_API_KEY=自己的Tavily密钥
    MINIMAX_API_KEY=自己的MiniMax密钥

Windows 在项目目录运行：

    powershell -ExecutionPolicy Bypass -File .\start.ps1 -Production

脚本识别服务密钥并填入缺失的 .env.local，保留已有配置，不打印密钥。也可从 .env.example 配置后 npm ci、npm run dev。

默认访问 [本机页面](http://localhost:3001/)。手机同 Wi-Fi 可用启动脚本显示的局域网地址；start.ps1 -Port 3002 可换端口。HTTP 环境无法自动复制时提供手动全选。

## 架构与接口

当前采用纯业务规则、服务适配和显式工作流：

- `src/core`：数据契约、来源、证据、报告与文案的纯规则。
- `src/server`：供应商协议、模型提示词、业务服务、HTTP 边界。
- `src/server/workflow`：`state.ts` 声明状态和能力契约，`nodes.ts` 放独立节点函数，`edges.ts` 管理转移，`run.ts` 组装并执行。
- `src/client`：请求生命周期与演示数据；页面与组件负责交互和展示。

节点返回更新，由执行器合并状态。边只读取状态；可用来源与覆盖按需计算。详细目录、流程图、删除记录和扩展位置见 [架构与演进约定](./docs/architecture.md)。旧 `src/lib` 已迁移删除，无兼容转发层。

问题 → 检索词规划 → Tavily Search / 必要时 Extract → 正文覆盖评估 / 必要时补搜一次 → 保留全部可用文章 → 千问分段回答及本地引用校验 → 必要时补写回答 → 保留文章依据 → 文案生成及事实校验 → 回答、段末信源与复制。

POST /api/analyze 输入 idea（5～1000 字）及可选 socialTargetLength（280 / 2000）。报告覆盖数量是已提取和实际引用文章数，不是达标门槛。诊断含搜索、补取、credits、模型调用、token 与耗时。

POST /api/social-content 接收服务器签名的 socialRetryToken，两小时有效，复用全部文章及已保留观察，只重试文案，不重复检索。每接口单进程并发上限 2；取消与新问题阻止旧结果重新出现。结果只保存在当前页面。

POST /api/social-image 接收 `{ "text": "当前社交文案" }`，返回 `image`（`dataUrl / prompt / model / generatedAt`）、`attempts`、`durationMs`。配图由用户点击触发，使用 MiniMax `image-01`，固定 `n=1`、aspect_ratio=3:4（竖版）、base64 返回及关闭自动提示词优化。提示词明确采用“Corporate Memphis”和“Alegria”插画风格、扁平化矢量艺术、极简几何图形。页面可以查看提示词、下载图片或重新生成；重写文案和切换问题会清除旧图并取消未完成请求。演示数据不会调用图片 API。

图片生成失败最多自动重试一次，使用完全相同的提示词；配置、鉴权、余额错误和取消直接返回。除此之外不做图片兜底、不替换供应商或插入占位图。按 [MiniMax 官方协议](https://platform.minimax.cn/docs/api-reference/image-generation-t2i)，提示词最多 1500 字符；当前配图接口接受最多 1200 字符的文案，序列化后的完整提示词超过上限时明确报错，不截断文案。图片以 base64 在浏览器展示和下载，无临时远程链接依赖。

首次分析将完整的原始文案提示词保存在服务器签名快照中。点击“重新生成文案”时，将该提示词原封不动发送给同一模型，只生成一次，不追加纠错提示、不自动修稿。报告、结论编号与所选长度保留；生成失败时显示原因。

## 大模型调用与 prompt 管理

所有模型指令、JSON 输入序列化和重试提示统一维护在 [src/server/prompts.ts](./src/server/prompts.ts)。当前实际调用点如下：

| 调用位置 | Prompt 构建函数 | 输入 | 重试行为 |
| --- | --- | --- | --- |
| `src/server/services/research.ts` → `researchWithTavily` | `searchQueryPrompt` | 用户问题、上海时区当前日期 | 失败用原始问题继续搜索 |
| `src/server/services/research.ts` → `researchWithTavily` | `searchReviewPrompt` | 用户问题、检索词、正文片段和提取状态 | 只评估首轮；有缺口补搜一次，失败保留文章 |
| `src/server/services/report.ts` → `generateReport` | `reportPrompt` | 用户问题、来源正文片段、可选校验反馈 | 首次格式或空回答失败最多修复一次；补写模式只生成一次 |
| `src/server/services/social.ts` → `generateSocialContent`（生成） | `socialContentPrompt` | 核心观察正文、目标长度、校验反馈 | 最多生成两次 |
| `src/server/services/image.ts` → `generateSocialImage` | `socialImagePrompt` | 当前社交文案全文 | 同一提示词最多请求两次，每次只生成一张 |

职责边界：业务模块准备数据、执行校验、控制重试与兜底；prompt 模块只导入数据类型，构建字符串；`server/providers/qwen.ts` 处理模型配置、HTTP、超时与错误。修改指令只需修改 `prompts.ts`，不需要调整调用层。文案 prompt 只接收观点，不接收来源正文或引用元数据。

本次空泛回答的定位、完整 prompt 组成和修改说明见 [回答与提示词检查](./docs/answer-prompt-audit.md)。

新增模型调用时，在 `prompts.ts` 定义具名输入类型和构建函数，调用层使用 `callQwen(promptBuilder(input), …)`，不要在调用层拼接指令或重试提示。`tests/prompts.test.ts` 检查所有生产 `callQwen` 调用使用集中构建函数，并检查 prompt 模块没有运行时依赖。

## 验证与交付

    npm test
    npm run typecheck
    npm run build
    npm run test:ui
    npm run test:ui:social
    npm run test:ui:answer
    npm run test:ui:image
    node scripts/verify-ui-observations.mjs

最后一项调用真实 API，会产生服务用量。其余测试使用模拟响应，覆盖检索词改写、按覆盖补搜、完整批量提取、分段引用直达原文，以及 prompt 集中管理、少量来源、单一类型、全部 12 篇文章、模型失败与无正文仍输出、事实校验、取消、复制及签名保护。最新实测见 [验收记录](./验收记录.md)。

图片真实验证（会产生 MiniMax 用量）：`npm run verify:image`。默认使用专门编写的演示文案；也可以 `npm run verify:image -- path/to/social.txt` 使用自己的文案文件。该脚本与页面调用同一工作流入口，保存文案、完整提示词、单张图片和调用记录到 [artifacts/social-image-example](./artifacts/social-image-example/README.md)。已保存的示例无需再次调用 API 即可查看；后续执行验证会更新这个示例目录。

[开发计划](./MVP开发计划.md)、[设计说明原稿](./设计决策说明.md)、[两页设计 PDF](./output/pdf/设计决策说明-v02.pdf)。旧规则保存在 docs/history；旧演示不代表当前引用政策。真实手机人工检查仍待确认。

平台直接发布、流式、其他图表模板、登录、数据库、PWA 和公网托管仍暂缓。原文、翻译和推断仍可人工核验；不声称模型或来源绝对正确。
