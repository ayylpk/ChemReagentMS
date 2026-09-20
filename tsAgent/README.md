# tsAgent —— BioReagentMS 的 TS 版 Agent + RAG 工程

BioReagentMS 的 agent 侧全部家当（旧 py 版 `agent-BioReagentMS` 已于 9/6 删除）。
技术栈：**Bun + TypeScript + LangGraph.js**，py 只作解析能力扩展（`pytools/`，CLI 契约调用）。

## 目录地图（每层职责 = 一个设计决策）

```
langgraph.json          # graph 注册：reagent_assistant → src/agent/index.ts:graph
contracts/              # ★ 跨语言契约单一事实源（doc-profile schema + Block 数组）
src/
├── agent/              # 主图：router→{db|knowledge|chat}→(dbQuery/rag/gap)→result 三路路由
│   ├── graph.ts        #   StateGraph 装配 + 判空降级全在代码（分流铁律）
│   ├── prompts.ts      #   提示词归档（图内自带现行版本，此文件是历史参考）
│   └── index.ts        #   langgraph.json 的取图入口（可选调试路）
├── tools/              # query_reagent_db(模板白名单)/search_knowledge/gapAnswer(缺口) + dbTemplates
├── rag/
│   ├── inspect/        # ★ 三层探测 → DocProfile（魔数表 + zip 深判 + 内容嗅探兜底；失败事实进 notes）
│   ├── parse/          # formats.ts 扩展名唯一事实源 + route(switch) + fromPy(pytools+diag+解释器候选)
│   ├── chunk/          # 分节切分：SDS 16 节天然边界，表格=原子 chunk
│   ├── gate/           # 质量闸门：乱码率/页均字数/列数一致/CAS 校验位（代码断言）
│   ├── embed/          # Ollama bge-m3（embed 同签名，可换 DashScope v4，见 deploy/DEPLOY.md 五哨①）
│   ├── sparse/         # jieba+TF 稀疏向量（Qdrant 服务端 idf）
│   ├── store/          # Qdrant 按 doc_id 幂等 upsert（增量一致性，不全量重建）+ ingest_log 台账
│   ├── search.ts       # 生产读侧唯一入口：named dense+sparse 双路 RRF + 相关性地板
│   └── pipeline.ts     # 编排：probe→route→chunk→gate→store 四状态落账
├── service/            # Hono :8123 —— agent 侧唯一常驻进程
│   ├── auth.ts         #   JWT(HS256) 自校验 + role_permission 查表（role 0 全通；缺 secret 一律 503 关门）
│   ├── routes/ingest.ts    #   /ingest 上传/台账/格式口径/重摄/删除（Knowledge.vue 的后端）
│   ├── routes/gapKnowledge.ts # /gap 缺口知识（AI 生成 → 人工确认）
│   ├── routes/stream.ts    #   /agent/runs/stream —— SSE 最小子集（前端不再依赖 :2024）
│   ├── routes/review.ts    #   /review 解析层人审（B 线：列表/详情/确认入库/驳回）
├── db/                 # mysql2 只读池 + SELECT 断言
└── config/             # zod 环境校验，缺 key 启动即死
pytools/                # py 能力扩展：parse.py CLI（stdout=契约 JSON，失败=非零码，TS 侧旁路降级）
scripts/ingest.ts       # bun run ingest -- <file|dir> 摄取入口
samples/                # 五类靶子（README 列了清单，真 SDS 别造玩具）
eval/qa50.jsonl         # 四路路由+命中率评估集骨架
resources/              # 解析资产落盘（图片/隔离件），不入库
```

## 缺口知识（本地查不到 → AI 生成 → 人工确认，全程在 MySQL）

联网搜索（Tavily）已整体移除。本地知识库没命中时的处理链是：

```
rag 空手 → gap 节点：先查 rag_gap_knowledge 能否复用（同问题不重复生成）
              ├─ 命中 pending → 复用并标注「待人工确认」
              ├─ 命中 done    → 复用并标注「已确认的缺口知识」
              └─ 没命中       → 生成一段**强制带免责声明**的通用参考 → 写进 MySQL（pending）
                                → 前端「缺口知识」页分页展示 → 人工改写/点「完成」（或忽略）
```

**为什么不直接进向量库**：写入侧红线是"chunk 正文不许掺 LLM 生成内容"（`chunk/bySection.ts`），
生成物进向量库 = 把生成内容伪装成文献证据。done 之后的价值来自**同问题复用**（`store/gap.ts`），不是检索。

