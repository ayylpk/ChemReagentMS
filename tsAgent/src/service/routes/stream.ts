// /agent/runs/stream —— 自写的 LangGraph 线协议最小子集（9/6 拍板：上线不拉 langgraph-api Python 镜像）
// 本地/线上同一个 Hono :8123 一套协议；langgraph dev(:2024) 降级为可选调试工具，前端不再依赖
// 协议（自己两端，够用就行）：
//   入 POST body { input: { question }, config: { configurable: { thread_id } } }
//      —— 档位**不收客户端自报的 mode**，由服务端按 token 判定（见下方 isPublic）
//   出 SSE data 行：{"type":"ai_chunk","text":"…"} 增量 → {"type":"done"} / {"type":"error","message":"…"}
// 未带有效 token 时（免登录演示通道 /assistant）的两件套：
//   ① allowDb=false —— 台账路关闭（提示词隔离 + 条件边双保险，库存数据不给匿名者）
//   ② per-IP 限流 —— 8 条/分钟 + 200 条/天（内存计数器，进程重启即重置，demo 够用）
// 注：联网兜底与它的"全局日预算"已随联网搜索一起移除（本地空手改为缺口问答进 MySQL 待办）
// 会话记忆：图里 MemorySaver 按 thread_id 分线程（进程内存档，服务重启 = 全员清空，符合"临时会话"定位）
import { Hono, type Context } from 'hono'
import { getConnInfo } from 'hono/bun'
import { AIMessageChunk } from '@langchain/core/messages'
import { graph } from '../../agent/graph'
import { tokenOf, verifyJwt } from '../auth'
import { config } from '../../config/env'

export const streamRoutes = new Hono()

// ── 限流器（固定窗口，进程内存版；升级路径=换 Redis，键语义不变） ──
// 两档：匿名（演示通道）严格、按 IP；内部（带有效 token）宽松、按 uid。两类都要过闸门。
const MIN_WINDOW = 8           // 匿名：每分钟
const DAY_WINDOW = 200         // 匿名：每天
const INTERNAL_MIN = 60        // 内部：每分钟（防失控，不做精细治理）
const INTERNAL_DAY = 2000      // 内部：每天
const buckets = new Map<string, { minStart: number; minCount: number; day: string; dayCount: number }>()

function takeQuota(key: string, internal: boolean): { ok: boolean; msg?: string } {
	const minLimit = internal ? INTERNAL_MIN : MIN_WINDOW
	const dayLimit = internal ? INTERNAL_DAY : DAY_WINDOW
	const now = Date.now()
	const day = new Date(now).toISOString().slice(0, 10)
	const b = buckets.get(key) ?? { minStart: now, minCount: 0, day, dayCount: 0 }
	if (b.day !== day) Object.assign(b, { day, dayCount: 0 })
	if (now - b.minStart > 60_000) Object.assign(b, { minStart: now, minCount: 0 })
	if (b.minCount >= minLimit) {
		buckets.set(key, b)
		return {
			ok: false,
			msg: internal ? `请求过于频繁（每分钟上限 ${minLimit} 条），稍后再试` : '演示通道每分钟最多 8 条，歇一会儿再问～',
		}
	}
	if (b.dayCount >= dayLimit) {
		buckets.set(key, b)
		return { ok: false, msg: internal ? `今日请求量已达上限（${dayLimit} 条）` : '今日演示额度已用完，明天再来或登录完整版' }
	}
	b.minCount++
	b.dayCount++
	buckets.set(key, b)
	return { ok: true }
}

/**
 * 限流用的客户端标识。
 * ⚠️ **默认取 TCP 对端地址**（客户端伪造不了）；只有明确部署在可信反代后面（`TRUST_PROXY=1`）时才读 XFF。
 * 旧写法无条件信任 `x-forwarded-for` 首段 —— 一个 `curl -H 'X-Forwarded-For: 1.2.3.4'` 就换到新桶，
 * 「8 条/分钟」形同不存在。
 */
const clientIp = (c: Context): string => {
	if (config.TRUST_PROXY) {
		const xff = c.req.header('x-forwarded-for')
		if (xff) return xff.split(',')[0]!.trim()
	}
	try {
		return getConnInfo(c).remote.address ?? 'local'
	} catch {
		return 'local' // 拿不到对端地址（非 Bun adapter 等）：归到同一个桶，宁严不宽
	}
}

