import type { Env } from '../env'
import { sleep } from '../util'
import { DRIVE_API, driveFetch, type ServiceAccount } from './auth'
import { DriveError } from './errors'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
const CACHE_TTL = 3600
const LOCK_TTL = 60

/**
 * Query-parameter extras for team/shared-drive commits. When SHARED_DRIVE_ID is
 * set, folder/list/resource calls must see all drives and target the shared
 * drive's corpus; file operations need supportsAllDrives.
 */
export function sharedDriveParams(env: Env): { search: string; res: string } {
  const id = env.SHARED_DRIVE_ID?.trim()
  if (!id) return { search: '', res: '' }
  return {
    search: `&corpora=drive&driveId=${encodeURIComponent(id)}&includeItemsFromAllDrives=true&supportsAllDrives=true`,
    res: `&supportsAllDrives=true`,
  }
}

/** True when root lookups must target the shared drive instead of 'root'. */
export function usingSharedDrive(env: Env): boolean {
  return Boolean(env.SHARED_DRIVE_ID?.trim())
}

export function escQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * KV key for a folder child lookup. Root folders of a service account are
 * account-scoped (each SA has its own Drive root), so when `sa` and a null
 * parent are given a distinct key is used; interior nodes key by parent id
 * (Drive file ids are globally unique, so those never collide across SAs).
 */
export function folderCacheKey(parentId: string | null, name: string, sa?: ServiceAccount): string {
  if (!parentId && sa) return `folder:sa:${sa.clientEmail}:root:${name}`
  return `folder:${parentId ?? ''}:${name}`
}

/** Searches Drive for an existing folder (no creation). Returns null if absent. */
export async function findFolder(
  env: Env,
  name: string,
  parentId: string | null,
  sa?: ServiceAccount,
): Promise<string | null> {
  const parentExpr = parentId ? `'${parentId}' in parents` : usingSharedDrive(env) ? `'${env.SHARED_DRIVE_ID}' in parents` : "'root' in parents"
  const q = `name='${escQuery(name)}' and mimeType='${FOLDER_MIME}' and ${parentExpr} and trashed=false`
  const url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=10&fields=files(id)&spaces=drive${sharedDriveParams(env).search}`
  const res = await driveFetch(env, url, {}, { sa })
  if (!res.ok) throw new DriveError(500, 'InternalError', `folder search failed (HTTP ${res.status})`)
  const data = (await res.json()) as { files: { id: string }[] }
  return data.files[0]?.id ?? null
}

/** Cached lookup (KV, 1h TTL): returns the Drive folder id or null if absent. */
export async function findCachedFolder(
  env: Env,
  name: string,
  parentId: string | null,
  sa?: ServiceAccount,
): Promise<string | null> {
  const cacheKey = folderCacheKey(parentId, name, sa)
  const cached = await env.FOLDER_CACHE.get(cacheKey)
  if (cached) return cached
  const id = await findFolder(env, name, parentId, sa)
  if (id) await env.FOLDER_CACHE.put(cacheKey, id, { expirationTtl: CACHE_TTL })
  return id
}

/**
 * Returns the existing folder id for (name, parent), creating it if missing.
 * Results are cached in KV (1h TTL); an advisory KV lock reduces duplicate-folder
 * races from concurrent creates.
 */
export async function getOrCreateFolder(
  env: Env,
  name: string,
  parentId: string | null,
  sa?: ServiceAccount,
): Promise<string> {
  const cacheKey = folderCacheKey(parentId, name, sa)
  const cached = await env.FOLDER_CACHE.get(cacheKey)
  if (cached) return cached

  const existing = await findFolder(env, name, parentId, sa)
  if (existing) {
    await env.FOLDER_CACHE.put(cacheKey, existing, { expirationTtl: CACHE_TTL })
    return existing
  }

  // Advisory lock: if another request is creating concurrently, wait briefly and re-check.
  const lockKey = `lock:${cacheKey}`
  const locked = await env.FOLDER_CACHE.get(lockKey)
  if (locked) {
    await sleep(150)
    const again = await env.FOLDER_CACHE.get(cacheKey)
    if (again) return again
    const existing2 = await findFolder(env, name, parentId, sa)
    if (existing2) {
      await env.FOLDER_CACHE.put(cacheKey, existing2, { expirationTtl: CACHE_TTL })
      return existing2
    }
  } else {
    await env.FOLDER_CACHE.put(lockKey, '1', { expirationTtl: LOCK_TTL })
  }

  const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME }
  if (parentId) body.parents = [parentId]
  const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files${sharedDriveParams(env).res}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { sa })
  const data = (await res.json().catch(() => null)) as { id?: string } | null
  if (!res.ok || !data?.id) {
    throw new DriveError(500, 'InternalError', `folder create failed (HTTP ${res.status})`)
  }
  await env.FOLDER_CACHE.put(cacheKey, data.id, { expirationTtl: CACHE_TTL })
  await env.FOLDER_CACHE.delete(lockKey).catch(() => {})
  return data.id
}

/**
 * Resolves an object key to (parentFolderId, fileName) using only existing
 * folders. Returns null when any path segment does not exist.
 */
export async function resolveExistingPath(
  env: Env,
  rootId: string,
  key: string,
  sa?: ServiceAccount,
): Promise<{ parentId: string; name: string } | null> {
  const segs = key.split('/').filter((s) => s.length > 0)
  if (segs.length === 0) return null
  let current = rootId
  for (let i = 0; i < segs.length - 1; i++) {
    const next = await findCachedFolder(env, segs[i], current, sa)
    if (!next) return null
    current = next
  }
  return { parentId: current, name: segs[segs.length - 1] }
}

/**
 * Resolves a directory path to the id of the folder at the end of it (existing
 * folders only). Returns null when any segment does not exist.
 */
export async function resolveExistingFolderId(
  env: Env,
  rootId: string,
  path: string,
  sa?: ServiceAccount,
): Promise<string | null> {
  const segs = path.split('/').filter((s) => s.length > 0)
  let current = rootId
  for (const seg of segs) {
    const next = await findCachedFolder(env, seg, current, sa)
    if (!next) return null
    current = next
  }
  return current
}

/**
 * Resolves an object key for upload, creating intermediate folders as needed.
 */
export async function resolvePathCreate(
  env: Env,
  rootId: string,
  key: string,
  sa?: ServiceAccount,
): Promise<{ parentId: string; name: string }> {
  const segs = key.split('/').filter((s) => s.length > 0)
  if (segs.length === 0) return { parentId: rootId, name: '' }
  let current = rootId
  for (let i = 0; i < segs.length - 1; i++) {
    current = await getOrCreateFolder(env, segs[i], current, sa)
  }
  return { parentId: current, name: segs[segs.length - 1] }
}
