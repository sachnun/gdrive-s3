import { describe, expect, it } from 'vitest'
import { contEvent, endEvent, eventStreamMessage, recordsEvent, statsEvent } from '../server/s3/eventstream'
import { parseCsv, parseJsonRecords, parseSelectRequest, parseSql, runSelect } from '../server/s3/select'

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

interface Decoded {
  totalLength: number
  headersLength: number
  headers: Record<string, string>
  payload: Uint8Array
}

function decodeMessage(bytes: Uint8Array): Decoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const totalLength = view.getUint32(0, false)
  const headersLength = view.getUint32(4, false)
  const preludeCrc = view.getUint32(8, false)
  expect(preludeCrc, 'prelude crc').toBe(crc32(bytes.subarray(0, 8)))
  expect(totalLength, 'total length').toBe(bytes.length)
  const messageCrc = view.getUint32(bytes.length - 4, false)
  expect(messageCrc, 'message crc').toBe(crc32(bytes.subarray(0, bytes.length - 4)))

  const headers: Record<string, string> = {}
  let i = 12
  const headerEnd = 12 + headersLength
  while (i < headerEnd) {
    const nameLen = bytes[i]
    i += 1
    const name = new TextDecoder().decode(bytes.subarray(i, i + nameLen))
    i += nameLen
    const type = bytes[i]
    i += 1
    expect(type, 'header type is string (7)').toBe(7)
    const valueLen = (bytes[i] << 8) | bytes[i + 1]
    i += 2
    const value = new TextDecoder().decode(bytes.subarray(i, i + valueLen))
    i += valueLen
    headers[name] = value
  }
  return { totalLength, headersLength, headers, payload: bytes.subarray(headerEnd, bytes.length - 4) }
}

describe('event stream framing', () => {
  it('frames a message with valid prelude and message CRCs', () => {
    const msg = eventStreamMessage({ ':message-type': 'event', ':event-type': 'End' }, new Uint8Array())
    const decoded = decodeMessage(msg)
    expect(decoded.headers[':message-type']).toBe('event')
    expect(decoded.headers[':event-type']).toBe('End')
    expect(decoded.payload.length).toBe(0)
  })

  it('emits a Records event carrying the raw payload', () => {
    const payload = new TextEncoder().encode('a,b\n1,2\n')
    const decoded = decodeMessage(recordsEvent(payload))
    expect(decoded.headers[':event-type']).toBe('Records')
    expect(decoded.headers[':content-type']).toBe('application/octet-stream')
    expect(new TextDecoder().decode(decoded.payload)).toBe('a,b\n1,2\n')
  })

  it('emits Stats as an XML payload with the byte counters', () => {
    const decoded = decodeMessage(statsEvent(10, 10, 4))
    expect(decoded.headers[':event-type']).toBe('Stats')
    expect(decoded.headers[':content-type']).toBe('text/xml')
    const xml = new TextDecoder().decode(decoded.payload)
    expect(xml).toContain('<BytesScanned>10</BytesScanned>')
    expect(xml).toContain('<BytesProcessed>10</BytesProcessed>')
    expect(xml).toContain('<BytesReturned>4</BytesReturned>')
  })

  it('emits empty Cont and End events', () => {
    for (const [event, type] of [[contEvent(), 'Cont'], [endEvent(), 'End']] as const) {
      const decoded = decodeMessage(event)
      expect(decoded.headers[':event-type']).toBe(type)
      expect(decoded.payload.length).toBe(0)
    }
  })

  it('keeps the prelude length consistent with the header bytes', () => {
    const decoded = decodeMessage(eventStreamMessage({ ':event-type': 'Records' }, new TextEncoder().encode('x')))
    expect(decoded.totalLength).toBe(12 + decoded.headersLength + 1 + 4)
  })
})

