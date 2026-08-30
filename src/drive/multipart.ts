import type { Env } from '../env'
import { randomHex, sha256Hex } from '../util'
import { DRIVE_API, driveFetch, type ServiceAccount } from './auth'
import { DriveError } from './errors'
import { FOLDER_MIME, findCachedFolder, getOrCreateFolder, sharedDriveParams } from './folder'
import { createResumableSession, findFilesInFolder, trashFile, uploadFile, uploadToSession, type FileMeta } from './files'
import { loadUnion, type Union } from './union/config'
import { saResolveKeyCreate } from './union/resolve'

export const MULTIPART_ROOT = '.gdrive-s3-multipart'
const GC_AGE_MS = 24 * 3600 * 1000

export interface MultipartState {
  bucket: string
  key: string
  folderId: string
  parentId: string
  name: string
  contentType: string
  createdAt: number
  parts: Record<string, { fileId: string; size: number; etag: string }>
  /** Union mode: upstream index holding the temp part folder. */
  saIndex?: number
  /** Union mode: upstream indices receiving the final concatenated object. */
  createTargets?: number[]
}

function stateKey(uploadId: string): string {
  return `multipart:${uploadId}`
}

async function getState(env: Env, uploadId: string): Promise<MultipartState> {
  const raw = await env.FOLDER_CACHE.get(stateKey(uploadId))
  if (!raw) throw new DriveError(404, 'NoSuchUpload', 'The specified multipart upload does not exist.')
  return JSON.parse(raw) as MultipartState
}

async function sessionSa(env: Env, state: MultipartState): Promise<ServiceAccount | undefined> {
  if (state.saIndex === undefined) return undefined
  const union = await loadUnion(env)
  return union.upstreams[state.saIndex]?.sa
}

/**
 * Creates a multipart upload session: a temp folder
 * `.gdrive-s3-multipart/<bucket>/<uploadId>` at the Drive root of the primary
 * upstream (union mode) or the default identity. In union mode, `createTargets`
 * are the upstream indices the final object will be concatenated into.
 */
export async function createMultipart(
  env: Env,
  args: {
    bucket: string
    key: string
    parentId: string
    name: string
    contentType: string
    sa?: ServiceAccount
    union?: Union
    createTargets?: number[]
  },
): Promise<{ uploadId: string }> {
  const uploadId = randomHex(24)
  const sa = args.sa
  const mpRoot = await getOrCreateFolder(env, MULTIPART_ROOT, null, sa)
  const bucketDir = await getOrCreateFolder(env, args.bucket, mpRoot, sa)
  const folderId = await getOrCreateFolder(env, uploadId, bucketDir, sa)
  const state: MultipartState = {
    bucket: args.bucket,
    key: args.key,
    folderId,
    parentId: args.parentId,
    name: args.name,
    contentType: args.contentType,
    createdAt: Date.now(),
    parts: {},
  }
  if (args.union && args.createTargets && args.createTargets.length > 0) {
    state.saIndex = Math.min(...args.createTargets)
    state.createTargets = args.createTargets
  }
  await env.FOLDER_CACHE.put(stateKey(uploadId), JSON.stringify(state))
  return { uploadId }
}

/** Uploads one part into the session's temp folder (part number kept in appProperties). */
export async function uploadPart(
  env: Env,
  uploadId: string,
  partNumber: number,
  body: BodyInit | null,
  size?: number,
  data?: Uint8Array,
): Promise<{ etag: string }> {
  const state = await getState(env, uploadId)
  const sa = await sessionSa(env, state)
  const n = String(partNumber)
  const existing = state.parts[n]
  if (existing) {
    await trashFile(env, existing.fileId, sa)
    delete state.parts[n]
  }
  const name = `part-${n.padStart(5, '0')}`
  const meta = await uploadFile(env, {
    parentId: state.folderId,
    name,
    body,
    contentType: 'application/octet-stream',
    size,
    appProperties: { partNumber: n, uploadId },
    data,
    sa,
  })
  const etag = await sha256Hex(meta.id)
  state.parts[n] = { fileId: meta.id, size: meta.size ? Number(meta.size) : (size ?? 0), etag }
  await env.FOLDER_CACHE.put(stateKey(uploadId), JSON.stringify(state))
  return { etag }
}

