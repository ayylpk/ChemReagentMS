// 三路冒烟：bun run scripts/smoke-graph.ts
// 一条命令验证 router→{db|knowledge|chat}→(缺口问答)→result 全链，打印路由判定+回答头一段
// 注：联网兜底已移除 —— 本地空手时走 gap 节点（生成带免责的通用参考 + 落 MySQL 待办）
import { graph, newThreadId, ragConfig } from '../src/agent/graph'

const CASES: { q: string; expect: string }[] = [
	{ q: '乙醇现在还有多少瓶？放在哪？', expect: 'db' }, // 台账数字 → stock_by_name
	{ q: '过氧化氢着火了怎么办？', expect: 'knowledge' }, // 文档内容 → 混合检索
	{ q: '你好呀', expect: 'chat' }, // 寒暄 → 不查数据
	{ q: '七氧化二锰的半致死量是多少？', expect: 'gap' }, // 本地必空手 → 缺口问答（生成 + 待办）
]

for (const { q, expect } of CASES) {
	const t0 = performance.now()
	// 每问一个新线程：冒烟要的是"单路正确"，别串多轮上下文
	const res = await graph.invoke({ question: q }, ragConfig(newThreadId()))
	const answer = String(res.messages.at(-1)?.content ?? '').replace(/\s+/g, ' ')
	const marks = [
		res.route ? `route=${res.route}` : '',
		res.dbResult ? `db=${dbHit(res.dbResult) ? 'hit' : 'miss'}` : '',
		res.RAGcontents?.length ? `rag=${res.RAGcontents.length}` : '',
		res.gapId ? `gap=#${res.gapId}` : (res.gapResult ? 'gap✓(未落表)' : ''),
		res.llmCalls != null ? `llm=${res.llmCalls}` : '',
	].filter(Boolean).join(' ')
	// gap 路的判定：要么落了待办表（gapId），要么至少产出了缺口参考文本
	const ok = expect === 'gap' ? !!(res.gapId || res.gapResult) : res.route === expect
	console.log(`\n${ok ? '✓' : '✗'} [${expect}] ${q}`)
	console.log(`  ${marks} | ${((performance.now() - t0) / 1000).toFixed(1)}s`)
	console.log(`  A: ${answer.slice(0, 160)}${answer.length > 160 ? '…' : ''}`)
}

function dbHit(t: string) {
	return !!t && !/结果为空|未知模板|缺必填|执行失败/.test(t)
}
process.exit(0)