describe('select SQL parser', () => {
  it('parses SELECT * FROM S3Object', () => {
    expect(parseSql('SELECT * FROM S3Object')).toEqual({ columns: '*', fromAlias: 'S3Object', where: null, limit: null })
  })

  it('parses a column list', () => {
    expect(parseSql('SELECT s.name, s.age FROM S3Object s')?.columns).toEqual(['s.name', 's.age'])
  })

  it('parses a WHERE with a numeric literal', () => {
    expect(parseSql('SELECT * FROM S3Object WHERE age > 30')).toEqual({
      columns: '*',
      fromAlias: 'S3Object',
      where: { column: 'age', op: '>', value: 30 },
      limit: null,
    })
  })

  it('parses a WHERE with a quoted string and normalises <> to !=', () => {
    expect(parseSql("SELECT * FROM S3Object WHERE name = 'bob'")?.where).toEqual({ column: 'name', op: '=', value: 'bob' })
    expect(parseSql("SELECT * FROM S3Object WHERE name <> 'bob'")?.where).toEqual({ column: 'name', op: '!=', value: 'bob' })
  })

  it('parses LIMIT and strips the table alias from the column', () => {
    const plan = parseSql('SELECT * FROM S3Object s WHERE s.age >= 18 LIMIT 2')
    expect(plan?.where).toEqual({ column: 'age', op: '>=', value: 18 })
    expect(plan?.limit).toBe(2)
  })

  it('rejects expressions it cannot evaluate', () => {
    for (const sql of ['SELECT FROM', 'DELETE FROM S3Object', 'SELECT * FROM S3Object WHERE a LIKE 1', 'SELECT * FROM']) {
      expect(parseSql(sql), sql).toBeNull()
    }
  })
})

describe('select request parser', () => {
  it('reads the expression, CSV input and output settings', () => {
    const body = `<SelectObjectContentRequest>
      <Expression>SELECT * FROM S3Object</Expression>
      <ExpressionType>SQL</ExpressionType>
      <InputSerialization><CSV><FileHeaderInfo>USE</FileHeaderInfo><FieldDelimiter>;</FieldDelimiter></CSV></InputSerialization>
      <OutputSerialization><CSV><FieldDelimiter>|</FieldDelimiter></CSV></OutputSerialization>
    </SelectObjectContentRequest>`
    const req = parseSelectRequest(body)!
    expect(req.expression).toBe('SELECT * FROM S3Object')
    expect(req.input.csv?.fileHeaderInfo).toBe('USE')
    expect(req.input.csv?.fieldDelimiter).toBe(';')
    expect(req.output.csv?.fieldDelimiter).toBe('|')
  })

  it('reads a JSON input type and a scan range', () => {
    const body = `<SelectObjectContentRequest>
      <Expression>SELECT * FROM S3Object</Expression>
      <InputSerialization><JSON><Type>LINES</Type></JSON></InputSerialization>
      <OutputSerialization><JSON/></OutputSerialization>
      <ScanRange><Start>0</Start><End>100</End></ScanRange>
    </SelectObjectContentRequest>`
    const req = parseSelectRequest(body)!
    expect(req.input.json?.type).toBe('LINES')
    expect(req.output.json).toBeTruthy()
    expect(req.scanRange).toEqual({ start: 0, end: 100 })
  })

  it('rejects a non-SQL expression type and missing expressions', () => {
    expect(parseSelectRequest('<SelectObjectContentRequest><Expression>x</Expression><ExpressionType>Pig</ExpressionType></SelectObjectContentRequest>')).toBeNull()
    expect(parseSelectRequest('<SelectObjectContentRequest/>')).toBeNull()
  })

  it('unescapes XML entities in the expression', () => {
    const body = '<SelectObjectContentRequest><Expression>SELECT * FROM S3Object WHERE a &lt; 5</Expression></SelectObjectContentRequest>'
    expect(parseSelectRequest(body)!.expression).toBe('SELECT * FROM S3Object WHERE a < 5')
  })
})

