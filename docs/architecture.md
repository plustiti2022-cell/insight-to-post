# 架构与演进约定

更新：2026-10-07。本文描述当前实现；历史开发计划和演示资料不定义当前行为。

## 设计目标

用最少的概念表达现有业务：取得文章、形成有依据的观察、生成文案。扩展通过稳定的能力接口进入，而不是让新功能穿透整个仓库。清晰度用可验证的边界、无循环依赖、失败分支和修改范围衡量。

当前系统属于代码控制的研究工作流：模型负责内容，程序负责预算、引用校验、路径和取消。它有节点与边，但不依赖特定 Agent SDK。长期任务的检查点、暂停恢复和分布式执行应由成熟运行时提供，在出现实际需求后接入；现有节点本身不是持久化执行器。

## 一张地图

```text
src/
  app/                      Next 页面与研究、文案、配图 HTTP 入口
  components/               报告、指标、依据、文案的展示组件
  client/                   浏览器请求生命周期与演示数据
  core/                     纯业务规则与对外数据契约
    contracts.ts            报告、来源、文案、请求的数据结构
    sources.ts              URL、来源类型、可用正文、覆盖、公开投影
    evidence.ts             证据编号、引用映射、事实与数值校验
    report.ts               观点归并、引用补齐、报告兜底
    social.ts               纯文案校验、长度、报告整理稿
  server/
    runtime.ts              统一错误、取消、模型 JSON 边界
    http.ts                 请求校验、体积限制、并发额度、错误响应
    prompts.ts              集中的模型指令与输入序列化
    providers/              千问与 Tavily 的 HTTP 协议适配
    services/               检索、报告、文案、签名快照
    workflow/
      state.ts              运行状态、节点契约、能力接口
      nodes.ts              独立节点函数，返回状态更新
      edges.ts              条件与转移，纯读取
      run.ts                服务组装、图执行、公开 analyze 入口
```

```mermaid
flowchart LR
  UI[页面与组件] --> Client[client 请求生命周期]
  Client --> API[app/api HTTP 入口]
  API --> HTTP[server/http 请求边界]
  HTTP --> Run[workflow/run 组装与执行]
  Run --> Flow[节点与边]
  Run --> Services[业务服务]
  Services --> Providers[供应商适配]
  Providers --> External[千问 / Tavily / MiniMax]
  Flow --> Core[core 纯规则]
  Services --> Core
  UI --> Core
```

箭头表示允许的依赖方向。`core` 不读取环境、不联网、不依赖 React；浏览器不导入 `server`；供应商不引用业务服务；服务不引用工作流；节点和边通过 `state.ts` 中的能力契约调用服务。只有 `run.ts` 知道实际服务实现。`tests/architecture.test.ts` 检查这些边界和整个源码的循环依赖。

## 工作流

```mermaid
flowchart TD
  search[规划检索词 / 检索提取 / 覆盖评估] -->|正文覆盖有缺口且搜索次数少于2| supplement[针对缺口补搜一次]
  search -->|其他情况| evidence[准备证据]
  supplement --> evidence
  evidence -->|有正文| generate[生成报告]
  evidence -->|无正文| complete[完成报告]
  generate -->|成功| validate[本地校验]
  generate -->|失败| complete
  validate -->|有回答| complete
  validate -->|无结论| recover[补写回答一次]
  validate -->|失败| complete
  recover -->|生成、本地校验| complete
  complete --> social[生成文案]
  social --> finish[返回报告、文案与诊断]
```

节点是具名函数，不代表必须有一个同名文件。当前九个节点集中在 `nodes.ts`，无逐节点包装文件。外部协议、较长的纯算法和服务仍按职责独立。节点返回局部更新，执行器统一合并；输入状态不原地改写。补搜服务使用研究副本，失败仍可保留本次副本取得的资料。

状态只保留跨步骤需要的原始研究、草稿、失败标志、警告和用量；可用来源、覆盖和最终响应在需要时计算。环境配置、取消信号、观察回调和服务对象放在执行上下文中，不作为业务状态存储。每次运行创建独立状态，服务接口可由测试替换。

`services/research.ts` 负责检索业务：先使用集中提示词改写查询，再调用 Tavily advanced（最多 15 个结果），对全部缺失正文的 URL 按每批 20 个执行 Extract。首轮模型以提取正文评估问题覆盖，返回可选 `followUpQuery`；边只读取该字段与搜索预算选择下一步，补搜后不再评估或循环。篇数和来源类型不是补搜或回答门槛。规划失败使用原问题，评估失败结束研究并保留文章，检索失败保留已有用量和结果。提供公开 URL 时直接提取。研究用量和每轮 `searchSteps` 随状态返回，计入最终诊断；搜索摘要始终不能成为正文证据。

