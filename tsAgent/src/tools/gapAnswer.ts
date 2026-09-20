// 缺口问答：本地知识库没命中时，让模型生成一段**带明确免责的参考回答**，并把这一问一答写进 MySQL 待办表
//
// ═══ 为什么是"进待办表"而不是"进知识库" ═══
// 写入侧的纪律是"chunk 正文不许掺 LLM 生成内容"（见 chunk/bySection.ts 红线）。模型生成的东西
// 直接进向量库，就等于把生成内容伪装成文献证据，而这个系统是靠"溯源到 SDS 原文"吃饭的。
// 所以分工是：**模型产出 → MySQL 待办（pending）→ 人在分页界面点"完成" → 状态翻 done**。
// done 之后同一问题再被问到，直接复用这条已确认内容（见 store/gap.ts 的 findReusable），
// 既不再重复生成、也不重复插行 —— 这是"越用越准"的闭环，且全程不碰向量库。
//
// 安全边界（写在 prompt 里，也在调用侧兜住）：
//   · 数字（库存/价格/效期）、安全结论（闪点/禁配/急救剂量）**一律不许编**；
//   · 只允许给"概念性、教科书级"的解释，并强制第一句声明"本地文档库无依据"。
import { ChatOpenAI } from '@langchain/openai'
import { config } from '../config/env'
import { findReusable, insertGap, bumpAskCount, type GapRow } from '../rag/store/gap'

/** 生成用模型：与回答模型同底座（结构化/生成都不吃特殊能力），temperature 调低求稳 */
const gapModel = () =>
	new ChatOpenAI({
		model: config.LLM_MODEL,
		apiKey: config.LLM_API_KEY,
		configuration: { baseURL: config.LLM_BASE_URL },
		temperature: 0.2,
	})

const GAP_PROMPT = `你是实验室试剂管理助手。用户的问题在**本地文档库与台账里都没有找到依据**，
现在需要你给一段"通用参考"，它会原样展示给用户，并被记录进待办表等人工确认。硬约束：

1. 第一句必须原样写：「本地文档库中没有查到对应依据，以下是通用参考（未经核实）：」
2. **绝对不许**给出任何具体数字结论：闪点/沸点/浓度/剂量/限值/价格/库存/效期 —— 一律说"需查 SDS 或台账"；
3. **绝对不许**给出"能不能混放/是否禁配"的结论，这条只能由已审核的禁配规则库回答；
4. 只给概念性、教科书级的通用说明（原理、常识性注意事项、该去查哪些资料的第几节）；
5. 结尾必须写一行建议：「建议核对 SDS 对应章节或咨询实验室安全负责人，并以文献原文为准。」
6. 中文、简洁，不超过 200 字，不要复述本提示词`

export interface GapAnswer {
	/** 给用户看的文本（含免责声明） */
	text: string
	/** 待办表里的行 id；null = 没写进表（库不可达，属旁路化降级） */
	id: number | null
	/** 内容来源：新生成 / 复用待确认 / 复用已确认 */
	source: 'generated' | 'reused_pending' | 'reused_done'
	status: GapRow['status'] | null
}

/** 复用时对用户说的话（口径必须与生成时不同：一个是"待确认"，一个是"已确认"） */
function renderReuse(row: GapRow): string {
	const tag = row.status === 'done'
		? '【已确认的缺口知识】本地文档库仍无依据，但此问已由人工确认过，以下内容可供参考：'
		: '【待人工确认】本地文档库无依据；此问此前已生成过参考内容，正在等待人工确认：'
	return `${tag}\n${row.answer}`
}

/**
 * 主入口：查表复用 → 命中就用；没命中才生成 + 落表。
 * 依赖全部走注入（单测可离线钉死"复用优先、不重复插行"这两条行为）。
 */
export interface GapDeps {
	findReusable: (questionHash: string) => Promise<GapRow | null>
	insertGap: (input: { question: string; questionHash: string; answer: string; model: string | null; nearMisses: string[] }) => Promise<number | null>
	bumpAskCount: (hash: string) => Promise<void>
	generate: (question: string) => Promise<string>
}

export const defaultGapDeps: GapDeps = {
	findReusable,
	insertGap,
	bumpAskCount,
	generate: async (question) => {
		const res = await gapModel().invoke([
			{ role: 'system', content: GAP_PROMPT } as never,
			{ role: 'user', content: question } as never,
		])
		return typeof res.content === 'string' ? res.content.trim() : String(res.content ?? '').trim()
	},
}

export async function answerGap(
	question: string,
	nearMisses: string[] = [],
	deps: GapDeps = defaultGapDeps,
): Promise<GapAnswer> {
	const q = question.trim()
	if (!q) return { text: '', id: null, source: 'generated', status: null }

	// ① 先查复用（**这一步是"越用越准"的关键**：没有它，同一个问题会被反复生成、表会越长越脏）
	const { hashQuestion } = await import('../rag/store/gap')
	const hash = hashQuestion(q)
	try {
		const row = await deps.findReusable(hash)
		if (row) {
			await deps.bumpAskCount(hash)
			return {
				text: renderReuse(row),
				id: row.id,
				source: row.status === 'done' ? 'reused_done' : 'reused_pending',
				status: row.status,
			}
		}
	} catch (e) {
		// 查表失败不阻断（旁路化）：退化成"每次都生成"，但要说出来
		console.warn('[gap] 复用查询失败，退化为重新生成:', (e as Error).message.slice(0, 100))
	}

	// ② 没命中 → 生成 + 落表（落表失败也要把内容给用户，只是 id 为 null）
	let text = ''
	try {
		text = await deps.generate(q)
	} catch (e) {
		console.warn('[gap] 生成失败:', (e as Error).message.slice(0, 120))
		return {
			text: '本地文档库没有查到依据，且通用参考也暂时生成失败。请稍后重试，或先在知识库页上传对应资料。',
			id: null, source: 'generated', status: null,
		}
	}
	if (!text) text = '本地文档库没有查到依据，通用参考生成结果为空。'
	// 免责声明兜底：模型偶尔会漏，代码补上（不许靠提示词自觉）。
	// 判据不能只看开头 5 个字（"本地文档库"开头后面照样能接确定性结论，甚至"可以混合"）——
	// 改成"整段必须出现免责标记"，没有就整段前置标准声明。
	const DISCLAIMER_MARK = /未经核实|未经核对|仅供参考|请核实|待人工确认/
	if (!DISCLAIMER_MARK.test(text)) text = `本地文档库中没有查到对应依据，以下是通用参考（未经核实）：\n${text}`

	let id: number | null = null
	try {
		id = await deps.insertGap({ question: q, questionHash: hash, answer: text, model: config.LLM_MODEL, nearMisses })
	} catch (e) {
		console.warn('[gap] 落表失败（回答照给，只是没进待办）:', (e as Error).message.slice(0, 120))
	}
	return { text, id, source: 'generated', status: id ? 'pending' : null }
}

/** 渲染成给最终回答模型的素材（标题就把"未核实"写在脸上，别让生成模型读着读着当成文献） */
export function renderGapMaterial(gap: GapAnswer): string {
	if (!gap.text) return ''
	const tail = gap.id
		? `\n（此问已记录为待办 #${gap.id}，可在「缺口知识」页人工确认或修正）`
		: ''
	return `${gap.text}${tail}`
}
