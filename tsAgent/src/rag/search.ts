// 生产读侧唯一入口：reagent_knowledge 双向量混合检索 + RRF 融合
// ragNode（图内检索）与 searchKnowledge（工具）共用这一份实现 —— 检索口径必须只有一处定义
// 分工线：embed/ollama.ts 与 sparse/bm25.ts 是"demo 期"的老文件（集合指向 sds_embed_demo），
//         本文件用 config 口径直连生产集合，named dense + named sparse 两路各查各的再融合
//
// 9/8 C 分支改动：
//   ① 查询先分类（纯函数在 query.ts）：精确查询（CAS/型号批号）不适用地板，sparse / CAS 精查才有机会进融合
//   ② RRF 合并键：payload.text → point id（同 text 不同 point 不再被误并），doc_id#seq 兜底
//   ③ 结果补可解释字段 denseScore / sparseScore / rrfScore / matchedBy
//   ④ 白名单 payload filter（section 归一化 / CAS 校验位）—— 模型只能在这几个维度上选
import { QdrantClient } from '@qdrant/js-client-rest'
import { config } from '../config/env'
import { embed } from './embed' // 门面选择后端（EMBED_BACKEND），不直认 Ollama
import { casCheckDigitOk } from './gate/quality'
import { buildPayloadFilter, classifyQuery, fuseRRF, type HybridHit, type RawPoint } from './query'
import { toSparse } from './sparse/bm25'

const qdrant = new QdrantClient({ url: config.QDRANT_URL, apiKey: config.QDRANT_API_KEY || undefined })
const COLL = config.QDRANT_COLLECTION

export type { HybridHit, MatchedBy, MatchRoute, QueryClassification, QueryKind } from './query'

export interface HybridOptions {
	top?: number // 融合后取几条（默认 6）
	limit?: number // 每路各捞几条（默认 10）
	section?: string // 可选：SDS 分节过滤（口语别名会被归一化，如"着火怎么办"→"消防措施"）
	minDense?: number // 稠密路余弦下限（bge-m3 归一化向量·Dot=Cosine）：低于它的内容视为无关
	casNumber?: string // 可选：CAS 精确过滤（校验位不通过则不施加）；传入即按精确查询处理
	sourceDoc?: string // 可选：来源文件名精确过滤（payload.source_doc）
	docId?: string // 可选：文档 id 精确过滤（payload.doc_id，含目录层级形态）
}

// 地板演进（实验数据）：0.35 拍脑袋（9/5 语料个位数文档）→ 0.55（9/6 bge-m3 n=5：无关0.40~0.49/相关0.60~0.77）
// 9/8 换 DashScope v4 后重测（scripts/floor-v4.ts，同 10 题 n=5）：
//   相关 top1 0.7265~0.8469、无关 top1 仅 0.2433~0.3293（v4 把无关分整体压低，与 bge-m3 路径不同但 0.55 仍成立）
//   分界带 0.33~0.73 宽达 0.40，0.55 居中偏拦（上余量 0.11 到最低相关命中 0.66，下余量 0.22）——维持 0.55
//   注意：v4 旧数据不可混用，任何分数结论以本轮为准；qa50 上线后用评估集继续回调
// ⚠️ 此值只对**语义查询**生效；精确查询（CAS/型号批号）走旁路不受它约束 —— 只许加旁路，不许调低地板
const MIN_DENSE_DEFAULT = 0.55

/** Qdrant 回包（query 的 ScoredPoint / scroll 的 Record）都能映射成 RawPoint */
type QdrantPoint = { id?: string | number | null; score?: number; payload?: unknown }
const toRaw = (points: readonly QdrantPoint[]): RawPoint[] =>
	points.map(p => ({ id: p.id, score: p.score ?? 0, payload: (p.payload ?? {}) as Record<string, unknown> }))

/** 混合检索：稠密(named dense) + 稀疏(named sparse) 并发 → 只认名次的 RRF 融合 → top
 *  精确查询额外走一条 payload 精查（CAS）旁路；语义查询行为与旧版一致（含 dense 地板） */
export async function hybridSearch(query: string, opts: HybridOptions = {}): Promise<HybridHit[]> {
	const { top = 6, limit = 10, section, minDense = MIN_DENSE_DEFAULT, casNumber, sourceDoc, docId } = opts

	// ── 分类与分流 ──
	const cls = classifyQuery(query)
	const explicitCas = casNumber?.trim() && casCheckDigitOk(casNumber.trim()) ? casNumber.trim() : undefined
	const casValue = explicitCas ?? cls.cas // 合法 CAS：来自查询文本或显式参数
	const precise = cls.kind !== 'semantic' || explicitCas !== undefined

	// 白名单 filter（section 归一化 + CAS 校验位 + 文档维度；非法值不施加）
	const built = buildPayloadFilter({ section, cas_number: casValue, source_doc: sourceDoc, doc_id: docId })
	if (built.dropped.length)
		console.warn('[search] 白名单过滤未施加:', built.dropped.map(d => `${d.field}=${d.value}(${d.reason})`).join('; '))
	const filter = built.filter

	const [vector] = await embed([query])

	// 三路并发；一路挂只丢一路（旁路化：宁可召回差一点，不要整问失败）。
	// ⚠️ 但"丢了哪一路"必须往下传：稠密路失败时所有候选的 denseScore 都是 null，
	//    若照常施加地板规则，稀疏路正常命中的也会被一起拒掉 —— 语义查询恒返回空（见 fuseRRF.denseFailed）。
	let denseFailed = false
	const [denseRes, sparseRes, casRes] = await Promise.all([
		qdrant.query(COLL, { query: vector, using: 'dense', limit, filter, with_payload: true })
			.then(r => toRaw(r.points))
			.catch(e => { denseFailed = true; console.warn('[search] 稠密路失败:', (e as Error).message); return [] as RawPoint[] }),
		qdrant.query(COLL, { query: toSparse(query), using: 'sparse', limit, filter, with_payload: true })
			.then(r => toRaw(r.points)).catch(e => { console.warn('[search] 稀疏路失败:', (e as Error).message); return [] as RawPoint[] }),
		// CAS 精查：payload 过滤直接捞（不受向量名次与地板限制），作为独立候选路参与 RRF
		casValue
			? qdrant.scroll(COLL, {
					filter: filter ?? { must: [{ key: 'cas_number', match: { value: casValue } }] },
					limit,
					with_payload: true,
				}).then(r => toRaw(r.points)).catch(e => { console.warn('[search] CAS 精查失败:', (e as Error).message); return [] as RawPoint[] })
			: Promise.resolve([] as RawPoint[]),
	])
	if (denseFailed) {
		console.warn('[search] 稠密路失败 → 本轮跳过稠密地板（继续用稀疏/CAS 候选；否则查询恒空且与"库里没有"无法区分）')
	}

	return fuseRRF({ dense: denseRes, sparse: sparseRes, casFilter: casRes, precise, minDense, top, denseFailed })
}
