// 离线单测：查询分类 / 分节归一化 / 白名单 filter / RRF 融合 —— 全部纯函数，不连 Qdrant、不配 env
// 只 import query.ts 与 sections.ts（search.ts 顶部 import config/qdrant，运行时需要环境，不进本测试）
import { describe, expect, test } from 'bun:test'
import { casCheckDigitOk } from './gate/quality'
import { buildPayloadFilter, classifyQuery, fuseRRF, type RawPoint } from './query'
import { normalizeSection, SDS_SECTIONS } from './sections'

const pt = (id: string | number, score: number, payload: Record<string, unknown> = {}): RawPoint => ({ id, score, payload })

// ─────────────────────────────────────────────────────────
describe('classifyQuery：精确 vs 语义', () => {
	test('合法 CAS（校验位通过）→ cas', () => {
		expect(casCheckDigitOk('7664-93-9')).toBe(true) // 前置断言：示例 CAS 本身合法
		const c = classifyQuery('7664-93-9 的消防措施是什么')
		expect(c.kind).toBe('cas')
		expect(c.cas).toBe('7664-93-9')
	})

	test('伪 CAS（校验位不对）→ 绝不当 cas', () => {
		expect(casCheckDigitOk('7664-93-8')).toBe(false)
		const c = classifyQuery('这个 7664-93-8 靠谱吗')
		expect(c.kind).not.toBe('cas')
		expect(c.cas).toBeUndefined()
		expect(c.kind).toBe('semantic')
	})

	test('批号/型号/货号前缀 → identifier', () => {
		expect(classifyQuery('批号 LOT-2024-001 放哪了').kind).toBe('identifier')
		expect(classifyQuery('型号 XY-2000A 的说明书').identifier).toBe('XY-2000A')
		expect(classifyQuery('货号:AB1234 有没有现货').kind).toBe('identifier')
	})

	test('整条查询就是一个含数字的短代号 → identifier', () => {
		expect(classifyQuery('K-12345')).toEqual({ kind: 'identifier', identifier: 'K-12345' })
		expect(classifyQuery('ABC123')).toEqual({ kind: 'identifier', identifier: 'ABC123' })
	})

	test('普通自然语言问题 → semantic（必须，不能被误判成精确查询）', () => {
		for (const q of [
			'浓硫酸溅到皮肤上怎么急救？',
			'着火了该用什么灭火器',
			'无水乙醇的储存条件是什么',
			'泄漏了怎么处理',
		]) expect(classifyQuery(q).kind).toBe('semantic')
	})

	test('边界：纯英文单词 / 纯数字 / 空串 → semantic（保守不放行）', () => {
		expect(classifyQuery('SDS').kind).toBe('semantic')
		expect(classifyQuery('hello').kind).toBe('semantic')
		expect(classifyQuery('12345').kind).toBe('semantic')
		expect(classifyQuery('   ').kind).toBe('semantic')
		// 超长纯英文短代号（>24）也不算
		expect(classifyQuery('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123').kind).toBe('semantic')
	})
})

// ─────────────────────────────────────────────────────────
describe('normalizeSection：口语别名 → 标准分节名', () => {
	const cases: [string, string][] = [
		['着火怎么办', '消防措施'],
		['灭火', '消防措施'],
		['洒了', '泄漏应急处理'],
		['泄漏了', '泄漏应急处理'],
		['漏了', '泄漏应急处理'],
		['急救', '急救措施'],
		['烧伤了', '急救措施'],
		['溅到眼睛', '急救措施'],
		['CAS', '成分/组成信息'],
		['是什么做的', '成分/组成信息'],
		['储存', '操作处置与储存'],
		['存放', '操作处置与储存'],
		['怎么放', '操作处置与储存'],
		['废弃', '废弃处置'],
		['怎么扔', '废弃处置'],
		['处理掉', '废弃处置'],
		['毒性', '毒理学信息'],
		['毒理', '毒理学信息'],
	]
	test('≥8 组口语别名命中标准名', () => {
		for (const [input, want] of cases) expect([input, normalizeSection(input)]).toEqual([input, want])
	})

	test('带编号 / 中英混写', () => {
		expect(normalizeSection('第5节')).toBe('消防措施')
		expect(normalizeSection('5. 消防措施')).toBe('消防措施')
		expect(normalizeSection('第 6 部分')).toBe('泄漏应急处理')
		expect(normalizeSection('16、其他信息')).toBe('其他信息')
		expect(normalizeSection('消防措施（Fire-fighting）')).toBe('消防措施')
		expect(normalizeSection('成分组成信息')).toBe('成分/组成信息')
	})

	test('标准名原样返回', () => {
		for (const s of SDS_SECTIONS) expect(normalizeSection(s)).toBe(s)
	})

	test('无法映射 → undefined（不瞎猜）', () => {
		expect(normalizeSection('胡说八道xyz')).toBeUndefined()
		expect(normalizeSection('')).toBeUndefined()
		expect(normalizeSection('   ')).toBeUndefined()
		expect(normalizeSection('第99节')).toBeUndefined() // 越界分节号
		expect(normalizeSection('1,2-二氯乙烷')).toBeUndefined() // 编号形态但不是分节
	})

	test('SDS_SECTIONS 与 gate/quality.ts 保持同步（防单边漂移）', async () => {
		const src = await Bun.file(new URL('./gate/quality.ts', import.meta.url)).text()
		const block = src.match(/const SDS_SECTIONS = \[([\s\S]*?)\]/)?.[1] ?? ''
		const names = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
		expect(names).toEqual([...SDS_SECTIONS])
	})
})

