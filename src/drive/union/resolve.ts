import type { Env } from '../../env'
import { findCachedFolder, getOrCreateFolder, resolveExistingFolderId, resolveExistingPath, resolvePathCreate, sharedDriveParams } from '../folder'
import { findFilesInFolder, type FileMeta } from '../files'
import { DRIVE_API, driveFetch } from '../auth'
import { DriveError } from '../errors'
import { mapLimit } from '../../util'
import type { Upstream, Union } from './config'
import { getQuota, type Quota } from './quota'
import { actionSelect, createSelect, searchPick, type PolicySource } from './policy'

export interface UnionFind {
  saIndex: number
  file: FileMeta
}

export interface UnionBucket {
  saIndex: number
  rootId: string
}

function pathMemoKey(bucket: string, key: string): string {
  return `path:${bucket}:${key}`
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FANOUT = 4

function minCacheTtl(union: Union): number {
  return Math.max(60, union.cfg.cacheTime)
}

/** SA-scoped bucket root folder id, or null when that SA has no such folder. */
export async function saBucketRoot(env: Env, up: Upstream, bucket: string): Promise<string | null> {
  return findCachedFolder(env, bucket, null, up.sa)
}

/** Creates (or finds) the SA-scoped bucket root folder. */
export async function getOrCreateBucketRoot(env: Env, up: Upstream, bucket: string): Promise<string> {
  return getOrCreateFolder(env, bucket, null, up.sa)
}

/** Resolves a key to (parent, name) within one upstream using existing folders only. */
export async function saResolveKey(
  env: Env,
  up: Upstream,
  bucket: string,
  key: string,
): Promise<{ parentId: string; name: string } | null> {
  if (!key) return null
  const root = await saBucketRoot(env, up, bucket)
  if (!root) return null
  return resolveExistingPath(env, root, key, up.sa)
}

/** Resolves a key for upload within one upstream, creating folders as needed. */
export async function saResolveKeyCreate(
  env: Env,
  up: Upstream,
  bucket: string,
  key: string,
): Promise<{ parentId: string; name: string }> {
  const root = await getOrCreateBucketRoot(env, up, bucket)
  if (!key) return { parentId: root, name: '' }
  return resolvePathCreate(env, root, key, up.sa)
}

/** Finds the object in ONE upstream; returns full metadata or null. */
export async function saFindFile(
  env: Env,
  up: Upstream,
  bucket: string,
  key: string,
): Promise<FileMeta | null> {
  const target = await saResolveKey(env, up, bucket, key)
  if (!target) return null
  const files = await findFilesInFolder(env, target.name, target.parentId, up.sa)
  return files[0] ?? null
}

export class ResolveSource implements PolicySource {
  private quotaMemo = new Map<number, Promise<Quota>>()

  constructor(
    private env: Env,
    private union: Union,
    private modTimes: Map<number, string | null>,
  ) {}

  quota(i: number): Promise<Quota> {
    let p = this.quotaMemo.get(i)
    if (!p) {
      p = getQuota(this.env, this.union.upstreams[i].sa, this.union.cfg.cacheTime)
      this.quotaMemo.set(i, p)
    }
    return p
  }

  modifiedTime(i: number): Promise<string | null> {
    return Promise.resolve(this.modTimes.get(i) ?? null)
  }
}

/**
 * SEARCH: resolves the key across all upstreams (bounded parallel) and returns
 * the winning copy per the search policy. Deterministic: the winner is cached
 * in KV so repeated HEAD/GETs do not fan out again.
 */
export async function unionFind(env: Env, union: Union, bucket: string, key: string): Promise<UnionFind | null> {
  const memoKey = pathMemoKey(bucket, key)
  const cached = await env.FOLDER_CACHE.get(memoKey)
  if (cached) {
    try {
      return JSON.parse(cached) as UnionFind
    } catch {
      // stale/corrupt memo; re-resolve
    }
  }
  const metas: (FileMeta | null)[] = await mapLimit(union.upstreams, FANOUT, (up) => saFindFile(env, up, bucket, key))
  const modTimes = new Map<number, string | null>()
  for (let i = 0; i < metas.length; i++) modTimes.set(union.upstreams[i].index, metas[i]?.modifiedTime ?? null)
  const cands = union.upstreams.filter((_, i) => metas[i] !== null).map((u) => u.index)
  if (cands.length === 0) {
    await env.FOLDER_CACHE.delete(memoKey).catch(() => {})
    return null
  }
  const winner = await searchPick(union.cfg.searchPolicy, cands, new ResolveSource(env, union, modTimes))
  if (winner === null) return null
  const file = metas[winner]
  if (!file) return null
  const out: UnionFind = { saIndex: winner, file }
  await env.FOLDER_CACHE.put(memoKey, JSON.stringify(out), { expirationTtl: minCacheTtl(union) })
  return out
}

/** Bucket-existence SEARCH: returns the lowest-index upstream owning the bucket root. */
export async function unionBucketExists(env: Env, union: Union, bucket: string): Promise<UnionBucket | null> {
  const roots = await mapLimit(union.upstreams, FANOUT, (up) => saBucketRoot(env, up, bucket))
  const cands = union.upstreams.filter((_, i) => roots[i] !== null).map((u) => u.index)
  if (cands.length === 0) return null
  const winner = await searchPick(union.cfg.searchPolicy, cands, new ResolveSource(env, union, new Map()))
  if (winner === null || roots[winner] === null) return null
  return { saIndex: winner, rootId: roots[winner]! }
}

/** CREATE: upstreams to write a new key into (parent-exists prefilter for ep* policies). */
export async function unionCreateTargets(env: Env, union: Union, bucket: string, key: string): Promise<number[]> {
  const dirSegs = key.split('/').filter((s) => s.length > 0).slice(0, -1)
  const creatable = union.upstreams.filter((u) => u.creatable).map((u) => u.index)
  if (creatable.length === 0) {
    throw new DriveError(403, 'AccessDenied', 'no creatable upstream for union create')
  }
  let cands = creatable
  if (union.cfg.createPolicy !== 'ff') {
    const keep = await mapLimit(creatable, FANOUT, async (i): Promise<number | null> => {
      const up = union.upstreams[i]
      const root = await saBucketRoot(env, up, bucket)
      if (!root) return null
      if (dirSegs.length === 0) return i
      const dir = await resolveExistingFolderId(env, root, dirSegs.join('/'), up.sa)
      return dir === null ? null : i
    })
    cands = keep.filter((i): i is number => i !== null)
    // No upstream has the parent chain yet: any creatable upstream can build it
    // (recursive mkdir during upload) — S3 keys do not require pre-existing dirs.
    if (cands.length === 0) cands = creatable
  }
  const targets = await createSelect(
    union.cfg.createPolicy,
    cands,
    new ResolveSource(env, union, new Map()),
    union.cfg.minFreeSpace,
  )
  if (targets.length === 0) {
    throw new DriveError(403, 'AccessDenied', 'no creatable upstream for union create')
  }
  return targets
}

/** CREATE: upstreams to write a new bucket root into (parent = Drive root, always present). */
export async function unionCreateBucketTargets(env: Env, union: Union, bucket: string): Promise<number[]> {
  const creatable = union.upstreams.filter((u) => u.creatable).map((u) => u.index)
  if (creatable.length === 0) {
    throw new DriveError(403, 'AccessDenied', 'no creatable upstream for union create')
  }
  return createSelect(
    union.cfg.createPolicy,
    creatable,
    new ResolveSource(env, union, new Map()),
    union.cfg.minFreeSpace,
  )
}

/** ACTION: writable upstreams that currently have the key. */
export async function unionActionTargets(env: Env, union: Union, bucket: string, key: string): Promise<number[]> {
  const hits = await unionActionHits(env, union, bucket, key)
  return hits.map((h) => h.saIndex)
}

/** ACTION: writable upstreams that currently have the key, with the winning file metadata. */
export async function unionActionHits(
  env: Env,
  union: Union,
  bucket: string,
  key: string,
): Promise<{ saIndex: number; file: FileMeta }[]> {
  const writable = union.upstreams.filter((u) => u.writable).map((u) => u.index)
  if (writable.length === 0) return []
  const hits = await mapLimit(writable, FANOUT, async (i): Promise<{ saIndex: number; file: FileMeta } | null> => {
    const up = union.upstreams[i]
    const file = await saFindFile(env, up, bucket, key)
    return file ? { saIndex: i, file } : null
  })
  const cands = hits.filter((h): h is { saIndex: number; file: FileMeta } => h !== null).map((h) => h.saIndex)
  const selected = await actionSelect(union.cfg.actionPolicy, cands, new ResolveSource(env, union, new Map()))
  const byIndex = new Map(hits.filter((h): h is { saIndex: number; file: FileMeta } => h !== null).map((h) => [h.saIndex, h.file]))
  return selected.map((i) => ({ saIndex: i, file: byIndex.get(i)! }))
}

/** ACTION targeting the bucket root itself (DeleteBucket). */
export async function unionActionBuckets(env: Env, union: Union, bucket: string): Promise<number[]> {
  const writable = union.upstreams.filter((u) => u.writable).map((u) => u.index)
  if (writable.length === 0) return []
  const roots = await mapLimit(writable, FANOUT, (i) => saBucketRoot(env, union.upstreams[i], bucket))
  const cands = writable.filter((_, i) => roots[i] !== null)
  return actionSelect(union.cfg.actionPolicy, cands, new ResolveSource(env, union, new Map()))
}

/** Merges root folders of every upstream (name → createdTime), lowest index wins. */
export async function unionListBuckets(env: Env, union: Union): Promise<Map<string, string>> {
  const merged = new Map<string, { created: string; index: number }>()
  const pages = await mapLimit(union.upstreams, FANOUT, async (up) => {
    const out: { name: string; created: string }[] = []
    const q = `mimeType='${FOLDER_MIME}' and ${env.SHARED_DRIVE_ID?.trim() ? `'${env.SHARED_DRIVE_ID}' in parents` : "'root' in parents"} and trashed=false`
    let pageToken: string | undefined
    for (let page = 0; page < 10; page++) {
      let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,createdTime)&spaces=drive&orderBy=name${sharedDriveParams(env).search}`
      if (pageToken) url += `&pageToken=${pageToken}`
      const res = await driveFetch(env, url, {}, { sa: up.sa })
      if (!res.ok) break
      const data = (await res.json()) as { nextPageToken?: string; files: { name: string; createdTime: string }[] }
      for (const f of data.files) out.push({ name: f.name, created: f.createdTime })
      pageToken = data.nextPageToken
      if (!pageToken) break
    }
    return { index: up.index, out }
  })
  for (const p of pages) {
    for (const b of p.out) {
      const cur = merged.get(b.name)
      if (!cur || p.index < cur.index) merged.set(b.name, { created: b.created, index: p.index })
    }
  }
  return new Map([...merged.entries()].map(([k, v]) => [k, v.created]))
}

/** Drops the search-policy memo after any write to the key. */
export async function invalidateObjectMemos(env: Env, bucket: string, keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => env.FOLDER_CACHE.delete(pathMemoKey(bucket, k)).catch(() => {})))
}