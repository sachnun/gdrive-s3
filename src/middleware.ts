import type { Env } from './env'
import { verifySignature, type SigResult } from './s3/signature'
import { s3Error } from './s3/xml'

/**
 * Parses a path-style request: /<bucket>/<key...>. Returns bucket=null for the
 * root path (ListBuckets). Rejects ".." segments.
 */
export function parseRequest(rawPath: string): { bucket: string | null; key: string | null } {
  const rawSegs = rawPath.split('/').filter((s) => s.length > 0)
  if (rawSegs.length === 0) return { bucket: null, key: null }
  let bucket: string
  try {
    bucket = decodeURIComponent(rawSegs[0])
  } catch {
    bucket = rawSegs[0]
  }
  if (bucket === '' || bucket === '..') return { bucket: null, key: null }
  const keySegs: string[] = []
  for (let i = 1; i < rawSegs.length; i++) {
    let seg: string
    try {
      seg = decodeURIComponent(rawSegs[i])
    } catch {
      seg = rawSegs[i]
    }
    if (seg === '..') return { bucket: null, key: null }
    keySegs.push(seg)
  }
  return { bucket, key: keySegs.length ? keySegs.join('/') : null }
}

function parseList(s: string | undefined): string[] {
  return (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

export function checkBucket(
  env: Env,
  bucket: string,
): { ok: true } | { ok: false; response: Response } {
  if (!parseList(env.ALLOWED_BUCKETS).includes(bucket)) {
    return { ok: false, response: s3Error(403, 'AccessDenied', 'Access Denied', `/${bucket}`) }
  }
  return { ok: true }
}

export function isPublicReadBucket(env: Env, bucket: string): boolean {
  return parseList(env.PUBLIC_READ_BUCKETS).includes(bucket)
}

export async function verifyRequest(env: Env, req: Request): Promise<SigResult> {
  return verifySignature(env, req)
}
