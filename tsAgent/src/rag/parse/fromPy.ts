// py 能力扩展桥：spawn python pytools/parse.py → stdout 契约 JSON → Block[] + diag
// 失败姿势（全在 route.ts 消费）：
//   DocReject      = py 判定"这文件不该进向量库"（台账 xlsx/不支持格式）→ pipeline 转人审
//   DocParseFailed = 环境/解析炸了（没装依赖、python 不在 PATH…）→ route 落回手写解析器（容灾）
//                    contract=true 的 DocParseFailed = 吐了 JSON 但结构非法（契约 bug）→ 不许落回手写掩盖，直接上抛落 failed
//
// 9/16 两处硬伤修复（都是"解析能力其实没生效，但没人知道"）：
//   ① 解释器只有一个候选 `python`：本机 `python` 是 msys 的 3.12（pymupdf/markitdown 一个没装），
//      而依赖全在另一个 3.14 里 → pdf/docx/xlsx 全部"py 解析失败 → 落回手写"，图片/pptx/html/odf 直接隔离。
//      现在按 PYTHON_BIN → py → python3 → python 逐个试，**只在环境级失败（连契约都没吐）时换下一个**，
//      且只在"失败得很快"时才换（避免把一次几分钟的真解析乘以候选数）。
//   ② stderr 里的降级事实（走了几页 VL、丢了几页、截了多少图）全被 console.log 丢掉 → 现在走 diag 契约。
import { spawn } from 'bun'
import { fileURLToPath } from 'node:url'
import type { Block, ParseDiag } from '../inspect/profile'
import { docDirName, docIdOf } from '../inspect/identity'

export class DocReject extends Error {}

export class DocParseFailed extends Error {
	/** true = 契约（stdout JSON 结构）非法，属数据/契约 bug，不是环境故障；route 据此拒绝静默降级 */
	readonly contract: boolean
	/** 实际使用的解释器（排查"到底哪个 python 在干活"时唯一有用的信息） */
	readonly python?: string
	constructor(message: string, contract = false, python?: string) {
		super(message)
		this.contract = contract
		this.python = python
	}
}

const ROOT = new URL('../../../', import.meta.url) // src/rag/parse → 上三层 = tsAgent 根
const TIMEOUT_MS = 5 * 60_000 // 与 CrewForge 工位同款 300s：PDF 批量推理给足余量
/** 环境级失败（无契约输出）允许换解释器重试的最长耗时：超过它说明"其实在真干活"，重试只会把代价乘以候选数 */
const SWITCH_FAST_MS = 20_000

/** 解析产物：块 + 抽取侧诊断（diag 可缺省 = 老 py 或手写 fallback） */
export interface ParsedDoc {
	blocks: Block[]
	diag?: ParseDiag
}

// ─────────────────────────────────────────── 解释器候选（Windows `py` 常是对的，POSIX 只有 python3/python）
let cachedBin: string | null = null

/** 候选顺序：PYTHON_BIN（显式指定，永不回退别处）> py/py3（Windows 启动器，取最新解释器）> python3 > python */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
	const out: string[] = []
	const push = (v?: string) => { const s = v?.trim(); if (s && !out.includes(s)) out.push(s) }
	if (env.PYTHON_BIN?.trim()) return [env.PYTHON_BIN.trim()] // 显式给了就只认它：静默换解释器比报错危险
	if (process.platform === 'win32') push('py')
	push('python3')
	push('python')
	return out
}

/** 进程内记住上次成功的解释器：一份文件一次 spawn，同一批里没必要每次都从头上试 */
export const lastGoodPython = (): string | null => cachedBin

// ─────────────────────────────────────────── 契约运行时校验（纯函数，无 IO，可单测）
// 背景：改前只做 JSON.parse，payload.blocks 只要是数组就原样 return。元素缺 type/markdown 也会一路
// 走到 bySection，被静默切成垃圾 chunk 入库（gate 判空才可能拦）。这里把契约错误在入口挡死。
// 契约单一事实源：contracts/doc-profile.schema.json 的 $defs.Blocks / $defs.ParseDiag。

const BLOCK_TYPES = ['heading', 'text', 'table', 'image'] as const
const BLOCK_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_TYPES)

/** 一条校验明细：第几个 block（顶层为 -1）/ 哪个字段 / 说明 / 实际值摘要 */
export interface PyIssue {
	index: number
	field: string
	message: string
	actual: string
}

