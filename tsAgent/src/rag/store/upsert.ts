// ⑧ 入库调度：三件套的唯一写入口（稠密 embed + 稀疏 toSparse + payload）+ doc_id 幂等 + 台账
// 分工线：embed/、sparse/ 只管自己模态的向量算法；"一条 chunk 同时长两种向量"的组合只发生在这层
// 读侧提醒：生产 collection 的稠密字段是 named "dense"——ragNode/searchDoc 接入真库那天加 using:'dense'
import { QdrantClient } from '@qdrant/js-client-rest'
import { createHash } from 'node:crypto'
import { config } from '../../config/env'
import { embed } from '../embed' // 门面选择后端（EMBED_BACKEND），写读永远同模
import { toSparse } from '../sparse/bm25'
import { pool } from '../../db/mysql'
import { SCHEMA_VERSION } from '../inspect/profile'
import type { Chunk, DocProfile } from '../inspect/profile'

// 台账表（接线日跑一次；logIngest 对缺表只 warn，旁路化）：
// CREATE TABLE IF NOT EXISTS ingest_log (
//   doc_id VARCHAR(128) PRIMARY KEY, file VARCHAR(512), status VARCHAR(16),
//   chunks INT, cost_ms INT, flags TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)
// 老库补列：ALTER TABLE ingest_log ADD COLUMN cost_ms INT NULL AFTER chunks

const qdrant = new QdrantClient({ url: config.QDRANT_URL, apiKey: config.QDRANT_API_KEY || undefined })
const COLL = config.QDRANT_COLLECTION
const EMBED_BATCH = 32 // v4/bge 批量上限内取稳；Ollama 不限但内存友好

/** point id 命名空间：本工程私有固定值，一旦上线永不变（变了=全库 id 漂移） */
const POINT_NS = '9f2c4b1e-6d3a-4f7b-8c05-1a2b3c4d5e6f'

/**
 * 确定性 point id：RFC4122-v5 风格的命名空间 UUID（SHA-1(namespace ‖ `${docId}#${seq}`)）。
 * 旧方案是 32 位 FNV-1a 数字：1710+ 文档 × 每档几十块 ≈ 10⁵ 点，按生日问题期望碰撞数 ≈ n²/2^33 ≈ 1.2，
 * —— 即"必然有若干条 chunk 被别条静默覆盖"，且覆盖后不报错、只少数据（最贵的那种 bug）。
 * 新方案取 SHA-1 前 128 位（122 位有效随机），10⁵ 量级碰撞概率 ≈ 10⁻²⁷，可当不存在。
 * 纯函数、无 IO、可单测；同 docId+seq 任何时候算出同一个 id（重摄幂等的前提）。
 */
