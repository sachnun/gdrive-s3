import type { Env } from '../env'
import { DRIVE_API, UPLOAD_API, driveFetch, type ServiceAccount } from './auth'
import { DriveError } from './errors'
import { FOLDER_MIME, escQuery, sharedDriveParams, usingSharedDrive } from './folder'
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

export async function getFileMeta(env: Env, id: string, sa?: ServiceAccount): Promise<FileMeta> {
  const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files/${id}?fields=${FILE_FIELDS}${sharedDriveParams(env).res}`, {}, { sa })
  if (res.status === 404) throw new DriveError(404, 'NoSuchKey', 'The specified key does not exist.')
  if (!res.ok) throw new DriveError(500, 'InternalError', `file metadata failed (HTTP ${res.status})`)
  return (await res.json()) as FileMeta
}

/** Initializes a resumable upload session, returning the session Location URL. */
export async function createResumableSession(
  env: Env,
  metadata: { name: string; parents: string[]; mimeType?: string; appProperties?: Record<string, string> },
  size?: number,
  sa?: ServiceAccount,
): Promise<string> {
  const url = new URL(`${UPLOAD_API}/files`)
  url.searchParams.set('uploadType', 'resumable')
  url.searchParams.set('fields', FILE_FIELDS)
  if (usingSharedDrive(env)) url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('includeItemsFromAllDrives', 'true')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (size !== undefined) headers['X-Upload-Content-Length'] = String(size)
  const res = await driveFetch(env, url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(metadata),
  }, { sa })
  const location = res.headers.get('Location')
  if (!res.ok || !location) {
    throw new DriveError(500, 'InternalError', `resumable session init failed (HTTP ${res.status})`)
  }
  return location
}

/** Streams a body into a resumable session. Returns file metadata on completion. */
export async function uploadToSession(
  env: Env,
  location: string,
  body: BodyInit | null,
  size?: number,
  contentType?: string,
  sa?: ServiceAccount,
): Promise<FileMeta> {
  const headers: Record<string, string> = {}
  if (size !== undefined) headers['Content-Length'] = String(size)
  if (contentType) headers['Content-Type'] = contentType
  const res = await driveFetch(env, location, {
    method: 'PUT',
    headers,
    body,
    duplex: 'half',
  } as RequestInit, { sa })
  if (res.status === 200 || res.status === 201) return (await res.json()) as FileMeta
  throw new DriveError(500, 'InternalError', `resumable upload failed (HTTP ${res.status})`)
}

/**
 * Uploads a file to Drive.
 *
 * With `data` (fully-buffered body, caller-checked ≤4 MiB): single-shot
 * `uploadType=multipart` — one Drive round trip instead of the two that a
 * resumable session costs. Otherwise: streaming resumable upload.
 */
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
    sa?: ServiceAccount
  },
): Promise<FileMeta> {
  const { parentId, name, body, contentType, size, appProperties, data, sa } = args
  if (data) return uploadSingleShot(env, args, data, sa)
  const location = await createResumableSession(
    env,
    { name, parents: [parentId], mimeType: contentType, appProperties },
    size,
    sa,
  )
  return uploadToSession(env, location, body, size, contentType, sa)
}

/** One-request upload (metadata + content as multipart/related); ≤5 MiB only. */
async function uploadSingleShot(
  env: Env,
  args: { parentId: string; name: string; contentType?: string; appProperties?: Record<string, string> },
  content: Uint8Array,
  sa?: ServiceAccount,
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
    `${UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}${usingSharedDrive(env) ? '&supportsAllDrives=true' : ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
    { sa },
  )
  if (!res.ok) throw new DriveError(500, 'InternalError', `upload failed (HTTP ${res.status})`)
  return (await res.json()) as FileMeta
}

/** Streams file content; optionally forwards a Range header (Drive supports it). */
export async function downloadFile(env: Env, id: string, range?: string | null, sa?: ServiceAccount): Promise<Response> {
  const headers: Record<string, string> = {}
  if (range) headers['Range'] = range
  return driveFetch(env, `${DRIVE_API}/drive/v3/files/${id}?alt=media${sharedDriveParams(env).res}`, { headers }, { sa })
}

/**
 * Finds files by exact name in a folder (newest created first, folders excluded).
 * Drive allows duplicate names, so callers pick the first (newest) result.
 */
export async function findFilesInFolder(env: Env, name: string, parentId: string, sa?: ServiceAccount): Promise<FileMeta[]> {
  const q = `name='${escQuery(name)}' and '${parentId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`
  const url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=files(${FILE_FIELDS})&orderBy=createdTime desc&spaces=drive${sharedDriveParams(env).search}`
  const res = await driveFetch(env, url, {}, { sa })
  if (!res.ok) throw new DriveError(500, 'InternalError', `file search failed (HTTP ${res.status})`)
  const data = (await res.json()) as { files: FileMeta[] }
  return data.files ?? []
}

/** Moves a file/folder to the Drive trash (safe delete; no permanent removal). */
export async function trashFile(env: Env, id: string, sa?: ServiceAccount): Promise<void> {
  const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files/${id}${sharedDriveParams(env).res}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  }, { sa })
  if (!res.ok && res.status !== 404) {
    throw new DriveError(500, 'InternalError', `trash failed (HTTP ${res.status})`)
  }
}

export async function copyFile(env: Env, srcId: string, name: string, parentId: string, sa?: ServiceAccount): Promise<FileMeta> {
  const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files/${srcId}/copy${sharedDriveParams(env).res}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId] }),
  }, { sa })
  if (!res.ok) throw new DriveError(500, 'InternalError', `copy failed (HTTP ${res.status})`)
  return (await res.json()) as FileMeta
}
