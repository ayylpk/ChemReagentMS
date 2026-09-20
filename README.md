# ChemReagentMS - 化学试剂库存管理系统

面向化学实验室的试剂库存管理系统：试剂主数据、批次出入库（FEFO）、效期预警、多级审批，内置 AI 助手（台账查询 / 知识库检索 / 禁配规则 / 缺口知识闭环）。

## 功能

- **库存主线**：试剂管理、批次入库、FEFO 出库、出库审批流、效期与安全库存预警（定时扫描）
- **知识库**：SDS·规章·SOP 长文档摄取（解析 + 人审漏斗），Qdrant 混合检索（dense + BM25，RRF 融合）
- **AI 助手**：意图路由三路 —— 台账结构化查询 / 知识库混合检索 / 闲聊，SSE 真流式
- **缺口知识**：本地没答案的问题 → AI 生成带免责的通用参考 → 落 MySQL → 人工确认入库
- **管理**：多角色 RBAC（管理员/仓库管理员/实验员/采购员/PI）、操作日志、Excel 报表导出

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Spring Boot 3.x · MyBatis + PageHelper · MySQL 8 + Druid · Redis · JWT |
| 前端 | Vue 3 + Vite · Element Plus · Pinia · Axios |
| AI | LangGraph.js（Bun）+ DeepSeek · Hono :8123 · Qdrant 双向量 RRF · Ollama bge-m3 · pymupdf4llm / markitdown / openpyxl + qwen-vl OCR |

## 项目结构

```
ChemReagentMS/
├── backend-ChemReagentMS/     # 后端 Maven 多模块（common / pojo / server）
├── frontend-ChemReagentMS/    # 前端 Vue 3（layout / router / stores / utils / views）
├── tsAgent/                   # AI Agent（LangGraph.js）+ Hono 周边服务 :8123
│   ├── src/agent/  src/rag/  src/tools/  src/service/  src/pytools/
│   └── corpus/                # 上传语料落盘（gitignore）
├── deploy/                    # Dockerfile / SQL
└── env.example                # 环境变量模板（复制为 .env 使用）
```

## 服务端口

| 服务 | 端口 |
|------|------|
| 后端 API（Spring Boot） | 8080 |
| 前端（Vite dev） | 5173 |
| Hono Agent 服务 | 8123 |
| Qdrant（Docker，卷 qdrant-data） | 6333 |
| Ollama bge-m3 | 11434 |

前端代理：`/api` → 8080；`/ingest` `/agent` `/review` `/reaction` `/gap` → 8123

## License

MIT
