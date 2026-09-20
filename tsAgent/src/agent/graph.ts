// ═══ 主图装配：三路意图路由 + 本地未命中 → 缺口问答（生成并进待办，不再联网） ═══
// 分流铁律（code-over-tools）：路由/判空/降级这些确定性逻辑全由代码节点做，
//   LLM 只干三件结构化的事——"一句话分类"（router）、"从白名单挑模板抽参"（dbQuery）、
//   以及"本地无依据时生成一段参考回答"（gapAnswer，**产出一律进待办表等人工确认，绝不直接入知识库**）
// 流程：
//   START → router ─ db ────────→ dbQuery ─(命中)──────────→ result
//                                        (空)→ result（不编数字）
//           START → router ─ knowledge → getQuerys → rag ─(有素材)→ result
//                                                       (空)→ gapAnswer → result
//           START → router ─ chat ─────────────────────────→ result
import { StateGraph, START, END, Annotation, messagesStateReducer, MemorySaver, type GraphNode } from '@langchain/langgraph'
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import { config } from '../config/env'
import { hybridSearch } from '../rag/search'
import { runTemplate, renderCatalog, DB_FAIL_PREFIX } from '../tools/dbTemplates'
import { answerGap, renderGapMaterial } from '../tools/gapAnswer'

// ── 会话层：短期记忆窗口 / 多用户线程键 ──
const MEMORY_WINDOW = 20 // 短期记忆只留最近 20 条（≈10 轮问答），谁再往里塞都当场截

/** 会话标识：当前时间 + 4 位随机数字 —— 脚本直调用
 *  ⚠️ HTTP 端（/agent/runs/stream）前端用 crypto.randomUUID()，两边只是字符串键，互不影响 */
export function newThreadId(): string {
	const rand = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
	return `${Date.now()}${rand}`
}

/** 组装 invoke/stream 的 config：按 thread_id 隔离多用户上下文 */
export function ragConfig(threadId: string) {
	return { configurable: { thread_id: threadId } }
}

const AgentState = Annotation.Root({
	messages: Annotation<BaseMessage[]>({
		default: () => [],
		// 先走 langgraph 官方 append 语义（按 id 去重/合并），再切窗口
		// 不截 = channel 无界增长，每步 checkpoint 全量写盘越来越肥，最后爆的是存档不是 prompt
		reducer: (x, y) => messagesStateReducer(x, y).slice(-MEMORY_WINDOW),
	}),
	question: Annotation<string>({ default: () => '', reducer: (_x, y) => y }),
	route: Annotation<'db' | 'knowledge' | 'chat'>({ default: () => 'knowledge', reducer: (_x, y) => y }),
	// 免登录演示通道（/assistant）置 false：台账路整个关闭 —— 库存是实验室内部数据，匿名者只能碰公开文献
	allowDb: Annotation<boolean>({ default: () => true, reducer: (_x, y) => y }),
	querys: Annotation<string[]>({ default: () => [], reducer: (_x, y) => y }),
	RAGcontents: Annotation<string[]>({ default: () => [], reducer: (_x, y) => y }),
	dbResult: Annotation<string>({ default: () => '', reducer: (_x, y) => y }),
	/** 缺口问答：本地无依据时模型生成的参考回答（**同一份同时写进 MySQL 待办表**，等人工确认） */
	gapResult: Annotation<string>({ default: () => '', reducer: (_x, y) => y }),
	gapId: Annotation<number | null>({ default: () => null, reducer: (_x, y) => y }),
	llmCalls: Annotation<number>({ default: () => 0, reducer: (x, y) => x + y }),
})

// 三个轻 LLM 共用一个底座（分类/抽参/改写这种活不吃模型，deepseek-chat 足够）
// ⚠️ withStructuredOutput 必须显式 functionCalling：默认 json_schema 路 DeepSeek 直接 400
//   "This response_format type is unavailable now"（9/6 冒烟实录）；换中转站若连 tool call 也没，才降级 jsonMode
const liteModel = () =>
	new ChatOpenAI({ model: config.LLM_MODEL, apiKey: config.LLM_API_KEY, configuration: { baseURL: config.LLM_BASE_URL } })