describe('CSV and JSON parsing', () => {
  it('parses plain CSV rows', () => {
    expect(parseCsv('a,b\n1,2\n3,4\n', { fileHeaderInfo: 'NONE', fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('honours quoted fields containing the delimiter', () => {
    const rows = parseCsv('name,note\n"a,b",c\n', { fileHeaderInfo: 'NONE', fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"' })
    expect(rows[1]).toEqual(['a,b', 'c'])
  })

  it('honours a custom field delimiter', () => {
    const rows = parseCsv('a;b\n1;2\n', { fileHeaderInfo: 'NONE', fieldDelimiter: ';', recordDelimiter: '\n', quoteCharacter: '"' })
    expect(rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('parses JSON documents and lines', () => {
    expect(parseJsonRecords('{"a":1}', 'DOCUMENT')).toEqual([{ a: 1 }])
    expect(parseJsonRecords('{"a":1}\n{"a":2}\n', 'LINES')).toEqual([{ a: 1 }, { a: 2 }])
    expect(parseJsonRecords('', 'DOCUMENT')).toEqual([])
  })
})

describe('runSelect', () => {
  const csv = new TextEncoder().encode('name,age\nalice,30\nbob,20\ncarol,40\n')

  it('selects every row for SELECT *', () => {
    const res = runSelect(csv, {
      expression: 'SELECT * FROM S3Object',
      input: { compression: 'NONE', csv: { fileHeaderInfo: 'USE', fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"' } },
      output: { csv: { fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"', quoteFields: 'ASNEEDED' } },
    })
    const out = new TextDecoder().decode(res.payload)
    expect(out).toContain('alice,30')
    expect(out).toContain('carol,40')
    expect(res.bytesScanned).toBe(csv.length)
    expect(res.bytesReturned).toBe(res.payload.length)
  })

  it('filters rows with WHERE', () => {
    const res = runSelect(csv, {
      expression: 'SELECT * FROM S3Object WHERE age > 25',
      input: { compression: 'NONE', csv: { fileHeaderInfo: 'USE', fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"' } },
      output: { csv: { fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"', quoteFields: 'ASNEEDED' } },
    })
    const out = new TextDecoder().decode(res.payload)
    expect(out).toContain('alice,30')
    expect(out).toContain('carol,40')
    expect(out).not.toContain('bob,20')
  })

  it('projects a subset of columns and emits the header', () => {
    const res = runSelect(csv, {
      expression: 'SELECT name FROM S3Object',
      input: { compression: 'NONE', csv: { fileHeaderInfo: 'USE', fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"' } },
      output: { csv: { fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"', quoteFields: 'ASNEEDED' } },
    })
    const lines = new TextDecoder().decode(res.payload).split('\n')
    expect(lines[0]).toBe('name')
    expect(lines[1]).toBe('alice')
    expect(lines).not.toContain('30')
  })

  it('applies LIMIT', () => {
    const res = runSelect(csv, {
      expression: 'SELECT * FROM S3Object LIMIT 1',
      input: { compression: 'NONE', csv: { fileHeaderInfo: 'USE', fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"' } },
      output: { csv: { fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"', quoteFields: 'ASNEEDED' } },
    })
    const lines = new TextDecoder().decode(res.payload).split('\n').filter(Boolean)
    expect(lines).toEqual(['alice,30'])
  })

  it('filters JSON records by key', () => {
    const json = new TextEncoder().encode('{"n":"a","v":1}\n{"n":"b","v":2}\n')
    const res = runSelect(json, {
      expression: 'SELECT * FROM S3Object WHERE v = 2',
      input: { compression: 'NONE', json: { type: 'LINES' } },
      output: { json: { recordDelimiter: '\n' } },
    })
    const out = new TextDecoder().decode(res.payload)
    expect(out).toContain('"n":"b"')
    expect(out).not.toContain('"n":"a"')
  })

  it('returns an empty payload for an unparseable expression', () => {
    const res = runSelect(csv, {
      expression: 'NOT SQL AT ALL',
      input: { compression: 'NONE', csv: { fileHeaderInfo: 'USE', fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"' } },
      output: { csv: { fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"', quoteFields: 'ASNEEDED' } },
    })
    expect(res.payload.length).toBe(0)
    expect(res.bytesReturned).toBe(0)
  })

  it('returns an empty payload when WHERE names an unknown column', () => {
    const res = runSelect(csv, {
      expression: 'SELECT * FROM S3Object WHERE nope = 1',
      input: { compression: 'NONE', csv: { fileHeaderInfo: 'USE', fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"' } },
      output: { csv: { fieldDelimiter: ',', recordDelimiter: '\n', quoteCharacter: '"', quoteFields: 'ASNEEDED' } },
    })
    expect(res.payload.length).toBe(0)
  })
})