报告生成的 `summary` 各项包含纯文字、可选 `presentation/label` 与该段引用。本地校验也检查标题中的数字。完成阶段将有效段落保存在 `answerBlocks` 中供 `components/core-answer.tsx` 展示；未被段落使用的独立文章只补进归并的 `summary[0].references`。归并的 `summary[0].text` 仍是社交写作唯一正文输入，社交模型、验证、复制与重生成逻辑保持不变。页面的域名胶囊按每段去重，只链接已取得正文且真正被该段引用的来源；上方检索结果保留文章链接，不再另设研究来源列表。来源抽屉仅由指标卡和文案依据的引用按钮打开，并展示对应证据片段。

回答层次参考 Morphic 的“简短开篇 + 加粗要点标题与具体解释”，生成、规则和渲染各负其责：集中提示词要求首答为 1–2 句结论（通常 40–90 字）；`core/report.ts` 检查唯一首答位于开头、无标题、无换行且不超过 120 字符，以及要点具备标题。生成服务在原有两次尝试预算内修复结构失败，补写模式仍只生成一次。引用校验移除首答时，边根据 `hasOpeningSummary` 进入补写，而不是仅检查数组是否为空。补写失败保留有效要点，页面明确提示简短总结未生成，不能将第一个具体内容块当成首答。该提示只用于展示，不混入已有社交输入。UI 使用独立 `strong` 加粗短首答，正文和引用保持普通字重，旧数据的超长第一项也不会被自动加粗。

报告生成或本地校验失败时清空未完成草稿，保留文章并明确说明回答未完成；无正文时说明检索情况，不虚构事实。不再填充通用观点或将指标说明充作回答。校验正常完成但回答被删空时进入 `recoverAnswer`：带原始问题、全部可用正文与校验原因，只生成一次文字回答，然后执行本地校验，保留此前通过的指标。补写失败不循环、不重新检索，也不覆盖已有指标。报告不再执行模型语义复核；正常搜索路径调用一次检索词规划、一次检索覆盖评估、一次报告生成和一次文案生成。直接 URL 提取无需前两次调用；报告和文案各自保留原有格式修复预算。

取消不进入兜底，HTTP 边界将原生取消映射为 499。首次模型格式修复和文案纠错由相应服务负责；补写模式禁止服务内部再次修复。当前图无回边，执行器检测重复节点，补写最多增加一次模型调用（生成回答）。

公开的 `analyze(idea, signal, observe, socialTargetLength, onEvent?)` 保留原有调用方式与 JSON 返回字段，新增可选公开事件回调，脚本使用新路径直接导入。复核相关观察事件随节点一起删除。请求体实际超限时统一返回 413；研究和文案 API 分别保留单进程并发上限 2。

`core/contracts.ts` 声明公开 `AnalysisEvent` 与阶段契约。执行器在节点运行前发送 `progress`，`completeReport` 合并后发送 `report`：使用与最终结果相同的公开投影，只包含已校验报告与公开来源，暂不包含文案或重生成 token。最终报告与阶段报告使用同一生成时间，文案完成时不重复滚动页面。内部 `observe` 继续用于脚本诊断，其研究正文、模型原始 JSON 和纠错内容不进入公开流。

`server/http.ts` 按 Accept 协商 JSON / SSE，两种传输共用端点并发额度。SSE 使用 POST fetch、JSON data 帧和 15 秒注释心跳；请求输入校验发生在返回流之前，流开始后的业务错误映射为受控 `error` 事件，完成发送 `result`。取消请求或消费端关闭流会中止执行信号，额度在执行真正结束后释放。`client/analysis-stream.ts` 负责跨块 UTF-8 解码、SSE 分帧、错误与完整结束检测；`use-analysis.ts` 管理增量状态、超时和过期请求，页面先展示观察，再挂载完成的文案组件。

## 这轮收敛了什么

| 原结构 | 当前归属与处理 |
| --- | --- |
| `lib/analysis` 的 14 个文件 | `server/workflow` 的 4 个文件，保留节点与边，取消逐动作包装 |
| `analyze.ts` 转发入口 | 直接由 `workflow/run.ts` 导出，删除旧文件 |
| 来源类型、覆盖、状态各自模块 | 归入纯 `core/sources.ts` |
| 千问联网工具解析与正文块协议 | 当前生产无调用，删除实现与专用测试；来源状态用当前 Tavily 行为验证 |
| 无调用方的文章去重算法 | 删除，保留每篇独立提取文章的现行政策 |
| 证据映射和报告校验 | 归入纯 `core/evidence.ts`，文案可复用，不依赖生成服务 |
| 报告生成 | 归入 `services/report.ts`，相关模型输出处理集中 |
| 社交纯校验与联网生成混合 | 纯规则进 `core/social.ts`，联网和重试进 `services/social.ts` |
| 通用错误藏在千问客户端 | 移入 `server/runtime.ts`，Tavily 不再依赖千问模块 |
| 三处模型 JSON 清洗 | 共用 `parseModelJson`；各业务服务单独校验结构 |
| 两个 API 重复的并发、体积、JSON、错误处理 | 共用 `server/http.ts`；路由只声明输入与业务调用 |
| 页面内的计时、fetch、取消与卸载处理 | 移入 `client/use-analysis.ts`，增加过期响应检查 |