// ══ 节点：router —— 一句话定路（前置分流，别浪费向量检索的钱去答"你好"）══
const routerModel = liteModel().withStructuredOutput(
	z.object({ route: z.enum(['db', 'knowledge', 'chat']).describe('三选一的意图路由') }),
	{ name: 'route_pick', method: 'functionCalling' },
)

const ROUTE_PROMPT = `你是试剂库助手的前置分流器，把用户问题归为三类之一，只做分类，不回答。
- db：问我们台账里的数字——库存数量/批次/存放位置/价格/效期/库存预警（能用 WHERE/GROUP BY 回答的）
- knowledge：问文档内容——SDS 分节讲了什么（成分/危害/急救/消防/储存/废弃）、规章、SOP、仪器手册
- chat：寒暄、致谢、问你是谁这类不查数据的话
判定倾向：出现"还有多少/放哪/哪个批次/快过期/低于安全线"→ db；出现"怎么办/什么危害/说明/要求"→ knowledge；
  多轮指代（"那它放哪"）要结合上文判断。拿不准 db 还是 knowledge 时选 knowledge（向量检索语义宽容，db 模板选错就全错）`

// 公开通道的分类器：db 类根本不在选项里 —— 与其"选了再拦"，不如"没得选"（提示词层面物理隔离）
const ROUTE_PROMPT_PUBLIC = `你是试剂库演示助手的前置分流器，把用户问题归为两类之一，只做分类，不回答。
- knowledge：问化学品的公开信息——SDS 分节讲了什么（成分/危害/急救/消防/储存/废弃）、实验规章、操作规范
- chat：寒暄、致谢、问你是谁，以及一切涉及"我们库存/台账数字"（还有多少/放哪/价格/效期）的问题——本演示通道没有内部台账权限，这类一律归 chat
多轮指代要结合上文判断`

const routerModelPublic = liteModel().withStructuredOutput(
	z.object({ route: z.enum(['knowledge', 'chat']).describe('二选一（演示通道无台账权限）') }),
	{ name: 'route_pick_public', method: 'functionCalling' },
)

const routerNode: GraphNode<typeof AgentState.State> = async (state) => {
	const question = state.question.trim()
	if (!question) return { route: 'chat', llmCalls: 0 }
	const allowDb = state.allowDb !== false
	try {
		const history = state.messages
			.slice(-4)
			.map((m) => `${m.getType() === 'human' ? '用户' : '助手'}: ${String(m.content).slice(0, 80)}`)
			.join('\n')
		const model = allowDb ? routerModel : routerModelPublic // 提示词层隔离 + 下面条件边双保险
		const { route } = await model.invoke([
			new SystemMessage(allowDb ? ROUTE_PROMPT : ROUTE_PROMPT_PUBLIC),
			new HumanMessage(`${history ? `上文：\n${history}\n\n` : ''}当前问题：${question}`),
		])
		return { route: route as 'db' | 'knowledge' | 'chat', llmCalls: 1 }
	} catch (e) {
		// 旁路化：分类挂了走 knowledge 主路（向量检索语义宽容，最差也是"未检索到"而不是死图）
		console.warn('[router] 分流失败，默认 knowledge 路:', (e as Error).message)
		return { route: 'knowledge', llmCalls: 1 }
	}
}

// ══ 节点：dbQuery —— 白名单里挑模板 + 抽参，然后代码执行 ══
const extractor = liteModel().withStructuredOutput(
	z.object({
		sql_name: z.string().describe('白名单模板名，选不出就填 none'),
		params: z.record(z.string(), z.string()).default({}).describe('模板参数（值，不是 SQL）'),
	}),
	{ name: 'db_pick', method: 'functionCalling' },
)

const DB_EXTRACT_PROMPT = `你是试剂台账查询的抽参模块：把用户问题映射到下面白名单模板之一。
## 模板白名单
${renderCatalog()}
规则：
1. sql_name 只能是上面列出的名字，一个字都不能改；语义套不上任何模板就填 "none"
2. 参数从问题里原样提取（名称/CAS 不要改写），问题没给天数就不填 days
3. 只做映射，不回答问题`

