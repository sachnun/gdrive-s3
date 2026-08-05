const textDecoder = new TextDecoder()

/**
 * True when the request body uses aws-chunked application framing
 * (STREAMING-UNSIGNED-PAYLOAD-TRAILER, used by aws-sdk v3 / aws cli stream
 * uploads with checksums). HTTP-level chunked transfer is always decoded by the
 * runtime; aws-chunked is an application-layer encoding we must unwrap ourselves.
 */
export function isAwsChunked(req: Request): boolean {
  const enc = (req.headers.get('content-encoding') ?? '').toLowerCase()
  return enc.includes('aws-chunked') || req.headers.get('x-amz-content-sha256') === 'STREAMING-UNSIGNED-PAYLOAD-TRAILER'
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function indexOfCrLf(buf: Uint8Array): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i
  }
  return -1
}

/**
 * Unwraps aws-chunked framing:
 *   <hex-size>\r\n<data>\r\n ... 0\r\n<trailer-headers>\r\n\r\n
 * Chunk signatures (STREAMING-AWS4-HMAC-SHA256-PAYLOAD) are not handled here —
 * those requests are rejected earlier during signature verification.
 */
export function decodeAwsChunked(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let buffer: Uint8Array = new Uint8Array(0)
  let chunkRemaining = 0
  let finished = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!finished) {
        if (chunkRemaining === 0) {
          const crlf = indexOfCrLf(buffer)
          if (crlf === -1) {
            const { done, value } = await reader.read()
            if (done) {
              if (buffer.length > 0) throw new Error('truncated aws-chunked body: missing chunk terminator')
              finished = true
              break
            }
            buffer = concat(buffer, value)
            continue
          }
          const line = textDecoder.decode(buffer.subarray(0, crlf)).trim()
          buffer = buffer.subarray(crlf + 2)
          if (line === '0' || line.startsWith('0;')) {
            // final chunk; the remaining bytes are trailer headers, discard them
            finished = true
            break
          }
          const size = parseInt(line, 16)
          if (isNaN(size)) throw new Error(`invalid aws-chunked size line: ${JSON.stringify(line)}`)
          chunkRemaining = size
        }
        if (buffer.length < chunkRemaining + 2) {
          const { done, value } = await reader.read()
          if (done) throw new Error('truncated aws-chunked data')
          buffer = concat(buffer, value)
          continue
        }
        const chunk = buffer.subarray(0, chunkRemaining)
        buffer = buffer.subarray(chunkRemaining + 2) // skip trailing CRLF
        chunkRemaining = 0
        controller.enqueue(chunk)
        return
      }
      controller.close()
    },
  })
}
