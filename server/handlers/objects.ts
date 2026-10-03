import type { Env } from '../env'
import { DriveError } from '../drive/errors'
import { findCachedFolder, resolveExistingPath, resolvePathCreate, getOrCreateFolder } from '../drive/folder'
import { copyFile, downloadFile, findFilesInFolder, patchAppProperties, trashFile, uploadFile } from '../drive/files'
import { contEvent, endEvent, eventStreamResponse, recordsEvent, statsEvent } from '../s3/eventstream'
import { bufferIfSmall, extractXmlTags, uploadBody } from '../s3/request'
import { parseSelectRequest, runSelect } from '../s3/select'
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

export async function handlePutObjectTagging(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const tags = extractXmlTags(await req.text())
  const existingTags = Object.keys(file.appProperties ?? {}).filter((k) => k.startsWith('x-amz-tag-'))
  const props: Record<string, string> = {}
  for (const [k, v] of Object.entries(file.appProperties ?? {})) {
    if (!k.startsWith('x-amz-tag-')) props[k] = v
  }
  for (const { key: tk, value } of tags) props[`x-amz-tag-${tk}`] = value.slice(0, 120)
  await patchAppProperties(env, file.id, props, existingTags)
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleDeleteObjectTagging(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const existingTags = Object.keys(file.appProperties ?? {}).filter((k) => k.startsWith('x-amz-tag-'))
  const props: Record<string, string> = {}
  for (const [k, v] of Object.entries(file.appProperties ?? {})) {
    if (!k.startsWith('x-amz-tag-')) props[k] = v
  }
  await patchAppProperties(env, file.id, props, existingTags)
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleGetObjectAttributes(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  return xml.objectAttributesXml(file.id, file.size ?? '0')
}

export async function handlePutObjectAcl(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleGetObjectLegalHold(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  return xml.legalHoldXml(file.appProperties?.['x-amz-legal-hold'] ?? 'OFF')
}

export async function handlePutObjectLegalHold(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const status = /<Status>\s*(ON|OFF)\s*<\/Status>/i.exec(await req.text())?.[1]?.toUpperCase() ?? 'OFF'
  await patchAppProperties(env, file.id, { 'x-amz-legal-hold': status })
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleGetObjectRetention(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const mode = file.appProperties?.['x-amz-retention-mode']
  const until = file.appProperties?.['x-amz-retain-until']
  if (!mode || !until) {
    return xml.s3Error(404, 'NoSuchObjectLockConfiguration', 'The specified object does not have a ObjectLock configuration', `/${bucket}/${key}`, requestId())
  }
  return xml.retentionXml(mode, until)
}

export async function handlePutObjectRetention(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const body = await req.text()
  const mode = /<Mode>\s*([A-Za-z]+)\s*<\/Mode>/.exec(body)?.[1] ?? 'GOVERNANCE'
  const until = /<RetainUntilDate>\s*([^<\s]+)\s*<\/RetainUntilDate>/.exec(body)?.[1] ?? new Date(Date.now() + 86400000).toISOString()
  await patchAppProperties(env, file.id, { 'x-amz-retention-mode': mode, 'x-amz-retain-until': until })
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleRenameObject(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const raw = req.headers.get('x-amz-rename-source') ?? ''
  const srcPath = decodeURIComponent(raw).replace(/^\/+/, '')
  const slash = srcPath.indexOf('/')
  if (slash === -1) return xml.s3Error(400, 'InvalidArgument', 'Invalid rename source', `/${bucket}/${key}`, requestId())
  const srcKey = srcPath.slice(slash + 1)
  const bucketFolderId = await findCachedFolder(env, bucket, null)
  if (!bucketFolderId) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  const target = await resolveExistingPath(env, bucketFolderId, srcKey)
  const src = target ? (await findFilesInFolder(env, target.name, target.parentId))[0] : undefined
  if (!src) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const dest = await resolvePathCreate(env, bucketFolderId, key)
  const copied = await copyFile(env, src.id, dest.name, dest.parentId)
  await trashFile(env, src.id)
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleRestoreObject(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleSelectObjectContent(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const selectReq = parseSelectRequest(await req.text())
  if (!selectReq) {
    return xml.s3Error(400, 'InvalidRequestParameter', 'The SQL expression is invalid or unsupported.', `/${bucket}/${key}`, requestId())
  }
  const download = await downloadFile(env, file.id, null)
  if (download.status !== 200) {
    return xml.s3Error(502, 'InternalError', `Drive download failed (HTTP ${download.status})`, `/${bucket}/${key}`, requestId())
  }
  const data = new Uint8Array(await download.arrayBuffer())
  const result = runSelect(data, selectReq)
  const chunks: Uint8Array[] = []
  if (result.payload.length > 0) chunks.push(recordsEvent(result.payload))
  chunks.push(statsEvent(result.bytesScanned, result.bytesProcessed, result.bytesReturned))
  chunks.push(endEvent())
  return eventStreamResponse(chunks)
}
