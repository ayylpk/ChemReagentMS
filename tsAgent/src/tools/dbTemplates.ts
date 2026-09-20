// 路1 结构化查询的"模板白名单"：db 路的全部 SQL 文本只能长在这一个文件里
// 纪律：必须是 SELECT + LIMIT + 参数化 —— 模型/用户的话永远只落在 ? 绑定值上
// （Java 类比：MyBatis 的 #{} 预编译；${} 字符串拼接在这里等于零容忍事故）
import { queryReadOnly } from '../db/mysql'

export interface SqlParam { name: string; desc: string; required?: boolean }
export interface SqlTemplate {
	desc: string
	params: SqlParam[]
	sql: string
	/** params → SQL 占位符数组：一个参数喂多个 ? 也在这里编排 */
	bind: (p: Record<string, string>) => unknown[]
}

const MAX_ROWS = 50 // 结果裁剪：喂 LLM 的表不能无限长

export const TEMPLATES: Record<string, SqlTemplate> = {
	stock_by_name: {
		desc: '按试剂名称或CAS号查现有批次库存（数量/存放位置/效期/单价）',
		params: [{ name: 'name', desc: '试剂名称或CAS号，支持模糊，如"乙醇"或"64-17-5"', required: true }],
		sql: `SELECT r.name AS 名称, r.cas_number AS CAS, r.specification AS 规格,
					b.batch_number AS 批号, b.current_quantity AS 现存数量, r.unit AS 单位,
					b.storage_location AS 存放位置, b.expiry_date AS 有效期至, b.unit_price AS 单价
			FROM reagent r JOIN reagent_batch b ON b.reagent_id = r.id
			WHERE r.name LIKE CONCAT('%', ?, '%') OR r.cas_number LIKE CONCAT('%', ?, '%')
			ORDER BY (b.expiry_date IS NULL), b.expiry_date LIMIT ${MAX_ROWS}`,
		bind: (p) => [p.name, p.name], // 一个值喂两个 ?
	},
	expiring_soon: {
		desc: 'N 天内到期且还有剩余数量的批次（默认 30 天），按到期日升序',
		params: [{ name: 'days', desc: '天数，整数，1~3650，缺省 30' }],
		sql: `SELECT r.name AS 名称, r.cas_number AS CAS, b.batch_number AS 批号,
					b.current_quantity AS 现存数量, b.expiry_date AS 到期日, b.storage_location AS 存放位置
			FROM reagent_batch b JOIN reagent r ON r.id = b.reagent_id
			WHERE b.expiry_date IS NOT NULL AND b.current_quantity > 0
			  AND b.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
			ORDER BY b.expiry_date LIMIT ${MAX_ROWS}`,
		bind: (p) => [clampDays(p.days)],
	},
	low_stock: {
		desc: '现存总量跌破安全库存线的试剂（库存预警清单）',
		params: [],
		sql: `SELECT r.name AS 名称, r.cas_number AS CAS, r.safety_stock_threshold AS 安全线,
					SUM(b.current_quantity) AS 现存合计, r.unit AS 单位
			FROM reagent r JOIN reagent_batch b ON b.reagent_id = r.id
			WHERE r.safety_stock_threshold IS NOT NULL
			GROUP BY r.id HAVING SUM(b.current_quantity) < r.safety_stock_threshold
			ORDER BY 现存合计 LIMIT ${MAX_ROWS}`,
		bind: () => [],
	},
}

/** days 这类数字参数进 SQL 前必须验形：非数字/超界直接拒（纵深防御，虽然 ? 绑定本身已免疫注入） */
function clampDays(raw?: string): number {
	const n = Number(raw ?? 30)
	if (!Number.isInteger(n) || n < 1 || n > 3650) return 30
	return n
}

/** 抽参节点的提示词素材：模板目录（名称+用途+参数），让 LLM 只在白名单里选 */
export function renderCatalog(): string {
	return Object.entries(TEMPLATES)
		.map(([k, t]) => `- ${k}：${t.desc}${t.params.length ? `（参数: ${t.params.map((p) => `${p.name}${p.required ? '·必填' : ''}: ${p.desc}`).join('; ')}）` : '（无参数）'}`)
		.join('\n')
}

/**
 * 「查询未能执行」的统一前缀。
 * 调用方（agent/graph.ts）据此把**故障**与**空结果**分开 —— 两者对用户是完全不同的结论：
 *   "未检索到相关内容" = 库里没有；"查询未能执行" = 系统坏了、稍后重试可能就有。
 * 把故障当空结果，等于把系统故障读成业务结论。
 */
export const DB_FAIL_PREFIX = '⚠️查询未能执行（系统故障，不是"没有数据"）：'

/** 执行入口：校验→参数化执行→markdown 表。返回文本永远是人话（错误也当数据回，不抛异常打断图） */
export async function runTemplate(sqlName: string, params: Record<string, string> = {}): Promise<string> {
	// 必须走自有属性判断：TEMPLATES 是普通对象，sql_name 传 'constructor'/'toString'/'__proto__' 时
	// 会命中 Object 原型成员（truthy，绕过 !tpl 判断），随后 tpl.params 为 undefined → for...of 抛 TypeError，
	// 而该异常会被上层吞成"查询未命中"（不可观测）。用 hasOwnProperty 挡掉。
	const tpl = Object.prototype.hasOwnProperty.call(TEMPLATES, sqlName) ? TEMPLATES[sqlName] : undefined
	if (!tpl) return `未知模板 "${sqlName}"。可用：${Object.keys(TEMPLATES).join(' / ')}`
	for (const p of tpl.params) {
		if (p.required && !params[p.name]?.trim()) return `模板 ${sqlName} 缺必填参数 ${p.name}（${p.desc}）`
	}
	let rows: Record<string, unknown>[]
	try {
		rows = await queryReadOnly<Record<string, unknown>>(tpl.sql, tpl.bind(params))
	} catch (e) {
		// 必须带 DB_FAIL_PREFIX：上层据此判定这是**故障**而不是"没查到"
		return `${DB_FAIL_PREFIX}${(e as Error).message.slice(0, 150)}`
	}
	if (!rows.length) return `模板 ${sqlName} 查询结果为空（条件可能太窄，试试放宽）`
	const cols = Object.keys(rows[0]!)
	const cell = (v: unknown) => {
		if (v instanceof Date) return v.toISOString().slice(0, 10)
		return String(v ?? '').replace(/\|/g, '¦')
	}
	return [
		`| ${cols.join(' | ')} |`,
		`|${cols.map(() => '---').join('|')}|`,
		...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(' | ')} |`),
	].join('\n') + (rows.length >= MAX_ROWS ? `\n（已截断于 ${MAX_ROWS} 行）` : '')
}
