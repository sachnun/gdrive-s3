import { BUCKETS } from '../config'
import type { Env } from '../env'
import { verifySignature, type SigResult } from './signature'
import { s3Error } from './xml'

export function checkBucket(bucket: string): { ok: true } | { ok: false; response: Response } {
  if (BUCKETS !== '*' && !BUCKETS.includes(bucket)) {
    return { ok: false, response: s3Error(403, 'AccessDenied', 'Access Denied', `/${bucket}`) }
  }
  return { ok: true }
}

export async function verifyRequest(env: Env, req: Request): Promise<SigResult> {
  return verifySignature(env, req)
}