/** py stdout 契约的规范形态（reject 缺省归一为 null，diag 可缺省） */
export interface PyPayload {
	blocks: Block[]
	reject: string | null
	diag?: ParseDiag
}

export type PyValidation = { ok: true; payload: PyPayload } | { ok: false; issues: PyIssue[] }

/** 实际值摘要：压成单行、截断，避免把整篇 markdown 塞进错误信息 */
function summarize(v: unknown): string {
	if (v === undefined) return 'undefined'
	let s: string
	try {
		s = JSON.stringify(v) ?? String(v)
	} catch {
		s = String(v)
	}
	return s.replace(/\s+/g, ' ').slice(0, 80)
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

interface BlockValidation {
	ok: boolean
	blocks: Block[]
	issues: PyIssue[]
}

/** 校验单个 block；有任一字段非法即返回 null 并登记明细 */
function validateBlock(item: unknown, index: number, out: PyIssue[]): Block | null {
	const local: PyIssue[] = []
	const push = (field: string, message: string, actual: unknown) => local.push({ index, field, message, actual: summarize(actual) })

	if (!isPlainObject(item)) {
		push('$', 'block 必须是对象', item)
		out.push(...local)
		return null
	}
	if (typeof item.type !== 'string' || !BLOCK_TYPE_SET.has(item.type)) push('type', `type 必须是 ${BLOCK_TYPES.join('/')} 之一`, item.type)
	if (typeof item.markdown !== 'string') push('markdown', 'markdown 必须是字符串', item.markdown)
	// level：可选；给了就必须是 1~6 的整数
	if (item.level !== undefined && item.level !== null && (!isInt(item.level) || item.level < 1 || item.level > 6))
		push('level', 'level 必须是 1~6 的整数', item.level)
	// page：可选；给了就必须是 ≥1 的整数
	if (item.page !== undefined && item.page !== null && (!isInt(item.page) || item.page < 1)) push('page', 'page 必须是 ≥1 的整数', item.page)
	// bbox：可选；给了就必须 [x0,y0,x1,y1]，全为有限 number 且 x1≥x0、y1≥y0
	const bb = item.bbox
	if (bb !== undefined && bb !== null) {
		if (!Array.isArray(bb) || bb.length !== 4 || !bb.every(n => typeof n === 'number' && Number.isFinite(n)))
			push('bbox', 'bbox 必须是长度 4 的 number 数组', bb)
		else if (bb[2]! < bb[0]! || bb[3]! < bb[1]!) push('bbox', 'bbox 必须满足 x1≥x0 且 y1≥y0', bb)
	}
	// html：可选；给了就必须是字符串（schema $defs.Blocks 声明）
	if (item.html !== undefined && item.html !== null && typeof item.html !== 'string') push('html', 'html 必须是字符串', item.html)

	if (local.length) {
		out.push(...local)
		return null
	}
	return item as unknown as Block
}

/**
 * 校验 blocks 数组。**全量通过才返回 blocks**——有任一坏块即整体失败，
 * 绝不过滤坏块继续跑（那正是"结构合法但缺字段"的块被静默入库的成因）。
 */
export function validateBlocks(raw: unknown): BlockValidation {
	if (!Array.isArray(raw)) {
		return { ok: false, blocks: [], issues: [{ index: -1, field: 'blocks', message: 'blocks 必须是数组', actual: summarize(raw) }] }
	}
	const issues: PyIssue[] = []
	const blocks: Block[] = []
	raw.forEach((item, i) => {
		const b = validateBlock(item, i, issues)
		if (b) blocks.push(b)
	})
	return issues.length ? { ok: false, blocks: [], issues } : { ok: true, blocks, issues }
}

/** diag 的计数字段白名单（与 $defs.ParseDiag 一致）；多一个字段就报错，防"悄悄加字段没人管" */
const DIAG_INT_FIELDS: readonly string[] = [
	'chars', 'pages_total', 'pages_via_vl', 'pages_vl_failed', 'pages_skipped_by_cap', 'pages_empty',
	'images_total', 'images_captioned', 'captions_truncated', 'captions_failed', 'images_over_cap',
	'sheets_total', 'sheets_rejected', 'sheets_truncated',
]

/**
 * 校验 diag（可缺省）。**严格到"多一个字段就报错"**：diag 是给 gate 与台账看的账本，
 * 字段悄悄漂移的后果是"某类降级从此没人统计"，比当场报错贵得多。
 */
export function validateDiag(raw: unknown): { ok: true; diag: ParseDiag } | { ok: false; issues: PyIssue[] } {
	if (!isPlainObject(raw)) {
		return { ok: false, issues: [{ index: -1, field: 'diag', message: 'diag 必须是对象', actual: summarize(raw) }] }
	}
	const issues: PyIssue[] = []
	for (const [k, v] of Object.entries(raw)) {
		if (k === 'extractor') {
			if (typeof v !== 'string' || !v.trim()) issues.push({ index: -1, field: 'diag.extractor', message: 'extractor 必须是非空字符串', actual: summarize(v) })
		} else if (k === 'notes') {
			if (!Array.isArray(v) || v.some(n => typeof n !== 'string'))
				issues.push({ index: -1, field: 'diag.notes', message: 'notes 必须是字符串数组', actual: summarize(v) })
		} else if (DIAG_INT_FIELDS.includes(k)) {
			if (!isInt(v) || (v as number) < 0) issues.push({ index: -1, field: `diag.${k}`, message: `${k} 必须是 ≥0 的整数`, actual: summarize(v) })
		} else {
			issues.push({ index: -1, field: `diag.${k}`, message: '未登记的 diag 字段（先改 contracts/doc-profile.schema.json 与 profile.ts 的 ParseDiag）', actual: summarize(v) })
		}
	}
	if (issues.length) return { ok: false, issues }
	const d = raw as unknown as ParseDiag
	if (typeof d.extractor !== 'string' || !isInt(d.chars))
		issues.push({ index: -1, field: 'diag', message: 'diag 必须含 extractor(string) 与 chars(int)', actual: summarize(raw) })
	if (issues.length) return { ok: false, issues }
	return { ok: true, diag: d }
}

/** 校验 parse.py stdout 顶层契约：对象 + blocks(数组) + reject(string|null|undefined) + diag(可缺省) */
export function validatePyPayload(raw: unknown): PyValidation {
	if (!isPlainObject(raw)) {
		return { ok: false, issues: [{ index: -1, field: '$', message: '契约必须是 JSON 对象', actual: summarize(raw) }] }
	}
	const bv = validateBlocks(raw.blocks)
	const issues = [...bv.issues]
	if (raw.reject !== undefined && raw.reject !== null && typeof raw.reject !== 'string')
		issues.push({ index: -1, field: 'reject', message: 'reject 必须是 string | null', actual: summarize(raw.reject) })
	let diag: ParseDiag | undefined
	if (raw.diag !== undefined && raw.diag !== null) {
		const dv = validateDiag(raw.diag)
		if (!dv.ok) issues.push(...dv.issues)
		else diag = dv.diag
	}
	if (issues.length) return { ok: false, issues }
	return { ok: true, payload: { blocks: bv.blocks, reject: (raw.reject as string | null | undefined) ?? null, ...(diag ? { diag } : {}) } }
}

/** 把校验明细压成一行人读文案（进 DocParseFailed.message → 台账 flags） */
export function formatIssues(issues: PyIssue[], cap = 5): string {
	const shown = issues.slice(0, cap).map(it => {
		const at = it.index >= 0 ? `blocks[${it.index}].${it.field}` : it.field
		return `${at} ${it.message}（实际: ${it.actual}）`
	})
	const more = issues.length > cap ? ` …另 ${issues.length - cap} 处` : ''
	return shown.join('；') + more
}

// ─────────────────────────────────────────── spawn 主流程

interface SpawnResult {
	stdout: string
	stderr: string
	exitCode: number | null
	ms: number
}

async function spawnParse(bin: string, file: string, mediaDir: string): Promise<SpawnResult> {
	const t0 = Date.now()
	const proc = spawn({
		cmd: [bin, fileURLToPath(new URL('pytools/parse.py', ROOT)), '--in', file, '--media-dir', mediaDir],
		stdout: 'pipe',
		stderr: 'pipe',
	})
	// 超时兜底分两级：先 SIGTERM，宽限 5s 仍不退则 SIGKILL。
	// 只发一次 SIGTERM 是不够的 —— python 侧若派生了孙进程、或进程处于不可中断状态，信号会被忽略，
	// 而 `await proc.exited` 与管道读取会**永不落地**：ingestDir 是顺序循环，后面所有文件跟着一起挂死，
	// 且不产生任何台账（连"卡在哪一份"都查不到）。
	const HARD_KILL_GRACE_MS = 5_000
	let hardKill: ReturnType<typeof setTimeout> | undefined
	const timer = setTimeout(() => {
		try { proc.kill() } catch { /* 已退出 */ }
		hardKill = setTimeout(() => { try { proc.kill(9) } catch { /* 已退出 */ } }, HARD_KILL_GRACE_MS)
	}, TIMEOUT_MS)
	let stdout = ''
	let stderr = ''
	try {
		const done = (async () => {
			;[stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			])
			await proc.exited
		})()
		// 最后一道闸：即便 SIGKILL 之后管道仍未关闭（孙进程持有写端），也必须返回。
		// 赢家是 guard 时 stdout/stderr 为空 → 契约解析失败 → 走 fallback/隔离，比整条 ingest 停死好得多。
		const guard = new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS + HARD_KILL_GRACE_MS + 10_000))
		await Promise.race([done, guard])
	} finally {
		clearTimeout(timer)
		if (hardKill) clearTimeout(hardKill)
	}
	return { stdout, stderr, exitCode: proc.exitCode, ms: Date.now() - t0 }
}

