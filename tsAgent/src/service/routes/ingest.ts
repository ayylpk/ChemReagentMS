// 上传摄取 API：知识库页的进食口（页面只给人工上传/拖拽入口，爬虫不进 UI）
// 契约：upload 立即返回 202+docId，真正解析进进程内串行队列（pipeline 注释定死"并发留给真上量时"）；
//       结果以 ingest_log 台账为唯一真相（进程重启不丢账，重摄幂等覆盖），前端轮询 /list 看状态翻转
//
// 9/16 准入口径改动（解析泛化第一刀）：改前是"后缀 ∈ 6 种白名单"，其余一律门口拒。
//   问题不在"拒"，在"**只能靠后缀判断**"——一个陌生后缀但内容是纯文本的货号说明、一份 .html 的
//   厂家 SDS、一张 .webp 的截图，全都在门口被拒，而它们其实都能解析。
//   现在：① 垃圾/转存档仍然门口拒（理由照旧）；② 其余**先落盘再问前门 probe**，
//         前门判 L2-review（加密/损坏/二进制不可解）→ 删文件 + 明确理由拒；
//         判得出来（含陌生后缀的内容嗅探兜底）→ 收下进队列。**后缀不再是准入门槛，内容才是。**
import { join, basename } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import { Hono } from 'hono'
import { pool } from '../../db/mysql'
import { ingestFile } from '../../rag/pipeline'
import { deleteDoc } from '../../rag/store/upsert'
import { ALLOWED_EXT, CONVERT_REQUIRED_EXT, JUNK_EXT, convertRequiredReason, extOf, isJunkExt, unsupportedReason } from '../../rag/parse/formats'
import { probe } from '../../rag/inspect/probe'
import { CORPUS, ROOT, docDirName, docIdOf } from '../../rag/inspect/identity'
// 鉴权：本组端点原先**一个都没挂**（/review、/gap 两组都挂了，只漏了这组）——
// 后果是匿名可上传污染语料（检索时成为提示注入载体），也可用无鉴权的 /list 枚举 doc_id 后
// 调 /delete 三删（向量库 + 台账 + 盘上原文件）。口径与其他三组一致：读用 query，写用 audit。
import { requirePermission } from '../auth'

export { CORPUS } // webSearch 确认件也落这（routes/webSearch.ts 共用；口径归 identity.ts，勿再各写一份）
mkdirSync(CORPUS, { recursive: true })
const MAX_SIZE = 50 * 1024 * 1024 // 单文件 50MB 顶（SDS 文档几百 KB 到几 MB，留足扫描余量）
// corpus 子目录白名单（9/6 拍板：化学/生物分开各住各的）：上传带 form 字段 sub=chemistry|bio，
// 不在名单/没带的落 misc（前端知识库页暂未传 sub）。台账 file 列存 dest 绝对路径，reingest/删除零改动
const SUBS = new Set(['chemistry', 'bio'])

/** 落盘名清洗：去路径、干掉文件系统非法字符；同名覆盖 = "重新上传即更新"语义（doc_id 相同，摄取幂等重建） */
function safeName(raw: string): string {
	const name = basename(raw.replace(/\\/g, '/'))
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
		.replace(/^\.+/, '')
		.slice(0, 100)
	return name || 'unnamed'
}

// ---------- 进程内串行队列 ----------
const queue: string[] = []
let pumping = false
async function pump(): Promise<void> {
	if (pumping) return
	pumping = true
	while (queue.length) {
		const f = queue.shift()!
		try {
			await ingestFile(f) // pipeline 自己兜状态 + 写台账，这里只保队列不断
		} catch (e) {
			console.error('[ingest] 队列异常（台账会兜 failed）:', f, (e as Error).message)
		}
	}
	pumping = false
}

/** 预写 queued：表在就记排队，MySQL 没起也不挡摄取（与 logIngest 同款旁路化） */
async function markQueued(docId: string, file: string): Promise<void> {
	try {
		await pool.query(
			`INSERT INTO ingest_log (doc_id, file, status, chunks, flags) VALUES (?, ?, 'queued', 0, '')
			 ON DUPLICATE KEY UPDATE status='queued', chunks=0, flags=''`,
			[docId, file],
		)
	} catch (e) {
		console.warn('[ingest] queued 预写跳过:', (e as Error).message.slice(0, 80))
	}
}

