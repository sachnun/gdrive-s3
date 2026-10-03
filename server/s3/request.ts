import { decodeAwsChunked, isAwsChunked } from './chunked'

export const SMALL_UPLOAD_MAX = 4 * 1024 * 1024

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

function parseLength(h: string | null): number | undefined {
  if (!h) return undefined
  const n = parseInt(h, 10)
  return isNaN(n) || n < 0 ? undefined : n
}

export function uploadBody(req: Request): { body: BodyInit | null; size: number | undefined } {
  if (isAwsChunked(req)) {
    const size = parseLength(req.headers.get('x-amz-decoded-content-length'))
    const raw = req.body ?? new ReadableStream<Uint8Array>({ start(c) { c.close() } })
    return { body: decodeAwsChunked(raw), size }
  }
  return { body: req.body, size: parseLength(req.headers.get('content-length')) }
}

export async function bufferIfSmall(
  body: BodyInit | null,
  size?: number,
): Promise<{ body: BodyInit | null; data?: Uint8Array }> {
  if (size === undefined || size > SMALL_UPLOAD_MAX) return { body }
  const data = new Uint8Array(await new Response(body).arrayBuffer())
  return { body: null, data }
}

export function extractXmlKeys(body: string): string[] {
  const keys: string[] = []
  const re = /<Key>([\s\S]*?)<\/Key>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) keys.push(unescapeXml(m[1].trim()))
  return keys
}

export function extractParts(body: string): { partNumber: number; etag: string }[] {
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

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
}