**prompt 层封死**：不许给任何具体数字结论（闪点/浓度/剂量/限值/库存）、不许给"能不能混放"的结论，
第一句必须是"本地文档库中没有查到对应依据，以下是通用参考（未经核实）"——模型漏写时**代码兜底补上**。
台账路（db）空手时**不生成**：数字编一个比答不出危险得多。

DDL：`deploy/sql/05_rag_gap_knowledge.sql`（`question_hash` UNIQUE —— 没有它，同一问题会反复生成、表很快变垃圾场）。
端点：`/gap/list`（分页）、`/gap/:id`、`/gap/:id/done`、`/gap/:id/ignore`；权限码 `gapKnowledge:query` / `:audit`。

## 两条人审闭环（9/16 打通）

| 线 | 干什么 | 端点 | 权限码 | 前端 |
|----|--------|------|--------|------|
| **B 解析层** | 过闸门不过/前门判死/拒收的文档：看档案+解析原文 → 改 → 确认入库 / 驳回 | `/review/pending`、`/review/:docId`、`/:docId/confirm`、`/:docId/reject` | `ragReview:query` / `:audit` | `ReviewParse.vue` |

三条纪律（都写进代码与测试）：
1. **审核人只从 JWT 取**（`reviewerIdOf`）：body 里传的 `reviewedBy` 一律忽略 —— 审核记录必须能追到真人。
2. **确认入库 ≠ 改个标记**：人工修正后的 blocks 会**重新切块 + 真入库**，否则队列写着"已确认"、库里却没内容（比空壳更坏的假绿）。
3. **保密失败姿态**：`JWT_SECRET_KEY` 未配置 → 人审端点一律 503（**关掉，绝不敞开**）；权限查询失败 → 按不放行处理。

DDL：`deploy/sql/04_rag_review_queue.sql`（队列表 + `ragReview:*` 权限点）。
落料点在 pipeline 四个非 done 出口（front-door / parser-reject / gate / needs-upgrade）——
**闸门不过那处最值钱**：它存下完整 blocks，人审才有得改。

## 三级成本漏斗（解析层宪法）

```
L0 免费直抽(direct/栏重排/列拼接) ──过闸门──→ 入库
L1 pytools VL(qwen-vl-ocr, ~¥0.001/页)──过闸门──→ 入库    整库 < ¥5
L2 人审队列(service /review) → 人工确认才入库，修正样本=回归评估集原料
```

## 解析层能力边界（9/16 解析泛化第一刀）

**口径三档**（`src/rag/parse/formats.ts` 是唯一事实源，四端共用；加扩展名先想清楚落哪档）：

| 档 | 含义 | 处置 |
|----|------|------|
| `FAMILY_EXT` | 能解析进库 | 进管线（pdf/docx/xlsx/pptx/html/odf/rtf/图片6种/文本19种） |
| `CONVERT_REQUIRED_EXT` | 认识但引擎吃不下 | **门口明确拒绝 + 一句转存人话理由**（.doc/.xls/.ppt/wps/iWork/heic/压缩包…） |
| `JUNK_EXT` | 临时/备份件 | 目录扫描跳过（不说"不支持"，那是不该扫） |

**前门判定顺序改了**：改前是"后缀命中文本族就直接 return"，于是**叫 .md 的 PDF 会被当文本读成乱码且无人知晓**；
现在是**内容实判优先**，后缀只作"声明"，两者不符时以内容为准并写进 `profile.notes`；
内容也认不出（陌生后缀）→ **内容嗅探兜底**（头部 512B 若可解码为文本就按文本族收，不再落 L2 黑洞）。

**diag 契约**：`parse.py --stdout` 从 `{blocks,reject}` 扩成 `+diag`（页级/图级/表级降级事实，见
`contracts/doc-profile.schema.json` 的 `$defs.ParseDiag`），`fromPy` 逐字段校验（多余字段直接报错），
`gate` 把它变成 info 级 flags 进 `ingest_log`。**纪律：diag 断言一律 info，不新开黄/红** ——
当前处置链里黄灯 = 整档隔离且无人复核，新开一条黄灯的实际语义是"这份文档从知识库消失"。

**解释器**：`PYTHON_BIN` 显式指定则只认它；未指定时 Windows 走 `py → python3 → python`、POSIX 走 `python3 → python`，
**只在环境级失败（连契约都没吐）且失败得很快时换下一个候选**。这条是踩出来的：本机 `python` 是 msys 3.12
（pymupdf/markitdown 一个没装），依赖全在 3.14 里，于是 pdf/docx/xlsx 全部"解析失败 → 落回手写"，其余格式直接隔离。