export const ingestRoutes = new Hono()

// 上传：multipart（字段名不限，所有 File 条目都收）→ 落盘 corpus/ → 预写台账 → 入队
ingestRoutes.post('/upload', async (c) => {
	const auth = await requirePermission(c, 'ragReview:audit')
	if (!auth.ok) return auth.response!
	const form = await c.req.formData()
	// Bun 的 FormData 值类型标注是 string|File 联合体但过滤谓词不认，整体过 unknown 再收窄
	const files = [...(form.values() as unknown as Iterable<unknown>)].filter((v): v is File => v instanceof File)
	if (!files.length) return c.json({ error: '未收到文件（multipart File 字段）' }, 400)

	const accepted: { docId: string; file: string; family?: string; notes?: string[] }[] = []
	const rejected: { name: string; reason: string }[] = []
	for (const f of files) {
		const name = safeName(f.name)
		const ext = extOf(name)
		// ① 门口速拒：垃圾后缀与"认识但吃不下"的转存档（零成本，连盘都不用落）
		if (isJunkExt(ext)) {
			rejected.push({ name: f.name, reason: `临时/备份件（.${ext}）不该进知识库` })
			continue
		}
		const conv = convertRequiredReason(ext)
		if (conv) {
			rejected.push({ name: f.name, reason: conv })
			continue
		}
		if (f.size > MAX_SIZE) {
			rejected.push({ name: f.name, reason: `超过 50MB 上限（${(f.size / 1048576).toFixed(1)}MB）` })
			continue
		}
		const sub = SUBS.has(String(form.get('sub') ?? '')) ? String(form.get('sub')) : 'misc' // 爬虫传 bio/chemistry；未传的（前端手传）落 misc
		const dir = join(CORPUS, sub)
		mkdirSync(dir, { recursive: true })
		const dest = join(dir, name)
		await writeFile(dest, Buffer.from(await f.arrayBuffer()))

		// ② 内容准入：落盘后问前门 —— 后缀只是"声明"，内容才是判据
		let profile
		try {
			profile = await probe(dest)
		} catch (e) {
			await rm(dest, { force: true })
			rejected.push({ name: f.name, reason: `前门探测失败：${(e as Error).message.slice(0, 100)}` })
			continue
		}
		if (profile.strategy === 'L2-review') {
			// 收下来只会变成一条"review"台账行且无人处置（review 队列仍是空壳）→ 门口就说清楚，别造幻觉
			await rm(dest, { force: true })
			rejected.push({ name: f.name, reason: `${unsupportedReason(ext)} —— 前门判定：${profile.reason}` })
			continue
		}

		const docId = docIdOf(dest) // 口径唯一来源 identity.ts（相对 corpus 根的路径折 "__"）
		await markQueued(docId, dest)
		queue.push(dest)
		accepted.push({ docId, file: name, family: profile.family, ...(profile.notes?.length ? { notes: profile.notes } : {}) })
	}
	void pump()
	return c.json({ accepted, rejected }, 202)
})

// 格式口径：前端知识库页**从这里取**白名单，不许再自己抄一份
// 起因：Knowledge.vue 里硬编码了 `['pdf','docx','xlsx','txt','md','csv']` 并注释"与 routes/ingest.ts 同步改"——
//   解析泛化扩族后前端没跟上，用户在页面上传 .html/.odt/.webp/.json 会被**前端先拦掉**，
//   根本到不了后端的前门准入（"四处口径"变成五处）。口径本体在 src/rag/parse/formats.ts，这里只做投影。
ingestRoutes.get('/formats', (c) =>
	c.json({
		allowed: [...ALLOWED_EXT].sort(),
		/** 认识但吃不下 → 前端可以直接把理由显示给用户（与 unsupportedReason 同源） */
		convertRequired: [...CONVERT_REQUIRED_EXT.entries()].map(([ext, reason]) => ({ ext, reason })),
		junk: [...JUNK_EXT].sort(),
		maxSizeMb: MAX_SIZE / 1048576,
		notes: [
			'白名单只挡"不该扫的噪音"，内容才是准入门槛：陌生后缀但内容是文本 → 后端按文本族收',
			'转存档（老 doc/xls、压缩包、iWork、heic…）在门口明确拒绝并给转存理由',
		],
	}),
)

