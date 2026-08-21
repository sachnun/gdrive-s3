import type { Env } from '../env'

export type SigResult = { ok: true } | { ok: false; status: number; code: string; message: string }

const encoder = new TextEncoder()
const SKEW_MS = 15 * 60 * 1000
const MAX_PRESIGNED_SECONDS = 7 * 24 * 3600

function err(status: number, code: string, message: string): SigResult {
  return { ok: false, status, code, message }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return hex(new Uint8Array(digest))
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(data)))
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function parseAmzDate(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s)
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

/**
 * Canonical query string from the RAW (already percent-encoded) query, sorted by
 * encoded name then encoded value. For presigned requests X-Amz-Signature is excluded.
 */
function canonicalQueryString(rawQuery: string, exclude: Set<string>): string {
  if (!rawQuery) return ''
  const pairs: { k: string; v: string }[] = []
  for (const part of rawQuery.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = eq === -1 ? part : part.slice(0, eq)
    const v = eq === -1 ? '' : part.slice(eq + 1)
    if (!exclude.has(k)) pairs.push({ k, v })
  }
  pairs.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.v < b.v ? -1 : a.v > b.v ? 1 : 0))
  return pairs.map((p) => `${p.k}=${p.v}`).join('&')
}

function buildCanonicalHeaders(
  headers: Headers,
  signedList: string[],
  overrides: Record<string, string> = {},
): string {
  return signedList
    .map((h) => h.trim())
    .filter(Boolean)
    .sort()
    .map((h) => {
      const v = overrides[h] ?? headers.get(h) ?? ''
      return `${h}:${v.replace(/\s+/g, ' ').trim()}\n`
    })
    .join('')
}

