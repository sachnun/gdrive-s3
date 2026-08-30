import type { Env } from '../env'
import { DRIVE_API, driveFetch, type ServiceAccount } from '../drive/auth'
import { DriveError } from '../drive/errors'
import { FOLDER_MIME, resolveExistingFolderId, sharedDriveParams } from '../drive/folder'
import type { Union, Upstream } from '../drive/union/config'
import { ResolveSource, saBucketRoot } from '../drive/union/resolve'
import { searchPick } from '../drive/union/policy'
import { mapLimit } from '../util'

export interface ListEntry {
  key: string
  lastModified: string
  etag: string
  size: number
}

export interface ListOptions {
  bucket: string
  prefix: string
  delimiter: string
  maxKeys: number
  marker?: string
  continuationToken?: string
  startAfter?: string
  isV2: boolean
  encodingType?: string
}

export interface ListResult {
  contents: ListEntry[]
  commonPrefixes: string[]
  isTruncated: boolean
  nextContinuationToken?: string
  nextMarker?: string
  keyCount: number
}

const TOKEN_PREFIX = 'gds3:'

interface DriveChild {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime: string
}

interface QueueItem {
  dirId: string
  dirKey: string
}

interface ListState {
  dirId: string
  dirKey: string
  pageToken?: string
  queue: QueueItem[]
  tail: string
  lastEmittedName?: string
  exhausted?: boolean
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64decode(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function encodeToken(state: ListState): string {
  return TOKEN_PREFIX + b64encode(JSON.stringify(state))
}

function decodeToken(token: string): ListState | null {
  const b64 = token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : token
  try {
    return JSON.parse(b64decode(b64)) as ListState
  } catch {
    return null
  }
}

interface UnionToken {
  upstreams: (ListState | null)[]
  /** Merged-key threshold: keys ≤ this were already emitted (or skipped by marker). */
  skipKey?: string
}

function encodeUnionToken(token: UnionToken): string {
  return TOKEN_PREFIX + 'u' + b64encode(JSON.stringify(token))
}

function decodeUnionToken(token: string): UnionToken | null {
  const b64 = token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : token
  if (!b64.startsWith('u')) return null
  try {
    return JSON.parse(b64decode(b64.slice(1))) as UnionToken
  } catch {
    return null
  }
}

async function listDrivePage(
  env: Env,
  dirId: string,
  pageToken?: string,
  sa?: ServiceAccount,
): Promise<{ entries: DriveChild[]; nextPageToken?: string }> {
  const q = `'${dirId}' in parents and trashed=false`
  let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&spaces=drive&orderBy=name${sharedDriveParams(env).search}`
  if (pageToken) url += `&pageToken=${pageToken}`
  const res = await driveFetch(env, url, {}, { sa })
  if (!res.ok) throw new DriveError(500, 'InternalError', `listing failed (HTTP ${res.status})`)
  const data = (await res.json()) as { nextPageToken?: string; files: DriveChild[] }
  return { entries: data.files ?? [], nextPageToken: data.nextPageToken }
}

async function resolvePrefixDir(
  env: Env,
  bucketFolderId: string,
  prefix: string,
  sa?: ServiceAccount,
): Promise<{ dirId: string | null; dirKey: string; tail: string }> {
  if (prefix === '') return { dirId: bucketFolderId, dirKey: '', tail: '' }
  const lastSlash = prefix.lastIndexOf('/')
  if (lastSlash === -1) {
    return { dirId: bucketFolderId, dirKey: '', tail: prefix }
  }
  const dirPath = prefix.slice(0, lastSlash)
  const tail = prefix.slice(lastSlash + 1)
  const dirId = await resolveExistingFolderId(env, bucketFolderId, dirPath, sa)
  return { dirId, dirKey: dirPath ? dirPath + '/' : '', tail }
}

interface StreamItem {
  key: string
  isPrefix: boolean
  entry?: DriveChild
}

function emptyResult(): ListResult {
  return { contents: [], commonPrefixes: [], isTruncated: false, keyCount: 0 }
}

/**
 * One upstream's key-ordered stream walker (grid DFS with pagination). `next()`
 * yields items in strictly increasing key order — common prefixes (delimiter
 * mode) interleaved with object keys. State is snapshotted into the continuation
 * token so pagination resumes exactly where it stopped.
 */
class UpstreamWalker {
  private loaded: DriveChild[] = []
  private idx = 0
  private started = false
  exhausted = false

  constructor(
    private env: Env,
    private state: ListState,
    private sa?: ServiceAccount,
    private delimiter?: string,
  ) {}

  private prepare(entries: DriveChild[]): DriveChild[] {
    let list = entries
    if (this.state.tail) {
      const tail = this.state.tail
      list = list.filter((e) => e.name.startsWith(tail))
    }
    if (this.state.lastEmittedName) {
      const last = this.state.lastEmittedName
      list = list.filter((e) => e.name > last)
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return list
  }

  private nextDir(): boolean {
    const next = this.state.queue.shift()
    if (!next) return false
    this.state.dirId = next.dirId
    this.state.dirKey = next.dirKey
    this.state.tail = ''
    this.state.pageToken = undefined
    this.state.lastEmittedName = undefined
    return true
  }

  async next(): Promise<StreamItem | null> {
    for (;;) {
      if (!this.started) {
        this.started = true
        const page = await listDrivePage(this.env, this.state.dirId, this.state.pageToken, this.sa)
        this.state.pageToken = page.nextPageToken
        this.loaded = this.prepare(page.entries)
        this.idx = 0
      }
      if (this.idx >= this.loaded.length) {
        if (this.state.pageToken) {
          const page = await listDrivePage(this.env, this.state.dirId, this.state.pageToken, this.sa)
          this.state.pageToken = page.nextPageToken
          this.loaded = this.prepare(page.entries)
          this.idx = 0
          if (this.loaded.length === 0 && !this.state.pageToken && !this.nextDir()) {
            this.exhausted = true
            return null
          }
          if (this.loaded.length === 0) continue
        } else if (!this.nextDir()) {
          this.exhausted = true
          return null
        } else {
          const page = await listDrivePage(this.env, this.state.dirId, undefined, this.sa)
          this.state.pageToken = page.nextPageToken
          this.loaded = this.prepare(page.entries)
          this.idx = 0
          if (this.loaded.length === 0 && !this.state.pageToken) continue
        }
      }
      const e = this.loaded[this.idx]
      this.idx++
      const entryKey = this.state.dirKey + e.name
      this.state.lastEmittedName = e.name
      if (e.mimeType === FOLDER_MIME) {
        if (this.delimiter) return { key: entryKey + '/', isPrefix: true }
        this.state.queue.push({ dirId: e.id, dirKey: entryKey + '/' })
        continue
      }
      return { key: entryKey, isPrefix: false, entry: e }
    }
  }

  snapshot(): ListState {
    return { ...this.state, exhausted: this.exhausted }
  }
}

/** ListObjects (V1 + V2, shared engine) with prefix, delimiter, max-keys and pagination. */
export async function listObjects(env: Env, bucketFolderId: string | null, opts: ListOptions): Promise<ListResult> {
  const { prefix: pfx, delimiter, maxKeys } = opts

  let state: ListState | null = null
  if (opts.continuationToken) {
    state = decodeToken(opts.continuationToken)
  } else if (opts.marker && opts.marker.startsWith(TOKEN_PREFIX)) {
    state = decodeToken(opts.marker)
  }
  if (!state) {
    if (!bucketFolderId) return emptyResult()
    const { dirId, dirKey, tail } = await resolvePrefixDir(env, bucketFolderId, pfx)
    if (!dirId) return emptyResult()
    state = { dirId, dirKey, pageToken: undefined, queue: [], tail }
  }

  // Keys to skip on the first pass (V1 marker as plain key / V2 start-after).
  let skip: string | null = null
  if (!opts.continuationToken) {
    if (opts.marker && !opts.marker.startsWith(TOKEN_PREFIX)) skip = opts.marker
    else if (opts.startAfter) skip = opts.startAfter
  }

  const contents: ListEntry[] = []
  const commonPrefixes = new Set<string>()
  let keyCount = 0

  const walker = new UpstreamWalker(env, state, undefined, delimiter)
  for (;;) {
    if (keyCount >= maxKeys) break
    const item = await walker.next()
    if (!item) break
    if (skip && item.key <= skip) continue
    if (item.isPrefix) {
      if (!commonPrefixes.has(item.key)) {
        commonPrefixes.add(item.key)
        keyCount++
      }
    } else if (item.entry) {
      contents.push({
        key: item.key,
        lastModified: item.entry.modifiedTime,
        etag: `"${item.entry.id}"`,
        size: Number(item.entry.size ?? 0),
      })
      keyCount++
    }
  }

  const isTruncated = maxKeys > 0 && keyCount >= maxKeys && !walker.exhausted
  const result: ListResult = {
    contents,
    commonPrefixes: [...commonPrefixes],
    isTruncated,
    keyCount,
  }
  if (isTruncated) {
    const token = encodeToken(walker.snapshot())
    result.nextContinuationToken = token
    result.nextMarker = token
  }
  return result
}

/** Union-mode ListObjects: k-way merge of every upstream's key-ordered stream. */
export async function listObjectsUnion(env: Env, union: Union, opts: ListOptions): Promise<ListResult> {
  const { prefix: pfx, delimiter, maxKeys } = opts

  let resume: UnionToken | null = null
  if (opts.continuationToken) {
    resume = decodeUnionToken(opts.continuationToken)
  } else if (opts.marker && opts.marker.startsWith(TOKEN_PREFIX)) {
    resume = decodeUnionToken(opts.marker)
  }
  const tokenUpstreams = resume?.upstreams ?? null
  // Keys already emitted (or excluded by a marker/start-after) must stay out of
  // every continuation page: the threshold is the last counted key (or the
  // request's own skip boundary on the first page).
  const skipThresh = resume?.skipKey ?? (opts.marker && !opts.marker.startsWith(TOKEN_PREFIX) ? opts.marker : (opts.startAfter ?? ''))

  const baseStates: (ListState | null)[] =
    tokenUpstreams ??
    (await mapLimit(union.upstreams, 4, async (up): Promise<ListState | null> => {
      const root = await saBucketRoot(env, up, opts.bucket)
      if (!root) return null
      const { dirId, dirKey, tail } = await resolvePrefixDir(env, root, pfx, up.sa)
      if (!dirId) return null
      return { dirId, dirKey, pageToken: undefined, queue: [], tail }
    }))

  const walkers: (UpstreamWalker | null)[] = union.upstreams.map((up, i) => {
    if (!baseStates[i]) return null
    const st = baseStates[i] as ListState
    // The in-memory page buffer is gone; the merge-level skipKey re-filters,
    // so name-level resume filtering must not re-drop unconsumed boundary keys.
    st.lastEmittedName = undefined
    return new UpstreamWalker(env, st, up.sa, delimiter)
  })

  const contents: ListEntry[] = []
  const commonPrefixes = new Set<string>()
  let keyCount = 0

  // heads[i] is the walker's current item (null when exhausted or root missing).
  const heads: (StreamItem | null)[] = await Promise.all(walkers.map((w) => (w ? w.next() : Promise.resolve(null))))

  if (heads.every((h) => h === null)) {
    return emptyResult()
  }

  let lastKey = ''
  for (;;) {
    let best = -1
    for (let i = 0; i < heads.length; i++) {
      if (!heads[i]) continue
      if (best === -1 || heads[i]!.key < heads[best]!.key) best = i
    }
    if (best === -1) break

    const key = heads[best]!.key
    if (key <= skipThresh) {
      heads[best] = await walkers[best]!.next()
      continue
    }
    if (keyCount >= maxKeys) break

    // Collect every upstream whose head has the same key, capturing entries
    // before advancing those cursors.
    const group: number[] = []
    const items = new Map<number, StreamItem>()
    for (let i = 0; i < heads.length; i++) {
      if (heads[i] && heads[i]!.key === key) {
        const upstreamIndex = collectUpstreamIndex(i)
        group.push(upstreamIndex)
        items.set(upstreamIndex, heads[i]!)
        heads[i] = await walkers[i]!.next()
      }
    }

    const firstItem = items.get(group[0])!
    if (firstItem.isPrefix) {
      if (!commonPrefixes.has(key)) {
        commonPrefixes.add(key)
        keyCount++
        lastKey = key
      }
    } else {
      const modTimes = new Map<number, string | null>()
      for (const g of group) modTimes.set(g, items.get(g)?.entry?.modifiedTime ?? null)
      const winner =
        group.length === 1
          ? group[0]
          : (await searchPick(union.cfg.searchPolicy, group, new ResolveSource(env, union, modTimes))) ?? group[0]
      const entry = items.get(winner)?.entry
      if (entry) {
        contents.push({
          key,
          lastModified: entry.modifiedTime,
          etag: `"${entry.id}"`,
          size: Number(entry.size ?? 0),
        })
        keyCount++
        lastKey = key
      }
    }
  }

  const anyAlive = walkers.some((w) => w !== null && !w.exhausted)
  const isTruncated = maxKeys > 0 && keyCount >= maxKeys && anyAlive

  const result: ListResult = {
    contents,
    commonPrefixes: [...commonPrefixes],
    isTruncated,
    keyCount,
  }
  if (isTruncated) {
    const finalSkip = lastKey > skipThresh ? lastKey : skipThresh
    const token = encodeUnionToken({ upstreams: walkers.map((w) => (w ? w.snapshot() : null)), skipKey: finalSkip })
    result.nextContinuationToken = token
    result.nextMarker = token
  }
  return result

  function collectUpstreamIndex(i: number): number {
    return union.upstreams[i].index
  }
}