// 周边 HTTP 服务（9/6 起 = agent 侧唯一常驻进程）：摄取 API + 解析人审 + 缺口知识 + 聊天流式端点
// :8123 承接 vite 代理：/ingest、/agent→runs/stream、/review、/gap
//   （自写线协议最小子集，替代 langgraph dev :2024）
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from '../config/env'
import { reviewRoutes } from './routes/review'
import { gapRoutes } from './routes/gapKnowledge'
import { ingestRoutes } from './routes/ingest'
import { streamRoutes } from './routes/stream'

const app = new Hono()

app.get('/healthz', (c) => c.json({ ok: true, port: config.SERVICE_PORT }))
app.route('/review', reviewRoutes) // 解析层人审（B 线，DDL: deploy/sql/04）
app.route('/gap', gapRoutes) // 缺口知识（AI 生成 → 人工确认，DDL: deploy/sql/05）
app.route('/ingest', ingestRoutes)
app.route('/agent', streamRoutes) // Chat.vue 走 /agent 代理 → :8123（不再依赖 langgraph dev :2024）

console.log(`[service] http://127.0.0.1:${config.SERVICE_PORT}`)
serve({ fetch: app.fetch, port: config.SERVICE_PORT })
