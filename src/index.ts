import { Hono } from 'hono'
import type { Env } from './env'
import { DRIVE_API, driveFetch } from './drive/auth'
import { DriveError } from './drive/errors'
import { FOLDER_MIME, findCachedFolder, findFolder, folderCacheKey, getOrCreateFolder, resolveExistingPath, resolvePathCreate, sharedDriveParams } from './drive/folder'
import { copyFile, downloadFile, findFilesInFolder, getFileMeta, trashFile, uploadFile, type FileMeta } from './drive/files'
import { abortMultipart, completeMultipart, createMultipart, gcMultipart, uploadPart } from './drive/multipart'
import { cachePublicGet, matchPublicGet, purgePublicCache } from './edge-cache'
import { checkBucket, isPublicReadBucket, MULTIPART_ROOT, parseRequest, verifyRequest } from './middleware'
import { listObjects, listObjectsUnion, type ListOptions } from './s3/list'
import * as xml from './s3/xml'
import { decodeAwsChunked, isAwsChunked } from './s3/chunked'
import { mapLimit, requestId, toHttpDate } from './util'
import { loadUnion, type Union } from './drive/union/config'
import {
  invalidateObjectMemos,
  saBucketRoot,
  saResolveKeyCreate,
  unionActionBuckets,
  unionActionHits,
  unionBucketExists,
  unionCreateBucketTargets,
  unionCreateTargets,
  unionFind,
  unionListBuckets,
  getOrCreateBucketRoot,
} from './drive/union/resolve'
import type { ServiceAccount } from './drive/auth'

const app = new Hono<{ Bindings: Env }>()

/** Minimal execution context: only waitUntil is needed (for background GC). */
interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void
}

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
    let execCtx: WaitUntilCtx | undefined
    try {
      execCtx = c.executionCtx
    } catch {
      // unavailable outside Workers (tests) — background work runs fire-and-forget
    }
    const res = await dispatch(env, req, method, rawPath, params, execCtx)
    const purge = purgeAfterWrite(env, method, rawPath)
    if (purge) {
      if (execCtx) execCtx.waitUntil(purge)
      else void purge.catch(() => {})
    }
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
  execCtx?: WaitUntilCtx,
): Promise<Response> {
  const { bucket, key } = parseRequest(rawPath)
  const union = await loadUnion(env)

  // Root path: ListBuckets.
  if (!bucket) {
    if (method === 'GET') return handleListBuckets(env, union)
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
        if (params.has('location')) return handleGetBucketLocation(env, bucket, union)
        if (params.has('delete')) return handleDeleteObjects(env, req, bucket, union)
        return handleListObjects(env, bucket, params, params.get('list-type') === '2', union)
      case 'HEAD':
        return handleHeadBucket(env, bucket, union)
      case 'PUT':
        return handleCreateBucket(env, bucket, union)
      case 'POST':
        if (params.has('delete')) return handleDeleteObjects(env, req, bucket, union)
        return xml.s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', rawPath, requestId())
      case 'DELETE':
        if (params.has('delete')) return handleDeleteObjects(env, req, bucket, union)
        return handleDeleteBucket(env, bucket, union)
      default:
        return xml.s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', rawPath, requestId())
    }
  }

  // ----- object-level operations -----
  const isUploadMethod = method === 'PUT' || method === 'POST'
  if (isUploadMethod && params.has('uploads')) return handleCreateMultipart(env, req, bucket, key, union, execCtx)
  if (params.has('uploadId')) {
    if (params.has('partNumber') && method === 'PUT') return handleUploadPart(env, req, bucket, key, params)
    if (method === 'POST') return handleCompleteMultipart(env, req, bucket, key, params, union)
    if (method === 'DELETE') return handleAbortMultipart(env, bucket, key, params)
    return xml.s3Error(400, 'InvalidRequest', 'Invalid multipart request', rawPath, requestId())
  }
  switch (method) {
    case 'PUT':
      return handlePutObject(env, req, bucket, key, union)
    case 'GET':
      return handleGetObject(env, req, bucket, key, rawPath, union, execCtx)
    case 'HEAD':
      return handleHeadObject(env, bucket, key, rawPath, union)
    case 'DELETE':
      return handleDeleteObject(env, bucket, key, union)
    default:
      return xml.s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', rawPath, requestId())
  }
}

// ---------- buckets ----------