// 台账列表：分页 + 状态/关键字过滤（前端 3s 轮询的就是它，SQL 保持轻）
ingestRoutes.get('/list', async (c) => {
	const auth = await requirePermission(c, 'ragReview:query')
	if (!auth.ok) return auth.response!
	const page = Math.max(Number(c.req.query('page')) || 1, 1)
	const pageSize = Math.min(Math.max(Number(c.req.query('pageSize')) || 10, 1), 100)
	const status = c.req.query('status') || ''
	const keyword = c.req.query('keyword') || ''

	const where: string[] = []
	const params: unknown[] = []
	if (status) { where.push('status=?'); params.push(status) }
	if (keyword) { where.push('(doc_id LIKE ? OR file LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }
	const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''

	const countRes = (await pool.query(`SELECT COUNT(*) n FROM ingest_log${whereSql}`, params)) as [{ n: number }[], unknown]
	const listRes = (await pool.query(
		`SELECT doc_id, file, status, chunks, cost_ms, flags, updated_at FROM ingest_log${whereSql}
		 ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
		[...params, pageSize, (page - 1) * pageSize],
	)) as [Record<string, unknown>[], unknown]
	const records = listRes[0].map((r) => ({ ...r, file: String(r.file ?? '').replace(/^.*[\\/]/, '') }))
	return c.json({ records, total: countRes[0][0]?.n ?? 0 })
})

// 重摄：按台账里的原盘路径重跑 pipeline（文件被删则请用户重新上传）
ingestRoutes.post('/:docId/reingest', async (c) => {
	const auth = await requirePermission(c, 'ragReview:audit')
	if (!auth.ok) return auth.response!
	const docId = c.req.param('docId')
	const [rows] = (await pool.query('SELECT file FROM ingest_log WHERE doc_id=?', [docId])) as [{ file: string }[], unknown]
	const row = rows[0]
	if (!row) return c.json({ error: `台账无此文档: ${docId}` }, 404)
	const file = row.file
	if (!existsSync(file)) return c.json({ error: '盘上原文件已不存在，请重新上传' }, 410)
	await markQueued(docId, file)
	queue.push(file)
	void pump()
	return c.json({ ok: true }, 202)
})

// 删除：四删——向量库按 doc_id、台账行、盘上原文件、解析副产物（图转文的媒体目录）
// ⚠️ 顺序有意为之：**向量库删成功才继续**，失败即中止且不改动台账/文件。
//    旧写法是三步各删各的、互不阻断（向量库失败只记进 problems），会留下最难受的一种状态：
//    向量库里这份文档还在（检索能命中），但台账和原文件都没了 —— 列表里看不见它，
//    用户再也点不到删除，等于留下不可见、不可再删的孤儿数据。
ingestRoutes.delete('/:docId', async (c) => {
	const auth = await requirePermission(c, 'ragReview:audit')
	if (!auth.ok) return auth.response!
	const docId = c.req.param('docId')
	const [rows] = (await pool.query('SELECT file FROM ingest_log WHERE doc_id=?', [docId])) as [{ file: string }[], unknown]

	// ① 向量库（先做，且必须成功）
	try {
		await deleteDoc(docId)
	} catch (e) {
		const msg = (e as Error).message.slice(0, 150)
		console.warn(`[ingest] 向量库删除失败，中止本次删除 docId=${docId}:`, msg)
		return c.json({ error: `向量库删除失败，已中止本次删除（台账与原文件未改动，可稍后重试）：${msg}` }, 502)
	}

	// ② 台账行
	await pool.query('DELETE FROM ingest_log WHERE doc_id=?', [docId])

	const problems: string[] = []
	// ③ 盘上原文件（已不存在不算错，force: true）
	if (rows[0]) await rm(rows[0].file, { force: true }).catch((e) => problems.push(`盘上文件删除失败: ${e.message}`))
	// ④ 解析副产物：图转文落盘的 resources/<docId>/（含 media/ 子目录）。
	//    此前不在删除范围内 —— 删文档、重摄都不会回收，磁盘只增不减（仓库里已积了若干残留目录）。
	await rm(join(ROOT, 'resources', docDirName(docId)), { recursive: true, force: true })
		.catch((e) => problems.push(`媒体目录清理失败: ${e.message}`))
	return c.json({ ok: true, problems })
})
