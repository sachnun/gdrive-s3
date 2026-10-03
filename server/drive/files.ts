import type { Env } from '../env'
import { DRIVE_API, UPLOAD_API, driveFetch } from './auth'
import { DriveError } from './errors'
import { FOLDER_MIME, escQuery } from './folder'
import { randomHex } from '../util'

export interface FileMeta {
  id: string
  name: string
  size: string
  mimeType: string
  modifiedTime: string
  createdTime?: string
  trashed?: boolean
  appProperties?: Record<string, string>
}

export const FILE_FIELDS = 'id,name,size,mimeType,modifiedTime,createdTime,trashed,appProperties'

export async function getFileMeta(env: Env, id: string): Promise<FileMeta> {
  const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files/${id}?fields=${FILE_FIELDS}&supportsAllDrives=true`)
  if (res.status === 404) throw new DriveError(404, 'NoSuchKey', 'The specified key does not exist.')
  if (!res.ok) throw new DriveError(500, 'InternalError', `file metadata failed (HTTP ${res.status})`)
  return (await res.json()) as FileMeta
}

export async function createResumableSession(
  env: Env,
  metadata: { name: string; parents: string[]; mimeType?: string; appProperties?: Record<string, string> },
  size?: number,
): Promise<string> {
  const url = new URL(`${UPLOAD_API}/files`)
  url.searchParams.set('uploadType', 'resumable')
  url.searchParams.set('fields', FILE_FIELDS)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (size !== undefined) headers['X-Upload-Content-Length'] = String(size)
  const res = await driveFetch(env, url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(metadata),
  })
  const location = res.headers.get('Location')
  if (!res.ok || !location) {
    throw new DriveError(500, 'InternalError', `resumable session init failed (HTTP ${res.status})`)
  }
  return location
}

export async function uploadToSession(
  env: Env,
  location: string,
  body: BodyInit | null,
  size?: number,
  contentType?: string,
): Promise<FileMeta> {
  const headers: Record<string, string> = {}
  if (size !== undefined) headers['Content-Length'] = String(size)
  if (contentType) headers['Content-Type'] = contentType
  const res = await driveFetch(env, location, {
    method: 'PUT',
    headers,
    body,
    duplex: 'half',
  } as RequestInit)
  if (res.status === 200 || res.status === 201) return (await res.json()) as FileMeta
  throw new DriveError(500, 'InternalError', `resumable upload failed (HTTP ${res.status})`)
}

export async function uploadFile(
  env: Env,
  args: {
    parentId: string
    name: string
    body: BodyInit | null
    contentType?: string
    size?: number
    appProperties?: Record<string, string>
    data?: Uint8Array
  },
): Promise<FileMeta> {
  const { parentId, name, body, contentType, size, appProperties, data } = args
  if (data) return uploadSingleShot(env, args, data)
  const location = await createResumableSession(
    env,
    { name, parents: [parentId], mimeType: contentType, appProperties },
    size,
  )
  return uploadToSession(env, location, body, size, contentType)
}

async function uploadSingleShot(
  env: Env,
  args: { parentId: string; name: string; contentType?: string; appProperties?: Record<string, string> },
  content: Uint8Array,
): Promise<FileMeta> {
  const boundary = 'gds3' + randomHex(16)
  const metadata: Record<string, unknown> = { name: args.name, parents: [args.parentId] }
  if (args.contentType) metadata.mimeType = args.contentType
  if (args.appProperties) metadata.appProperties = args.appProperties
  const enc = new TextEncoder()
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${args.contentType ?? 'application/octet-stream'}\r\n\r\n`,
  )
  const tail = enc.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(head.length + content.length + tail.length)
  body.set(head, 0)
  body.set(content, head.length)
  body.set(tail, head.length + content.length)
  const res = await driveFetch(
    env,
    `${UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
  )
  if (!res.ok) throw new DriveError(500, 'InternalError', `upload failed (HTTP ${res.status})`)
  return (await res.json()) as FileMeta
}

export async function downloadFile(env: Env, id: string, range?: string | null): Promise<Response> {
  const headers: Record<string, string> = {}
  if (range) headers['Range'] = range
  return driveFetch(env, `${DRIVE_API}/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers })
}

export async function findFilesInFolder(env: Env, name: string, parentId: string): Promise<FileMeta[]> {
  const q = `name='${escQuery(name)}' and '${parentId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`
  const url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=files(${FILE_FIELDS})&orderBy=createdTime desc&spaces=drive`
  const res = await driveFetch(env, url)
  if (!res.ok) throw new DriveError(500, 'InternalError', `file search failed (HTTP ${res.status})`)
  const data = (await res.json()) as { files: FileMeta[] }
  return data.files ?? []
}

export async function trashFile(env: Env, id: string): Promise<void> {
  const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  })
  if (!res.ok && res.status !== 404) {
    throw new DriveError(500, 'InternalError', `trash failed (HTTP ${res.status})`)
  }
}

export async function copyFile(env: Env, srcId: string, name: string, parentId: string): Promise<FileMeta> {
  const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files/${srcId}/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId] }),
  })
  if (!res.ok) throw new DriveError(500, 'InternalError', `copy failed (HTTP ${res.status})`)
  return (await res.json()) as FileMeta
}

const BATCH_URL = 'https://www.googleapis.com/batch/drive/v3'
const BATCH_SIZE = 20

function buildBatch(ids: string[]): { body: string; boundary: string } {
  const boundary = `gdrive_s3_batch_${randomHex(8)}`
  const parts = ids.map((id, i) =>
    [
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: <item-${i}>`,
      '',
      `PATCH /drive/v3/files/${encodeURIComponent(id)} HTTP/1.1`,
      'Content-Type: application/json',
      '',
      JSON.stringify({ trashed: true }),
      '',
    ].join('\r\n'),
  )
  return { body: `${parts.join('')}--${boundary}--\r\n`, boundary }
}

export async function trashFiles(env: Env, ids: string[]): Promise<Map<string, string | null>> {
  const failed = new Map<string, string | null>()
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE)
    const { body, boundary } = buildBatch(chunk)
    const res = await driveFetch(env, BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
      body,
    })
    if (!res.ok) {
      for (const id of chunk) failed.set(id, `batch failed (HTTP ${res.status})`)
      continue
    }
    const text = await res.text()
    const statuses = [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]))
    chunk.forEach((id, idx) => {
      const status = statuses[idx]
      if (status === undefined) failed.set(id, 'no batch response')
      else if (status >= 400 && status !== 404) failed.set(id, `HTTP ${status}`)
    })
  }
  return failed
}
