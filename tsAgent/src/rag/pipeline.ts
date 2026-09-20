// ⑨ 总装线：probe(前门) → runStrategy(抽取) → bySection(切块) → gate(后门) → store(入库) + 台账
// 铁律：单文件失败只标记自己、绝不中断整批（旁路化降级）；每步产出都进台账，可观测不控制
import { probe } from './inspect/probe'
import { runStrategy, NeedsUpgrade, type ParsedDoc } from './parse/route'
import { DocReject } from './parse/fromPy'
import { bySection } from './chunk/bySection'
import { docIdOf } from './inspect/identity' // doc_id 唯一来源；台账与切片必须同口径
import { gate } from './gate/quality'
import { upsertChunks, logIngest } from './store/upsert'
import { enqueueReview } from './store/review' // 非 done 出口落料：人审才有"可审的料"
import { extOf, isJunkExt, convertRequiredReason } from './parse/formats'
import type { DocProfile, ParseDiag } from './inspect/profile'

/** diag 一行摘要进台账（flags 是 TEXT，先按人可读的一行记；结构化列等 review 闭环一起做 DDL） */
function renderDiag(d: ParseDiag): string {
	const kv = Object.entries(d)
		.filter(([k, v]) => k !== 'notes' && v !== undefined && v !== 0)
		.map(([k, v]) => `${k}=${v}`)
	return kv.join(' ')
}

export interface IngestResult {
	file: string
	profile?: DocProfile
	status: 'done' | 'review' | 'quarantined' | 'failed' | 'skipped'
	chunks: number
	flags: string[]
}
export interface IngestOptions { dryRun?: boolean }

export async function ingestFile(file: string, opts: IngestOptions = {}): Promise<IngestResult> {
	const t0 = performance.now() // 单档全链耗时进台账，供"每文档解析耗时"计时表用
	const result: IngestResult = { file, status: 'failed', chunks: 0, flags: [] }
	// ⚠️ 必须 await：ingest CLI 打印完就 process.exit(0)，fire-and-forget 的台账写库赶不上死亡
	const finish = async () => {
		// dry-run 不产生副作用：台账状态记 'dry-run'，**绝不能记 'done'**。
		// 依据：reingest 用 `SELECT doc_id FROM ingest_log WHERE status='done'` 判"已摄，跳过"，
		// extractReactions 的准入也看 status='done'。dry-run 若写 done，等于台账谎报"已入库"——
		// 此后这些文件在默认流程里永远不会被真正摄取（台账有记录、向量库里一个点都没有）。
		await logIngest({ docId: docIdOf(file), file, status: opts.dryRun ? 'dry-run' : result.status, chunks: result.chunks, flags: result.flags, costMs: Math.round(performance.now() - t0) })
		return result
	}
	try {
		// 前门：档案。判死（L2）的连抽都不抽
		const profile = await probe(file)
		result.profile = profile
		if (profile.strategy === 'L2-review') {
			result.status = 'review'
			result.flags.push(`[前门] ${profile.reason}`)
			// 落料：前门判死的文档没有 blocks（压根没解析），但档案本身要留下 —— 人审要知道"为什么被判死"
			await enqueueReview({ docId: docIdOf(file), file, origin: 'front-door', reason: profile.reason, flags: result.flags, profile, blocks: [] })
			return finish()
		}

		// 抽取：本期未实现的路（双栏重排）→ NeedsUpgrade → 隔离（不是失败，是排队等能力）
		let parsed: ParsedDoc
		try {
			parsed = await runStrategy(profile)
		} catch (e) {
			if (e instanceof DocReject) {
				// py 判定"不该进向量库"（如台账型 xlsx）：转人审，理由进台账
				result.status = 'review'
				result.flags.push(`[拒收] ${e.message}`)
				await enqueueReview({ docId: docIdOf(file), file, origin: 'parser-reject', reason: e.message, flags: result.flags, profile, blocks: [] })
				return finish()
			}
			if (e instanceof NeedsUpgrade) {
				result.status = 'quarantined'
				result.flags.push(`[隔离] ${e.message}`)
				await enqueueReview({ docId: docIdOf(file), file, origin: 'needs-upgrade', reason: e.message, flags: result.flags, profile, blocks: [] })
				return finish()
			}
			throw e
		}
		const blocks = parsed.blocks
		// 前门 notes（后缀与内容不符、内容嗅探兜底…）与 diag 是同一类东西：**前门/抽取发现的事实必须进台账**，
		// 否则"这份文档当初是怎么被判成这个格式的"永远查不到
		if (profile.notes?.length) result.flags.push(...profile.notes.map(n => `[前门] ${n}`))
		if (parsed.diag) result.flags.push(`[diag] ${renderDiag(parsed.diag)}`)

		// 切块 + 后门质检（diag 一起交给 gate：降级事实要在质检里被看见）
		const chunks = bySection(file, blocks)
		const verdict = gate(profile, blocks, parsed.diag)
		result.flags.push(...verdict.flags)
		if (!verdict.pass) {
			// 红灯=人审；黄灯本应升 L1 重抽——L1 未接，先按隔离存放（升级路径：接 fromPy 后黄灯自动变重跑）
			result.status = verdict.escalate === 'L2' ? 'review' : 'quarantined'
			// **这里是落料最值钱的一处**：闸门不过的文档有完整 blocks —— 存下来人审才有得改
			await enqueueReview({
				docId: docIdOf(file), file, origin: 'gate', blocks,
				reason: verdict.flags.filter(f => /^\[(red|yellow)\]/.test(f)).join('；').slice(0, 500) || '闸门未通过',
				flags: result.flags, profile,
			})
			return finish()
		}

		// 入库（dry-run 只出档案与判分到为止）
		if (!opts.dryRun) await upsertChunks(profile, chunks)
		result.status = 'done'
		result.chunks = chunks.length
		if (opts.dryRun) result.flags.push('[info] dry-run 未入库')
		return finish()
	} catch (e) {
		result.status = 'failed'
		result.flags.push(`[failed] ${(e as Error).message.slice(0, 200)}`)
		return finish()
	}
}

