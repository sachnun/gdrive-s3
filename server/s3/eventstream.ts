const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const HEADER_TYPE_STRING = 7

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, false)
  return b
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function encodeHeader(name: string, value: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const valueBytes = new TextEncoder().encode(value)
  const len = new Uint8Array(2)
  new DataView(len.buffer).setUint16(0, nameBytes.length, false)
  const vlen = new Uint8Array(2)
  new DataView(vlen.buffer).setUint16(0, valueBytes.length, false)
  return concat([new Uint8Array([nameBytes.length]), nameBytes, new Uint8Array([HEADER_TYPE_STRING]), vlen, valueBytes])
}

/**
 * Encodes one AWS event-stream message:
 *   [total_length][headers_length][prelude_crc] headers [payload] [message_crc]
 * All integers are big-endian uint32; both CRCs are CRC32.
 */
export function eventStreamMessage(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const headerParts = Object.entries(headers).map(([k, v]) => encodeHeader(k, v))
  const headerBytes = concat(headerParts)
  const totalLength = 12 + headerBytes.length + payload.length + 4
  const prelude = concat([u32(totalLength), u32(headerBytes.length)])
  const preludeCrc = u32(crc32(prelude))
  const body = concat([prelude, preludeCrc, headerBytes, payload])
  return concat([body, u32(crc32(body))])
}

export function recordsEvent(payload: Uint8Array): Uint8Array {
  return eventStreamMessage({ ':message-type': 'event', ':event-type': 'Records', ':content-type': 'application/octet-stream' }, payload)
}

export function statsEvent(bytesScanned: number, bytesProcessed: number, bytesReturned: number): Uint8Array {
  const payload = new TextEncoder().encode(
    `<Stats><Details><BytesScanned>${bytesScanned}</BytesScanned><BytesProcessed>${bytesProcessed}</BytesProcessed><BytesReturned>${bytesReturned}</BytesReturned></Details></Stats>`,
  )
  return eventStreamMessage({ ':message-type': 'event', ':event-type': 'Stats', ':content-type': 'text/xml' }, payload)
}

export function progressEvent(bytesScanned: number, bytesProcessed: number, bytesReturned: number): Uint8Array {
  const payload = new TextEncoder().encode(
    `<Progress><Details><BytesScanned>${bytesScanned}</BytesScanned><BytesProcessed>${bytesProcessed}</BytesProcessed><BytesReturned>${bytesReturned}</BytesReturned></Details></Progress>`,
  )
  return eventStreamMessage({ ':message-type': 'event', ':event-type': 'Progress', ':content-type': 'text/xml' }, payload)
}

export function contEvent(): Uint8Array {
  return eventStreamMessage({ ':message-type': 'event', ':event-type': 'Cont' }, new Uint8Array())
}

export function endEvent(): Uint8Array {
  return eventStreamMessage({ ':message-type': 'event', ':event-type': 'End' }, new Uint8Array())
}

export function eventStreamResponse(chunks: Uint8Array[]): Response {
  return new Response(concat(chunks), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.amazon.eventstream',
      'x-amz-request-id': '',
    },
  })
}