const dbQuery: GraphNode<typeof AgentState.State> = async (state) => {
	const question = state.question.trim()
	if (!question) return { dbResult: '', llmCalls: 0 }
	try {
		const { sql_name, params } = await extractor.invoke([
			new SystemMessage(DB_EXTRACT_PROMPT),
			new HumanMessage(question),
		])
		const dbResult = sql_name === 'none' ? '' : await runTemplate(sql_name, params)
		return { dbResult, llmCalls: 1 }
	} catch (e) {
		// ⚠️ 不能退化成空串：空串会被 dbMiss 判成"没查到"，用户看到"未检索到相关内容"，
		//    而真相是查询压根没执行（抽参模型不可用 / 连接池耗尽…）。带前缀把故障传下去。
		console.warn('[dbQuery] 抽参/执行失败:', (e as Error).message)
		return { dbResult: `${DB_FAIL_PREFIX}${(e as Error).message.slice(0, 150)}`, llmCalls: 1 }
	}
}

/** runTemplate 的返回值哪些算"**真的没查到**"——判空用字符串规则，确定性代码。
 *  ⚠️ 不含"执行失败"：那是故障，必须走 dbFailed 单独处理，绝不能当空结果。 */
const dbMiss = (t: string) => !t || /结果为空|未知模板|缺必填/.test(t)

/** 台账查询"未能执行"（故障），与 dbMiss 互斥 */
const dbFailed = (t: string) => !!t && t.startsWith(DB_FAIL_PREFIX)

// ══ 节点：getQuerys —— question 改写为 RAG 检索查询（同 9/5 版）══
const queryRewriter = liteModel().withStructuredOutput(
	z.object({
		querys: z.array(z.string().min(1)).min(1).max(3).describe('1~3 条给向量检索用的查询语句'),
	}),
	{ name: 'rag_querys', method: 'functionCalling' },
)

const QUERY_REWRITE_PROMPT = `你是试剂库 RAG 的查询改写模块，把用户问题转成向量库的检索查询。只做改写，不回答问题。
规则：
1. 去掉口语成分（礼貌语/假设语气/称呼），只留核心实体+意图
2. 化学品名、CAS 号、规格数字原样保留，不要把俗称改成学名
3. 术语靠拢 SDS 分节用词，例如"着火了怎么办"→"火灾应对措施"，"洒了"→"泄漏应急处理"，"能不能放一起"→"储存条件 禁配物"
4. 产出 1~3 条互补查询（原问题改写版 + 同义术语版），措辞彼此有差异以扩大召回`

const getQuerys: GraphNode<typeof AgentState.State> = async (state) => {
	const question = state.question.trim()
	if (!question) return { querys: [], llmCalls: 0 }
	try {
		const { querys } = await queryRewriter.invoke([
			new SystemMessage(QUERY_REWRITE_PROMPT),
			new HumanMessage(question),
		])
		const cleaned = querys.map((q) => q.trim()).filter(Boolean)
		return { querys: cleaned.length ? cleaned : [question], llmCalls: 1 }
	} catch (e) {
		// 旁路化降级：改写服务挂了不杀对话，拿原问题直检
		console.warn('[getQuerys] 改写失败，降级为原问题查询:', (e as Error).message)
		return { querys: [question], llmCalls: 1 }
	}
}