export interface ScanResult {
	files: string[]
	/** 扫到了但按口径不该摄入的（含理由）—— 记账，不静默 */
	skipped: { file: string; reason: string }[]
}

/**
 * 目录扫描的**唯一口径**（ingestDir 与 scripts/reingest.ts 共用；谁都不许再自己写 glob）。
 * 历史教训两次都出在"各地各写一份后缀表"：一次是 ingestDir 只认 pdf/docx/xlsx → 1710 份 md 整批被静默跳过；
 * 一次是 reingest.ts 又抄了一份同样的 glob。现在扫全量、逐文件给结论，后缀不再是准入门槛。
 */
export async function scanIngestables(dir: string): Promise<ScanResult> {
	const files: string[] = []
	const skipped: ScanResult['skipped'] = []
	// dot:true 必开：Bun.Glob 默认不产出隐藏条目，会让下面"隐藏文件/临时件"两个记账分支变成不可达的死代码——
	// 口径本来是"扫到了但按规则不摄入的，记账不静默"，默认扫描实际是"静默不扫"。
	for await (const f of new Bun.Glob('**/*').scan({ cwd: dir, absolute: true, dot: true })) {
		const base = f.replace(/^.*[\\/]/, '')
		const ext = extOf(f)
		if (base.startsWith('.')) skipped.push({ file: f, reason: '隐藏文件' })
		else if (isJunkExt(ext)) skipped.push({ file: f, reason: `临时/备份件（.${ext}）` })
		else {
			const conv = convertRequiredReason(ext)
			if (conv) skipped.push({ file: f, reason: conv })
			else files.push(f)
		}
	}
	files.sort()
	return { files, skipped }
}

/** 批量：顺序跑但互不牵连（并发留给真上量时，台账按文件各自记账）。扫描口径见 scanIngestables */
export async function ingestDir(dir: string, opts: IngestOptions = {}): Promise<IngestResult[]> {
	const { files, skipped } = await scanIngestables(dir)
	const skip = new Map(skipped.map(s => [s.file, { file: s.file, status: 'skipped' as const, chunks: 0, flags: [`[跳过] ${s.reason}`] }]))
	const results: IngestResult[] = []
	for (const f of [...files, ...skipped.map(s => s.file)].sort()) results.push(skip.get(f) ?? await ingestFile(f, opts))
	return results
}
