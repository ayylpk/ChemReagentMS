// 检索的确定性内核：查询分类 / 白名单 filter 构造 / RRF 融合 —— 全纯函数、零 I/O、零 LLM
// 之所以从 search.ts 拆出来：search.ts 顶部 import config/qdrant，import 即要求环境变量与客户端，
// 纯逻辑放这里才能在不连 Qdrant、不配 env 的前提下离线单测（见 search.test.ts）
import { casCheckDigitOk } from './gate/quality'
import type { Retrieved } from './embed/ollama' // 只借返回形状，不碰 demo 实现
import { normalizeSection } from './sections'

export const RRF_K = 60 // 论文正统常数，与 graph.ragNode 时代同款

// ─────────────────────────────────────────────────────────
// ① 查询分类：精确查询 vs 语义查询（确定性、零成本、可测）
// ─────────────────────────────────────────────────────────
export type QueryKind = 'cas' | 'identifier' | 'semantic'

export interface QueryClassification {
	kind: QueryKind
	cas?: string // kind='cas' 时命中的合法 CAS
	identifier?: string // kind='identifier' 时命中的型号/批号/货号
}

// 与 gate/quality.ts 的 badCasIn 同口径（边界断言防 R/S 码串扰）
const CAS_RE = /(?<![\d-])\d{2,7}-\d{2}-\d(?![\d-])/g
// 显式前缀型：批号/型号/货号/编号/料号/规格 + 值；英文前缀要求词左边界，防 snapshot 里的 "sn" 误伤
const IDENT_PREFIX_RE =
	/(?:批号|型号|货号|编号|料号|规格|(?<![A-Za-z])(?:lot|batch|serial|sn))[:：\s]*([A-Za-z0-9][A-Za-z0-9._-]{3,})/i
// "整条查询就是一个短代号"：纯 ASCII 字母数字 + . _ -，长度 ≤ 24
const SHORT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/

/**
 * 判定查询性质（保守优先：拿不准一律 semantic，宁可不放行也不放噪声进来）
 * - cas：形似 CAS **且校验位通过**（伪 CAS 不当精确查询）
 * - identifier：显式批次/型号前缀，或整条查询就是一个含数字的短代号
 * - semantic：其余，含中文自然语言问题与纯英文单词/纯数字
 */
export function classifyQuery(query: string): QueryClassification {
	const q = query?.trim() ?? ''
	if (!q) return { kind: 'semantic' }

	// ① CAS：形似 + 校验位通过。伪 CAS（校验位错）落到后面规则，绝不当 cas 放行
	const validCas = (q.match(CAS_RE) ?? []).find(c => casCheckDigitOk(c))
	if (validCas) return { kind: 'cas', cas: validCas }

	// ② 显式批次/型号前缀
	const m = q.match(IDENT_PREFIX_RE)
	if (m?.[1]) return { kind: 'identifier', identifier: m[1] }

	// ③ 整条查询就是一个短代号：必须含数字，且含字母或连字符
	//    —— 纯英文单词（SDS / hello）与纯数字（页码 / 数量）都不算，宁可保守
	if (SHORT_CODE_RE.test(q) && /\d/.test(q) && (/[A-Za-z]/.test(q) || q.includes('-')))
		return { kind: 'identifier', identifier: q }

	return { kind: 'semantic' }
}

// ─────────────────────────────────────────────────────────
// ② 白名单 payload filter 构造：只认 4 个枚举字段，值只走 keyword 精确匹配
//    绝不接受任意 key、绝不拼 SQL / 正则 —— 模型只能在下面这几个维度上选
//    9/16 section 语义扩展（跨节打包的配套）：chunk 可能横跨数节（sections 是数组），
//      所以 section 维度发一条 should：命中 section（公共祖先叶子）**或** sections 里任一元素。
//      不这么改，"过滤消防措施"会漏掉所有"把消防措施并进去"的块 —— 过滤静默失效比过滤不准更贵。
// ─────────────────────────────────────────────────────────
export const FILTER_KEYS = ['section', 'cas_number', 'source_doc', 'doc_id'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]

/** 落到 Qdrant filter 上的 key：= 模型可填的白名单维度 ∪ {'sections'}（派生字段，不接受模型填） */
export type ClauseKey = FilterKey | 'sections'

export interface PayloadFilterClause {
	key: ClauseKey
	match: { value: string }
}

export interface PayloadFilterSpec {
	section?: string
	cas_number?: string
	source_doc?: string
	doc_id?: string
}

export interface PayloadFilterResult {
	/** must 可缺省：只有 section 一个条件时结果是 { should: [...] }（section 进 must 会筛掉跨节块，见 buildPayloadFilter） */
	filter?: { must?: PayloadFilterClause[]; should?: PayloadFilterClause[] }
	applied: PayloadFilterClause[]
	dropped: { field: FilterKey; value: string; reason: string }[]
}

