import type { Env } from './env'
import { DriveError } from './drive/errors'
import { isPublicReadBucket } from './s3/access'
import { parseRequest } from './s3/request'
import { purgePublicCache } from './edge-cache'
import * as xml from './s3/xml'
import { requestId } from './util'

/**
 * Purges the edge-cache entry after a mutating request on a public-read
 * bucket. Bucket-level DeleteObjects (?delete on the root path) cannot be
 * mapped to individual keys here — those entries expire via TTL instead.
 */
export function purgeAfterWrite(env: Env, method: string, rawPath: string): Promise<void> | null {
  if (method !== 'PUT' && method !== 'POST' && method !== 'DELETE') return null
  const { bucket, key } = parseRequest(rawPath)
  if (!bucket || !key || !isPublicReadBucket(env, bucket)) return null
  return purgePublicCache(env, rawPath)
}

export function errorResponse(req: Request, rawPath: string, error: unknown): Response {
  if (error instanceof DriveError) {
    return withCors(req, xml.s3Error(error.status, error.code, error.message, rawPath, requestId()))
  }
  console.error('gdrive-s3 error:', error)
  return withCors(req, xml.s3Error(500, 'InternalError', 'We encountered an internal error. Please try again.', rawPath, requestId()))
}

export function withCors(req: Request, res: Response): Response {
  if (!req.headers.get('origin')) return res
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Accept-Ranges')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export function preflightResponse(): Response {
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
