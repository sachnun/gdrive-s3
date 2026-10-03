import type { Env } from '../env'
import { findCachedFolder, getOrCreateFolder, resolveExistingPath, resolvePathCreate } from '../drive/folder'
import { abortMultipart, completeMultipart, createMultipart, gcMultipart, getMultipartState, uploadPart, uploadPartMeta } from '../drive/multipart'
import { copyFile, findFilesInFolder } from '../drive/files'
import { bufferIfSmall, extractParts, uploadBody } from '../s3/request'
import * as xml from '../s3/xml'
import { requestId } from '../util'

export async function handleCreateMultipart(
  env: Env,
  req: Request,
  bucket: string,
  key: string,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const bucketFolderId = await getOrCreateFolder(env, bucket, null)
  const { parentId, name } = await resolvePathCreate(env, bucketFolderId, key)
  const contentType = req.headers.get('content-type') ?? 'application/octet-stream'
  const { uploadId } = await createMultipart(env, { bucket, key, parentId, name, contentType })
  waitUntil(gcMultipart(env, bucket))
  return xml.initiateMultipartXml(bucket, key, uploadId)
}

export async function handleUploadPart(
  env: Env,
  req: Request,
  bucket: string,
  key: string,
  params: URLSearchParams,
): Promise<Response> {
  const uploadId = params.get('uploadId') ?? ''
  const partNumber = parseInt(params.get('partNumber') ?? '', 10)
  if (!uploadId || isNaN(partNumber) || partNumber < 1) {
    return xml.s3Error(400, 'InvalidArgument', 'Invalid partNumber or uploadId', `/${bucket}/${key}`, requestId())
  }
  const { body, size } = uploadBody(req)
  const { body: stream, data } = await bufferIfSmall(body, size)
  const { etag } = await uploadPart(env, uploadId, partNumber, stream, size, data)
  return xml.uploadPartXml(etag)
}

export async function handleCompleteMultipart(
  env: Env,
  req: Request,
  bucket: string,
  key: string,
  params: URLSearchParams,
  region: string,
): Promise<Response> {
  const uploadId = params.get('uploadId') ?? ''
  const body = await req.text()
  const parts = extractParts(body)
  const { etag } = await completeMultipart(env, uploadId, parts)
  return xml.completeMultipartXml(bucket, key, etag, region)
}

export async function handleAbortMultipart(
  env: Env,
  bucket: string,
  key: string,
  params: URLSearchParams,
): Promise<Response> {
  const uploadId = params.get('uploadId') ?? ''
  await abortMultipart(env, uploadId)
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleListParts(env: Env, bucket: string, key: string, params: URLSearchParams): Promise<Response> {
  const uploadId = params.get('uploadId') ?? ''
  const state = await getMultipartState(env, uploadId)
  if (!state) return xml.s3Error(404, 'NoSuchUpload', 'The specified multipart upload does not exist.', `/${bucket}/${key}`, requestId())
  return xml.listPartsXml(bucket, key, uploadId, state.parts)
}

export async function handleUploadPartCopy(
  env: Env,
  req: Request,
  bucket: string,
  key: string,
  params: URLSearchParams,
): Promise<Response> {
  const uploadId = params.get('uploadId') ?? ''
  const partNumber = params.get('partNumber') ?? ''
  const state = await getMultipartState(env, uploadId)
  if (!state) return xml.s3Error(404, 'NoSuchUpload', 'The specified multipart upload does not exist.', `/${bucket}/${key}`, requestId())

  const raw = req.headers.get('x-amz-copy-source') ?? ''
  const srcPath = decodeURIComponent(raw).replace(/^\/+/, '')
  const slash = srcPath.indexOf('/')
  if (slash === -1) return xml.s3Error(400, 'InvalidArgument', 'Invalid copy source', `/${bucket}/${key}`, requestId())
  const srcBucket = srcPath.slice(0, slash)
  const srcKey = srcPath.slice(slash + 1)

  const srcBucketId = await findCachedFolder(env, srcBucket, null)
  if (!srcBucketId) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const target = await resolveExistingPath(env, srcBucketId, srcKey)
  const src = target ? (await findFilesInFolder(env, target.name, target.parentId))[0] : undefined
  if (!src) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())

  const range = req.headers.get('x-amz-copy-source-range')
  const copied = await copyFile(env, src.id, `part-${partNumber}`, state.folderId)
  const size = Number(src.size ?? 0)
  await uploadPartMeta(env, uploadId, partNumber, copied.id, size, copied.id)
  return xml.copyPartXml(copied.id, copied.modifiedTime ?? new Date().toISOString(), range)
}
