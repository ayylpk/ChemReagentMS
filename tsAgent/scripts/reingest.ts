// 服务器重摄自动化：bun run reingest -- /app/corpus [--limit N] [--redo] [--dry-run]
// 与 scripts/ingest.ts 的三点差异（为 9/7 换引擎全库重建而生）：
//   ① 断点续传：默认跳过台账里已 done 的文档，Ctrl+C 随时掐、再跑接着来
//   ② 进度+速率+ETA：2.1 万点在 2 核机上要跑数小时，不看速率等于盲飞
//   ③ 扫描口径取 scanIngestables（9/16 起）：原先这里**又抄了一份** `**/*.{md,txt,csv,pdf,docx,xlsx}`——
//      正是当年把 1710 份 md 漏掉的那种写法。现在扫全量、逐文件给结论，新家族（html/pptx/odf/未知后缀）自动纳入
import { pool } from '../src/db/mysql'
import { ingestFile, scanIngestables } from '../src/rag/pipeline'
import { docIdOf } from '../src/rag/inspect/identity'

const argv = process.argv.slice(2)
const flags = argv.filter(a => a.startsWith('--'))
const target = argv.find(a => !a.startsWith('--'))
if (!target) {
	console.error('usage: bun run reingest -- <dir> [--limit N] [--redo] [--dry-run]')
	process.exit(1)
}
// --limit 只接受正整数。旧写法 `Number(x) || 0` 会把 abc / 缺值 / 负数一律静默变成 0，
// 而 0 的语义是"不限量"→ 本意"先打样定速率"的安全阀，参数写错反而变成全量跑数小时。
// 宁可当场报错退出，也不要悄悄换个语义执行。
const limit = (() => {
	const i = argv.indexOf('--limit')
	if (i < 0) return 0
	const raw = argv[i + 1]
	const n = Number(raw)
	if (!Number.isInteger(n) || n < 1) {
		console.error(`--limit 需要正整数，收到 "${raw ?? ''}"（拒绝把非法值当成"不限量"）`)
		process.exit(1)
	}
	return n
})()

// 台账 done 集合按 doc_id 比对（与 pipeline logIngest / bySection 新口径逐字同一函数）——
// ⚠️ 这里原先按"去后缀文件名"比对：identity.ts 新口径下 corpus 子目录文档的 doc_id 变成
//    `bio__xxx`，而台账里存的还是旧名 `xxx`（甚至它压根没进过台账，因为旧口径互相覆盖时只留最后一份）——
//    继续按文件名比对会把"其实没摄进去"的文件误判成已 done 而永久跳过，旧点子永不迁移。
//    改成直接比 doc_id：认身份不认名字，认名字不认路径（Windows 旧台账路径在 Linux 上本就对不上）。
const [doneRows] = await pool.query("SELECT doc_id FROM ingest_log WHERE status='done'") as [{ doc_id: string }[], unknown]
const done = new Set(doneRows.map(r => r.doc_id))

const { files, skipped } = await scanIngestables(target)
files.sort()
if (skipped.length) {
	console.log(`跳过 ${skipped.length} 份（不该摄入，不是"不支持"）：`)
	for (const s of skipped.slice(0, 10)) console.log(`  ${s.file.replace(/^.*[\\/]/, '')} —— ${s.reason}`)
	if (skipped.length > 10) console.log(`  …另 ${skipped.length - 10} 份（口径见 src/rag/parse/formats.ts）`)
}
const todo = flags.includes('--redo') ? files : files.filter(f => !done.has(docIdOf(f)))
const batch = limit > 0 ? todo.slice(0, limit) : todo
console.log(`语料 ${files.length} 份 | 台账已有 ${files.length - todo.length} | 本次待摄 ${batch.length}${limit && todo.length > limit ? `（--limit ${limit} 先打样定速率）` : ''}`)

let ok = 0, bad = 0
const t0 = Date.now()
for (const [i, f] of batch.entries()) {
	const name = f.replace(/^.*[\\/]/, '')
	const r = await ingestFile(f, { dryRun: flags.includes('--dry-run') })
	r.status === 'done' ? ok++ : bad++
	// 速率=累计均速（前几十份含冷启动，跑过 100 份后这个数才可信）
	const rate = (i + 1) / ((Date.now() - t0) / 60000)
	console.log(`[${i + 1}/${batch.length}] ${r.status.padEnd(10)} ${name}  chunks=${r.chunks}  速率=${rate.toFixed(1)}份/分  ETA≈${((batch.length - i - 1) / rate).toFixed(0)}分`)
	for (const fl of r.flags) console.log(`    ${fl}`)
}
console.log(`\n完 ${batch.length} 份：done=${ok} 非done=${bad}（review/quarantined/failed 详情查台账 flags）`)
process.exit(0) // 硬退防 mysql 池吊死（scripts/ingest.ts 同款血泪）