// ─────────────────────────────────────────────────────────
describe('buildPayloadFilter：白名单枚举式过滤', () => {
	test('section 归一化后才进 filter', () => {
		const r = buildPayloadFilter({ section: '着火怎么办' })
		// 9/16：跨节打包的配套 —— section 维度发 should（section 或 sections 数组任一命中），
		// 只认 section 会漏掉"把该节并进去"的块（过滤静默失效比过滤不准更贵）
		// section 只走 should，**must 里不许再出现 section**：
		// 跨节块的 section 是公共祖先，进 must 会把"把该节并进去"的块整批筛掉（9/18 修正，
		// 旧断言恰好把这个错误结构钉成了"正确"）。
		expect(r.filter?.must ?? []).toEqual([])
		expect(r.filter?.should).toEqual([
			{ key: 'section', match: { value: '消防措施' } },
			{ key: 'sections', match: { value: '消防措施' } },
		])
		expect(r.dropped).toEqual([])
	})

	test('不带 section 时不出 should 子句（别给每次查询塞无用条件）', () => {
		const r = buildPayloadFilter({ cas_number: '7664-93-9' })
		expect(r.filter?.should).toBeUndefined()
	})

	test('CAS 校验位不通过 → 不施加并说明', () => {
		const r = buildPayloadFilter({ cas_number: '7664-93-8' })
		expect(r.filter).toBeUndefined()
		expect(r.dropped[0]?.field).toBe('cas_number')
	})

	test('合法 CAS + 文档维度：全部 keyword 精确匹配，且 key 只来自白名单', () => {
		const r = buildPayloadFilter({ cas_number: '7664-93-9', source_doc: '硫酸SDS.pdf', doc_id: 'sds/硫酸SDS' })
		expect(r.filter?.must).toEqual([
			{ key: 'cas_number', match: { value: '7664-93-9' } },
			{ key: 'source_doc', match: { value: '硫酸SDS.pdf' } },
			{ key: 'doc_id', match: { value: 'sds/硫酸SDS' } },
		])
		for (const c of r.filter!.must ?? []) expect(['section', 'cas_number', 'source_doc', 'doc_id']).toContain(c.key)
	})

	test('section 无法归一化 → 不施加', () => {
		const r = buildPayloadFilter({ section: '胡说八道xyz' })
		expect(r.filter).toBeUndefined()
		expect(r.dropped[0]?.reason).toContain('分节')
	})
})