async function deriveSigningKey(secret: string, date: string, region: string): Promise<Uint8Array> {
  const kDate = await hmac(encoder.encode('AWS4' + secret), date)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

/**
 * Verifies AWS Signature V4 (header auth and presigned query auth).
 * Enforces presigned X-Amz-Expires and ±15 min date freshness (replay protection).
 */
export async function verifySignature(env: Env, req: Request): Promise<SigResult> {
  const rawUrl = req.url
  const url = new URL(rawUrl)
  const rawPath = url.pathname
  const rawQuery = url.search.slice(1)
  const query = url.searchParams
  const headers = req.headers
  const method = req.method

  // Detect aws-chunked signed payloads early (before auth parsing): signed-chunk
  // mode is rejected (P2); unsigned-trailer mode is allowed and de-chunked in the
  // upload path.
  const payloadHashHint =
    query.get('X-Amz-Content-Sha256') ??
    query.get('x-amz-content-sha256') ??
    headers.get('x-amz-content-sha256') ??
    undefined
  if (payloadHashHint === 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' || payloadHashHint === 'STREAMING-AWS4-ECDSA-P256-SHA256-PAYLOAD') {
    return {
      ok: false,
      status: 501,
      code: 'NotImplemented',
      message: 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD chunked signing is not supported yet',
    }
  }

  const isPresigned = query.has('X-Amz-Signature') || query.has('x-amz-signature')

  let credential: string
  let signedHeaders: string
  let amzDate: string
  let signature: string

  if (isPresigned) {
    if (query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') {
      return err(400, 'InvalidArgument', 'Unsupported authorization algorithm')
    }
    credential = query.get('X-Amz-Credential') ?? ''
    signedHeaders = query.get('X-Amz-SignedHeaders') ?? ''
    amzDate = query.get('X-Amz-Date') ?? ''
    signature = query.get('X-Amz-Signature') ?? query.get('x-amz-signature') ?? ''
    const expStr = query.get('X-Amz-Expires')
    if (!expStr) return err(400, 'InvalidArgument', 'X-Amz-Expires is required for presigned requests')
    const expiresSec = parseInt(expStr, 10)
    if (isNaN(expiresSec) || expiresSec < 0 || expiresSec > MAX_PRESIGNED_SECONDS) {
      return err(400, 'AuthorizationQueryParametersError', 'X-Amz-Expires must be an integer between 0 and 604800')
    }
    const dateMs = parseAmzDate(amzDate)
    if (isNaN(dateMs)) return err(400, 'AuthorizationQueryParametersError', 'X-Amz-Date is not a valid timestamp')
    const now = Date.now()
    if (now < dateMs - SKEW_MS) {
      return err(403, 'RequestTimeTooSkewed', 'The difference between the request time and the server time is too large.')
    }
    if (now > dateMs + expiresSec * 1000 + SKEW_MS) {
      return err(403, 'AccessDenied', 'Request has expired')
    }
  } else {
    const authHeader = headers.get('authorization')
    if (!authHeader) return err(403, 'AccessDenied', 'Missing credentials')
    const m = /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-fA-F]+)$/.exec(
      authHeader,
    )
    if (!m) return err(400, 'InvalidArgument', 'Invalid Authorization header format')
    credential = m[1]
    signedHeaders = m[2]
    signature = m[3]
    amzDate = headers.get('x-amz-date') ?? ''
    const dateMs = parseAmzDate(amzDate)
    if (isNaN(dateMs)) return err(403, 'AccessDenied', 'Missing or invalid x-amz-date')
    if (Math.abs(Date.now() - dateMs) > SKEW_MS) {
      return err(403, 'RequestTimeTooSkewed', 'The difference between the request time and the server time is too large.')
    }
  }

  const credParts = credential.split('/')
  if (credParts.length !== 5) return err(403, 'InvalidArgument', 'Invalid credential scope')
  const [accessKey, scopeDate, scopeRegion, scopeService, scopeTerm] = credParts
  if (accessKey !== env.ACCESS_KEY) {
    return err(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.')
  }
  if (scopeService !== 's3' || scopeTerm !== 'aws4_request') {
    return err(403, 'InvalidArgument', 'Invalid credential scope')
  }
  if (scopeDate !== amzDate.slice(0, 8)) {
    return err(403, 'InvalidArgument', 'Credential scope date does not match x-amz-date')
  }

  const signedList = signedHeaders.toLowerCase().split(';').map((h) => h.trim()).filter(Boolean)
  if (!signedList.includes('host')) {
    return err(403, 'InvalidArgument', 'SignedHeaders must include host')
  }

  const canonicalPayloadHash = payloadHashHint ?? 'UNSIGNED-PAYLOAD'
  const excludeQuery: Set<string> = isPresigned
    ? new Set(['X-Amz-Signature', 'x-amz-signature'])
    : new Set()

  const signingKey = await deriveSigningKey(env.SECRET_KEY, scopeDate, scopeRegion)

  /**
   * Edge/CDN proxies (e.g. Cloudflare) rewrite `Accept-Encoding` in flight
   * (`identity` -> `gzip, br`), breaking clients that signed it (Go SDKs,
   * rclone). The signature stays bound to the key, method, path, date and all
   * other signed headers, so also accept the common rewrites of that one header.
   */
  const variations: { list: string[]; overrides: Record<string, string> }[] = [{ list: signedList, overrides: {} }]
  if (signedList.includes('accept-encoding')) {
    // Go SDK clients sign Accept-Encoding as `identity` (HEAD) or `gzip` (GET);
    // Cloudflare rewrites both to `gzip, br` in flight. Cover the common rewrites.
    for (const v of ['identity', 'gzip', 'gzip, br', 'br, gzip', 'br', 'deflate', '']) {
      variations.push({ list: signedList, overrides: { 'accept-encoding': v } })
    }
    variations.push({ list: signedList.filter((h) => h !== 'accept-encoding'), overrides: {} })
  }

  for (const { list, overrides } of variations) {
    const canonicalRequest = [
      method,
      rawPath === '' ? '/' : rawPath,
      canonicalQueryString(rawQuery, excludeQuery),
      buildCanonicalHeaders(headers, list, overrides),
      list.join(';'),
      canonicalPayloadHash,
    ].join('\n')
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      `${scopeDate}/${scopeRegion}/s3/aws4_request`,
      await sha256hex(canonicalRequest),
    ].join('\n')
    const expected = hex(await hmac(signingKey, stringToSign))
    if (timingSafeEqualHex(expected, signature.toLowerCase())) {
      return { ok: true }
    }
  }

  return err(
    403,
    'SignatureDoesNotMatch',
    'The request signature we calculated does not match the signature you provided. Check your key and signing method.',
  )
}
