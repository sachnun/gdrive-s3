import type { Env } from './env'
import { isPublicReadBucket } from './middleware'

/**
 * Edge caching of public-read object GETs via the Workers Cache API (free,
 * stored per PoP). Repeated downloads of public objects skip the Drive API
 * round-trip entirely and stop consuming the 400 req/100 s Drive rate limit.
 *
 * Only full-body 200 GET responses are cached. Range requests and signed
 * (non-public) traffic always go to Drive. Mutations on a public bucket purge
 * the entry; writes from other clients rely on TTL expiry.
 *
 * All helpers degrade to no-ops when the Cache API is unavailable (Node test
 * environment), so behavior outside Workers is unchanged.
 */

const DEFAULT_TTL_SECONDS = 300

function cacheStorage(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches
}

/** Synthetic-origin key: stable across hosts; path is the raw /bucket/key. */
function cacheKey(rawPath: string): Request {
  return new Request(`https://gdrive-s3.edge-cache${rawPath}`)
}

export function publicCacheTtl(env: Env): number {
  const n = parseInt(env.PUBLIC_CACHE_TTL ?? '', 10)
  return isNaN(n) || n <= 0 ? DEFAULT_TTL_SECONDS : n
}

/** Cached full-object response for a public GET/HEAD, or null on miss. */
export async function matchPublicGet(env: Env, bucket: string, rawPath: string): Promise<Response | null> {
  if (!isPublicReadBucket(env, bucket)) return null
  const storage = cacheStorage()
  if (!storage) return null
  try {
    const hit = await storage.default.match(cacheKey(rawPath))
    return hit ?? null
  } catch {
    return null
  }
}

/**
 * Splits a successful full-object response into a client-facing copy and a
 * background cache write. Returns null when the response is not cacheable
 * (caller serves it unchanged). The stored copy carries Cache-Control max-age;
 * the client-facing copy keeps the original headers.
 */
export function cachePublicGet(
  env: Env,
  bucket: string,
  rawPath: string,
  res: Response,
): { response: Response; stored: Promise<void> } | null {
  if (!isPublicReadBucket(env, bucket)) return null
  const storage = cacheStorage()
  if (!storage) return null
  // Unknown length would let a truncated body be cached.
  if (res.status !== 200 || !res.body || !res.headers.has('Content-Length')) return null
  const headers = new Headers(res.headers)
  headers.set('Cache-Control', `public, max-age=${publicCacheTtl(env)}`)
  const [clientStream, cacheStream] = res.body.tee()
  const stored = storage.default
    .put(cacheKey(rawPath), new Response(cacheStream, { status: 200, headers }))
    .then(() => undefined, () => undefined)
  return { response: new Response(clientStream, { status: 200, headers: res.headers }), stored }
}

/** Evicts a mutated object's cache entry (best-effort). */
export async function purgePublicCache(env: Env, rawPath: string): Promise<void> {
  const storage = cacheStorage()
  if (!storage) return
  try {
    await storage.default.delete(cacheKey(rawPath))
  } catch {
    // best-effort; entry expires via TTL anyway
  }
}
