import { H3 } from 'h3'
import type { Env } from './env'
import { resolveBucketAlias } from './drive/alias'
import { checkBucket, verifyRequest } from './s3/access'
import { parseRequest } from './s3/request'
import * as buckets from './handlers/buckets'
import * as objects from './handlers/objects'
import * as multipart from './handlers/multipart'
import { errorResponse, preflightResponse, withCors } from './http'
import * as xml from './s3/xml'
import { bucketSubResource, notImplemented, objectSubResource } from './s3/subresource'
import { requestId } from './util'

interface ReqCtx {
  env: Env
  waitUntil(promise: Promise<unknown>): void
}

function reqCtx(event: { req: Request }): ReqCtx {
  const cf = (event.req as unknown as {
    runtime?: { cloudflare?: { env?: Env; context?: { waitUntil(p: Promise<unknown>): void } } }
  }).runtime?.cloudflare
  const env = cf?.env ?? (globalThis as { __env__?: Env }).__env__
  return {
    env: env as Env,
    waitUntil: (promise) => {
      if (cf?.context) cf.context.waitUntil(promise)
      else void promise.catch(() => {})
    },
  }
}

const app = new H3({
  onError: (error, event) => errorResponse(event.req as unknown as Request, event.url.pathname, error.cause ?? error),
})

app.all('/**', async (event) => {
  const req = event.req as unknown as Request
  const method = req.method
  const url = event.url
  const rawPath = url.pathname
  const params = url.searchParams

  if (method === 'OPTIONS') return preflightResponse()

  try {
    const { env, waitUntil } = reqCtx({ req })
    const res = await dispatch(env, req, method, rawPath, params, waitUntil)
    return withCors(req, res)
  } catch (err) {
    return errorResponse(req, rawPath, err)
  }
})

async function dispatch(
  env: Env,
  req: Request,
  method: string,
  rawPath: string,
  params: URLSearchParams,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const requested = parseRequest(rawPath).bucket

  if (!requested) {
    const sig = await verifyRequest(env, req)
    if (!sig.ok) return xml.s3Error(sig.status, sig.code, sig.message, rawPath, requestId())
    if (method === 'GET') return buckets.handleListBuckets(env)
    return xml.s3Error(400, 'InvalidRequest', 'Unknown request at root path', rawPath, requestId())
  }

  const sig = await verifyRequest(env, req)
  if (!sig.ok) return xml.s3Error(sig.status, sig.code, sig.message, rawPath, requestId())

  const bucket = await resolveBucketAlias(env, requested)
  const key = parseRequest(rawPath).key

  const gate = checkBucket(requested, bucket)
  if (!gate.ok) return gate.response

  if (!key) return dispatchBucket(env, req, method, params, rawPath, bucket, sig.region, requested)

  const isUploadMethod = method === 'PUT' || method === 'POST'
  if (isUploadMethod && params.has('uploads')) {
    return multipart.handleCreateMultipart(env, req, bucket, key, waitUntil)
  }
  if (params.has('uploadId')) {
    if (params.has('partNumber') && method === 'PUT') {
      if (req.headers.get('x-amz-copy-source')) return multipart.handleUploadPartCopy(env, req, bucket, key, params)
      return multipart.handleUploadPart(env, req, bucket, key, params)
    }
    if (method === 'POST') return multipart.handleCompleteMultipart(env, req, bucket, key, params, sig.region)
    if (method === 'DELETE') return multipart.handleAbortMultipart(env, bucket, key, params)
    if (method === 'GET') return multipart.handleListParts(env, bucket, key, params)
    return xml.s3Error(400, 'InvalidRequest', 'Invalid multipart request', rawPath, requestId())
  }

  const sub = objectSubResource(params)
  if (sub.kind === 'acl') {
    if (method === 'PUT') return objects.handlePutObjectAcl(env, bucket, key)
    return objects.handleGetObjectAcl(env, bucket, key)
  }
  if (sub.kind === 'tagging') {
    if (method === 'GET') return objects.handleGetObjectTagging(env, bucket, key)
    if (method === 'PUT') return objects.handlePutObjectTagging(env, req, bucket, key)
    if (method === 'DELETE') return objects.handleDeleteObjectTagging(env, bucket, key)
  }
  if (sub.kind === 'attributes') return objects.handleGetObjectAttributes(env, bucket, key)
  if (sub.kind === 'legal-hold') {
    if (method === 'PUT') return objects.handlePutObjectLegalHold(env, req, bucket, key)
    return objects.handleGetObjectLegalHold(env, bucket, key)
  }
  if (sub.kind === 'retention') {
    if (method === 'PUT') return objects.handlePutObjectRetention(env, req, bucket, key)
    return objects.handleGetObjectRetention(env, bucket, key)
  }
  if (sub.kind === 'rename' && method === 'PUT') return objects.handleRenameObject(env, req, bucket, key)
  if (sub.kind === 'unknown') {
    return notImplemented(rawPath, `${sub.name} is not supported by this gateway`)
  }

  switch (method) {
    case 'PUT':
      return objects.handlePutObject(env, req, bucket, key)
    case 'GET':
      return objects.handleGetObject(env, req, bucket, key)
    case 'HEAD':
      return objects.handleHeadObject(env, bucket, key)
    case 'DELETE':
      return objects.handleDeleteObject(env, bucket, key)
    default:
      return methodNotAllowed(rawPath)
  }
}