/** 按白名单构造 Qdrant filter；非法/不可归一化的值不施加并在 dropped 里说明原因 */
export function buildPayloadFilter(spec: PayloadFilterSpec): PayloadFilterResult {
	const applied: PayloadFilterClause[] = []
	const dropped: PayloadFilterResult['dropped'] = []
	let should: PayloadFilterClause[] | undefined

	// section：口语别名 → 标准分节名；归一化失败不施加（不瞎猜）
	const section = spec.section?.trim()
	if (section) {
		const std = normalizeSection(section)
		if (std) {
			// 跨节打包后，一块可能横跨数节：section 记公共祖先叶子、sections 记覆盖到的各叶子。
			// 过滤发 should（任一命中即可）—— 只认 section 会漏掉"把该节并进去"的块（静默失效）
			should = [
				{ key: 'section', match: { value: std } },
				{ key: 'sections', match: { value: std } }, // payload.sections 是 string[]，Qdrant 语义 = 任一元素命中
			]
			// ⚠️ section 只能进 should，**绝不能同时进 must**：跨节打包块的 section 记的是覆盖帧的公共祖先
			//    （不等于叶子名），一旦进了 must，这类块会被整批筛掉 —— 正是本函数要防的"过滤静默少数据"。
			//    曾经两处都放，should 被 must 架空（and 语义），9/18 审查修。
		} else dropped.push({ field: 'section', value: section, reason: '无法归一化到 SDS 标准分节名' })
	}

	// cas_number：必须过校验位，错编号进 filter 只会捞空/捞错
	const cas = spec.cas_number?.trim()
	if (cas) {
		if (casCheckDigitOk(cas)) applied.push({ key: 'cas_number', match: { value: cas } })
		else dropped.push({ field: 'cas_number', value: cas, reason: 'CAS 校验位不通过' })
	}

	// 文档维度：source_doc 是文件名、doc_id 是含层级的文档 id —— 一律 keyword 精确匹配
	const sourceDoc = spec.source_doc?.trim()
	if (sourceDoc) applied.push({ key: 'source_doc', match: { value: sourceDoc } })
	const docId = spec.doc_id?.trim()
	if (docId) applied.push({ key: 'doc_id', match: { value: docId } })

	return {
		// 判空必须带上 should：只有 section 一个条件时 applied 是空的，
		// 若按 applied.length 判就会连 should 一起丢掉 → 过滤彻底失效（返回全库，静默）
		filter: applied.length || should
			? { ...(applied.length ? { must: applied } : {}), ...(should ? { should } : {}) }
			: undefined,
		applied, dropped,
	}
}

// ─────────────────────────────────────────────────────────
// ③ RRF 融合 + 精确旁路地板闸（纯函数，输入假数据即可测）
// ─────────────────────────────────────────────────────────
export type MatchRoute = 'dense' | 'sparse' | 'cas_filter'
export type MatchedBy =
	| 'dense' | 'sparse' | 'cas_filter'
	| 'dense+sparse' | 'dense+cas_filter' | 'sparse+cas_filter'
	| 'dense+sparse+cas_filter'

/** 更宽的结果类型：Retrieved 的形状 + 合并键 / 可解释分 / 来源路 */
export interface HybridHit extends Retrieved {
	pointId: string // 合并键：point id（优先）或 `${doc_id}#${seq}` 兜底
	doc_id?: string
	seq?: number
	denseScore: number | null // 稠密路原始分；未进 dense top 记 null（不是 0 —— 0 会和真·低分混淆）
	sparseScore: number | null // 稀疏路原始分；未进 sparse top 记 null
	rrfScore: number // 融合总分（排序依据；对外 score 字段取的就是它）
	matchedBy: MatchedBy // 这条靠哪条/哪几条路被捞上来
}

/** 从 Qdrant 回包抽出的最小点形状（query 的 ScoredPoint 与 scroll 的 Record 都能映射到它） */
export interface RawPoint {
	id: string | number | null | undefined
	score: number
	payload: Record<string, unknown>
}

export interface FuseInput {
	dense: RawPoint[]
	sparse: RawPoint[]
	casFilter?: RawPoint[]
	precise: boolean // 精确查询：不适用 dense 地板
	minDense: number // 语义查询的稠密地板（常量由 search.ts 持有，这里只接收）
	top: number
	/**
	 * 稠密路**整体失败**（网络/服务端出错，而不是"返回空"）时置 true。
	 * 此时每个点的 denseScore 都是 null；若照常施加"未进 dense top → 视作 0 分 → 拒"的地板规则，
	 * 稀疏路正常命中的候选会被一起拒掉 —— 语义查询恒返回空，上层把"检索故障"读成"库里没有"。
	 */
	denseFailed?: boolean
}