// ══ 节点：rag —— 每条查询走 rag/search.ts 的混合检索（named dense+sparse 双路已在内层 RRF），跨查询再做一次 RRF ══
// 9/6 变更：原直连 embed/ollama.ts + sparse/bm25.ts 的 demo 集合（sds_embed_demo），
//           现统一走 hybridSearch(config.QDRANT_COLLECTION)——读写同库，生产口径
const RRF_K = 60
const ragNode: GraphNode<typeof AgentState.State> = async (state) => {
	const querys = state.querys.filter((q) => q.trim())
	if (!querys.length) return { RAGcontents: [] }

	const lists = await Promise.all(
		querys.map((q) =>
			hybridSearch(q, { top: 8 }).catch((e) => {
				console.warn('[ragNode] 单条查询混合检索失败，忽略:', (e as Error).message)
				return [] as Awaited<ReturnType<typeof hybridSearch>>
			}),
		),
	)

	// 跨查询融合：只用名次（各路量纲不通）；合并键 = point id（同 text 不同 point 不许并），doc_id#seq 兜底
	const rrf = new Map<string, number>()
	const itemOf = new Map<string, (typeof lists)[number][number]>()
	for (const list of lists)
		for (let i = 0; i < list.length; i++) {
			const hit = list[i]!
			const key = hit.pointId || (hit.doc_id != null && hit.seq != null ? `${hit.doc_id}#${hit.seq}` : '')
			if (!key) continue
			rrf.set(key, (rrf.get(key) ?? 0) + 1 / (RRF_K + i + 1))
			if (!itemOf.has(key)) itemOf.set(key, hit)
		}

	// 融合分降序取 top3 喂生成（再多 getResult 也有 6000 字符封顶，宁缺毋滥）
	const RAGcontents = [...rrf.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([key]) => {
			const item = itemOf.get(key)!
			return `【${(item.section as string) ?? '未分节'}｜${(item.source_doc as string) ?? '?'}】${item.text}`
		})
	return { RAGcontents }
}

// ══ 节点：gap —— 本地空手时的缺口问答（**不再联网**）══
// 做三件事：① 先查缺口表能否复用（同问题不重复生成）② 不能就生成一段带免责的通用参考
//           ③ 把这一问一答写进 MySQL 待办表，等人在「缺口知识」页确认
// 纪律：只接 knowledge 路。台账（db）不许编数字 —— 那一路空手就直接认怂。
const gapNode: GraphNode<typeof AgentState.State> = async (state) => {
	const question = state.question.trim() || state.querys[0] || ''
	if (!question) return { gapResult: '', gapId: null, llmCalls: 0 }
	// 近失（检索到但被地板挡掉的弱命中）作为线索一起存：人工补资料时知道"差在哪"
	const nearMisses = state.RAGcontents.length ? state.RAGcontents.map(c => c.slice(0, 120)) : []
	const gap = await answerGap(question, nearMisses)
	return { gapResult: renderGapMaterial(gap), gapId: gap.id, llmCalls: 1 }
}

// ══ 节点：result —— 素材 + question → 流式生成回答（链尾，答案写进 messages）══
const answerModel = new ChatOpenAI({
	model: config.LLM_MODEL,
	apiKey: config.LLM_API_KEY,
	configuration: { baseURL: config.LLM_BASE_URL },
	streaming: true, // 真流式：/agent/runs/stream 靠它吐 AIMessageChunk，Chat 端逐字上屏
})

const ANSWER_PROMPT = `你是实验室试剂管理助手，依据下方"素材"回答用户问题。
规则：
1. 闪点、浓度、禁配物、急救步骤这类安全数据严禁用模型常识编造或补全，只能引自素材
2. 溯源口径：本地文档库素材点名出处（如"据《硫酸SDS·消防措施》"）；台账数据如实报数值与位置；
   **缺口参考**要明说"本地库没有依据，以下为通用参考、未经核实"，并提示已记为待办等人工确认
3. 素材为空或与问题相关性不足：直说"未检索到相关内容"，并建议换关键词或先在知识库页上传对应文档，不要硬答
4. 纯寒暄（问题不涉及数据）正常自然回应即可
5. 中文、简洁，关键安全信息用列表
6. **素材只有"缺口参考"时**（没有本地文档素材）：可以转述它，但必须保留其中的免责声明，
   且不许把它说成本库结论；若用户问的是安全数值，直接说"这类数据必须查 SDS 原文，本库暂无依据"`

