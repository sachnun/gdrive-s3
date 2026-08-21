import { Hono } from 'hono'
import type { Env } from './env'
import { DRIVE_API, driveFetch } from './drive/auth'
import { DriveError } from './drive/errors'
import { FOLDER_MIME, findFolder, getOrCreateFolder, resolveExistingPath, resolvePathCreate } from './drive/folder'
import { copyFile, downloadFile, findFilesInFolder, getFileMeta, trashFile, uploadFile } from './drive/files'
import { abortMultipart, completeMultipart, createMultipart, gcMultipart, uploadPart } from './drive/multipart'
import { checkBucket, isPublicReadBucket, parseRequest, verifyRequest } from './middleware'
import { listObjects, type ListOptions } from './s3/list'
import * as xml from './s3/xml'
import { decodeAwsChunked, isAwsChunked } from './s3/chunked'
import { requestId, toHttpDate } from './util'

const app = new Hono<{ Bindings: Env }>()

app.all('*', async (c) => {
  const env = c.env
  const req = c.req.raw
  const method = req.method
  const rawUrl = req.url
  const url = new URL(rawUrl)
  const rawPath = url.pathname
  const params = url.searchParams

  if (method === 'OPTIONS') return preflightResponse()

  try {
    const res = await dispatch(env, req, method, rawPath, params)
    return withCors(req, res)
  } catch (err) {
    if (err instanceof DriveError) {
      return withCors(req, xml.s3Error(err.status, err.code, err.message, rawPath, requestId()))
    }
    console.error('gdrive-s3 error:', err)
    return withCors(
      req,
      xml.s3Error(500, 'InternalError', 'We encountered an internal error. Please try again.', rawPath, requestId()),
    )
  }
})

async function dispatch(
  env: Env,
  req: Request,
  method: string,
  rawPath: string,
  params: URLSearchParams,
): Promise<Response> {
  const { bucket, key } = parseRequest(rawPath)

  // Root path: ListBuckets.
  if (!bucket) {
    if (method === 'GET') return handleListBuckets(env)
    return xml.s3Error(400, 'InvalidRequest', 'Unknown request at root path', rawPath, requestId())
  }

  const gate = checkBucket(env, bucket)
  if (!gate.ok) return gate.response

  const publicRead = (method === 'GET' || method === 'HEAD') && isPublicReadBucket(env, bucket)
  if (!publicRead) {
    const sig = await verifyRequest(env, req)
    if (!sig.ok) return xml.s3Error(sig.status, sig.code, sig.message, rawPath, requestId())
  }

  // ----- bucket-level operations -----
  if (!key) {
    switch (method) {
      case 'GET':
        if (params.has('location')) return handleGetBucketLocation(env, bucket)
        if (params.has('delete')) return handleDeleteObjects(env, req, bucket)
        return handleListObjects(env, bucket, params, params.get('list-type') === '2')
      case 'HEAD':
        return handleHeadBucket(env, bucket)
      case 'PUT':
        return handleCreateBucket(env, bucket)
      case 'POST':
        if (params.has('delete')) return handleDeleteObjects(env, req, bucket)
        return xml.s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', rawPath, requestId())
      case 'DELETE':
        if (params.has('delete')) return handleDeleteObjects(env, req, bucket)
        return xml.s3Error(501, 'NotImplemented', 'DeleteBucket is not supported (objects are moved to trash; buckets are never deleted).', rawPath, requestId())
      default:
        return xml.s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', rawPath, requestId())
    }
  }

  // ----- object-level operations -----
  const isUploadMethod = method === 'PUT' || method === 'POST'
  if (isUploadMethod && params.has('uploads')) return handleCreateMultipart(env, req, bucket, key)
  if (params.has('uploadId')) {
    if (params.has('partNumber') && method === 'PUT') return handleUploadPart(env, req, bucket, key, params)
    if (method === 'POST') return handleCompleteMultipart(env, req, bucket, key, params)
    if (method === 'DELETE') return handleAbortMultipart(env, bucket, key, params)
    return xml.s3Error(400, 'InvalidRequest', 'Invalid multipart request', rawPath, requestId())
  }
  switch (method) {
    case 'PUT':
      return handlePutObject(env, req, bucket, key)
    case 'GET':
      return handleGetObject(env, req, bucket, key)
    case 'HEAD':
      return handleHeadObject(env, bucket, key)
    case 'DELETE':
      return handleDeleteObject(env, bucket, key)
    default:
      return xml.s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', rawPath, requestId())
  }
}