/** Re-syncs the part list from the temp folder so KV loss/races cannot lose parts. */
async function reconcileParts(env: Env, state: MultipartState, sa?: ServiceAccount): Promise<void> {
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const q = `'${state.folderId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`
    let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,size,appProperties)&spaces=drive${sharedDriveParams(env).search}`
    if (pageToken) url += `&pageToken=${pageToken}`
    const res = await driveFetch(env, url, {}, { sa })
    if (!res.ok) throw new DriveError(500, 'InternalError', `multipart reconcile failed (HTTP ${res.status})`)
    const data = (await res.json()) as {
      nextPageToken?: string
      files: { id: string; size?: string; appProperties?: Record<string, string> }[]
    }
    for (const f of data.files) {
      const n = f.appProperties?.partNumber
      if (n) state.parts[n] = { fileId: f.id, size: f.size ? Number(f.size) : 0, etag: await sha256Hex(f.id) }
    }
    pageToken = data.nextPageToken
    if (!pageToken) break
  }
}

interface PartRef {
  partNumber: number
  fileId: string
  size: number
}

async function orderParts(
  env: Env,
  state: MultipartState,
  requested: { partNumber: number; etag: string }[],
): Promise<PartRef[]> {
  // Re-sync from Drive only when the KV state cannot answer by itself: when the
  // client listed parts that are unknown to us, or sent no part list at all.
  const sa = await sessionSa(env, state)
  const needsReconcile =
    requested.length === 0 || !requested.every((r) => state.parts[String(r.partNumber)])
  if (needsReconcile) await reconcileParts(env, state, sa)

  if (requested.length === 0) {
    return Object.entries(state.parts)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, p]) => ({ partNumber: 0, fileId: p.fileId, size: p.size }))
  }
  return requested.map((r) => {
    const p = state.parts[String(r.partNumber)]
    if (!p) throw new DriveError(400, 'InvalidPart', `Part ${r.partNumber} was not uploaded.`)
    if (p.etag !== r.etag) throw new DriveError(400, 'InvalidPart', `ETag mismatch for part ${r.partNumber}.`)
    return { partNumber: r.partNumber, fileId: p.fileId, size: p.size }
  })
}

/** Streams the ordered parts into one destination parent (existing-folder walk). */
async function concatInto(
  env: Env,
  state: MultipartState,
  ordered: PartRef[],
  parentId: string,
  sessionSa: ServiceAccount | undefined,
  partSa?: ServiceAccount,
): Promise<FileMeta> {
  const totalSize = ordered.reduce((s, p) => s + p.size, 0)
  const location = await createResumableSession(env, { name: state.name, parents: [parentId], mimeType: state.contentType }, totalSize, sessionSa)
  let finalMeta: FileMeta | undefined
  if (ordered.length === 0) {
    finalMeta = await uploadToSession(env, location, null, 0, state.contentType, sessionSa)
  } else {
    let offset = 0
    for (const p of ordered) {
      // Part files live in the PRIMARY upstream's temp folder; the final object
      // session belongs to the target upstream — read and write use different SAs.
      const partRes = await driveFetch(env, `${DRIVE_API}/drive/v3/files/${p.fileId}?alt=media&supportsAllDrives=true`, {}, { sa: partSa ?? sessionSa })
      if (!partRes.ok) {
        throw new DriveError(500, 'InternalError', `read part ${p.partNumber} failed (HTTP ${partRes.status})`)
      }
      // Drive resumable sessions can be fed in multiple sequential PUTs, but each
      // must declare its byte range via Content-Range (otherwise Drive restarts at 0).
      const end = offset + p.size - 1
      const up = await driveFetch(env, location, {
        method: 'PUT',
        headers: {
          'Content-Length': String(p.size),
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${end}/${totalSize}`,
        },
        body: partRes.body,
        duplex: 'half',
      } as RequestInit, { sa: sessionSa })
      offset += p.size
      if (up.status === 200 || up.status === 201) {
        finalMeta = (await up.json()) as FileMeta
      } else if (up.status !== 308) {
        throw new DriveError(500, 'InternalError', `concat part ${p.partNumber} failed (HTTP ${up.status})`)
      }
    }
  }
  if (!finalMeta) throw new DriveError(500, 'InternalError', 'multipart concat did not produce a file')
  return finalMeta
}

