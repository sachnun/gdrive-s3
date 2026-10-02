import type { Env } from '../env'
import { DRIVE_API, driveFetch } from '../drive/auth'
import { DriveError } from '../drive/errors'
import { FOLDER_MIME, resolveExistingFolderId } from '../drive/folder'

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

async function listDrivePage(env: Env, dirId: string, pageToken?: string): Promise<{ entries: DriveChild[]; nextPageToken?: string }> {
  const q = `'${dirId}' in parents and trashed=false`
  let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&spaces=drive&orderBy=name`
  if (pageToken) url += `&pageToken=${pageToken}`
  const res = await driveFetch(env, url)
  if (!res.ok) throw new DriveError(500, 'InternalError', `listing failed (HTTP ${res.status})`)
  const data = (await res.json()) as { nextPageToken?: string; files: DriveChild[] }
  return { entries: data.files ?? [], nextPageToken: data.nextPageToken }
}

/**
 * Splits a prefix into the folder path to descend into and the remaining name
 * prefix to filter within that folder. Example: "a/b/c" → dir "a/b", tail "c".
 */
async function resolvePrefixDir(
  env: Env,
  bucketFolderId: string,
  prefix: string,
): Promise<{ dirId: string | null; dirKey: string; tail: string }> {
  if (prefix === '') return { dirId: bucketFolderId, dirKey: '', tail: '' }
  const lastSlash = prefix.lastIndexOf('/')
  if (lastSlash === -1) {
    return { dirId: bucketFolderId, dirKey: '', tail: prefix }
  }
  const dirPath = prefix.slice(0, lastSlash)
  const tail = prefix.slice(lastSlash + 1)
  const dirId = await resolveExistingFolderId(env, bucketFolderId, dirPath)
  return { dirId, dirKey: dirPath ? dirPath + '/' : '', tail }
}

/**
 * ListObjects (V1 + V2, shared engine) with prefix, delimiter, max-keys and
 * pagination. Drive pages (pageSize=1000) are walked; delimiter="/" aggregates
 * folders into CommonPrefixes, delimiter="" recurses into subfolders.
 */
export async function listObjects(env: Env, bucketFolderId: string | null, opts: ListOptions): Promise<ListResult> {
  const { prefix, delimiter, maxKeys } = opts
  const empty = (): ListResult => ({
    contents: [],
    commonPrefixes: [],
    isTruncated: false,
    keyCount: 0,
  })

  let state: ListState | null = null
  if (opts.continuationToken) {
    state = decodeToken(opts.continuationToken)
  } else if (opts.marker && opts.marker.startsWith(TOKEN_PREFIX)) {
    state = decodeToken(opts.marker)
  }
  if (!state) {
    if (!bucketFolderId) return empty()
    const { dirId, dirKey, tail } = await resolvePrefixDir(env, bucketFolderId, prefix)
    if (!dirId) return empty()
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
  let isTruncated = false
  let keyCount = 0

  while (state && keyCount < maxKeys) {
    const cur = state
    const page = await listDrivePage(env, cur.dirId, cur.pageToken)
    cur.pageToken = page.nextPageToken

    let entries = page.entries
    if (cur.tail) entries = entries.filter((e) => e.name.startsWith(cur.tail))
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const e of entries) {
      if (keyCount >= maxKeys) {
        isTruncated = true
        break
      }
      const isFolder = e.mimeType === FOLDER_MIME
      const entryKey = cur.dirKey + e.name
      if (isFolder && delimiter) {
        const cp = entryKey + '/'
        if (skip && cp <= skip) continue
        if (!commonPrefixes.has(cp)) {
          commonPrefixes.add(cp)
          keyCount++
        }
      } else if (isFolder) {
        // Recursive mode (delimiter=""): folder is not a key itself; queue its contents.
        if (skip && entryKey + '/' <= skip) continue
        cur.queue.push({ dirId: e.id, dirKey: entryKey + '/' })
      } else {
        if (skip && entryKey <= skip) continue
        contents.push({
          key: entryKey,
          lastModified: e.modifiedTime,
          etag: `"${e.id}"`,
          size: Number(e.size ?? 0),
        })
        keyCount++
      }
    }

    if (keyCount >= maxKeys) {
      if (!isTruncated && (cur.pageToken || cur.queue.length > 0)) isTruncated = true
      break
    }
    if (cur.pageToken) continue // more pages in the current dir
    const next = cur.queue.shift()
    if (!next) break
    cur.dirId = next.dirId
    cur.dirKey = next.dirKey
    cur.tail = ''
  }

  const result: ListResult = {
    contents,
    commonPrefixes: [...commonPrefixes],
    isTruncated,
    keyCount,
  }
  if (isTruncated && state) {
    const token = encodeToken(state)
    result.nextContinuationToken = token
    result.nextMarker = token
  }
  return result
}
