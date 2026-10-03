import type { Env } from '../env'
import { DriveError } from '../drive/errors'
import { findCachedFolder, resolveExistingPath, resolvePathCreate, getOrCreateFolder } from '../drive/folder'
import { copyFile, downloadFile, findFilesInFolder, trashFile, uploadFile } from '../drive/files'
import { bufferIfSmall, uploadBody } from '../s3/request'
import * as xml from '../s3/xml'
import { requestId, toHttpDate } from '../util'

export async function handlePutObject(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const bucketFolderId = await getOrCreateFolder(env, bucket, null)
  const copySource = req.headers.get('x-amz-copy-source')
  if (copySource) return handleCopyObject(env, bucket, key, bucketFolderId, copySource)
  const { parentId, name } = await resolvePathCreate(env, bucketFolderId, key)
  const contentType = req.headers.get('content-type') ?? 'application/octet-stream'
  const { body, size } = uploadBody(req)
  const { body: stream, data } = await bufferIfSmall(body, size)
  const appProperties = metaToAppProperties(req.headers)
  const meta = await uploadFile(env, { parentId, name, body: stream, contentType, size, appProperties, data })
  await deleteOld(env, parentId, name, meta.id)
  return new Response('', { status: 200, headers: { ETag: `"${meta.id}"`, 'x-amz-request-id': requestId() } })
}

async function handleCopyObject(
  env: Env,
  bucket: string,
  key: string,
  bucketFolderId: string,
  copySource: string,
): Promise<Response> {
  let srcPath: string
  try {
    srcPath = decodeURIComponent(copySource).replace(/^\/+/, '')
  } catch {
    srcPath = copySource.replace(/^\/+/, '')
  }
  const slash = srcPath.indexOf('/')
  const srcBucket = slash === -1 ? srcPath : srcPath.slice(0, slash)
  const srcKey = slash === -1 ? '' : srcPath.slice(slash + 1)
  const srcBucketFolderId = srcBucket === bucket ? bucketFolderId : await findCachedFolder(env, srcBucket, null)
  if (!srcBucketFolderId) {
    return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  }
  const srcRes = await resolveExistingPath(env, srcBucketFolderId, srcKey)
  const srcFile = srcRes ? (await findFilesInFolder(env, srcRes.name, srcRes.parentId))[0] : undefined
  if (!srcFile) {
    return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  }
  const dest = await resolvePathCreate(env, bucketFolderId, key)
  const copied = await copyFile(env, srcFile.id, dest.name, dest.parentId)
  await deleteOld(env, dest.parentId, dest.name, copied.id)
  return xml.copyObjectXml(copied.id, copied.modifiedTime ?? new Date().toISOString())
}

export async function handleGetObject(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const res = await downloadFile(env, file.id, req.headers.get('range'))
  if (res.status === 404) {
    return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  }
  const headers: Record<string, string> = {
    'Content-Type': file.mimeType || 'application/octet-stream',
    'ETag': `"${file.id}"`,
    'Last-Modified': toHttpDate(file.modifiedTime),
    'Accept-Ranges': 'bytes',
    ...metaHeaders(file),
    'x-amz-request-id': requestId(),
  }
  const cl = res.headers.get('content-length')
  if (cl) headers['Content-Length'] = cl
  if (res.status === 206) {
    const cr = res.headers.get('content-range')
    if (cr) headers['Content-Range'] = cr
    return new Response(res.body, { status: 206, headers })
  }
  if (res.status !== 200) {
    throw new DriveError(502, 'InternalError', `Drive download failed (HTTP ${res.status})`)
  }
  return new Response(res.body, { status: 200, headers })
}

export async function handleHeadObject(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const headers: Record<string, string> = {
    'Content-Type': file.mimeType || 'application/octet-stream',
    'Content-Length': file.size ?? '0',
    'ETag': `"${file.id}"`,
    'Last-Modified': toHttpDate(file.modifiedTime),
    'Accept-Ranges': 'bytes',
    ...metaHeaders(file),
    'x-amz-request-id': requestId(),
  }
  return new Response(null, { status: 200, headers })
}

export async function handleDeleteObject(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (file) await trashFile(env, file.id)
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

async function findObject(
  env: Env,
  bucket: string,
  key: string,
): Promise<{ id: string; name: string; mimeType: string; size: string; modifiedTime: string; appProperties?: Record<string, string> } | null> {
  const bucketFolderId = await findCachedFolder(env, bucket, null)
  if (!bucketFolderId) return null
  const target = await resolveExistingPath(env, bucketFolderId, key)
  if (!target) return null
  const files = await findFilesInFolder(env, target.name, target.parentId)
  return files[0] ?? null
}

async function deleteOld(env: Env, parentId: string, name: string, keepId: string): Promise<void> {
  const files = await findFilesInFolder(env, name, parentId)
  for (const f of files) {
    if (f.id !== keepId) await trashFile(env, f.id)
  }
}

function metaToAppProperties(headers: Headers): Record<string, string> | undefined {
  const props: Record<string, string> = {}
  for (const [k, v] of headers.entries()) {
    if (k.startsWith('x-amz-meta-')) props[k] = v.slice(0, 120)
  }
  return Object.keys(props).length ? props : undefined
}

function metaHeaders(file: { appProperties?: Record<string, string> }): Record<string, string> {
  const out: Record<string, string> = {}
  if (file.appProperties) {
    for (const [k, v] of Object.entries(file.appProperties)) {
      if (k.startsWith('x-amz-meta-')) out[k] = v
    }
  }
  return out
}

export async function handleGetObjectAcl(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  return xml.aclXml()
}

export async function handleGetObjectTagging(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  return xml.taggingXml(file.appProperties)
}