const ROUTE_ORDER: readonly MatchRoute[] = ['dense', 'sparse', 'cas_filter']

interface Bucket {
	pointId: string
	payload: Record<string, unknown>
	rrfScore: number
	denseScore: number | null
	sparseScore: number | null
	routes: Set<MatchRoute>
}

/** 合并键：point id 优先；退而 `${doc_id}#${seq}`（seq 由入库侧补，可能不存在，必须容错）；
 *  两者都没有时给一次性匿名键（保留不丢，但绝不与别人合并） */
function pointKeyOf(p: RawPoint, anon: string): string {
	if (p.id !== null && p.id !== undefined && String(p.id) !== '') return String(p.id)
	const { doc_id: docId, seq } = p.payload
	if (docId !== undefined && docId !== null && seq !== undefined && seq !== null)
		return `${String(docId)}#${String(seq)}`
	return anon
}

/** 显式构造结果对象：先从 payload 里剥掉与计算字段同名的键，避免 payload 字段反过来覆盖 denseScore 等 */
function toHit(b: Bucket): HybridHit {
	// 剥名防覆盖（不直接把 payload 铺平，见任务：`{ score, ...payload }` 的隐患）
	const {
		score: _score, denseScore: _denseScore, sparseScore: _sparseScore, rrfScore: _rrfScore,
		matchedBy: _matchedBy, pointId: _pointId, ...rest
	} = b.payload
	void _score; void _denseScore; void _sparseScore; void _rrfScore; void _matchedBy; void _pointId
	return {
		...rest,
		score: b.rrfScore, // 对外 score 语义 = 融合排序分（如需原始分看 denseScore / sparseScore）
		text: String(b.payload.text ?? ''),
		pointId: b.pointId,
		doc_id: typeof b.payload.doc_id === 'string' ? b.payload.doc_id : undefined,
		seq: typeof b.payload.seq === 'number' ? b.payload.seq : undefined,
		denseScore: b.denseScore,
		sparseScore: b.sparseScore,
		rrfScore: b.rrfScore,
		matchedBy: ROUTE_ORDER.filter(r => b.routes.has(r)).join('+') as MatchedBy,
	}
}

/**
 * RRF 融合：score = Σ 各路 1/(k+名次)；合并键 = point id（同 text 不同 id 不合并）
 * 然后过地板闸：语义查询只看稠密路原始分（纯稀疏命中被拒，与旧行为一致）；
 * 精确查询（precise=true）不设地板，让 sparse / cas_filter 独占命中也有权进入排序。
 */
export function fuseRRF(input: FuseInput): HybridHit[] {
	const buckets = new Map<string, Bucket>()
	const routesWithList: readonly (readonly [RawPoint[] | undefined, MatchRoute])[] = [
		[input.dense, 'dense'],
		[input.sparse, 'sparse'],
		[input.casFilter, 'cas_filter'],
	]

	let anon = 0
	for (const [list, route] of routesWithList) {
		if (!list?.length) continue
		for (let i = 0; i < list.length; i++) {
			const p = list[i]!
			const key = pointKeyOf(p, `__anon_${route}_${anon++}`)
			let b = buckets.get(key)
			if (!b) {
				b = {
					pointId: key,
					payload: p.payload ?? {},
					rrfScore: 0,
					denseScore: null,
					sparseScore: null,
					routes: new Set(),
				}
				buckets.set(key, b)
			}
			b.rrfScore += 1 / (RRF_K + i + 1)
			if (route === 'dense') b.denseScore = b.denseScore === null ? p.score : Math.max(b.denseScore, p.score)
			else if (route === 'sparse') b.sparseScore = b.sparseScore === null ? p.score : Math.max(b.sparseScore, p.score)
			b.routes.add(route)
		}
	}

	const out: HybridHit[] = []
	for (const b of buckets.values()) {
		// 地板闸：语义查询只认稠密路原始分（未进 dense top → null → 视作 0 → 被拒）。
		// ⚠️ 稠密路整体失败时**不施加**这条：否则每个候选的 denseScore 都是 null、全被拒，
		//    语义查询恒返回空 —— 上层会把"检索故障"当成"本库没有这条知识"（故障与空结果不可区分）。
		if (!input.denseFailed && !input.precise && (b.denseScore ?? 0) < input.minDense) continue
		out.push(toHit(b))
	}
	out.sort(
		(a, b) =>
			b.rrfScore - a.rrfScore ||
			(b.denseScore ?? -1) - (a.denseScore ?? -1) ||
			(a.pointId < b.pointId ? -1 : a.pointId > b.pointId ? 1 : 0),
	)
	return out.slice(0, input.top)
}
