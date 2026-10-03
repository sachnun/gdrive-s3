import { BUCKETS } from '../config'
import type { Env } from '../env'
import { verifySignature, type SigResult } from './signature'
import { s3Error } from './xml'

export function checkBucket(...names: string[]): { ok: true } | { ok: false; response: Response } {
  if (BUCKETS !== '*' && !names.some((n) => BUCKETS.includes(n))) {
    return { ok: false, response: s3Error(403, 'AccessDenied', 'Access Denied', `/${names[0]}`) }
  }
  return { ok: true }
}

export async function verifyRequest(env: Env, req: Request): Promise<SigResult> {
  return verifySignature(env, req)
}
