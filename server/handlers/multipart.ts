import type { Env } from '../env'
import { getOrCreateFolder, resolvePathCreate } from '../drive/folder'
import { abortMultipart, completeMultipart, createMultipart, gcMultipart, uploadPart } from '../drive/multipart'
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
  // Best-effort cleanup of abandoned sessions — never block the response on it.
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
): Promise<Response> {
  const uploadId = params.get('uploadId') ?? ''
  const body = await req.text()
  const parts = extractParts(body)
  const { etag } = await completeMultipart(env, uploadId, parts)
  return xml.completeMultipartXml(bucket, key, etag, env.REGION || 'us-east-1')
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