**不装第三方库也能抽**：html/odf/pptx/rtf/csv/文本族全部有标准库实现，markitdown 只在**真正转换成功**时才被采信
（实测 markitdown 对 RTF 会把控制字原样吐回，那不是转换，已有产出体检拦住）。

## 切块（9/16 切片泛化第二刀）

**通用引擎** `src/rag/chunk/recursive.ts`（纯函数、零 I/O）：**只认纯文本，不假设任何结构**。
"结构随意"的文档不是另走一条路，而是同一条路上的自然退化。

```
① 归一    保行结构（不再把连续非空行拼成一段 —— 行结构在块化阶段被扔掉是碎块的病根之一）
          相邻重复行保守去重（去标点后相同，或一方包含另一方且被包含者 ≥24 字；差一个条件的两条都留）
② 切      目标区间 [MIN 250, MAX 800]，软上限 920
          窗口 [from+MIN, from+MAX] 内取优先级最高的一类里**最靠右**的切点：段落 > 句末(。！？；) > 换行 > 逗号
          窗口内没有 → 往后扩到软上限，取**遇到的第一个**（"达到上限继续往后找边界"）
          还没有（无标点巨串）→ 硬切于 MAX，绝不返回超限块
③ 并      不足下限的相邻片并起来（含"尾巴碎块"）；硬约束：并完不超软上限
④ 叠      只在**真切开的缝**上给：下一块头部 = 上一块尾部 10%（≤150 字，前块 <80 字不带）
          被并掉的缝不算缝（内容连续、没丢东西、不需要重叠）；长度记 payload.overlap_chars
⑤ 锚      文档标识 + 标识符 + 完整标题路径；无结构 → section 留空，不拿文件名硬凑
```

**结构只当"帧"，不参与切点决策**：`heading` 只产出元数据（`heading_path` / `section` / `sections`）。
跨节打包后一块可能横跨数节，所以 `section` = 覆盖帧路径的**公共祖先**（不编造），`sections[]` = 覆盖到的各叶子节名，
读侧 section 过滤发 `should`（section 或 sections 任一命中）—— 只认 section 会漏掉"把该节并进去"的块。

**两种模式一行切换**（`bySection(file, blocks, { perFrameBoundary })`，300 份 ICSC 实测）：

| 模式 | chunk/份 | p50 | <120 字 | 横跨多节 | 代价 |
|------|---------|-----|---------|---------|------|
| **A 跨节打包（默认）** | 2.6 | 706 | 0% | 65.8% | 一节内容会与邻节同块（靠 sections[] 保住过滤精度） |
| B 一节一块 | 10.7 | 109 | 60% | 0% | 块太小、锚占比高（向量被锚词主导） |

改前基线：10.7 块/份、p50=109、碎片率 59.5%。两模式的**零丢失校验都是 0 失败**（与"清洗后原文"逐字相等）。

**payload 契约 v3**：+ `overlap_chars`、+ `sections[]`（keyword index）；`SCHEMA_VERSION` 2→3。
**代价**：切法变 → `seq` 全变（解析层人审按 seq 定位来源），
所以上线这套要配一次全量重摄 + 一轮规则来源复核。

## 快速开始

```bash
cp .env.example .env   # 填 key（LLM 走 OpenAI 兼容口，DeepSeek/DashScope 均可）
bun install
bun run service        # Hono :8123 —— 本地/线上唯一常驻进程（摄取+人审+聊天流式端点）
bun run ingest -- samples/   # CLI 摄取入口（走 pipeline，和上传 API 同一台发动机）
bun run typecheck
bun run scripts/smoke-graph.ts  # 四路路由冒烟（需 LLM key 有余额）
bun run dev            # 可选：langgraph server :2024 调试图结构用，前端已不依赖
```

## 集成期 TODO（9/6 结账）

- [x] graph 名保持 `reagent_assistant`；`/runs/stream` 协议两端自写（stream.ts + Chat.vue），:2024 从关键路径摘除
- [x] vite proxy：`/ingest` `/agent` `/review` `/gap` → 8123 全收编
- [x] `git rm -r ../agent-BioReagentMS`（9/6 完成；.env 键已核对，新工程无缺失）
- [ ] L2 人审队列实装（review.ts 空壳 + 前端对照页）
- [ ] qa50 灌题跑命中率（地板值 0.35 等参数等它回调）
- [ ] 爬虫 fetch-sds 走 /ingest/upload 喂料（UI 无爬虫入口，脚本直连 API）