streamRoutes.post('/runs/stream', async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		input?: { question?: string }
		config?: { configurable?: { thread_id?: string } }
		mode?: string
	} | null
	const question = String(body?.input?.question ?? '').trim()
	// 通道档位**由服务端按身份判定，绝不采信请求体里的 mode**。
	//   带了有效 token → 内部通道（allowDb 放开，权限另由 RBAC 管）
	//   没带 / token 无效 → 演示通道（关台账路 + 严格限流）
	// 旧写法 `isPublic = body.mode === 'public'` 等于让调用方自己申报权限：不传 mode 即 isPublic=false，
	// 于是 allowDb 默认放开、且完全不过限流 —— 匿名直接问"乙醇还剩多少"就能拿到内部台账。
	const payload = config.JWT_SECRET_KEY ? verifyJwt(tokenOf(c), config.JWT_SECRET_KEY) : null
	const isPublic = payload === null
	const uid = typeof payload?.uid === 'number' ? payload.uid : null

	// 会话键按身份分命名空间（匿名统一加 pub: 前缀，内部按 uid 前缀）。
	// 旧写法直接采信客户端传来的 thread_id —— 猜中/枚举到别人的线程号就能读到对方上下文
	// （服务端 MemorySaver 是共享的，getState 只认 thread_id）。
	// 完整做法是按身份派生命名空间 + 线程数 LRU 上限，本次先堵住"匿名读内部会话"这条最直接的越权路径。
	const rawThread = String(body?.config?.configurable?.thread_id ?? '').trim() || 'anon'
	const threadId = isPublic ? `pub:${rawThread}` : `u${uid ?? 'x'}:${rawThread}`

	if (!question) return c.json({ error: 'input.question 必填' }, 400)
	if (question.length > 500) return c.json({ error: '问题过长（≤500 字）' }, 400)

	// 两类通道都要过闸门（旧写法只限 public，而那时的 isPublic 可由客户端自报 —— 等于不限流）；
	// 超限时连图都不进（一次 LLM 都不起）
	const quota = takeQuota(isPublic ? `ip:${clientIp(c)}` : `uid:${uid ?? 'x'}`, !isPublic)
	if (!quota.ok) {
		return new Response(
			`data: ${JSON.stringify({ type: 'ai_chunk', text: quota.msg })}\n\ndata: {"type":"done"}\n\n`,
			{ headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } },
		)
	}

	const enc = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (obj: Record<string, unknown>) =>
				controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
			let gotChunk = false
			try {
				const it = await graph.stream(
					{ question, allowDb: !isPublic },
					{
						configurable: { thread_id: threadId },
						streamMode: 'messages',
						// 客户端断开（关页面/切走）就中止这一轮：否则图会继续跑完 —— 继续调模型、继续烧额度，
						// 结果却写进一个已经没人接收的流。signal 取自请求本身（连接断开时由运行时触发）。
						signal: c.req.raw.signal,
					},
				)
				for await (const [msg, meta] of it as unknown as AsyncIterable<[any, any]>) {
					// 三重交集才上屏：result 节点 + 是增量块 + 文本非空
					//   漏任一条都会炸：router/dbQuery 的 isChunk 块 content 为空（结构化输出流）；
					//   末尾还有个 isChunk=false 的聚合态 AIMessage，转它=整句重复一遍（9/6 调试实录）
					//   另注：messages 流里 chunk.getType() 返回 'ai' 而非 'AIMessageChunk'，只能靠 isInstance 判
					if (meta?.langgraph_node !== 'result') continue
					if (!AIMessageChunk.isInstance(msg)) continue
					const text = typeof msg?.content === 'string' ? msg.content : ''
					if (!text) continue
					gotChunk = true
					send({ type: 'ai_chunk', text })
				}
				if (!gotChunk) {
					// 无流式块的结局（result 节点 catch 里手搓的错误消息）：去终态捞最后一条，保证气泡有字
					const st = await graph.getState({ configurable: { thread_id: threadId } })
					const last = st?.values?.messages?.at?.(-1)
					const text = typeof last?.content === 'string' ? last.content : ''
					if (text) send({ type: 'ai_chunk', text })
				}
				send({ type: 'done' })
			} catch (e) {
				// 客户端主动断开引发的中止不是错误：安静收场（连 done 都不必发，对端已经不在了）
				if ((e as Error)?.name === 'AbortError') {
					controller.close()
					return
				}
				send({ type: 'error', message: (e as Error).message.slice(0, 200) })
			}
			controller.close()
		},
	})
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no', // nginx 侧关缓冲（线上加 this 头防"憋到最后一次吐"）
		},
	})
})