async function dispatchBucket(
  env: Env,
  req: Request,
  method: string,
  params: URLSearchParams,
  rawPath: string,
  bucket: string,
  region: string,
  requested: string,
): Promise<Response> {
  const sub = bucketSubResource(params)
  switch (method) {
    case 'GET':
      switch (sub.kind) {
        case 'location':
          return buckets.handleGetBucketLocation(env, bucket, region)
        case 'uploads':
          return buckets.handleListMultipartUploads(env, bucket, params)
        case 'versions':
          return buckets.handleListObjectVersions(env, bucket, params)
        case 'versioning':
          return buckets.handleGetBucketVersioning(env, bucket)
        case 'acl':
          return buckets.handleGetBucketAcl(env, bucket)
        case 'tagging':
          return buckets.handleGetBucketTagging(env, bucket)
        case 'policy':
          return buckets.handleGetBucketPolicy(env, bucket)
        case 'cors':
          return buckets.handleGetBucketCors(env, bucket)
        case 'lifecycle':
          return buckets.handleGetBucketLifecycle(env, bucket)
        case 'encryption':
          return buckets.handleGetBucketEncryption(env, bucket)
        case 'notification':
          return buckets.handleGetBucketNotification(env, bucket)
        case 'replication':
          return buckets.handleGetBucketReplication(env, bucket)
        case 'website':
          return buckets.handleGetBucketWebsite(env, bucket)
        case 'logging':
          return buckets.handleGetBucketLogging(env, bucket)
        case 'accelerate':
          return buckets.handleGetBucketAccelerate(env, bucket)
        case 'requestPayment':
          return buckets.handleGetBucketRequestPayment(env, bucket)
        case 'publicAccessBlock':
          return buckets.handleGetPublicAccessBlock(env, bucket)
        case 'ownershipControls':
          return buckets.handleGetBucketOwnershipControls(env, bucket)
        case 'objectLock':
          return buckets.handleGetObjectLockConfiguration(env, bucket)
        case 'abac':
          return buckets.handleGetBucketAbac(env, bucket)
        case 'listConfig':
          if (params.get('id')) return buckets.handleGetBucketConfigById(env, bucket, sub.name, params.get('id')!)
          return buckets.handleListBucketConfig(env, bucket, sub.name)
        case 'delete':
          return buckets.handleDeleteObjects(env, req, bucket)
        case 'unknown':
          return notImplemented(rawPath, `${sub.name} is not supported by this gateway`)
        default:
          return buckets.handleListObjects(env, bucket, params, params.get('list-type') === '2')
      }
    case 'HEAD':
      return buckets.handleHeadBucket(env, bucket)
    case 'PUT':
      if (sub.kind === 'none') return buckets.handleCreateBucket(env, bucket, requested)
      if (sub.kind === 'unknown') return notImplemented(rawPath, `${sub.name} is not supported by this gateway`)
      if (sub.kind === 'acl') return buckets.handlePutBucketAcl(env, bucket)
      return buckets.handlePutBucketConfig(env, bucket, sub.kind)
    case 'POST':
      if (sub.kind === 'delete') return buckets.handleDeleteObjects(env, req, bucket)
      if (sub.kind === 'unknown') return notImplemented(rawPath, `${sub.name} is not supported by this gateway`)
      return methodNotAllowed(rawPath)
    case 'DELETE':
      if (sub.kind === 'delete') return buckets.handleDeleteObjects(env, req, bucket)
      if (sub.kind === 'unknown') return notImplemented(rawPath, `${sub.name} is not supported by this gateway`)
      if (sub.kind === 'none') return buckets.handleDeleteBucket(env, bucket)
      return buckets.handleDeleteBucketConfig(env, bucket, sub.kind)
    default:
      return methodNotAllowed(rawPath)
  }
}

function methodNotAllowed(rawPath: string): Response {
  return xml.s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', rawPath, requestId())
}

export default app