export async function fromPy(file: string): Promise<ParsedDoc> {
	// 图转文的落盘位：resources/<docId>/media —— docId 走 identity.ts 的唯一口径
	// （改前是"文件名去扩展名"的老口径，与台账里的 doc_id 已经不是一回事，media 目录会散成一堆对不上号的目录）
	const mediaDir = fileURLToPath(new URL(`resources/${docDirName(docIdOf(file))}/media`, ROOT))
	const candidates = cachedBin ? [cachedBin, ...pythonCandidates().filter(b => b !== cachedBin)] : pythonCandidates()
	const failures: string[] = []

	for (const [i, bin] of candidates.entries()) {
		const { stdout, stderr, exitCode, ms } = await spawnParse(bin, file, mediaDir)
		if (stderr.trim()) for (const line of stderr.trim().split('\n')) console.log(`  [py] ${line}`)

		// 契约：stdout 最后一行 JSON；非零退出且没契约 → 环境级失败（解释器选错/依赖没装）
		const lastLine = stdout.trim().split('\n').pop() ?? ''
		let raw: unknown
		try {
			raw = JSON.parse(lastLine)
		} catch {
			failures.push(`${bin}: 无契约输出（exit=${exitCode}，${ms}ms）`)
			// 只在"失败得很快"且还有候选时才换解释器：真在干活的长解析不许乘 N
			if (i < candidates.length - 1 && ms < SWITCH_FAST_MS) {
				console.warn(`[fromPy] 解释器 ${bin} 未能解析（${ms}ms，无契约输出），换下一个候选试试`)
				continue
			}
			throw new DocParseFailed(
				`parse.py 无契约输出（解释器=${bin}，exit=${exitCode}）。检查该解释器是否装了 pytools/requirements.txt，` +
				`或用 PYTHON_BIN 指定解释器。${failures.length > 1 ? `已试: ${failures.join('；')}` : ''}`,
				false, bin,
			)
		}

		// 吐了 JSON 但结构非法 = 契约 bug（不是环境故障）→ DocParseFailed(contract)，上抛落 failed，不许静默降级
		const check = validatePyPayload(raw)
		if (!check.ok) {
			throw new DocParseFailed(`parse.py 契约结构非法（解释器=${bin}，exit=${exitCode}）：${formatIssues(check.issues)}`, true, bin)
		}

		const { blocks, reject, diag } = check.payload
		if (reject) throw new DocReject(reject)
		if (exitCode !== 0 && !blocks.length) {
			// 吐了合法契约但零块且非零退出：环境级失败（如 markitdown 缺失时 docx 会走到这），允许换解释器
			failures.push(`${bin}: exit=${exitCode} 且无块产出`)
			if (i < candidates.length - 1 && ms < SWITCH_FAST_MS) continue
			throw new DocParseFailed(`parse.py exit=${exitCode} 且无块产出（解释器=${bin}）`, false, bin)
		}
		cachedBin = bin
		if (i > 0) {
			// 换过解释器 = 一次真实的降级事实，必须留在账上（否则"py 到底用哪个解释器跑的"永远说不清）
			if (diag) diag.notes = [...(diag.notes ?? []), `解释器降级：${candidates[0]} 不可用，实际使用 ${bin}`]
			console.warn(`[fromPy] 使用解释器 ${bin}（首选 ${candidates[0]} 不可用）`)
		}
		return { blocks, ...(diag ? { diag } : {}) }
	}
	throw new DocParseFailed(`所有候选解释器都无法解析：${failures.join('；')}（可用 PYTHON_BIN 指定）`)
}