export function pointId(docId: string, seq: number): string {
	const h = createHash('sha1')
	h.update(Buffer.from(POINT_NS.replace(/-/g, ''), 'hex')) // 16 字节命名空间
	h.update(`${docId}#${seq}`, 'utf8')
	const b = h.digest()
	b[6] = (b[6]! & 0x0f) | 0x50 // version 5（name-based, SHA-1）
	b[8] = (b[8]! & 0x3f) | 0x80 // RFC4122 variant
	const hex = b.subarray(0, 16).toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** 需要 payload index 的字段（新增字段必须登记在这里，否则 filter 走全表扫） */
const PAYLOAD_INDEXES: readonly (readonly [string, 'keyword' | 'integer'])[] = [
	['section', 'keyword'], ['sections', 'keyword'], ['cas_number', 'keyword'], ['doc_id', 'keyword'],
	['heading_path', 'keyword'], ['table_id', 'keyword'], // heading_path/sections 是数组，keyword index 会逐元素索引
]

// 进程内"建集合"的单飞（single-flight）：check-then-act 之间隔着 await，
// 只用布尔标志的话，两个并发首摄会同时看到 false、同时 collectionExists、同时 createCollection，
// 第二个必然收到 400 → 异常上抛，那份文档被记成 failed（logIngest / enqueueReview 都做了旁路化，唯独这里没有）。
// 缓存 **promise 本身**：并发调用共享同一次创建；失败则清空，允许下次重试（不把失败永久缓存住）。
let collectionReady: Promise<void> | null = null
async function ensureCollection(): Promise<void> {
	collectionReady ??= (async () => {
		// ⚠️ 1.19 客户端 collectionExists 返回 {exists:boolean} 对象而非裸布尔——直接 if(await) 恒真，血泪注释
		if ((await qdrant.collectionExists(COLL)).exists) return
		await qdrant.createCollection(COLL, {
			vectors: { dense: { size: config.EMBED_DIM, distance: 'Dot' } },
			sparse_vectors: { sparse: { modifier: 'idf' } }, // IDF 服务端统计，写入只管交 tf
		})
	})().catch((e) => {
		collectionReady = null
		throw e
	})
	await collectionReady
}

/**
 * payload index 的幂等兜底（已在线上跑的集合不会因为"建集合时加过"而自动补索引）：
 * createPayloadIndex 对已存在的索引是 no-op，真报错也只 warn —— 索引缺失只影响过滤性能，
 * 绝不能挡住写入主流程。进程内只跑一次（同样用 promise 单飞，避免并发各跑一遍）。
 */
let indexesReady: Promise<void> | null = null
async function ensurePayloadIndex(): Promise<void> {
	indexesReady ??= (async () => {
		for (const [field_name, field_schema] of PAYLOAD_INDEXES) {
			try {
				await qdrant.createPayloadIndex(COLL, { field_name, field_schema, wait: true })
			} catch (e) {
				console.warn(`[store] payload index 跳过 ${field_name}:`, (e as Error).message.slice(0, 120))
			}
		}
	})().catch((e) => {
		indexesReady = null
		throw e
	})
	await indexesReady
}

/** 把一个文档的全部 chunk 写入向量库（**先写新点、收尾再清理未覆盖的旧点** = 增量重建，不全库重建） */
export async function upsertChunks(profile: DocProfile, chunks: Chunk[]): Promise<void> {
	if (!chunks.length) return
	await ensureCollection()
	await ensurePayloadIndex()
	const docId = chunks[0]!.docId

	const sourceDoc = profile.file.replace(/^.*[\\/]/, '')
	for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
		const batch = chunks.slice(i, i + EMBED_BATCH)
		const dense = await embed(batch.map(c => c.text)) // 一次批量
		const points = batch.map((c, j) => ({
			id: pointId(c.docId, c.seq),
			vector: { dense: dense[j]!, sparse: toSparse(c.text) },
			// payload 只增不删：老字段（doc_id/source_doc/section/cas_number/page/bbox/text/summary）语义不动，
			// 下游 src/tools/searchKnowledge.ts 与 src/agent/graph.ts 仍按 section 读"叶子分节名"
			payload: {
				doc_id: c.docId,
				source_doc: sourceDoc,
				section: c.section ?? null,
				sections: c.sections ?? (c.section ? [c.section] : null), // 覆盖到的叶子节名（跨节打包时 >1 个）
				heading_path: c.headingPath, // 完整标题路径（数组）
				seq: c.seq,
				cas_number: c.text.match(/(?<![\d-])\d{2,7}-\d{2}-\d(?![\d-])/)?.[0] ?? null, // 锚前缀里就带着；边界防 R/S 码串扰（同 gate）
				page: c.page ?? null,
				bbox: c.bbox ?? null,
				text: c.text,
				table_id: c.tableId ?? null,
				table_part: c.tablePart ? `${c.tablePart.index}/${c.tablePart.total}` : null,
				// 切缝上下文长度：本块头部有多少字是上一块的尾巴（10% 重叠）。正文里没有标记，
				// 展示/评估要裁掉重复就得靠这个数（二期：渲染层据此裁剪）
				overlap_chars: c.overlapChars ?? 0,
				schema_version: SCHEMA_VERSION, // 供下游识别"这条点属哪一代字段契约"
				...(c.summary ? { summary: c.summary } : {}),
				...(c.flags?.length ? { chunk_flags: c.flags } : {}),
			},
		}))
		await qdrant.upsert(COLL, { wait: true, points })
	}

	// 收尾：清掉"同 doc_id、但 seq 不在本次集合里"的旧点（重摄后块数变少时才会存在）。
	// ⚠️ 这里是"先写后删"，不是"先删后写"：point id 由 pointId(docId, seq) 确定性生成，
	//    同 seq 的新点会**原位覆盖**旧点，所以先写不会写重；而且中途失败时旧数据依然完整（最坏是部分更新）。
	//    旧写法"先删后写"只要在 embed / 第 N 批 upsert 处抛错，就是"旧点已删、新点只写了一半"——
	//    这份文档在检索里直接消失，而台账只留一条 failed（不可逆的静默数据丢失）。
	// 判据仍走 payload.doc_id（不按 point id）：id 方案演进过（32 位数字 → UUID），doc_id 才是身份。
	// ⚠️ 全库只有这一处 + deleteDoc 两处删除；谁都不许改成按 id 删。
	await qdrant.delete(COLL, {
		filter: {
			must: [{ key: 'doc_id', match: { value: docId } }],
			must_not: [{ key: 'seq', match: { any: chunks.map(c => c.seq) } }],
		},
		wait: true,
	})
}

/** 整档删除：向量库按 doc_id 清空（与 upsert 同款 filter 写法），知识库页 / 重摄前用 */
export async function deleteDoc(docId: string): Promise<void> {
	await qdrant.delete(COLL, { filter: { must: [{ key: 'doc_id', match: { value: docId } }] }, wait: true })
}

/** 摄取台账 upsert：表没建/MySQL 没起都不许挡主流程（旁路化降级，同 sys_task 桥姿势） */
export async function logIngest(entry: { docId: string; file: string; status: string; chunks: number; flags: string[]; costMs?: number }): Promise<void> {
	try {
		await pool.query(
			`INSERT INTO ingest_log (doc_id, file, status, chunks, cost_ms, flags) VALUES (?, ?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE status=VALUES(status), chunks=VALUES(chunks), cost_ms=VALUES(cost_ms), flags=VALUES(flags)`,
			[entry.docId, entry.file, entry.status, entry.chunks, entry.costMs ?? null, entry.flags.join('\n')],
		)
	} catch (e) {
		console.warn('[store] 台账写入跳过（ingest_log 缺表或 MySQL 未起）:', (e as Error).message.slice(0, 100))
	}
}
