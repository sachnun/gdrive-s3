import type { Env } from '../../env'
import { DRIVE_API, driveFetch, type ServiceAccount } from '../auth'
import { DriveError } from '../errors'

export const INFINITE_FREE = Number.MAX_SAFE_INTEGER - 1

export interface Quota {
  limit: number
  usage: number
  free: number
}

function quotaKey(email: string): string {
  return `quota:${email}`
}

/** Cached per-SA Drive quota. Missing quota info is treated as infinite free space. */
export async function getQuota(env: Env, sa: ServiceAccount, cacheTime: number): Promise<Quota> {
  const key = quotaKey(sa.clientEmail)
  const cached = await env.FOLDER_CACHE.get(key)
  if (cached) {
    try {
      return JSON.parse(cached) as Quota
    } catch {
      // fall through and refetch
    }
  }
  let quota: Quota
  try {
    const res = await driveFetch(
      env,
      `${DRIVE_API}/drive/v3/about?fields=storageQuota`,
      {},
      { sa },
    )
    if (!res.ok) throw new DriveError(500, 'InternalError', `quota fetch failed (HTTP ${res.status})`)
    const data = (await res.json()) as { storageQuota?: { limit?: string; usage?: string } }
    const limit = Number(data.storageQuota?.limit ?? 0)
    const usage = Number(data.storageQuota?.usage ?? 0)
    const free = limit > 0 && limit >= usage ? limit - usage : INFINITE_FREE
    quota = { limit, usage, free }
  } catch {
    quota = { limit: 0, usage: 0, free: INFINITE_FREE }
  }
  await env.FOLDER_CACHE.put(key, JSON.stringify(quota), { expirationTtl: Math.max(60, cacheTime) })
  return quota
}