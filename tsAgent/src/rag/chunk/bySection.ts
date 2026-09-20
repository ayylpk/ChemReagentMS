// ⑦ 切块：Block[] → Chunk[]。**切法全部委托给 recursive.ts 的通用引擎**，本文件只做三件事：
//   ① 拍平：把 Block[] 变成"帧（标题栈）+ 片（文本/表格/图注）"
//   ② 定帧：标题只更新帧（它不产出内容），帧是"允许被合并的范围"，**不参与切点决策**
//   ③ 拼锚：文档标识 + 标识符 + 完整标题路径，最后一步才拼到正文前
// 锚规则（上次稀疏空枪的根治）：每块文本头部拼 "文档标题（CAS xxx）｜完整标题路径"，
// 让 CAS/试剂名/各级分节名这些精确 token 真实存在于 chunk 正文里 —— toSparse 才有靶可打
// 红线（与 profile.ts 的 Chunk 注释同款）：text 只由 ①源块原文 ②重叠前缀 ③上述锚 ④表续接标记 拼成，
//   任何位置都不许掺 LLM 生成内容，也不许改写来源原文
import type { Block, Chunk, TablePart } from '../inspect/profile'
import { badCasIn } from '../gate/quality'
import { docIdOf } from '../inspect/identity' // doc_id 唯一来源；本文件不许再自己拼
import { MAX_TABLE_CHARS } from './params'
import { MIN_CHUNK, isSameFact, prepareText, splitPrepared, type CutOptions, type Piece } from './recursive'

export { MAX_TABLE_CHARS } // 兼容旧 import 路径（口径本体在 params.ts）

const LLM_SUMMARY_ENABLED = false // 开了也只准写 summary（召回用），正文一个字不许动 —— 写入侧红线

/** md 表格分隔行：|---|---| / |:--|--:| */
const MD_TABLE_SEP = /^\|[\s:|-]+\|?$/
/** 续接标记模板：固定文案，非 LLM 生成；放在表头之前的独立行，绝不塞进表格内部 */
const contMark = (i: number, total: number) => `（表续 ${i}/${total}）`

export interface TableSplit {
	parts: string[]
	oversizedRow: boolean // 单片里出现超过 maxChars 的单行（行原子，未再切）
}

/**
 * 按"行边界"拆 md 表：每片 = 表头行 + 分隔行 + 若干完整数据行。
 * 返回 null = 不可安全拆（调用方整块保留并记 flag，宁可大也不瞎切）。
 * 硬约束：绝不把一行切成两半；绝不丢分隔行（丢了 md 表就塌成普通文本，列关系全废）。
 */
export function splitMdTable(md: string, maxChars: number = MAX_TABLE_CHARS): TableSplit | null {
	const lines = md.split('\n')
	const first = lines.findIndex(l => l.trim().startsWith('|'))
	if (first < 0) return null                                   // 不是 md 表
	let last = first
	while (last + 1 < lines.length && lines[last + 1]!.trim().startsWith('|')) last++
	const prefix = lines.slice(0, first)                          // 表前标题行（如"表1 成分"）
	const suffix = lines.slice(last + 1)                          // 表后残留行
	const tableLines = lines.slice(first, last + 1)

	const header = tableLines[0]!
	const sep = tableLines[1] !== undefined && MD_TABLE_SEP.test(tableLines[1]!.trim()) ? tableLines[1]! : null
	if (!sep) return null                                        // 没有分隔行：结构已不完整，不拆
	const rows = tableLines.slice(2)
	const head = `${header}\n${sep}`
	if (head.length + 1 > maxChars) return null                  // 表头自身就超阈值，重复表头无意义
	if (rows.length < 2) return null                             // 拆出来只会是一片，没必要动

	const parts: string[][] = []
	let cur: string[] = []
	let curLen = head.length + 1
	let oversizedRow = false
	for (const r of rows) {
		const rl = r.length + 1
		if (rl > maxChars) oversizedRow = true                   // 单行超长：只能整行带走
		if (cur.length && curLen + rl > maxChars) { parts.push(cur); cur = []; curLen = head.length + 1 }
		cur.push(r)
		curLen += rl
	}
	if (cur.length) parts.push(cur)
	if (parts.length < 2) return null

	const total = parts.length
	return {
		parts: parts.map((p, i) => [
			...(i === 0 ? prefix : []),                            // 表标题只跟第一片，免得重复 N 遍
			...(i === 0 ? [] : [contMark(i + 1, total)]),         // 续接标记：独立行，不进表格
			head,                                                  // 每片都重复表头 + 分隔行
			...p,
			...(i === total - 1 ? suffix : []),
		].join('\n')),
		oversizedRow,
	}
}

