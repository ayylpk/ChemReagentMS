// ③ 前门·三层探测：产出 DocProfile —— 文件是什么、有什么病、走哪条路，全部确定性代码，下游 route 只照档案执行
// 9/16 解析泛化第一刀（改前三条硬边界，全部为"不知道会收到什么文档"而改）：
//   ① 魔数表只有 pdf/zip/ole2/jpeg/png 五种 → 扩到 gif/bmp/webp/tiff/heic/rtf/html/xml，并深判 zip 内部结构
//      （docx/xlsx/pptx/odf 四族共用一个 zip 魔数，只看魔数等于把 pptx 当 docx）
//   ② **后缀判定在魔数之前**（`TEXT_FAMILY_EXT` 命中就 return）→ 一个叫 .md 的 PDF 会被当文本读成乱码。
//      现在顺序反过来：内容实判优先，后缀只作"声明"，两者不符记进 notes（既往是静默按后缀走）
//   ③ 认不出来 → L2-review。而 review 无消费者（routes/review.ts 是空壳）＝黑洞。
//      现在多一层**内容嗅探兜底**：字节可解码为文本 → 按文本族收（陌生后缀不再等于拒收）。
// ⚠️ 仍未做（档案里如实标 unknown/0，不许瞎猜）：PDF 双栏间隙直方图、线框密度 → 下期
import { unzipSync } from 'fflate'
import type { DocProfile, DocxProbe, Strategy } from '../inspect/profile'
import { GARBLED_RE } from '../gate/quality'
import { TEXT_FAMILY_EXT, convertRequiredReason, extOf, familyOfExt } from '../parse/formats'
import { loadPdf, pagePlainText } from '../parse/fromPdf'

/** 探测取样字节数：够看清所有魔数与"这段是不是文本"，又不至于把 50MB 文件读进内存 */
const HEAD_BYTES = 512
/** 内容嗅探的容忍线：替换符/控制符占比超过它就不当文本（二进制里的偶然 ASCII 段不算文本） */
const SNIFF_TEXT_MAX_BAD = 0.02

type MagicKind =
	| 'ole2' | 'pdf' | 'zip' | 'jpeg' | 'png' | 'gif' | 'bmp' | 'webp' | 'tiff' | 'heic'
	| 'rtf' | 'html' | 'xml' | 'unknown'

const hex = (head: Uint8Array, n = 8): string =>
	[...head.slice(0, n)].map(b => b.toString(16).padStart(2, '0')).join('') // ⚠️ 必须无空格拼接（带空格则 startsWith 全灭）
const ascii = (head: Uint8Array, start: number, len: number): string =>
	new TextDecoder('latin1').decode(head.slice(start, start + len))

/**
 * 魔数判定（纯函数，可单测）。表驱动：加格式只加一行，别再往 if 链里塞。
 * BMP 特殊：'BM' 只有 2 字节，正文以 "BM" 开头的文本会误判 → 额外要求"保留字段 4 字节为 0"。
 * HEIC 特殊：ftyp box 的 brand 在第 8 字节起（heic/heix/mif1/msf1）——认出来是为了给"请转存 jpg"的理由，不是为解析。
 */