重构前 `src` 有 39 个 TypeScript/TSX 文件，架构收敛时为 28 个；本轮独立拆分核心回答组件后为 29 个；旧 `src/lib` 的 31 个文件已删除并迁移必要职责。没有旧路径转发层，没有新增生产依赖。文件数仅作规模参考，关键结果是边界可测试、循环依赖为零、能力可以替换。

## 增长时改哪里

| 新需求 | 修改位置 |
| --- | --- |
| 改回答指令或写作风格 | `server/prompts.ts` 与提示词测试 |
| 新增模型或检索供应商 | `server/providers`、相应服务实现、`workflow/run.ts` 的组装 |
| 改覆盖、引用或数值政策 | `core` 与对应行为测试 |
| 新增研究步骤或路由条件 | `workflow/state.ts`、`nodes.ts`、`edges.ts` |
| 新增报告展示 | 数据契约与展示组件；纯格式规则留在 `core` |
| 流式进度 | 修改 `core` 的公开事件契约、工作流执行器和 HTTP / client 传输；避免公开上游全文事件 |
| 数据库存储与长任务恢复 | 新增实际需要的存储适配；选择具有检查点与恢复语义的运行时 |

短操作不再加一个转发文件。一个模块出现独立变化原因、独立副作用或明显不同的数据契约时才拆分。能力契约只描述实际需要的方法，不预建工具注册表、插件体系、仓储接口或通用 Agent 引擎。

## 社交配图

配图是文案之后由用户独立触发的操作：`components/social-image.tsx` → `/api/social-image` → `workflow/run.ts:createSocialImage` → `services/image.ts` → `providers/minimax.ts`。服务实现在现有 `run.ts` 组装，入口在调用前后检查取消；不向研究图添加条件分支或图像失败兜底。`core/contracts.ts` 保存纯输入契约与图片返回类型，浏览器只导入这些契约。

`prompts.ts:socialImagePrompt` 接收当前文案全文，固定 Corporate Memphis / Alegria、扁平矢量和极简几何风格；不把文章正文、依据或密钥传入图片模型。`services/image.ts` 管理提示词长度与最多两次请求的预算，重试原封不动重发同一个提示词，耗尽后抛出错误；取消、配置、鉴权与余额错误直接退出。没有替代图片、替代模型、缓存回退或自动改写文案。

供应商适配仅负责环境配置和 MiniMax HTTP 协议：固定 `image-01`、`n=1`、`aspect_ratio=3:4`、base64 和关闭 prompt optimizer，检查 HTTP 及 `base_resp.status_code`，确认响应恰好一张图片并识别 PNG / JPEG / WebP；不暴露上游原始错误。页面按当前文案挂载配图组件，文案重生成和切换问题会卸载组件、取消请求并清除旧图；新旧文案不共用图片。base64 在页面展示并通过下载链接保存，服务器不新增图片存储系统。

签名快照为当前文案重生成保留了原提示词，这是现行产品规则；它不是通用会话记忆。接口内的并发计数仅适用于单进程，横向部署时需改为共享额度。节点返回更新使替换运行时更容易，但不意味着已经拥有检查点、幂等重放或暂停恢复。

## 验证

`npm test` 覆盖业务、工作流、取消、状态隔离、HTTP 并发释放、提示词边界、架构依赖和签名保护，以及图片协议、次数预算、输入限制、取消和无兜底行为；流式测试覆盖报告先于文案、公开投影、SSE 分块、错误、截断、取消及与 JSON 共用额度。`npm run typecheck`、`npm run build` 验证集成。五项 UI 脚本验证移动端布局、来源抽屉、请求重试、复制、重生成与旧结果清除、分段回答的域名胶囊直达原文，以及单张配图、下载、错误与过期请求。`npm run test:ui:stream` 通过本地模拟 HTTP 服务逐块返回，验证真实浏览器接收进度、先展示观察、后展示文案，以及失败和取消的状态。UI 测试使用模拟响应，`npm run verify:image` 真实调用同一配图入口并保存示例，会产生用量。

## 参考依据

- [Anthropic：Scaling Managed Agents，2026-04-08](https://www.anthropic.com/engineering/managed-agents)：围绕稳定接口分离可变化的执行机制。
- [Anthropic：Harness design for long-running application development，2026-03-24](https://www.anthropic.com/engineering/harness-design-long-running-apps)：逐项检验脚手架价值，并在模型能力变化后收敛结构。
- [LangGraph：Thinking in LangGraph，当前官方文档](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)：节点返回更新、保留原始状态、计算可推导数据。

这些原则提供设计依据；当前目录划分是结合本项目规模与行为作出的工程选择，并非官方规定或通用最优答案。