/**
 * Concatenates part files (streamed sequentially into one resumable session at
 * the final key), applies overwrite semantics, then trashes the temp folder.
 * In union mode the final object is written to every CREATE target upstream.
 */
export async function completeMultipart(
  env: Env,
  uploadId: string,
  requested: { partNumber: number; etag: string }[],
): Promise<{ etag: string }> {
  const state = await getState(env, uploadId)
  const ordered = await orderParts(env, state, requested)
  const sa = await sessionSa(env, state)

  let finalMeta: FileMeta
  if (state.createTargets?.length) {
    const union = await loadUnion(env)
    const primarySa = sa
    let last: FileMeta | null = null
    for (const t of state.createTargets) {
      const up = union.upstreams[t]
      if (!up) continue
      const { parentId } = await saResolveKeyCreate(env, up, state.bucket, state.key)
      last = await concatInto(env, state, ordered, parentId, up.sa, primarySa)
      await cleanupSiblings(env, state.name, parentId, last.id, up.sa)
    }
    if (!last) throw new DriveError(500, 'InternalError', 'multipart concat did not produce a file')
    finalMeta = last
  } else {
    finalMeta = await concatInto(env, state, ordered, state.parentId, sa)
    await cleanupSiblings(env, state.name, state.parentId, finalMeta.id, sa)
  }

  await trashFile(env, state.folderId, sa)
  await env.FOLDER_CACHE.delete(stateKey(uploadId)).catch(() => {})
  return { etag: finalMeta.id }
}

/** Overwrite semantics: trash older files with the same name in the target folder. */
async function cleanupSiblings(env: Env, name: string, parentId: string, keepId: string, sa?: ServiceAccount): Promise<void> {
  const siblings = await findFilesInFolder(env, name, parentId, sa)
  for (const s of siblings) {
    if (s.id !== keepId) await trashFile(env, s.id, sa)
  }
}

export async function abortMultipart(env: Env, uploadId: string): Promise<void> {
  const state = await getState(env, uploadId)
  const sa = await sessionSa(env, state)
  await trashFile(env, state.folderId, sa)
  await env.FOLDER_CACHE.delete(stateKey(uploadId)).catch(() => {})
}

/**
 * Lazily trashes abandoned multipart temp folders older than 24h. Called on
 * CreateMultipartUpload; also Drive expires abandoned resumable sessions (~7 days).
 */
export async function gcMultipart(env: Env, bucket: string): Promise<void> {
  try {
    const mpRoot = await findCachedFolder(env, MULTIPART_ROOT, null)
    if (!mpRoot) return
    const bucketDir = await findCachedFolder(env, bucket, mpRoot)
    if (!bucketDir) return
    const cutoff = new Date(Date.now() - GC_AGE_MS).toISOString()
    let pageToken: string | undefined
    for (let page = 0; page < 5; page++) {
      const q = `'${bucketDir}' in parents and trashed=false and mimeType='${FOLDER_MIME}'`
      let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime)&spaces=drive${sharedDriveParams(env).search}`
      if (pageToken) url += `&pageToken=${pageToken}`
      const res = await driveFetch(env, url)
      if (!res.ok) return
      const data = (await res.json()) as {
        nextPageToken?: string
        files: { id: string; name: string; modifiedTime: string }[]
      }
      for (const f of data.files) {
        if (f.modifiedTime < cutoff) {
          await trashFile(env, f.id)
          await env.FOLDER_CACHE.delete(stateKey(f.name)).catch(() => {})
        }
      }
      pageToken = data.nextPageToken
      if (!pageToken) break
    }
  } catch {
    // best-effort cleanup; never fail the request because of GC
  }
}