const resultNode: GraphNode<typeof AgentState.State> = async (state) => {
	const { question, RAGcontents, dbResult, gapResult, route } = state

	// 素材拼装；db 的"没查到"不进素材（免得 LLM 对着报错文本编故事）
	const parts: string[] = []
	if (RAGcontents.length) parts.push(`## 本地文档库素材（混合检索，RRF 融合排序）\n${RAGcontents.join('\n---\n').slice(0, 6000)}`)
	// 台账素材：**故障必须标注后再进素材**，否则模型会按"没有数据"作答（把系统故障说成"库里没有"）
	if (dbFailed(dbResult)) {
		parts.push(
			`## ⚠️ 试剂台账查询未能执行\n${dbResult}\n\n` +
			`请如实告知用户"台账查询系统故障、暂时查不到，可稍后重试"，**不要**说"未检索到相关内容"` +
			`（那是"库里确实没有"的意思，与事实不符）。`,
		)
	} else if (!dbMiss(dbResult)) {
		parts.push(`## 试剂台账查询结果（MySQL 实时数据）\n${dbResult.slice(0, 2500)}`)
	}
	// 缺口问答：标题就把"未核实"写在脸上 —— 它跟文献素材必须一眼分得清
	if (gapResult) parts.push(`## 本地库无依据时的通用参考（⚠️ 模型生成、未经核实，已记为待办待人工确认）\n${gapResult}`)
	const material = parts.join('\n\n') || '(本轮无任何素材)'

	try {
		const res = await answerModel.invoke([
			new SystemMessage(
				`${ANSWER_PROMPT}\n\n${material}` +
				(route === 'chat' ? '\n\n提示：本轮被分流为闲聊（chat），若无素材按规则 4 处理。' : '') +
				`\n\n## 本轮实际使用的检索查询\n${state.querys.join(' / ') || '(无)'} —— 仅供你判断检索角度是否跑偏，不必复述`,
			),
			// 短期记忆：窗口内历史原样带上，多轮指代（"刚才那个酸"）靠这一行接住
			...state.messages,
			new HumanMessage(question),
		])
		// 用户这句也写回 messages channel —— 线程记忆里才有来龙去脉（之前只进 AI 的话，历史是独白）
		const stamped: BaseMessage[] = question ? [new HumanMessage(question), res] : [res]
		return { messages: stamped, llmCalls: 1 }
	} catch (e) {
		// 链尾也旁路化：生成挂了至少回一句人话，不给前端留黑洞
		console.warn('[result] 回答生成失败:', (e as Error).message)
		return {
			messages: [
				...(question ? [new HumanMessage(question)] : []),
				new AIMessage(`回答生成失败：${(e as Error).message.slice(0, 100)}（检查 LLM 服务后重试）`),
			],
			llmCalls: 1,
		}
	}
}

// ══ 主图装配 ══
// checkpointer 两幅面孔（同 9/5 注释）：
//   ▸ 脚本直调 graph.invoke/stream → 下面的 MemorySaver 内存档（重启即清空，正好符合"退出就清空"的临时会话定位）
//   ▸ 若将来上 langgraph server：服务端自带存档 + thread 管理，本注入只在脚本场景生效
export const checkpointer = new MemorySaver()

export const graph = new StateGraph(AgentState)
	.addNode('router', routerNode)
	.addNode('dbQuery', dbQuery)
	.addNode('getQuerys', getQuerys)
	.addNode('rag', ragNode)
	.addNode('gap', gapNode)
	.addNode('result', resultNode)
	.addEdge(START, 'router')
	// 三选一的分发（全在代码，不劳 LLM）
	// allowDb=false（演示通道）时 db 判定即使漏网也降级到 knowledge —— 与提示词隔离互为双保险
	.addConditionalEdges('router', (s) =>
		s.route === 'db' && s.allowDb !== false ? 'dbQuery'
			: s.route === 'chat' ? 'result' : 'getQuerys')
	// 台账空手 → 直接认怂（**不许生成数字**：库存/价格/效期编一个出来比答不出来危险得多）
	.addEdge('dbQuery', 'result')
	.addEdge('getQuerys', 'rag')
	// 检索有素材 → 直接答；空手 → 缺口问答（生成 + 落 MySQL 待办），不再联网
	.addConditionalEdges('rag', (s) => (s.RAGcontents.length ? 'result' : 'gap'))
	.addEdge('gap', 'result')
	.addEdge('result', END)
	.compile({ checkpointer })
