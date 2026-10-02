import { H3 } from 'h3'
import type { Env } from './env'
import { checkBucket, isPublicReadBucket, verifyRequest } from './s3/access'
import { parseRequest } from './s3/request'
import * as buckets from './handlers/buckets'
import * as objects from './handlers/objects'
import * as multipart from './handlers/multipart'
import { errorResponse, preflightResponse, purgeAfterWrite, withCors } from './http'
import * as xml from './s3/xml'
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
    const purge = purgeAfterWrite(env, method, rawPath)
    if (purge) waitUntil(purge)
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
  const { bucket, key } = parseRequest(rawPath)

  // Root path: ListBuckets.
  if (!bucket) {
    if (method === 'GET') return buckets.handleListBuckets(env)
    return xml.s3Error(400, 'InvalidRequest', 'Unknown request at root path', rawPath, requestId())
  }

  const gate = checkBucket(env, bucket)
  if (!gate.ok) return gate.response

  const publicRead = (method === 'GET' || method === 'HEAD') && isPublicReadBucket(env, bucket)
  if (!publicRead) {
    const sig = await verifyRequest(env, req)
    if (!sig.ok) return xml.s3Error(sig.status, sig.code, sig.message, rawPath, requestId())
  }

  if (!key) return dispatchBucket(env, req, method, params, rawPath, bucket)

  const isUploadMethod = method === 'PUT' || method === 'POST'
  if (isUploadMethod && params.has('uploads')) {
    return multipart.handleCreateMultipart(env, req, bucket, key, waitUntil)
  }
  if (params.has('uploadId')) {
    if (params.has('partNumber') && method === 'PUT') return multipart.handleUploadPart(env, req, bucket, key, params)
    if (method === 'POST') return multipart.handleCompleteMultipart(env, req, bucket, key, params)
    if (method === 'DELETE') return multipart.handleAbortMultipart(env, bucket, key, params)
    return xml.s3Error(400, 'InvalidRequest', 'Invalid multipart request', rawPath, requestId())
  }

  switch (method) {
    case 'PUT':
      return objects.handlePutObject(env, req, bucket, key)
    case 'GET':
      return objects.handleGetObject(env, req, bucket, key, rawPath, waitUntil)
    case 'HEAD':
      return objects.handleHeadObject(env, bucket, key, rawPath)
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
): Promise<Response> {
  switch (method) {
    case 'GET':
      if (params.has('location')) return buckets.handleGetBucketLocation(env, bucket)
      if (params.has('delete')) return buckets.handleDeleteObjects(env, req, bucket)
      return buckets.handleListObjects(env, bucket, params, params.get('list-type') === '2')
    case 'HEAD':
      return buckets.handleHeadBucket(env, bucket)
    case 'PUT':
      return buckets.handleCreateBucket(env, bucket)
    case 'POST':
      if (params.has('delete')) return buckets.handleDeleteObjects(env, req, bucket)
      return methodNotAllowed(rawPath)
    case 'DELETE':
      if (params.has('delete')) return buckets.handleDeleteObjects(env, req, bucket)
      return buckets.handleDeleteBucket(env, bucket)
    default:
      return methodNotAllowed(rawPath)
  }
}

function methodNotAllowed(rawPath: string): Response {
  return xml.s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.', rawPath, requestId())
}

export default app
