import type { Env } from '../env'
import { verifySignature, type SigResult } from './signature'
import { s3Error } from './xml'

function parseList(s: string | undefined): string[] {
  return (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * Bucket allowlist gate. A "*" entry allows every bucket (AWS root-credential
 * semantics: any authenticated principal may create/access any bucket).
 */
export function checkBucket(
  env: Env,
  bucket: string,
): { ok: true } | { ok: false; response: Response } {
  const allowed = parseList(env.ALLOWED_BUCKETS)
  if (!allowed.includes('*') && !allowed.includes(bucket)) {
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