export function MAGIC(head: Uint8Array): MagicKind {
	const h = hex(head, 16)
	if (h.startsWith('d0cf11e0')) return 'ole2' // 老 doc/xls/ppt/msg 都住这
	if (h.startsWith('25504446')) return 'pdf' // %PDF
	if (h.startsWith('504b0304') || h.startsWith('504b0506') || h.startsWith('504b0708')) return 'zip' // ooxml/odf/zip
	if (h.startsWith('ffd8ff')) return 'jpeg'
	if (h.startsWith('89504e47')) return 'png'
	if (h.startsWith('474946383')) return 'gif' // GIF87a/GIF89a
	if (h.startsWith('424d') && head.length >= 10 && hex(head.slice(6, 10)) === '00000000') return 'bmp'
	if (h.startsWith('52494646') && ascii(head, 8, 4) === 'WEBP') return 'webp' // RIFF....WEBP
	if (h.startsWith('49492a00') || h.startsWith('4d4d002a')) return 'tiff'
	if (ascii(head, 4, 4) === 'ftyp' && ['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(ascii(head, 8, 4))) return 'heic'
	if (h.startsWith('7b5c7274')) return 'rtf' // {\rt
	const prog = ascii(head, 0, 14).toLowerCase().replace(/^\uFEFF/, '').trimStart()
	if (prog.startsWith('<!doctype html') || prog.startsWith('<html')) return 'html'
	if (prog.startsWith('<?xml')) return 'xml'
	return 'unknown'
}

/** 内容嗅探：这段字节像不像可解码文本（陌生后缀的兜底判据，也是"后缀与内容不符"的仲裁者） */
export function looksLikeText(head: Uint8Array): boolean {
	if (!head.length) return false
	// BOM 直接认（UTF-16/UTF-32 的字节里控制符一堆，逐字符统计会误判成二进制）
	if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return true
	// 替换符数：UTF-8 解不开的字节会变成 U+FFFD；控制符（除 \t\n\r\f\v）在真文本里几乎为零（NUL 必杀）
	// NUL（0x00）在真文本里不存在：单个即判二进制，直接短路返回。
	// 旧写法是 `for (const b of head) if (b === 0) bad += 2` 参与比例计算，而分母是 512 字节——
	// 一个 NUL 只贡献 2/512，远低于阈值，于是注释里"单个就足以说明是二进制"与实现正好相反：
	// 含 1~3 个 NUL 的损坏/二进制文件仍被判成文本族，一路走 py 直读。
	if (head.includes(0)) return false
	let bad = 0
	const decoded = new TextDecoder('utf-8', { fatal: false }).decode(head)
	for (const ch of decoded) {
		const c = ch.codePointAt(0)!
		if (c === 0xfffd) bad++
		else if (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 11) bad++
	}
	return bad / decoded.length <= SNIFF_TEXT_MAX_BAD
}

const tagCount = (xml: string, tag: string): number =>
	(xml.match(new RegExp(`<${tag}[ />]`, 'g')) ?? []).length

/** docx 结构探测：解 zip 读 document.xml 数标签（双栏只记录不处理——逻辑流完好） */
function probeDocx(xml: string): DocxProbe {
	const cols = [...xml.matchAll(/<w:cols[^>]*w:num="(\d+)"/g)].map(m => Number(m[1]))
	// 排版假表格：单行、≥2 格、整表纯文字 >400 字 —— 典型"表格伪装双栏"
	let layoutTables = 0
	for (const seg of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)) {
		const tbl = seg[0]
		const rows = (tbl.match(/<w:tr[ >]/g) ?? []).length
		const cells = (tbl.match(/<w:tc[ >]/g) ?? []).length
		const chars = tbl.replace(/<[^>]+>/g, '').length
		if (rows === 1 && cells >= 2 && chars > 400) layoutTables++
	}
	// 浮动文本框：内容顺序隐患，文字量达标才算（页眉水印之类忽略）
	const textBoxes = [...xml.matchAll(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g)]
		.filter(seg => seg[0].replace(/<[^>]+>/g, '').length > 50).length
	return {
		columns: cols.length ? Math.max(...cols) : 1,
		tableCount: tagCount(xml, 'w:tbl'),
		layoutTables,
		textBoxes,
		drawingCount: tagCount(xml, 'w:drawing'),
		paraChars: xml.replace(/<[^>]+>/g, '').length,
	}
}

/**
 * zip 解压过滤器：只保留"判家族 + 探测 docx 结构"需要看的条目。
 * 为什么需要它：docx/xlsx 里体积最大的通常就是 word/media、xl/media 下的图片，
 * 全量解压等于把同一份文档在内存里放两份（压缩字节 + 全部条目），几十 MB 的文件在 2C4G 机器上就是 OOM 风险；
 * 而前门只需要**条目名**加 document.xml 的内容。
 * 注意：压缩包本身仍要整读（zip 的中央目录在尾部，非流式解压必须先拿到完整字节），
 * 这里省掉的是"解压后全部条目"的那份副本。
 */
function keepForProbe(f: { name: string }): boolean {
	const n = f.name
	return (
		n === 'word/document.xml' || //                docx：判家族 + 结构探测都靠它
		n === 'ppt/presentation.xml' || //              pptx：判家族
		n === 'content.xml' || //                       odf：判家族（兼兜底）
		n === 'mimetype' || //                          odf：法定第一项
		n === 'META-INF/manifest.xml' || //             odf：判家族
		(n.startsWith('xl/') && n.endsWith('.xml')) //  xlsx：判家族
	)
}

/**
 * zip 深判：四族共用一个魔数，靠内部条目布局区分（mimetype 条目对 odf 是法定第一项）。
 * 返回 null = 认不出结构的普通压缩包（外层按"请解包"处理，不许当 docx 硬啃）。
 */
export function classifyZip(entries: Record<string, unknown>): 'docx' | 'xlsx' | 'pptx' | 'odf' | null {
	const names = Object.keys(entries)
	if (names.includes('word/document.xml')) return 'docx'
	if (names.includes('ppt/presentation.xml')) return 'pptx'
	if (names.some(k => k.startsWith('xl/') && k.endsWith('.xml'))) return 'xlsx'
	// odf：mimetype 法定（application/vnd.oasis.opendocument.*），content.xml 兜底
	if (names.includes('content.xml') && (names.includes('META-INF/manifest.xml') || names.includes('mimetype'))) return 'odf'
	return null
}

/** PDF 轻量探测：页数/文字层有无/页均字数（前 5 页取样）；加密件抛 PasswordException */
async function probePdf(file: string): Promise<DocProfile['pdf']> {
	const doc = await loadPdf(file)
	const sample = Math.min(doc.numPages, 5)
	let chars = 0
	let garbled = 0
	let sampled = 0
	for (let p = 1; p <= sample; p++) {
		const text = await pagePlainText(await doc.getPage(p) as never)
		chars += text.length
		garbled += (text.match(GARBLED_RE) ?? []).length
		if (text.trim()) sampled++
	}
	const charsPerPage = chars / Math.max(sample, 1)
	return {
		hasTextLayer: sampled > 0,
		pages: doc.numPages,
		charsPerPage,
		columns: 'unknown',        // 双栏判定下期：栏间隙直方图在 fromPdf 排期里
		gapConsistentRatio: 0,
		lineDensity: 0,
		garbledRatio: chars ? garbled / chars : 1,
	}
}

/**
 * strategy 推导：全部判定来自档案字段，一条 switch 说清（code-over-tools）。
 * 原则：能解析的一律给能干活的路（L0-py/L1-py-vl）；吃不下的一律给**带人话理由**的 L2-review。
 */
function decide(p: Omit<DocProfile, 'strategy' | 'reason'>): { strategy: Strategy; reason: string } {
	if (p.family === 'convert-required') {
		const why = convertRequiredReason(extOf(p.file)) ?? '该格式无法直接解析'
		return { strategy: 'L2-review', reason: why }
	}
	if (p.family === 'unknown' || p.family === 'legacy-doc')
		return { strategy: 'L2-review', reason: p.family === 'legacy-doc' ? '老 OLE 格式：请转存为 docx/xlsx/pptx 再上传' : '内容与后缀都无法识别（疑似损坏或加密）' }
	if (p.family === 'xlsx')
		return { strategy: 'L0-py', reason: 'sheet 级交 pytools：台账型 sheet 会被拒（转 MySQL），文档型进库' }
	if (p.family === 'text')
		return { strategy: 'L0-py', reason: '纯文本/Markdown：py 直读，md 语法顺带被块化' }
	if (p.family === 'html')
		return { strategy: 'L0-py', reason: 'HTML：py 侧 html.parser 直抽（markitdown 在则优先用）' }
	if (p.family === 'pptx')
		return { strategy: 'L0-py', reason: 'PPTX：py 侧按页抽 slide XML 文本（markitdown 在则优先用）' }
	if (p.family === 'odf')
		return { strategy: 'L0-py', reason: 'OpenDocument：zip 内 content.xml 直抽' }
	if (p.family === 'rtf')
		return { strategy: 'L0-py', reason: 'RTF：控制字剥离后按文本块化' }
	if (p.family === 'image')
		return { strategy: 'L1-py-vl', reason: '图片文档，qwen-vl-ocr 整页解析' }
	if (p.family === 'docx' && p.docx) {
		const d = p.docx
		if (d.textBoxes > 0) return { strategy: 'L1-py-vl', reason: `浮动文本框×${d.textBoxes}，抽取顺序不可信` }
		if (d.drawingCount >= 3 && d.paraChars < d.drawingCount * 200)
			return { strategy: 'L1-py-vl', reason: '图文倒挂（图多字少），按图片文档处理' }
		if (d.layoutTables > 0) return { strategy: 'L0-cell-join', reason: `排版假表格×${d.layoutTables}（py 主力自带表格处理，手写 fallback 才用 cell-join）` }
		return { strategy: 'L0-py', reason: `docx 交 markitdown（分栏=${d.columns} 不影响抽取；手写 mammoth 为备胎）` }
	}
	if (p.family === 'pdf' && p.pdf) {
		const f = p.pdf
		if (!f.hasTextLayer) return { strategy: 'L1-py-vl', reason: '无文字层（扫描件），交给视觉解析' }
		if (f.garbledRatio > 0.02) return { strategy: 'L1-py-vl', reason: `文字层乱码率 ${(f.garbledRatio * 100).toFixed(1)}%，直抽不可信` }
		return { strategy: 'L0-py', reason: `数字版 PDF（${f.pages} 页，页均 ${f.charsPerPage.toFixed(0)} 字）→ pymupdf4llm` }
	}
	return { strategy: 'L2-review', reason: '档案信息不足，宁可人审' }
}

export async function probe(file: string): Promise<DocProfile> {
	const bunFile = Bun.file(file)
	const size = await bunFile.size
	const ext = extOf(file)
	if (!size) {
		const base: Omit<DocProfile, 'strategy' | 'reason'> = { file, family: 'unknown', magic: 'empty(0B)' }
		return { ...base, ...decide(base), notes: ['空文件（0 字节）'] }
	}

	const head = new Uint8Array(await bunFile.slice(0, HEAD_BYTES).arrayBuffer())
	const magic = MAGIC(head)
	const declared = familyOfExt(ext) // 后缀"声明"的家族（可能 undefined）
	const notes: string[] = []
	const base: Omit<DocProfile, 'strategy' | 'reason'> = { file, family: 'unknown', magic }

	// ① 内容实判优先。后缀与内容不符时以**内容**为准并记账 —— 叫 .md 的 PDF 是真会遇到的
	//    （既往顺序是先看后缀直接 return，这种文件会被当文本读成乱码且无人知晓）
	try {
		if (magic === 'zip') {
			// 只解必要条目（见 keepForProbe）：word/media 下的图片不进内存
			const entries = unzipSync(new Uint8Array(await bunFile.arrayBuffer()), { filter: keepForProbe }) as Record<string, unknown>
			const fam = classifyZip(entries)
			if (fam) base.family = fam
			else notes.push('zip 结构不属 docx/xlsx/pptx/odf（疑似普通压缩包）')
			// ★ docx 结构探测必须在这里接上：decide() 里 docx 的三个分支（浮动文本框 / 图文倒挂 / 排版假表格）
			//   全部依赖 profile.docx，而此前**没有任何地方给它赋值** —— 条件恒为假，所有 docx 一路掉到
			//   decide 的兜底分支（L2-review），等于一份都进不了库，且台账里看不出原因。
			if (fam === 'docx') {
				const docXml = entries['word/document.xml']
				if (docXml instanceof Uint8Array) {
					base.docx = probeDocx(new TextDecoder('utf-8').decode(docXml))
				} else {
					// 取不到 document.xml（结构异常）也要给一个空档案，否则又会掉回兜底；
					// 空档案下 decide 会走 docx 的默认路（L0-py），交给 py 侧如实报错。
					notes.push('zip 判为 docx 但取不到 word/document.xml（结构异常），按默认 docx 策略处理')
					base.docx = probeDocx('')
				}
			}
		} else if (magic === 'pdf') {
			base.family = 'pdf'
			base.pdf = await probePdf(file)
		} else if (magic === 'ole2') base.family = 'legacy-doc'
		else if (magic === 'html') base.family = 'html'
		else if (magic === 'rtf') base.family = 'rtf'
		else if (magic === 'xml') base.family = 'text' // 裸 XML 按文本收（保住原文，不擅自解析语义）
		else if (['jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff'].includes(magic)) base.family = 'image'
		else if (magic === 'heic') base.family = 'convert-required'
		else if (TEXT_FAMILY_EXT.has(ext) || looksLikeText(head)) {
			// ② 魔数不认识 → 内容嗅探兜底：可解码为文本就按文本族收（陌生后缀不再是死路）
			//    ⚠️ 只读头部 512 字节，判的是"像不像文本"而不是"整篇都是文本"——代价是极小概率误收二进制，
			//       但误收的后果是"gate 判空/乱码报警 + 台账可见"，比"静默拒收"轻得多。
			base.family = 'text'
			base.magic = `text(${new TextDecoder('utf-8', { fatal: false }).decode(head.slice(0, 12)).replace(/\s+/g, ' ')})`
			if (!TEXT_FAMILY_EXT.has(ext)) notes.push(`扩展名 .${ext || '(无)'} 不在白名单，但内容像纯文本 → 按文本族收`)
		}
	} catch (e) {
		const msg = (e as Error).message ?? String(e)
		if (/password/i.test(msg)) return { ...base, strategy: 'L2-review', reason: '加密 PDF，需口令', notes }
		// zip/PDF 结构损坏：不当场判死，交给 py（它拿到原始文件可以走别的路），这里只记账
		notes.push(`前门探测异常（${msg.slice(0, 80)}）→ 按内容嗅探继续`)
		if (looksLikeText(head)) base.family = 'text'
	}

	// ③ 认不出的后缀若属"认识但吃不下"档 → 明确转存理由（第 2 档，不是 L2 黑洞）
	if (base.family === 'unknown' && convertRequiredReason(ext)) base.family = 'convert-required'

	// ④ 后缀与内容不符：以内容为准，但必须记账（既往是静默按其中一边走）
	if (declared && base.family !== declared)
		notes.push(`后缀 .${ext} 声明为 ${declared}，内容实判为 ${base.family} → 按内容走`)
	else if (!declared && base.family !== 'unknown' && base.family !== 'convert-required')
		notes.push(`后缀 .${ext || '(无)'} 未登记，按内容实判为 ${base.family}`)

	const profile: DocProfile = { ...base, ...decide(base) }
	if (notes.length) profile.notes = notes
	return profile
}