// ---------- buckets ----------

async function handleListBuckets(env: Env): Promise<Response> {
  const allowed = (env.ALLOWED_BUCKETS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const buckets: { name: string; creationDate: string }[] = []
  const found = new Set<string>()
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const q = `mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`
    let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,createdTime)&spaces=drive&orderBy=name`
    if (pageToken) url += `&pageToken=${pageToken}`
    const res = await driveFetch(env, url)
    if (!res.ok) throw new DriveError(500, 'InternalError', `bucket list failed (HTTP ${res.status})`)
    const data = (await res.json()) as { nextPageToken?: string; files: { id: string; name: string; createdTime: string }[] }
    for (const f of data.files) {
      if (allowed.includes(f.name) && !found.has(f.name)) {
        buckets.push({ name: f.name, creationDate: f.createdTime })
        found.add(f.name)
      }
    }
    pageToken = data.nextPageToken
    if (!pageToken) break
  }
  // Fallback for allowed buckets not seen in the root listing (e.g. >1000 root folders).
  for (const name of allowed) {
    if (found.has(name)) continue
    const id = await findFolder(env, name, null)
    if (id) {
      try {
        const meta = await getFileMeta(env, id)
        buckets.push({ name, creationDate: meta.createdTime ?? '' })
      } catch {
        buckets.push({ name, creationDate: '' })
      }
    }
  }
  buckets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return xml.listBucketsXml(buckets)
}

async function handleHeadBucket(env: Env, bucket: string): Promise<Response> {
  const id = await findFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

async function handleCreateBucket(env: Env, bucket: string): Promise<Response> {
  await getOrCreateFolder(env, bucket, null)
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

async function handleGetBucketLocation(env: Env, bucket: string): Promise<Response> {
  const id = await findFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.locationXml(env.REGION || 'us-east-1')
}

async function handleListObjects(env: Env, bucket: string, params: URLSearchParams, isV2: boolean): Promise<Response> {
  const bucketFolderId = await findFolder(env, bucket, null)
  const maxKeysRaw = parseInt(params.get('max-keys') ?? '1000', 10)
  const maxKeys = isNaN(maxKeysRaw) ? 1000 : Math.min(Math.max(maxKeysRaw, 0), 1000)
  const opts: ListOptions = {
    bucket,
    prefix: (params.get('prefix') ?? '').replace(/^\/+/, ''),
    delimiter: params.get('delimiter') ?? '',
    maxKeys,
    marker: params.get('marker') ?? undefined,
    continuationToken: params.get('continuation-token') ?? undefined,
    startAfter: params.get('start-after') ?? undefined,
    isV2,
    encodingType: params.get('encoding-type') ?? undefined,
  }
  const result = await listObjects(env, bucketFolderId, opts)
  return xml.listObjectsXml(opts, result, requestId())
}

async function handleDeleteObjects(env: Env, req: Request, bucket: string): Promise<Response> {
  const body = await req.text()
  const keys = extractXmlKeys(body)
  const deleted: string[] = []
  const errors: { key: string; code: string; message: string }[] = []
  for (const k of keys) {
    try {
      const bucketFolderId = await findFolder(env, bucket, null)
      const target = bucketFolderId ? await resolveExistingPath(env, bucketFolderId, k) : null
      const file = target ? (await findFilesInFolder(env, target.name, target.parentId))[0] : undefined
      if (file) await trashFile(env, file.id)
      deleted.push(k)
    } catch {
      errors.push({ key: k, code: 'InternalError', message: 'failed to delete object' })
    }
  }
  return xml.deleteResultXml(deleted, errors)
}

// ---------- objects ----------

async function handlePutObject(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const bucketFolderId = await getOrCreateFolder(env, bucket, null)
  const copySource = req.headers.get('x-amz-copy-source')
  if (copySource) return handleCopyObject(env, bucket, key, bucketFolderId, copySource)
  const { parentId, name } = await resolvePathCreate(env, bucketFolderId, key)
  const contentType = req.headers.get('content-type') ?? 'application/octet-stream'
  const { body, size } = uploadBody(req)
  const appProperties = metaToAppProperties(req.headers)
  const meta = await uploadFile(env, { parentId, name, body, contentType, size, appProperties })
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
  const srcBucketFolderId = srcBucket === bucket ? bucketFolderId : await findFolder(env, srcBucket, null)
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

async function handleGetObject(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (!file) return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  const range = req.headers.get('range')
  const res = await downloadFile(env, file.id, range)
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

async function handleHeadObject(env: Env, bucket: string, key: string): Promise<Response> {
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

async function handleDeleteObject(env: Env, bucket: string, key: string): Promise<Response> {
  const file = await findObject(env, bucket, key)
  if (file) await trashFile(env, file.id)
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

// ---------- multipart ----------

async function handleCreateMultipart(env: Env, req: Request, bucket: string, key: string): Promise<Response> {
  const bucketFolderId = await getOrCreateFolder(env, bucket, null)
  const { parentId, name } = await resolvePathCreate(env, bucketFolderId, key)
  const contentType = req.headers.get('content-type') ?? 'application/octet-stream'
  const { uploadId } = await createMultipart(env, { bucket, key, parentId, name, contentType })
  await gcMultipart(env, bucket)
  return xml.initiateMultipartXml(bucket, key, uploadId)
}

async function handleUploadPart(
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
  const { etag } = await uploadPart(env, uploadId, partNumber, body, size)
  return xml.uploadPartXml(etag)
}

async function handleCompleteMultipart(
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

async function handleAbortMultipart(
  env: Env,
  bucket: string,
  key: string,
  params: URLSearchParams,
): Promise<Response> {
  const uploadId = params.get('uploadId') ?? ''
  await abortMultipart(env, uploadId)
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

// ---------- helpers ----------

/** Resolves a key to the newest file with that name (folders excluded). */
async function findObject(
  env: Env,
  bucket: string,
  key: string,
): Promise<{ id: string; name: string; mimeType: string; size: string; modifiedTime: string; appProperties?: Record<string, string> } | null> {
  const bucketFolderId = await findFolder(env, bucket, null)
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

function parseLength(h: string | null): number | undefined {
  if (!h) return undefined
  const n = parseInt(h, 10)
  return isNaN(n) || n < 0 ? undefined : n
}

/**
 * Returns the upload body and its size, decoding aws-chunked framing when the
 * client used STREAMING-UNSIGNED-PAYLOAD-TRAILER (aws-sdk v3 stream uploads).
 */
function uploadBody(req: Request): { body: BodyInit | null; size: number | undefined } {
  if (isAwsChunked(req)) {
    const size = parseLength(req.headers.get('x-amz-decoded-content-length'))
    const raw = req.body ?? new ReadableStream<Uint8Array>({ start(c) { c.close() } })
    return { body: decodeAwsChunked(raw), size }
  }
  return { body: req.body, size: parseLength(req.headers.get('content-length')) }
}

function extractXmlKeys(body: string): string[] {
  const keys: string[] = []
  const re = /<Key>([\s\S]*?)<\/Key>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) keys.push(unescapeXml(m[1].trim()))
  return keys
}

function extractParts(body: string): { partNumber: number; etag: string }[] {
  const parts: { partNumber: number; etag: string }[] = []
  const re = /<Part>([\s\S]*?)<\/Part>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const block = m[1]
    const pn = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(block)
    const et = /<ETag>\s*([\s\S]*?)\s*<\/ETag>/.exec(block)
    if (pn && et) parts.push({ partNumber: parseInt(pn[1], 10), etag: unescapeXml(et[1].trim()).replace(/^"|"$/g, '') })
  }
  return parts
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
}

function withCors(req: Request, res: Response): Response {
  if (!req.headers.get('origin')) return res
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Accept-Ranges')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  })
}

export default app
