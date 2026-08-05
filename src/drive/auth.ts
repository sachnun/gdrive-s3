import type { Env } from '../env'
import { DriveError } from './errors'

export const DRIVE_API = 'https://www.googleapis.com'
export const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const TOKEN_KEY = 'access_token'

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

/**
 * Returns a cached OAuth access token from KV, refreshing when absent/expired
 * (KV expirationTtl = expires_in - 60s).
 */
export async function getAccessToken(env: Env): Promise<string> {
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
    return driveFetch(env, url, init, true)
  }
  return res
}