async function handleListBuckets(env: Env, union: Union): Promise<Response> {
  const allowed = (env.ALLOWED_BUCKETS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const wildcard = allowed.includes('*')
  const buckets: { name: string; creationDate: string }[] = []
  const found = new Set<string>()

  if (union.cfg.mode === 'union') {
    const merged = await unionListBuckets(env, union)
    for (const [name, created] of merged) {
      if (name === MULTIPART_ROOT) continue
      if ((wildcard || allowed.includes(name)) && !found.has(name)) {
        buckets.push({ name, creationDate: created })
        found.add(name)
      }
    }
    // Fallback for allowed buckets not seen in the merged root listing.
    for (const name of allowed) {
      if (found.has(name)) continue
      if (await unionBucketExists(env, union, name)) buckets.push({ name, creationDate: '' })
    }
  } else {
    let pageToken: string | undefined
    for (let page = 0; page < 10; page++) {
      const q = `mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`
      let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,createdTime)&spaces=drive&orderBy=name${sharedDriveParams(env).search}`
      if (pageToken) url += `&pageToken=${pageToken}`
      const res = await driveFetch(env, url)
      if (!res.ok) throw new DriveError(500, 'InternalError', `bucket list failed (HTTP ${res.status})`)
      const data = (await res.json()) as { nextPageToken?: string; files: { id: string; name: string; createdTime: string }[] }
      for (const f of data.files) {
        // Internal multipart temp storage is never exposed as a bucket.
        if (f.name === MULTIPART_ROOT) continue
        if ((wildcard || allowed.includes(f.name)) && !found.has(f.name)) {
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
  }

  buckets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return xml.listBucketsXml(buckets)
}

async function handleHeadBucket(env: Env, bucket: string, union: Union): Promise<Response> {
  if (union.cfg.mode === 'union') {
    const found = await unionBucketExists(env, union, bucket)
    if (!found) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
    return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
  }
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

async function handleCreateBucket(env: Env, bucket: string, union: Union): Promise<Response> {
  // AWS S3 naming rules: 3-63 chars, lowercase letters/digits/dots/hyphens,
  // must begin and end with a letter or digit.
  // https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    return xml.s3Error(400, 'InvalidBucketName', 'The specified bucket is not valid.', `/${bucket}`, requestId())
  }
  // us-east-1 legacy semantics: re-creating an owned bucket returns 200 OK.
  if (union.cfg.mode === 'union') {
    const targets = await unionCreateBucketTargets(env, union, bucket)
    await mapLimit(targets, 4, (i) => getOrCreateBucketRoot(env, union.upstreams[i], bucket))
    return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
  }
  await getOrCreateFolder(env, bucket, null)
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

async function handleGetBucketLocation(env: Env, bucket: string, union: Union): Promise<Response> {
  if (union.cfg.mode === 'union') {
    const found = await unionBucketExists(env, union, bucket)
    if (!found) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
    return xml.locationXml(env.REGION || 'us-east-1')
  }
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.locationXml(env.REGION || 'us-east-1')
}

async function handleListObjects(
  env: Env,
  bucket: string,
  params: URLSearchParams,
  isV2: boolean,
  union: Union,
): Promise<Response> {
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
  let result
  if (union.cfg.mode === 'union') {
    result = await listObjectsUnion(env, union, opts)
  } else {
    const bucketFolderId = await findCachedFolder(env, bucket, null)
    result = await listObjects(env, bucketFolderId, opts)
  }
  return xml.listObjectsXml(opts, result, requestId())
}

async function handleDeleteBucket(env: Env, bucket: string, union: Union): Promise<Response> {
  if (union.cfg.mode === 'union') {
    const targets = await unionActionBuckets(env, union, bucket)
    if (targets.length === 0) {
      return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
    }
    const caches = await env.FOLDER_CACHE.list({ prefix: `path:${bucket}:` })
    for (const t of targets) {
      const up = union.upstreams[t]
      const root = (await saBucketRoot(env, up, bucket)) as string | null
      if (root) await trashFile(env, root, up.sa)
      await env.FOLDER_CACHE.delete(folderCacheKey(null, bucket, up.sa)).catch(() => {})
    }
    const memoPrefix = `path:${bucket}:`
    for (const k of caches.keys) {
      if (k.name.startsWith(memoPrefix)) await env.FOLDER_CACHE.delete(k.name).catch(() => {})
    }
    return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
  }
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  await trashFile(env, id)
  await env.FOLDER_CACHE.delete(folderCacheKey(null, bucket)).catch(() => {})
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

async function handleDeleteObjects(env: Env, req: Request, bucket: string, union: Union): Promise<Response> {
  const body = await req.text()
  const keys = extractXmlKeys(body)
  const results = await mapLimit(keys, DELETE_OBJECTS_CONCURRENCY, async (k): Promise<boolean> => {
    try {
      if (union.cfg.mode === 'union') {
        const hits = await unionActionHits(env, union, bucket, k)
        for (const h of hits) await trashFile(env, h.file.id, union.upstreams[h.saIndex].sa)
        await invalidateObjectMemos(env, bucket, [k])
        return true
      }
      const bucketFolderId = await findCachedFolder(env, bucket, null).catch(() => null)
      const target = bucketFolderId ? await resolveExistingPath(env, bucketFolderId, k) : null
      const file = target ? (await findFilesInFolder(env, target.name, target.parentId))[0] : undefined
      if (file) await trashFile(env, file.id)
      return true
    } catch {
      return false
    }
  })
  const deleted: string[] = []
  const errors: { key: string; code: string; message: string }[] = []
  results.forEach((ok, i) => {
    if (ok) deleted.push(keys[i])
    else errors.push({ key: keys[i], code: 'InternalError', message: 'failed to delete object' })
  })
  return xml.deleteResultXml(deleted, errors)
}

// ---------- objects ----------

async function handlePutObject(env: Env, req: Request, bucket: string, key: string, union: Union): Promise<Response> {
  const copySource = req.headers.get('x-amz-copy-source')
  if (union.cfg.mode === 'union') {
    if (copySource) return handleCopyObjectUnion(env, union, bucket, key, copySource)
    return handlePutObjectUnion(env, req, bucket, key, union)
  }
  const bucketFolderId = await getOrCreateFolder(env, bucket, null)
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

/** Union PUT: overwrite → ACTION targets get a fresh copy + old trashed; new → CREATE targets. */
async function handlePutObjectUnion(env: Env, req: Request, bucket: string, key: string, union: Union): Promise<Response> {
  const contentType = req.headers.get('content-type') ?? 'application/octet-stream'
  const { body, size } = uploadBody(req)
  const { body: stream, data } = await bufferIfSmall(body, size)
  const appProperties = metaToAppProperties(req.headers)

  const actionHits = await unionActionHits(env, union, bucket, key)
  let targets: number[]
  if (actionHits.length > 0) {
    targets = actionHits.map((h) => h.saIndex)
  } else {
    targets = await unionCreateTargets(env, union, bucket, key)
  }

  const bodies = fanOut(stream ?? data ?? null, targets.length)
  let lastId = ''
  let i = 0
  for (const t of targets) {
    const up = union.upstreams[t]
    const { parentId, name } = await saResolveKeyCreate(env, up, bucket, key)
    const b = bodies[i++]
    const meta = await uploadFile(env, {
      parentId,
      name,
      body: b ?? null,
      contentType,
      size,
      appProperties,
      data: data ? data : undefined,
      sa: up.sa,
    })
    lastId = meta.id
    await cleanupDuplicates(env, parentId, name, meta.id, up.sa)
  }
  await invalidateObjectMemos(env, bucket, [key])
  return new Response('', { status: 200, headers: { ETag: `"${lastId}"`, 'x-amz-request-id': requestId() } })
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

/** Union Copy: src via SEARCH, dest via CREATE policy; same-SA → server copy, cross-SA → stream. */
async function handleCopyObjectUnion(env: Env, union: Union, bucket: string, key: string, copySource: string): Promise<Response> {
  let srcPath: string
  try {
    srcPath = decodeURIComponent(copySource).replace(/^\/+/, '')
  } catch {
    srcPath = copySource.replace(/^\/+/, '')
  }
  const slash = srcPath.indexOf('/')
  const srcBucket = slash === -1 ? srcPath : srcPath.slice(0, slash)
  const srcKey = slash === -1 ? '' : srcPath.slice(slash + 1)
  const srcHit = await unionFind(env, union, srcBucket, srcKey)
  if (!srcHit) {
    return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  }
  const targets = await unionCreateTargets(env, union, bucket, key)
  const srcSa = union.upstreams[srcHit.saIndex].sa
  const srcContentType = srcHit.file.mimeType || 'application/octet-stream'
  let last: { id: string; modifiedTime: string } | null = null
  for (const t of targets) {
    const up = union.upstreams[t]
    const { parentId, name } = await saResolveKeyCreate(env, up, bucket, key)
    let copied: FileMeta
    if (t === srcHit.saIndex) {
      copied = await copyFile(env, srcHit.file.id, name, parentId, up.sa)
    } else {
      const srcRes = await downloadFile(env, srcHit.file.id, null, srcSa)
      if (!srcRes.ok || !srcRes.body) {
        throw new DriveError(502, 'InternalError', `copy source download failed (HTTP ${srcRes.status})`)
      }
      const size = Number(srcHit.file.size ?? 0)
      copied = await uploadFile(env, {
        parentId,
        name,
        body: srcRes.body,
        contentType: srcContentType,
        size: size > 0 ? size : undefined,
        sa: up.sa,
      })
    }
    last = { id: copied.id, modifiedTime: copied.modifiedTime ?? new Date().toISOString() }
    await cleanupDuplicates(env, parentId, name, copied.id, up.sa)
  }
  await invalidateObjectMemos(env, bucket, [key])
  if (!last) throw new DriveError(500, 'InternalError', 'copy produced no object')
  return xml.copyObjectXml(last.id, last.modifiedTime)
}

async function handleGetObject(
  env: Env,
  req: Request,
  bucket: string,
  key: string,
  rawPath: string,
  union: Union,
  execCtx?: WaitUntilCtx,
): Promise<Response> {
  const range = req.headers.get('range')
  const cacheable = !range && isPublicReadBucket(env, bucket)
  if (cacheable) {
    const hit = await matchPublicGet(env, bucket, rawPath)
    if (hit) return hit
  }
  const found = await findObject(env, union, bucket, key)
  if (!found) {
    if (union.cfg.mode === 'union') await invalidateObjectMemos(env, bucket, [key])
    return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  }
  const file = found.file
  const res = await downloadFile(env, file.id, range, found.saIndex !== undefined ? union.upstreams[found.saIndex].sa : undefined)
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
  let response = new Response(res.body, { status: 200, headers })
  if (cacheable) {
    const cached = cachePublicGet(env, bucket, rawPath, response)
    if (cached) {
      if (execCtx) execCtx.waitUntil(cached.stored)
      else void cached.stored.catch(() => {})
      response = cached.response
    }
  }
  return response
}

async function handleHeadObject(env: Env, bucket: string, key: string, rawPath: string, union: Union): Promise<Response> {
  // Serve from the edge-cache entry when present (avoids the Drive metadata
  // round-trip for public buckets).
  if (isPublicReadBucket(env, bucket)) {
    const hit = await matchPublicGet(env, bucket, rawPath)
    if (hit) return new Response(null, { status: 200, headers: new Headers(hit.headers) })
  }
  const found = await findObject(env, union, bucket, key)
  if (!found) {
    if (union.cfg.mode === 'union') await invalidateObjectMemos(env, bucket, [key])
    return xml.s3Error(404, 'NoSuchKey', 'The specified key does not exist.', `/${bucket}/${key}`, requestId())
  }
  const file = found.file
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

async function handleDeleteObject(env: Env, bucket: string, key: string, union: Union): Promise<Response> {
  if (union.cfg.mode === 'union') {
    const hits = await unionActionHits(env, union, bucket, key)
    for (const h of hits) await trashFile(env, h.file.id, union.upstreams[h.saIndex].sa)
    await invalidateObjectMemos(env, bucket, [key])
    return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
  }
  const file = await findObject(env, union, bucket, key)
  if (file) await trashFile(env, file.file.id)
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

// ---------- multipart ----------

/** Bodies at or below this size (and of known length) upload in one Drive request. */
const SMALL_UPLOAD_MAX = 4 * 1024 * 1024
/** Max parallel per-key deletions in DeleteObjects (Drive rate limit friendly). */
const DELETE_OBJECTS_CONCURRENCY = 8

/** Buffers a known-size body ≤ SMALL_UPLOAD_MAX so it can go in one request. */
async function bufferIfSmall(
  body: BodyInit | null,
  size?: number,
): Promise<{ body: BodyInit | null; data?: Uint8Array }> {
  if (size === undefined || size > SMALL_UPLOAD_MAX) return { body }
  const data = new Uint8Array(await new Response(body).arrayBuffer())
  return { body: null, data }
}

/** Splits one body into n streams (tee chain) for multi-target writes. */
function fanOut(body: BodyInit | null, n: number): (BodyInit | null)[] {
  if (n <= 1) return [body]
  const stream =
    body instanceof ReadableStream ? body : new Response(body ?? new Uint8Array()).body!
  const parts: BodyInit[] = []
  let cur: ReadableStream = stream
  for (let i = 0; i < n - 1; i++) {
    const [a, b] = cur.tee()
    parts.push(a)
    cur = b
  }
  parts.push(cur)
  return parts
}

async function handleCreateMultipart(
  env: Env,
  req: Request,
  bucket: string,
  key: string,
  union: Union,
  execCtx?: WaitUntilCtx,
): Promise<Response> {
  const contentType = req.headers.get('content-type') ?? 'application/octet-stream'
  let uploadResult
  if (union.cfg.mode === 'union') {
    const targets = await unionCreateTargets(env, union, bucket, key)
    const primary = union.upstreams[Math.min(...targets)]
    const { parentId, name } = await saResolveKeyCreate(env, primary, bucket, key)
    uploadResult = await createMultipart(env, {
      bucket,
      key,
      parentId,
      name,
      contentType,
      sa: primary.sa,
      union,
      createTargets: targets,
    })
  } else {
    const bucketFolderId = await getOrCreateFolder(env, bucket, null)
    const { parentId, name } = await resolvePathCreate(env, bucketFolderId, key)
    uploadResult = await createMultipart(env, { bucket, key, parentId, name, contentType })
  }
  const { uploadId } = uploadResult
  // Best-effort cleanup of abandoned sessions — never block the response on it.
  const gc = gcMultipart(env, bucket)
  if (execCtx) execCtx.waitUntil(gc)
  else void gc.catch(() => {})
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
  const { body: stream, data } = await bufferIfSmall(body, size)
  const { etag } = await uploadPart(env, uploadId, partNumber, stream, size, data)
  return xml.uploadPartXml(etag)
}

async function handleCompleteMultipart(
  env: Env,
  req: Request,
  bucket: string,
  key: string,
  params: URLSearchParams,
  union: Union,
): Promise<Response> {
  const uploadId = params.get('uploadId') ?? ''
  const body = await req.text()
  const parts = extractParts(body)
  const { etag } = await completeMultipart(env, uploadId, parts)
  if (union.cfg.mode === 'union') await invalidateObjectMemos(env, bucket, [key])
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

interface FoundObject {
  file: FileMeta
  saIndex?: number
}

/** Resolves a key to the newest file with that name (folders excluded). */
async function findObject(env: Env, union: Union, bucket: string, key: string): Promise<FoundObject | null> {
  if (union.cfg.mode === 'union') {
    const hit = await unionFind(env, union, bucket, key)
    if (!hit) return null
    return { file: hit.file, saIndex: hit.saIndex }
  }
  const bucketFolderId = await findCachedFolder(env, bucket, null)
  if (!bucketFolderId) return null
  const target = await resolveExistingPath(env, bucketFolderId, key)
  if (!target) return null
  const files = await findFilesInFolder(env, target.name, target.parentId)
  return files[0] ? { file: files[0] } : null
}

async function deleteOld(env: Env, parentId: string, name: string, keepId: string): Promise<void> {
  const files = await findFilesInFolder(env, name, parentId)
  for (const f of files) {
    if (f.id !== keepId) await trashFile(env, f.id)
  }
}

/** Trashes every sibling copy of a freshly-written file in one SA (overwrite semantics). */
async function cleanupDuplicates(env: Env, parentId: string, name: string, keepId: string, sa?: ServiceAccount): Promise<void> {
  const files = await findFilesInFolder(env, name, parentId, sa)
  for (const f of files) {
    if (f.id !== keepId) await trashFile(env, f.id, sa)
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

/**
 * Purges the edge-cache entry after a mutating request on a public-read
 * bucket. Bucket-level DeleteObjects (?delete on the root path) cannot be
 * mapped to individual keys here — those entries expire via TTL instead.
 */
function purgeAfterWrite(env: Env, method: string, rawPath: string): Promise<void> | null {
  if (method !== 'PUT' && method !== 'POST' && method !== 'DELETE') return null
  const { bucket, key } = parseRequest(rawPath)
  if (!bucket || !key || !isPublicReadBucket(env, bucket)) return null
  return purgePublicCache(env, rawPath)
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