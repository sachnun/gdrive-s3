import type { Env } from '../env'
import { sleep } from '../util'
import { DRIVE_API, driveFetch } from './auth'
import { DriveError } from './errors'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
const CACHE_TTL = 3600
const LOCK_TTL = 60

export function escQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export function folderCacheKey(parentId: string | null, name: string): string {
  return `folder:${parentId ?? ''}:${name}`
}

export async function findFolder(env: Env, name: string, parentId: string | null): Promise<string | null> {
  const parentExpr = parentId ? `'${parentId}' in parents` : "'root' in parents"
  const q = `name='${escQuery(name)}' and mimeType='${FOLDER_MIME}' and ${parentExpr} and trashed=false`
  const url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=10&fields=files(id)&spaces=drive`
  const res = await driveFetch(env, url)
  if (!res.ok) throw new DriveError(500, 'InternalError', `folder search failed (HTTP ${res.status})`)
  const data = (await res.json()) as { files: { id: string }[] }
  return data.files[0]?.id ?? null
}

export async function findCachedFolder(env: Env, name: string, parentId: string | null): Promise<string | null> {
  const cacheKey = folderCacheKey(parentId, name)
  const cached = await env.FOLDER_CACHE.get(cacheKey)
  if (cached) return cached
  const id = await findFolder(env, name, parentId)
  if (id) await env.FOLDER_CACHE.put(cacheKey, id, { expirationTtl: CACHE_TTL })
  return id
}

export async function getOrCreateFolder(env: Env, name: string, parentId: string | null): Promise<string> {
  const cacheKey = folderCacheKey(parentId, name)
  const cached = await env.FOLDER_CACHE.get(cacheKey)
  if (cached) return cached

  const existing = await findFolder(env, name, parentId)
  if (existing) {
    await env.FOLDER_CACHE.put(cacheKey, existing, { expirationTtl: CACHE_TTL })
    return existing
  }

  const lockKey = `lock:${cacheKey}`
  const locked = await env.FOLDER_CACHE.get(lockKey)
  if (locked) {
    await sleep(150)
    const again = await env.FOLDER_CACHE.get(cacheKey)
    if (again) return again
    const existing2 = await findFolder(env, name, parentId)
    if (existing2) {
      await env.FOLDER_CACHE.put(cacheKey, existing2, { expirationTtl: CACHE_TTL })
      return existing2
    }
  } else {
    await env.FOLDER_CACHE.put(lockKey, '1', { expirationTtl: LOCK_TTL })
  }

  const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME }
  if (parentId) body.parents = [parentId]
  const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as { id?: string } | null
  if (!res.ok || !data?.id) {
    throw new DriveError(500, 'InternalError', `folder create failed (HTTP ${res.status})`)
  }
  await env.FOLDER_CACHE.put(cacheKey, data.id, { expirationTtl: CACHE_TTL })
  await env.FOLDER_CACHE.delete(lockKey).catch(() => {})
  return data.id
}

export async function resolveExistingPath(
  env: Env,
  rootId: string,
  key: string,
): Promise<{ parentId: string; name: string } | null> {
  const segs = key.split('/').filter((s) => s.length > 0)
  if (segs.length === 0) return null
  let current = rootId
  for (let i = 0; i < segs.length - 1; i++) {
    const next = await findCachedFolder(env, segs[i], current)
    if (!next) return null
    current = next
  }
  return { parentId: current, name: segs[segs.length - 1] }
}

export async function resolveExistingFolderId(env: Env, rootId: string, path: string): Promise<string | null> {
  const segs = path.split('/').filter((s) => s.length > 0)
  let current = rootId
  for (const seg of segs) {
    const next = await findCachedFolder(env, seg, current)
    if (!next) return null
    current = next
  }
  return current
}

export async function resolvePathCreate(
  env: Env,
  rootId: string,
  key: string,
): Promise<{ parentId: string; name: string }> {
  const segs = key.split('/').filter((s) => s.length > 0)
  if (segs.length === 0) return { parentId: rootId, name: '' }
  let current = rootId
  for (let i = 0; i < segs.length - 1; i++) {
    current = await getOrCreateFolder(env, segs[i], current)
  }
  return { parentId: current, name: segs[segs.length - 1] }
}
