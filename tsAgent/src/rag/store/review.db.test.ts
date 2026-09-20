// 连库往返测试：证明"迁移 04 的 DDL ↔ review store 的列清单/映射口径"真的对得上
//   （列名拼错、JSON/MEDIUMTEXT 回读形态不符、人审状态机写错这类问题，离线测不出来）
// 纪律：
//   · 库不可用 / 迁移未应用 → **整组跳过**，绝不让离线环境变红；
//   · 自建数据只落在 'selftest.review.' 前缀的 doc_id 下，测试前后各清一次。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { Block, DocProfile } from '../inspect/profile'

const PREFIX = 'selftest.review.'
const REVIEWER = 1
const FILE = 'F:/code/project/BioReagentMS/tsAgent/corpus/selftest.review.demo.md'

let store: typeof import('./review') | null = null
let poolRef: Pool | null = null
let skipReason = ''

try {
	const db = await import('../../db/mysql')
	await db.pool.query('SELECT 1')
	const [rows] = await db.pool.query<RowDataPacket[]>(
		'SELECT table_name t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
		['rag_review_queue'],
	)
	if (!rows.length) skipReason = '迁移 04_rag_review_queue.sql 未应用'
	else {
		store = await import('./review')
		poolRef = db.pool
	}
} catch (e) {
	skipReason = 'MySQL 不可用：' + (e as Error).message.slice(0, 90)
}

const profile = (): DocProfile => ({ file: FILE, family: 'pdf', magic: 'pdf', strategy: 'L0-py', reason: '测试用' })
const blocks = (): Block[] => [
	{ type: 'heading', level: 1, markdown: '硫酸 SDS' },
	{ type: 'text', markdown: '皮肤接触：立即用大量流动清水冲洗至少15分钟。' },
]

const cleanup = async () => {
	if (!poolRef) return
	await poolRef.query('DELETE FROM rag_review_queue WHERE doc_id LIKE ?', [`${PREFIX}%`])
}

beforeAll(cleanup)
afterAll(async () => {
	await cleanup()
	if (poolRef) await poolRef.end().catch(() => {})
})

const suite = skipReason ? describe.skip : describe

suite(`解析人审队列连库往返（${skipReason || '库与迁移均就绪'}）`, () => {
	test('落料 → 列表 → 详情：profile/blocks/flags 原样回来', async () => {
		const docId = `${PREFIX}gate`
		await store!.enqueueReview({
			docId, file: FILE, origin: 'gate', reason: '[red] CAS 校验位失败: 7664-93-8',
			flags: ['[前门] 数字前缀', '[diag] extractor=text chars=120', '[red] CAS 校验位失败'],
			profile: profile(), blocks: blocks(),
		})
		const { records, total } = await store!.listReviewItems({ status: 'pending', keyword: PREFIX })
		expect(total).toBeGreaterThanOrEqual(1)
		const row = records.find(r => r.docId === docId)!
		expect(row.origin).toBe('gate')
		expect(row.reason).toContain('CAS 校验位失败')
		expect(row.flags).toHaveLength(3)                 // flags 换行存、回读成数组
		expect(row.profile?.family).toBe('pdf')           // JSON 列回读（mysql2 可能给字符串，parseJson 两种都吃）
		expect(row.blocksCount).toBe(2)

		const detail = await store!.getReviewItem(docId)!
		expect(detail!.blocks).toHaveLength(2)
		expect(detail!.blocks[1]!.markdown).toContain('皮肤接触')
		expect(detail!.editedBlocks ?? null).toBeNull()   // 还没人改过
	})

	test('★ 确认入库：状态翻转 + 修正样本存档（edited_blocks 是人改过的对照样本）', async () => {
		const docId = `${PREFIX}confirm`
		await store!.enqueueReview({ docId, file: FILE, origin: 'gate', reason: '闸门不过', flags: [], profile: profile(), blocks: blocks() })
		const edited: Block[] = [{ type: 'text', markdown: '人工修正后的正文。' }]
		await store!.markReviewed(docId, { status: 'confirmed', reviewedBy: REVIEWER, chunks: 7, editedBlocks: edited })

		const item = await store!.getReviewItem(docId)!
		expect(item!.status).toBe('confirmed')
		expect(item!.chunks).toBe(7)
		expect(item!.reviewedBy).toBe(REVIEWER)
		expect(item!.reviewedAt).toBeTruthy()
		expect(item!.editedBlocks?.[0]?.markdown).toBe('人工修正后的正文。')
	})

	test('★ 重新落料把已裁决的条目拉回 pending（重传后要重新看，不许停在 rejected 装没人管）', async () => {
		const docId = `${PREFIX}reopen`
		await store!.enqueueReview({ docId, file: FILE, origin: 'front-door', reason: '第一轮：加密 PDF', flags: ['[前门] 加密'], profile: profile(), blocks: [] })
		await store!.markReviewed(docId, { status: 'rejected', reviewedBy: REVIEWER })
		expect((await store!.getReviewItem(docId))!.status).toBe('rejected')

		await store!.enqueueReview({ docId, file: FILE, origin: 'gate', reason: '第二轮：能解析了但闸门不过', flags: ['[red] 空抽取'], profile: profile(), blocks: blocks() })
		const again = await store!.getReviewItem(docId)!
		expect(again!.status).toBe('pending')
		expect(again!.reason).toContain('第二轮')
		expect(again!.reviewedBy).toBeNull()   // 审核痕迹清掉：这次是新的一次摄取，要新的裁决
		expect(again!.reviewedAt).toBeNull()
	})

	test('countPending：缺表时返回 null 而不是 0（0 会被当成"审完了"）', async () => {
		const n = await store!.countPending()
		expect(typeof n).toBe('number')
		expect(n!).toBeGreaterThanOrEqual(0)
	})

	test('列表过滤：status / keyword 各自生效', async () => {
		const confirmed = await store!.listReviewItems({ status: 'confirmed', keyword: PREFIX })
		expect(confirmed.records.every(r => r.status === 'confirmed')).toBe(true)
		const byKeyword = await store!.listReviewItems({ keyword: `${PREFIX}gate` })
		expect(byKeyword.records.every(r => r.docId.includes('gate'))).toBe(true)
	})
})

if (skipReason) test(`（跳过）解析人审队列连库往返：${skipReason}`, () => expect(true).toBe(true))