interface HeadingFrame { level: number; text: string }

/** 标题文字归一：去掉防御性的 markdown # 前缀与首尾空白（py/docx 产的 heading 本就不带 #） */
const headText = (b: Block) => b.markdown.replace(/^#+\s*/, '').trim()

/**
 * 标题栈：维护"从最顶层标题到当前叶节点"的完整路径。
 * level 缺失时的确定性规则（按优先级，注释即契约）：
 *   ① 块自带 b.level（pytools/fromDocx 都给）
 *   ② markdown 前导 # 的个数
 *   ③ 兜底 1（当作顶层标题：不出栈里已有内容，只把自己压上去 → 路径 = [自己]）
 * 重复/同名标题（两节都叫"其他信息"）不做去重：栈里是两个独立帧，路径照样完整、不丢层级。
 */
function pushHeading(stack: HeadingFrame[], b: Block): void {
	const hashLevel = b.markdown.match(/^#+/)?.[0].length
	const level = b.level && b.level > 0 ? b.level : (hashLevel ?? 1)
	while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop() // 同级或更深 → 回退
	stack.push({ level, text: headText(b) })
}

export interface BySectionOptions {
	/** 透传给引擎（测试用：`{ min: 0 }` 可关掉打包，看帧逻辑本身） */
	cut?: CutOptions
	/**
	 * 帧边界即切块边界（一节一块，= 9/16 之前的行为）。
	 * 默认 false：跨节打包到 MIN —— ICSC 那种每节 70 字的语料，按帧切会把每节切成一个碎块（实测 p50=109）。
	 * 打开它的代价：块小、锚占比高（向量被锚词主导）；好处：section 精确、一块一节、过滤零歧义。
	 * 两种模式的实测分布都在 README 里，选哪种由语料形态定，不由代码替它拍板。
	 */
	perFrameBoundary?: boolean
}

/** 两段说的是不是同一件事（与引擎内行去重同一判据） */
const sameFact = isSameFact

/** 路径数组的最深公共前缀（合并片用；单路径原样返回） */
function commonPrefix(paths: readonly (readonly string[])[]): string[] {
	if (!paths.length) return []
	const first = paths[0]!
	let n = first.length
	for (const p of paths.slice(1)) {
		let i = 0
		while (i < n && i < p.length && p[i] === first[i]) i++
		n = i
	}
	return first.slice(0, n)
}

export function bySection(file: string, blocks: Block[], options: BySectionOptions = {}): Chunk[] {
	const cutOpts = options.cut ?? {}
	const docId = docIdOf(file)
	const firstHeading = blocks.find(b => b.type === 'heading')
	const title = (firstHeading ? headText(firstHeading) : '') || docId
	// CAS 锚：全文恰好一种有效编号且标题里没写过，才补进锚（防"标题自带+再拼一遍"双份）
	const body = blocks.map(b => b.markdown).join('\n')
	const allCas = [...new Set(body.match(/(?<![\d-])\d{2,7}-\d{2}-\d(?![\d-])/g) ?? [])] // 边界断言，与 gate/upsert 三处口径统一
		.filter(c => !badCasIn(body).includes(c))
	const casTag = allCas.length === 1 && !title.includes(allCas[0]!) ? `（CAS ${allCas[0]}）` : ''
	const anchor = `${title}${casTag}`

	const chunks: Chunk[] = []
	const stack: HeadingFrame[] = [] // 标题栈 = 完整 headingPath 的唯一来源
	let seq = 0

	/** 锚 + 标题路径：顶层与文档标题重复就不重复拼（防锚三连击）；路径只由真实标题文字拼成 */
	const anchorFor = (path: readonly string[]): string => {
		const tail = path.filter((h, i) => !(i === 0 && h === title))
		return `${anchor}${tail.length ? `｜${tail.join(' > ')}` : ''}`
	}
	const buildAnchor = (): string => anchorFor(stack.map(f => f.text))

	type Extra = {
		page?: number; bbox?: number[]; tableId?: string; tablePart?: TablePart
		flags?: string[]; overlapChars?: number; headingPath?: string[]; sections?: string[]
	}
	const makeChunk = (text: string, extra: Extra): Chunk => {
		const path = extra.headingPath ?? stack.map(f => f.text)
		return {
			docId, seq: seq++, section: path[path.length - 1] || undefined, headingPath: path,
			page: extra.page, bbox: extra.bbox,
			...(extra.sections?.length ? { sections: extra.sections } : {}),
			...(extra.tableId ? { tableId: extra.tableId } : {}),
			...(extra.tablePart ? { tablePart: extra.tablePart } : {}),
			...(extra.flags?.length ? { flags: extra.flags } : {}),
			...(extra.overlapChars ? { overlapChars: extra.overlapChars } : {}),
			text,
		}
	}

	/** 片级告警：只记"切法值得看一眼"的情形，正常片一个字都不加（免得台账被噪声淹没） */
	const pieceFlags = (p: Piece, coveredSections: readonly string[]): string[] => {
		const f: string[] = []
		if (p.overlapChars) f.push(`[overlap] 头部 ${p.overlapChars} 字为上一块的上下文（按比例重叠，非本片原文）`)
		if (p.cut === 'hard') f.push('[cut] 无自然边界可依，按 MAX 硬切（该片可能截断句子）')
		if (p.mergedFrom > 1) f.push(`[merge] 由 ${p.mergedFrom} 个初切片合并（下限 ${MIN_CHUNK} 字）`)
		if (coveredSections.length > 1) f.push(`[cross_section] 本片横跨 ${coveredSections.length} 个分节：${coveredSections.join(' / ')}`)
		if (p.belowMin) f.push(`[below_min] 本片仅 ${p.text.length} 字（不足下限 ${MIN_CHUNK}）：短节/帧尾/单片超长所致，不是切法错误`)
		return f
	}

	/**
	 * 累积缓冲：**遇到标题不再 flush**（9/16 修）—— ICSC 每节才 70 字，按帧切会把每节切成一个碎块，
	 * 实测 p50 卡在 109 字不动。现在按"整篇连续正文"切，切完再回填每一片**覆盖了哪些帧**：
	 *   heading_path = 覆盖帧标题路径的最深公共前缀（单帧时就是原路径，语义不变）
	 *   section      = 该前缀的叶子（合并片 → 公共祖先，**不编造**）
	 *   sections     = 覆盖到的各叶子节名（读侧 section 过滤靠它保住精度，见 query.ts）
	 * 结构边界（表格/图注）仍然 flush：那里不是连续原文，不该被并进文本块。
	 */
	type Seg = { text: string; path: string[] }
	let segs: Seg[] = []
	const flush = (): void => {
		if (!segs.length) return
		const input = segs
		segs = []

		// 清洗：**逐段**归一 + 去重（逐段做是为了保住"偏移 → 帧"的映射精确），再丢掉整段重复
		const kept: Seg[] = []
		let dropped = 0
		for (const s of input) {
			const prepared = prepareText(s.text)
			dropped += prepared.dropped
			if (!prepared.text) continue
			const prev = kept[kept.length - 1]
			if (prev && sameFact(prev.text, prepared.text)) { dropped++; continue }
			kept.push({ text: prepared.text, path: s.path })
		}
		if (!kept.length) return

		const joined = kept.map(k => k.text).join('\n\n')
		const starts: number[] = []
		let off = 0
		for (const k of kept) { starts.push(off); off += k.text.length + 2 }

		const pieces = splitPrepared(joined, cutOpts)
		const droppedNote = dropped ? [`[dedup] 相邻重复行去重 ${dropped} 行/段（同内容两形态，只留信息量大的一条）`] : []
		let cursor = 0
		for (const p of pieces) {
			// 定位本片在 joined 里的位置：片是按序连续切出的，**本片新内容的起点就是上一片的终点**，推进游标即可。
			// ⚠️ 曾经用 `joined.indexOf(body, cursor)` 反查：合并片（recursive 的 mergeToMin）用 '\n' 拼、
			//    而 joined 用 '\n\n' 拼，被合并过的片文本根本不是 joined 的子串 → indexOf 恒为 -1 →
			//    定位退化成"拿上一片终点顶着"的猜测，偏移随合并次数累积，section / headingPath 会归属到相邻分节。
			const body = p.overlapChars ? p.text.slice(p.overlapChars) : p.text
			const idx = cursor
			const end = idx + body.length
			cursor = end
			const covered = kept.filter((k, i) => starts[i]! < end && starts[i]! + k.text.length > idx)
			const path = commonPrefix(covered.map(c => c.path))
			const sections = [...new Set(covered.map(c => c.path[c.path.length - 1]).filter((s): s is string => !!s))]
			chunks.push(makeChunk(`${anchorFor(path)}\n${p.text}`, {
				flags: [...droppedNote, ...pieceFlags(p, sections)],
				overlapChars: p.overlapChars,
				headingPath: path,
				sections,
			}))
		}
	}

	/** 表格专用出口：绝不复用文本切法（它会按换行/标点切，把表结构切烂）*/
	const emitTable = (b: Block, blockIndex: number, page?: number, bbox?: number[]) => {
		const tableId = `${docId}#${blockIndex}` // 来源 block 的稳定标识：同文档同块序 → 同 id
		const md = b.markdown
		const complex = !!b.html?.trim() // html 原文存在 = 合并单元格等复杂表（fromDocx 才产），md 只是降级视图
		const flags: string[] = []
		let parts: string[] = [md]
		if (md.length > MAX_TABLE_CHARS) {
			if (complex) {
				flags.push(`[table] 复杂表（含合并单元格）${md.length} 字符超 ${MAX_TABLE_CHARS}，整块保留未拆`)
			} else {
				const split = splitMdTable(md, MAX_TABLE_CHARS)
				if (split) {
					parts = split.parts
					if (split.oversizedRow) flags.push(`[table] 存在超长单行（行原子，未再切）`)
				} else {
					flags.push(`[table] 无规范表头/分隔行（或表头自身超限），整块保留未拆`)
				}
			}
		}
		const total = parts.length
		for (const [i, p] of parts.entries()) {
			// 表格用换行而不是空格接锚：锚独占一行，表格本身保持合法 md（表头行必须在行首，别被锚挤在同行）
			chunks.push(makeChunk(p.startsWith(anchor) ? p : `${buildAnchor()}\n${p}`, {
				page, bbox, tableId, tablePart: { index: i + 1, total }, flags,
			}))
		}
	}

	for (const [i, b] of blocks.entries()) {
		switch (b.type) {
			case 'heading':
				// 默认**不 flush**：标题只更新帧栈，正文继续攒（跨节打包才能到 MIN，见 flush 注释）。
				//   帧信息在 push 时快照进 seg，后续栈怎么变都不影响已入队的段。
				// perFrameBoundary=true 时回到"一节一块"（结构严谨的语料可能会选它）。
				if (options.perFrameBoundary) flush()
				pushHeading(stack, b) // 标题本身不单独成块，它活在后续块的 section/headingPath/锚里
				break
			case 'text':
				segs.push({ text: b.markdown, path: stack.map(f => f.text) })
				break
			case 'table': // 表格：阈值内原子；超阈值按行边界拆（表头/分隔行逐片重复，行绝不切两半）
				flush() // 表格不是连续正文，边界即切块边界
				emitTable(b, i, b.page, b.bbox)
				break
			case 'image': // 图片块：caption 文本（VL 产的"一句描述"）有内容才入库；独立成块，不合并不重叠
				flush()
				if (b.markdown.trim()) {
					chunks.push(makeChunk(`${buildAnchor()}\n${b.markdown.trim()}`, { page: b.page, bbox: b.bbox }))
				}
				break
		}
	}
	flush()

	if (LLM_SUMMARY_ENABLED) {
		// TODO(M3)：逐块调 LLM 生成一句话摘要 → ch.summary（只喂 embedding 召回，答案仍回原文）
	}
	return chunks
}