// ─────────────────────────────────────────────────────────
describe('fuseRRF：按 point id 融合 + 精确旁路地板', () => {
	const FLOOR = 0.55

	test('同一点两路命中 → 只产出一条，rrfScore 累加，matchedBy=dense+sparse', () => {
		const dense = [pt('p1', 0.8, { text: 'A', doc_id: 'd1', section: '消防措施' })]
		const sparse = [pt('p1', 3.2, { text: 'A', doc_id: 'd1' })]
		const out = fuseRRF({ dense, sparse, precise: true, minDense: FLOOR, top: 10 })
		expect(out.length).toBe(1)
		expect(out[0]!.matchedBy).toBe('dense+sparse')
		expect(out[0]!.rrfScore).toBeCloseTo(2 / 61, 10)
		expect(out[0]!.denseScore).toBe(0.8)
		expect(out[0]!.sparseScore).toBe(3.2)
		expect(out[0]!.pointId).toBe('p1')
	})

	test('只在单路命中 → matchedBy 正确，另一路分为 null', () => {
		const out = fuseRRF({
			dense: [pt('a', 0.7, { text: 'A' }), pt('b', 0.6, { text: 'B' })],
			sparse: [pt('c', 2.0, { text: 'C' })],
			precise: true, minDense: FLOOR, top: 10,
		})
		const byId = new Map(out.map((h) => [h.pointId, h]))
		expect(byId.get('a')!.matchedBy).toBe('dense')
		expect(byId.get('a')!.sparseScore).toBeNull()
		expect(byId.get('c')!.matchedBy).toBe('sparse')
		expect(byId.get('c')!.denseScore).toBeNull()
	})

	test('text 完全相同但 point id 不同 → 不许被合并成一条（换合并键的核心回归）', () => {
		const dense = [pt('p1', 0.9, { text: '同样的原文' }), pt('p2', 0.8, { text: '同样的原文' })]
		const out = fuseRRF({ dense, sparse: [], precise: true, minDense: FLOOR, top: 10 })
		expect(out.length).toBe(2)
		expect(new Set(out.map((h) => h.pointId))).toEqual(new Set(['p1', 'p2']))
	})

	test('无 point id 时用 `${doc_id}#${seq}` 兜底；两者都缺则保留不合并', () => {
		const dense = [
			{ id: undefined, score: 0.9, payload: { text: 'X', doc_id: 'd1', seq: 3 } },
			{ id: undefined, score: 0.8, payload: { text: 'X', doc_id: 'd1', seq: 3 } }, // 同 doc_id#seq → 并成一条
			{ id: null, score: 0.7, payload: { text: 'Y' } }, // 无 id 无 doc_id/seq
			{ id: null, score: 0.6, payload: { text: 'Y' } }, // 同上 → 各自保留
		]
		const out = fuseRRF({ dense, sparse: [], precise: true, minDense: FLOOR, top: 10 })
		expect(out.length).toBe(3)
		expect(out.find((h) => h.pointId === 'd1#3')!.rrfScore).toBeCloseTo(1 / 61 + 1 / 62, 10)
	})

	test('payload 里的 score/denseScore 不覆盖计算结果（显式构造回归）', () => {
		const dense = [pt('p1', 0.8, { text: 'A', score: 999, denseScore: 999, rrfScore: 999 })]
		const out = fuseRRF({ dense, sparse: [], precise: true, minDense: FLOOR, top: 10 })
		expect(out[0]!.score).toBeCloseTo(1 / 61, 10) // 对外 score = 融合分
		expect(out[0]!.denseScore).toBe(0.8) // 不是 payload 里的 999
		expect(out[0]!.text).toBe('A')
	})

	test('精确 CAS 查询：dense 低于地板但 sparse/精查命中 → 仍在结果里', () => {
		const dense = [pt('low', 0.2, { text: '硫酸SDS 消防措施', cas_number: '7664-93-9' })]
		const sparse = [pt('low', 4.0, { text: '硫酸SDS 消防措施', cas_number: '7664-93-9' })]
		const casFilter = [pt('low', 0, { text: '硫酸SDS 消防措施', cas_number: '7664-93-9' })]

		const preciseOut = fuseRRF({ dense, sparse, casFilter, precise: true, minDense: FLOOR, top: 10 })
		expect(preciseOut.map((h) => h.pointId)).toContain('low')
		expect(preciseOut[0]!.matchedBy).toBe('dense+sparse+cas_filter')

		// 对比：同一批点，普通语义查询（precise=false）仍被地板挡掉 —— 证明没为了放行而整体放宽
		const semanticOut = fuseRRF({ dense, sparse, casFilter, precise: false, minDense: FLOOR, top: 10 })
		expect(semanticOut).toEqual([])
	})

	test('CAS 精查独占命中（dense/sparse 都没有）→ 精确查询下出现，语义查询下被拒', () => {
		const casFilter = [pt('only', 0, { text: 'CAS 命中', cas_number: '7664-93-9' })]
		expect(fuseRRF({ dense: [], sparse: [], casFilter, precise: true, minDense: FLOOR, top: 10 }).map((h) => h.pointId)).toEqual(['only'])
		expect(fuseRRF({ dense: [], sparse: [], casFilter, precise: false, minDense: FLOOR, top: 10 })).toEqual([])
	})

	test('语义查询：dense 分达线才留下，纯稀疏命中被地板拒（与旧行为一致）', () => {
		const dense = [pt('ok', 0.72, { text: 'A' }), pt('low', 0.3, { text: 'B' })]
		const sparse = [pt('lit', 5.0, { text: 'C' })] // 只有稀疏命中
		const out = fuseRRF({ dense, sparse, precise: false, minDense: FLOOR, top: 10 })
		expect(out.map((h) => h.pointId)).toEqual(['ok'])
	})

	test('无结果 → 返回空数组、不抛异常', () => {
		expect(fuseRRF({ dense: [], sparse: [], precise: false, minDense: FLOOR, top: 6 })).toEqual([])
		expect(fuseRRF({ dense: [], sparse: [], casFilter: [], precise: true, minDense: FLOOR, top: 6 })).toEqual([])
	})

	test('top 截断生效', () => {
		const dense = Array.from({ length: 8 }, (_, i) => pt(`p${i}`, 0.9 - i * 0.01, { text: `t${i}` }))
		expect(fuseRRF({ dense, sparse: [], precise: true, minDense: FLOOR, top: 3 }).length).toBe(3)
	})
})
