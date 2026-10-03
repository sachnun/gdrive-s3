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
  budget?: number
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

const DRIVE_CALL_BUDGET = 40

interface DriveChild {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime: string
}

interface Frame {
  dirId: string
  dirKey: string
  pageToken?: string
  tail: string
  afterName: string
}

interface ListState {
  stack: Frame[]
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
    const parsed = JSON.parse(b64decode(b64)) as ListState
    return Array.isArray(parsed?.stack) ? parsed : null
  } catch {
    return null
  }
}

async function listDrivePage(
  env: Env,
  dirId: string,
  pageToken?: string,
): Promise<{ entries: DriveChild[]; nextPageToken?: string }> {
  const q = `'${dirId}' in parents and trashed=false`
  let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&spaces=drive&orderBy=name`
  if (pageToken) url += `&pageToken=${pageToken}`
  const res = await driveFetch(env, url)
  if (!res.ok) throw new DriveError(500, 'InternalError', `listing failed (HTTP ${res.status})`)
  const data = (await res.json()) as { nextPageToken?: string; files: DriveChild[] }
  return { entries: data.files ?? [], nextPageToken: data.nextPageToken }
}

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

export async function listObjects(env: Env, bucketFolderId: string | null, opts: ListOptions): Promise<ListResult> {
  const { prefix, delimiter, maxKeys } = opts
  const budget = opts.budget ?? DRIVE_CALL_BUDGET
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
    state = { stack: [{ dirId, dirKey, tail, afterName: '' }] }
  }

  let userSkip: string | null = null
  if (!opts.continuationToken) {
    if (opts.marker && !opts.marker.startsWith(TOKEN_PREFIX)) userSkip = opts.marker
    else if (opts.startAfter) userSkip = opts.startAfter
  }

  const contents: ListEntry[] = []
  const commonPrefixes = new Set<string>()
  let isTruncated = false
  let keyCount = 0

  const pageCache = new Map<string, Promise<{ entries: DriveChild[]; nextPageToken?: string }>>()
  let calls = 0
  const fetchPage = (frame: Frame) => {
    const key = `${frame.dirId}:${frame.pageToken ?? ''}`
    let hit = pageCache.get(key)
    if (!hit) {
      calls++
      hit = listDrivePage(env, frame.dirId, frame.pageToken)
      pageCache.set(key, hit)
    }
    return hit
  }

  while (state.stack.length > 0 && keyCount < maxKeys) {
    const cur = state.stack[state.stack.length - 1]
    if (calls >= budget) {
      isTruncated = true
      break
    }
    const page = await fetchPage(cur)

    let entries = page.entries
    if (cur.tail) entries = entries.filter((e) => e.name.startsWith(cur.tail))
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    if (cur.afterName) entries = entries.filter((e) => e.name > cur.afterName!)

    let pageDone = true
    for (const e of entries) {
      if (keyCount >= maxKeys) {
        isTruncated = true
        pageDone = false
        break
      }
      const isFolder = e.mimeType === FOLDER_MIME
      const entryKey = cur.dirKey + e.name
      cur.afterName = e.name
      if (isFolder && delimiter) {
        const cp = entryKey + '/'
        if (userSkip && cp <= userSkip) continue
        if (!commonPrefixes.has(cp)) {
          commonPrefixes.add(cp)
          keyCount++
        }
      } else if (isFolder) {
        state.stack.push({ dirId: e.id, dirKey: entryKey + '/', tail: '', afterName: '' })
        pageDone = false
        break
      } else {
        if (userSkip && entryKey <= userSkip) continue
        contents.push({
          key: entryKey,
          lastModified: e.modifiedTime,
          etag: e.id,
          size: Number(e.size ?? 0),
        })
        keyCount++
      }
    }
    if (!pageDone) continue

    cur.pageToken = page.nextPageToken
    if (keyCount >= maxKeys) {
      if (cur.pageToken || state.stack.length > 1) isTruncated = true
      break
    }
    if (cur.pageToken) continue
    state.stack.pop()
  }

  const result: ListResult = {
    contents,
    commonPrefixes: [...commonPrefixes],
    isTruncated,
    keyCount,
  }
  if (isTruncated) {
    const token = encodeToken(state)
    result.nextContinuationToken = token
    result.nextMarker = token
  }
  return result
}
