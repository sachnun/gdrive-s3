import type { Env } from '../env'
import { DriveError } from './errors'

export const DRIVE_API = 'https://www.googleapis.com'
export const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const TOKEN_KEY = 'access_token'
const SA_KV_KEY = 'service_accounts'
const SA_SCOPE = 'https://www.googleapis.com/auth/drive'
const SA_CACHE_TTL = 10 * 60 * 1000

export interface ServiceAccount {
  clientEmail: string
  privateKey: string
  tokenUri: string
}

/**
 * Parses service-account config: either a JSON array, or a file containing
 * concatenated service-account JSON blobs (the rclone `service_account_file`
 * format, one pretty-printed object after another).
 */
export function parseServiceAccounts(raw: string): ServiceAccount[] {
  const out: ServiceAccount[] = []
  const trimmed = raw.trim()
  const push = (obj: Record<string, unknown>) => {
    if (obj.type === 'service_account' && obj.client_email && obj.private_key) {
      out.push({
        clientEmail: String(obj.client_email),
        privateKey: String(obj.private_key),
        tokenUri: String(obj.token_uri ?? TOKEN_URL),
      })
    }
  }
  if (trimmed.startsWith('[')) {
    for (const obj of JSON.parse(trimmed) as Record<string, unknown>[]) push(obj)
    return out
  }
  let i = 0
  while (i < trimmed.length) {
    const start = trimmed.indexOf('{', i)
    if (start === -1) break
    let depth = 0
    let end = -1
    for (let j = start; j < trimmed.length; j++) {
      if (trimmed[j] === '{') depth++
      else if (trimmed[j] === '}') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end === -1) break
    try {
      push(JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>)
    } catch {
      // skip malformed blob
    }
    i = end + 1
  }
  return out
}

async function refreshAccessToken(env: Env): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    throw new DriveError(500, 'InternalError', `Google token refresh failed (HTTP ${res.status})`)
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  return { token: data.access_token, expiresIn: data.expires_in }
}

function base64url(data: Uint8Array): string {
  let bin = ''
  for (const b of data) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Signs a JWT (RS256) with the service account's PKCS#8 private key. */
async function signJwt(privateKeyPem: string, claims: Record<string, unknown>): Promise<string> {
  const derB64 = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const der = Uint8Array.from(atob(derB64), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)))
  const input = `${header}.${payload}`
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)))
  return `${input}.${base64url(sig)}`
}

/** Exchanges a signed JWT assertion for an OAuth access token (JWT bearer grant). */
async function serviceAccountToken(env: Env, sa: ServiceAccount): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000)
  const assertion = await signJwt(sa.privateKey, {
    iss: sa.clientEmail,
    scope: SA_SCOPE,
    aud: sa.tokenUri,
    iat: now,
    exp: now + 3600,
  })
  const res = await fetch(sa.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!res.ok) {
    throw new DriveError(500, 'InternalError', `Service account token failed (HTTP ${res.status})`)
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  return { token: data.access_token, expiresIn: data.expires_in }
}

/** Parsed service accounts, memoized per source string (TTL'd). */
const saCache = new Map<string, { at: number; list: ServiceAccount[] }>()
let rrIndex = 0

/**
 * Loads the service-account list from the env var, falling back to the AUTH_KV
 * key `service_accounts` (for payloads larger than the 5 KB secret limit).
 */
async function loadServiceAccounts(env: Env): Promise<ServiceAccount[]> {
  const source =
    env.GOOGLE_SERVICE_ACCOUNTS?.trim() || (await env.AUTH_KV.get(SA_KV_KEY)) || ''
  if (!source) return []
  const hit = saCache.get(source)
  if (hit && Date.now() - hit.at < SA_CACHE_TTL) return hit.list
  const list = parseServiceAccounts(source)
  saCache.set(source, { at: Date.now(), list })
  return list
}

/** Round-robins service accounts, caching each account's token in KV. */
async function getServiceAccountToken(env: Env): Promise<string> {
  const list = await loadServiceAccounts(env)
  if (list.length === 0) {
    throw new DriveError(500, 'InternalError', 'No Google credentials configured (set GOOGLE_REFRESH_TOKEN or service accounts)')
  }
  const sa = list[rrIndex++ % list.length]
  const cacheKey = `sa_token:${sa.clientEmail}`
  const cached = await env.AUTH_KV.get(cacheKey)
  if (cached) return cached
  const { token, expiresIn } = await serviceAccountToken(env, sa)
  await env.AUTH_KV.put(cacheKey, token, { expirationTtl: Math.max(60, expiresIn - 60) })
  return token
}

/**
 * Returns a cached OAuth access token from KV, refreshing when absent/expired.
 * Uses service-account auth when GOOGLE_REFRESH_TOKEN is unset, else the OAuth
 * refresh-token flow (KV expirationTtl = expires_in - 60s).
 */
export async function getAccessToken(env: Env): Promise<string> {
  if (!env.GOOGLE_REFRESH_TOKEN) return getServiceAccountToken(env)
  const cached = await env.AUTH_KV.get(TOKEN_KEY)
  if (cached) return cached
  const { token, expiresIn } = await refreshAccessToken(env)
  await env.AUTH_KV.put(TOKEN_KEY, token, { expirationTtl: Math.max(60, expiresIn - 60) })
  return token
}

/**
 * Drive API fetch wrapper: attaches the Bearer token, and on a 401 invalidates
 * the cached token and retries once with a freshly refreshed one.
 */
export async function driveFetch(env: Env, url: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const token = await getAccessToken(env)
  const headers = new Headers(init.headers)
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(url, { ...init, headers })
  if (res.status === 401 && !retried) {
    await env.AUTH_KV.delete(TOKEN_KEY)
    const listed = await env.AUTH_KV.list({ prefix: 'sa_token:' })
    for (const k of listed.keys) await env.AUTH_KV.delete(k.name)
    return driveFetch(env, url, init, true)
  }
  return res
}
