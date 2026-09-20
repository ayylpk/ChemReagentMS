// 服务端鉴权：校验 Java 后端签发的 JWT + 查 RBAC 权限码
//
// 口径来自实测（不是猜的）：
//   · 前端把 token 放在 **`token` 头**（不是 Authorization: Bearer，见 frontend utils/request.js:15）；
//     这里两个都收 —— 前端照旧，curl 调试方便。
//   · JWT 是 HS256，与 Java 后端**同一个 secret**（compose 里两边都注入 JWT_SECRET_KEY / JWT_SECRET）。
//   · 权限：permission.code = `domain:action`，经 role_permission 查表；
//     **role 0（系统管理员）在 role_permission 里惯例无行 → 按"全通"处理**（写在 02/04 的 SQL 注释里）。
//     ⚠️ 别写成"查不到权限就拒" —— 那会把管理员关在门外。
//
// 零新依赖：用 node:crypto 手写 HS256 校验（Bun 内置），不引 jsonwebtoken。
// 失败姿态：secret 未配置 → 503 并说明原因（**不接受无鉴权开放** —— 人审端点能改知识库内容，
//   缺少 secret 时"开放"比"不可用"危险得多）。
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { pool } from '../db/mysql'
import { config } from '../config/env'

export interface TokenPayload {
	uid?: number
	role?: number
	exp?: number
	[k: string]: unknown
}

const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * HMAC 密钥派生：**必须与 Java 后端同口径**。
 * Java 侧是 `Keys.hmacShaKeyFor(Base64.getDecoder().decode(secretKey))`
 *   （见 backend-.../common/.../utils/JwtUtil.java:18 签发、:31 解析）
 * 即：把配置里的 secret 先 base64 解码成 32 字节，再用作 HMAC 密钥。
 * ⚠️ 曾经直接拿 secret 原串（44 字符）当 key —— 那样 Java 签出的合法 token 在本服务里签名恒不匹配，
 *   表现是"登录成功却永远 401"，且离线单测因为自己签自己验而全绿，抓不到。
 */
const hmacKey = (secret: string): Buffer => Buffer.from(secret, 'base64')

/** 签发（只在测试与本地调试用；生产 token 由 Java 后端签） */
export function signJwt(payload: TokenPayload, secret: string, ttlSeconds = 3600): string {
	const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
	const body = b64url(Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })))
	const sig = b64url(createHmac('sha256', hmacKey(secret)).update(`${header}.${body}`).digest())
	return `${header}.${body}.${sig}`
}

/**
 * 校验并解出 payload；任何一步不对都返回 null（**绝不抛**：调用方只需要"过/不过"）。
 * 检查：三段结构 → header.alg 必须是 HS256（禁 alg=none 这类降级）→ 签名常量时间比较 → exp 未过期。
 */
export function verifyJwt(token: string, secret: string): TokenPayload | null {
	if (!token || !secret) return null
	const parts = token.split('.')
	if (parts.length !== 3) return null
	const [h, p, s] = parts as [string, string, string]
	let header: { alg?: string }
	try {
		header = JSON.parse(b64urlToBuf(h).toString('utf8')) as { alg?: string }
	} catch {
		return null
	}
	if (header.alg !== 'HS256') return null
	const expect = createHmac('sha256', hmacKey(secret)).update(`${h}.${p}`).digest()
	const got = b64urlToBuf(s)
	if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null
	let payload: TokenPayload
	try {
		payload = JSON.parse(b64urlToBuf(p).toString('utf8')) as TokenPayload
	} catch {
		return null
	}
	if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
	return payload
}

/** 从请求里取 token：`token` 头优先（前端口径），其次 Authorization: Bearer */
export function tokenOf(c: Context): string {
	const t = c.req.header('token')?.trim()
	if (t) return t
	const auth = c.req.header('authorization')?.trim() ?? ''
	const m = /^Bearer\s+(.+)$/i.exec(auth)
	return m?.[1]?.trim() ?? ''
}

// ── 权限查询（进程内 60s 缓存：审核页会连点，别每次都打库；权限变更不频繁，60s 足够新鲜） ──
const permCache = new Map<string, { ok: boolean; at: number }>()
const PERM_TTL_MS = 60_000

/** 该角色是否拥有权限码。查库失败按**不放行**处理（安全侧失败），但会 warn —— 不静默 */
export async function roleHasPermission(role: number, code: string): Promise<boolean> {
	if (role === 0) return true // 系统管理员：惯例全通（见 SQL 注释），先于查库
	const key = `${role}:${code}`
	const hit = permCache.get(key)
	if (hit && Date.now() - hit.at < PERM_TTL_MS) return hit.ok
	try {
		const [rows] = (await pool.query(
			`SELECT 1 FROM role_permission rp JOIN permission p ON p.id = rp.permission_id
			  WHERE rp.role = ? AND p.code = ? LIMIT 1`,
			[role, code],
		)) as [unknown[], unknown]
		const ok = rows.length > 0
		permCache.set(key, { ok, at: Date.now() })
		return ok
	} catch (e) {
		console.warn(`[auth] 权限查询失败（按不放行处理）role=${role} code=${code}:`, (e as Error).message.slice(0, 100))
		return false
	}
}

export interface AuthResult {
	ok: boolean
	payload?: TokenPayload
	response?: Response
}

export interface GuardDeps {
	secret: () => string
	hasPermission: (role: number, code: string) => Promise<boolean>
}

/**
 * 守卫工厂（生产用下面的 requirePermission，测试注入假 secret/假权限表 → 三条分支都能离线钉死）。
 * 状态码语义：503 = 服务端没配 secret（不是用户的问题）；401 = 没带/带了假 token；403 = 人来了，缺权限。
 */
export function createGuard(deps: GuardDeps) {
	return async function guard(c: Context, code: string): Promise<AuthResult> {
		const secret = deps.secret()
		if (!secret) {
			return {
				ok: false,
				response: c.json({
					error: '人审端点已关闭：服务端未配置 JWT_SECRET_KEY',
					hint: '在 tsAgent/.env 与部署 .env 里补上 JWT_SECRET_KEY（与 Java 后端同一个值），或走 docker-compose 的 JWT_SECRET 注入',
				}, 503),
			}
		}
		const payload = verifyJwt(tokenOf(c), secret)
		if (!payload) return { ok: false, response: c.json({ error: '未登录或 token 无效/过期（请重新登录）' }, 401) }
		const role = typeof payload.role === 'number' ? payload.role : undefined
		if (role === undefined) return { ok: false, response: c.json({ error: 'token 里没有 role，无法判定权限' }, 403) }
		if (!(await deps.hasPermission(role, code)))
			return { ok: false, response: c.json({ error: `缺少权限：${code}` }, 403) }
		return { ok: true, payload }
	}
}

/** 生产守卫：secret 取配置、权限查 MySQL（role 0 全通，见 roleHasPermission） */
export const requirePermission = createGuard({
	secret: () => config.JWT_SECRET_KEY,
	hasPermission: roleHasPermission,
})

/** 审核人 uid：**只从 token 取**（审计要求，客户端自报的 reviewedBy 一律忽略） */
export function reviewerIdOf(payload: TokenPayload): number {
	const uid = Number(payload.uid ?? payload.userId ?? payload.id ?? 0)
	if (!Number.isInteger(uid) || uid <= 0) {
		// uid 缺失时给 0：数据库列允空，但审核记录不能假装有个真人 —— 调用方应据此拒绝写入
		throw new Error('token 里没有可用的用户 id（uid/userId/id），无法记录审核人')
	}
	return uid
}
