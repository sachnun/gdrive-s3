import type { Env } from '../env'
import { randomHex } from '../util'
import { DRIVE_API, driveFetch } from './auth'
import { DriveError } from './errors'
import { FOLDER_MIME, findCachedFolder, getOrCreateFolder } from './folder'
import { createResumableSession, findFilesInFolder, trashFile, uploadFile, uploadToSession, type FileMeta } from './files'

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
}

function stateKey(uploadId: string): string {
  return `multipart:${uploadId}`
}

export async function getMultipartState(env: Env, uploadId: string): Promise<MultipartState | null> {
  const raw = await env.FOLDER_CACHE.get(stateKey(uploadId)).catch(() => null)
  if (!raw) return null
  try {
    return JSON.parse(raw) as MultipartState
  } catch {
    return null
  }
}

async function getState(env: Env, uploadId: string): Promise<MultipartState> {
  const raw = await env.FOLDER_CACHE.get(stateKey(uploadId))
  if (!raw) throw new DriveError(404, 'NoSuchUpload', 'The specified multipart upload does not exist.')
  return JSON.parse(raw) as MultipartState
}

export async function createMultipart(
  env: Env,
  args: { bucket: string; key: string; parentId: string; name: string; contentType: string },
): Promise<{ uploadId: string }> {
  const uploadId = randomHex(24)
  const mpRoot = await getOrCreateFolder(env, MULTIPART_ROOT, null)
  const bucketDir = await getOrCreateFolder(env, args.bucket, mpRoot)
  const folderId = await getOrCreateFolder(env, uploadId, bucketDir)
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
  await env.FOLDER_CACHE.put(stateKey(uploadId), JSON.stringify(state))
  return { uploadId }
}

export async function uploadPart(
  env: Env,
  uploadId: string,
  partNumber: number,
  body: BodyInit | null,
  size?: number,
  data?: Uint8Array,
): Promise<{ etag: string }> {
  const state = await getState(env, uploadId)
  const n = String(partNumber)
  const existing = state.parts[n]
  if (existing) {
    await trashFile(env, existing.fileId)
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
  })
  const etag = meta.id
  state.parts[n] = { fileId: meta.id, size: meta.size ? Number(meta.size) : (size ?? 0), etag }
  await env.FOLDER_CACHE.put(stateKey(uploadId), JSON.stringify(state))
  return { etag }
}

async function reconcileParts(env: Env, state: MultipartState): Promise<void> {
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const q = `'${state.folderId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`
    let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,size,appProperties)&spaces=drive`
    if (pageToken) url += `&pageToken=${pageToken}`
    const res = await driveFetch(env, url)
    if (!res.ok) throw new DriveError(500, 'InternalError', `multipart reconcile failed (HTTP ${res.status})`)
    const data = (await res.json()) as {
      nextPageToken?: string
      files: { id: string; size?: string; appProperties?: Record<string, string> }[]
    }
    for (const f of data.files) {
      const n = f.appProperties?.partNumber
      if (n) state.parts[n] = { fileId: f.id, size: f.size ? Number(f.size) : 0, etag: f.id }
    }
    pageToken = data.nextPageToken
    if (!pageToken) break
  }
}

export async function completeMultipart(
  env: Env,
  uploadId: string,
  requested: { partNumber: number; etag: string }[],
): Promise<{ etag: string }> {
  const state = await getState(env, uploadId)
  const needsReconcile =
    requested.length === 0 || !requested.every((r) => state.parts[String(r.partNumber)])
  if (needsReconcile) await reconcileParts(env, state)

  let ordered: { partNumber: number; fileId: string; size: number }[]
  if (requested.length === 0) {
    ordered = Object.entries(state.parts)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, p]) => ({ partNumber: 0, fileId: p.fileId, size: p.size }))
  } else {
    ordered = requested.map((r) => {
      const p = state.parts[String(r.partNumber)]
      if (!p) throw new DriveError(400, 'InvalidPart', `Part ${r.partNumber} was not uploaded.`)
      if (p.etag !== r.etag) throw new DriveError(400, 'InvalidPart', `ETag mismatch for part ${r.partNumber}.`)
      return { partNumber: r.partNumber, fileId: p.fileId, size: p.size }
    })
  }

  const totalSize = ordered.reduce((s, p) => s + p.size, 0)
  const location = await createResumableSession(
    env,
    { name: state.name, parents: [state.parentId], mimeType: state.contentType },
    totalSize,
  )

  let finalMeta: FileMeta | undefined
  if (ordered.length === 0) {
    finalMeta = await uploadToSession(env, location, null, 0, state.contentType)
  } else {
    finalMeta = await uploadToSession(env, location, concatParts(env, ordered), totalSize, state.contentType)
  }
  if (!finalMeta) throw new DriveError(500, 'InternalError', 'multipart concat did not produce a file')

  const siblings = await findFilesInFolder(env, state.name, state.parentId)
  for (const s of siblings) {
    if (s.id !== finalMeta.id) await trashFile(env, s.id)
  }

  await trashFile(env, state.folderId)
  await env.FOLDER_CACHE.delete(stateKey(uploadId)).catch(() => {})
  return { etag: finalMeta.id }
}

function concatParts(env: Env, parts: { partNumber: number; fileId: string; size: number }[]): ReadableStream<Uint8Array> {
  let index = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (index >= parts.length) {
            controller.close()
            return
          }
          const p = parts[index++]
          const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files/${p.fileId}?alt=media&supportsAllDrives=true`)
          if (!res.ok || !res.body) {
            controller.error(new DriveError(500, 'InternalError', `read part ${p.partNumber} failed (HTTP ${res.status})`))
            return
          }
          reader = res.body.getReader()
        }
        const { done, value } = await reader.read()
        if (done) {
          reader = null
          continue
        }
        controller.enqueue(value)
        return
      }
    },
    cancel(reason) {
      void reader?.cancel(reason)
    },
  })
}

export async function abortMultipart(env: Env, uploadId: string): Promise<void> {
  const state = await getState(env, uploadId)
  await trashFile(env, state.folderId)
  await env.FOLDER_CACHE.delete(stateKey(uploadId)).catch(() => {})
}

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
      let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime)&spaces=drive`
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
  }
}

export interface UploadSummary {
  key: string
  uploadId: string
  initiated: string
  size: number
}

export async function listUploads(
  env: Env,
  bucket: string,
  prefix: string,
  limit: number,
): Promise<UploadSummary[]> {
  const mpRoot = await findCachedFolder(env, MULTIPART_ROOT, null)
  if (!mpRoot) return []
  const bucketDir = await findCachedFolder(env, bucket, mpRoot)
  if (!bucketDir) return []
  const q = `'${bucketDir}' in parents and trashed=false and mimeType='${FOLDER_MIME}'`
  const url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=files(id,name,createdTime,modifiedTime)&spaces=drive`
  const res = await driveFetch(env, url)
  if (!res.ok) return []
  const data = (await res.json()) as {
    files: { id: string; name: string; createdTime: string; modifiedTime: string }[]
  }
  const out: UploadSummary[] = []
  for (const f of data.files) {
    if (out.length >= limit) break
    const raw = await env.FOLDER_CACHE.get(stateKey(f.name)).catch(() => null)
    if (!raw) continue
    const state = JSON.parse(raw) as MultipartState
    if (prefix && !state.key.startsWith(prefix)) continue
    let size = 0
    for (const p of Object.values(state.parts)) size += p.size
    out.push({ key: state.key, uploadId: f.name, initiated: state.createdAt ? new Date(state.createdAt).toISOString() : f.createdTime, size })
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out
}

export async function uploadPartMeta(
  env: Env,
  uploadId: string,
  partNumber: string,
  fileId: string,
  size: number,
  etag: string,
): Promise<void> {
  const state = await getState(env, uploadId)
  const existing = state.parts[partNumber]
  if (existing) await trashFile(env, existing.fileId)
  state.parts[partNumber] = { fileId, size, etag }
  await env.FOLDER_CACHE.put(stateKey(uploadId), JSON.stringify(state))
}
