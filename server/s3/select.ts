export interface SelectInput {
  compression: string
  csv?: { fileHeaderInfo: string; fieldDelimiter: string; recordDelimiter: string; quoteCharacter: string }
  json?: { type: string }
}

export interface SelectOutput {
  csv?: { fieldDelimiter: string; recordDelimiter: string; quoteCharacter: string; quoteFields: string }
  json?: { recordDelimiter: string }
}

export interface SelectRequest {
  expression: string
  input: SelectInput
  output: SelectOutput
  scanRange?: { start: number; end: number }
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)
  if (m) return m[1]
  return new RegExp(`<${name}\\s*/>`).test(xml) ? '' : null
}

function has(xml: string, name: string): boolean {
  return new RegExp(`<${name}(?:\\s[^>]*)?/?>`).test(xml)
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
}

export function parseSelectRequest(body: string): SelectRequest | null {
  const expression = tag(body, 'Expression')
  if (expression === null) return null
  const exprType = tag(body, 'ExpressionType')
  if (exprType && exprType !== 'SQL') return null

  const inputXml = tag(body, 'InputSerialization') ?? ''
  const outputXml = tag(body, 'OutputSerialization') ?? ''
  const compression = tag(inputXml, 'CompressionType') ?? 'NONE'

  const csvIn = tag(inputXml, 'CSV')
  const jsonIn = tag(inputXml, 'JSON')
  const csvOut = tag(outputXml, 'CSV')
  const jsonOut = tag(outputXml, 'JSON')

  const input: SelectInput = { compression }
  if (csvIn !== null) {
    input.csv = {
      fileHeaderInfo: tag(csvIn, 'FileHeaderInfo') ?? 'NONE',
      fieldDelimiter: unescapeXml(tag(csvIn, 'FieldDelimiter') ?? ','),
      recordDelimiter: unescapeXml(tag(csvIn, 'RecordDelimiter') ?? '\n'),
      quoteCharacter: unescapeXml(tag(csvIn, 'QuoteCharacter') ?? '"'),
    }
  }
  if (jsonIn !== null) input.json = { type: tag(jsonIn, 'Type') ?? 'DOCUMENT' }

  const output: SelectOutput = {}
  if (csvOut !== null) {
    output.csv = {
      fieldDelimiter: unescapeXml(tag(csvOut, 'FieldDelimiter') ?? ','),
      recordDelimiter: unescapeXml(tag(csvOut, 'RecordDelimiter') ?? '\n'),
      quoteCharacter: unescapeXml(tag(csvOut, 'QuoteCharacter') ?? '"'),
      quoteFields: tag(csvOut, 'QuoteFields') ?? 'ASNEEDED',
    }
  }
  if (jsonOut !== null) output.json = { recordDelimiter: unescapeXml(tag(jsonOut, 'RecordDelimiter') ?? '\n') }

  let scanRange: { start: number; end: number } | undefined
  const scanXml = tag(body, 'ScanRange')
  if (scanXml !== null) {
    const start = Number(tag(scanXml, 'Start') ?? '0')
    const end = Number(tag(scanXml, 'End') ?? '0')
    scanRange = { start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0 }
  }

  return { expression: unescapeXml(expression), input, output, scanRange }
}

export function parseCsv(text: string, cfg: SelectInput['csv']): string[][] {
  const fieldDelim = cfg?.fieldDelimiter ?? ','
  const recordDelim = cfg?.recordDelimiter ?? '\n'
  const quote = cfg?.quoteCharacter ?? '"'
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === quote) {
        if (text[i + 1] === quote) {
          field += quote
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (quote && c === quote) {
      inQuotes = true
      i++
      continue
    }
    if (text.startsWith(recordDelim, i)) {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += recordDelim.length
      continue
    }
    if (c === fieldDelim) {
      row.push(field)
      field = ''
      i++
      continue
    }
    field += c
    i++
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
}

export function parseJsonRecords(text: string, type: string): unknown[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (type === 'LINES') {
    return trimmed.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  }
  const parsed = JSON.parse(trimmed)
  return Array.isArray(parsed) ? parsed : [parsed]
}

interface SqlPlan {
  columns: string[] | '*'
  fromAlias: string | null
  where: { column: string; op: string; value: string | number } | null
  limit: number | null
}

/** Parses the small SQL subset S3 Select clients use: SELECT ... FROM ... [WHERE ...] [LIMIT n]. */
export function parseSql(expression: string): SqlPlan | null {
  const sql = expression.replace(/\s+/g, ' ').trim()
  const m = /^SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][\w]*)(?:\s+[A-Za-z_]\w*)?(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/i.exec(sql)
  if (!m) return null
  const selectPart = m[1].trim()
  const columns: string[] | '*' = selectPart === '*' ? '*' : selectPart.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''))
  const fromAlias = m[2]
  let where: SqlPlan['where'] = null
  if (m[3]) {
    const w = /^\s*([\w."']+)\s*(=|!=|<>|<=|>=|<|>)\s*(.+?)\s*$/.exec(m[3])
    if (!w) return null
    const column = w[1].replace(/^["']|["']$/g, '').replace(/^[\w]*\./, '')
    const op = w[2] === '<>' ? '!=' : w[2]
    let raw = w[3].trim()
    let value: string | number
    if (/^'.*'$/.test(raw)) value = raw.slice(1, -1).replace(/''/g, "'")
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw)
    else return null
    where = { column, op, value }
  }
  return { columns, fromAlias, where, limit: m[4] ? Number(m[4]) : null }
}

function compare(a: unknown, op: string, b: string | number): boolean {
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  const numeric = !Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== ''
  const left = numeric ? na : String(a ?? '')
  const right = numeric ? nb : String(b ?? '')
  switch (op) {
    case '=':
      return left === right
    case '!=':
      return left !== right
    case '<':
      return left < right
    case '<=':
      return left <= right
    case '>':
      return left > right
    case '>=':
      return left >= right
    default:
      return false
  }
}

export interface SelectResult {
  payload: Uint8Array
  bytesScanned: number
  bytesProcessed: number
  bytesReturned: number
}

export function runSelect(data: Uint8Array, req: SelectRequest): SelectResult {
  const plan = parseSql(req.expression)
  const bytesScanned = data.length
  if (!plan) {
    return { payload: new Uint8Array(), bytesScanned, bytesProcessed: 0, bytesReturned: 0 }
  }

  const outDelim = req.output.csv?.fieldDelimiter ?? ','
  const outRecord = req.output.csv?.recordDelimiter ?? '\n'
  const encoder = new TextEncoder()

  const emit = (records: string[]): Uint8Array => encoder.encode(records.join(outRecord))

  if (req.input.json) {
    const rows = parseJsonRecords(new TextDecoder().decode(data), req.input.json.type).filter(
      (r): r is Record<string, unknown> => typeof r === 'object' && r !== null,
    )
    const filtered = plan.where ? rows.filter((r) => compare(r[plan.where!.column], plan.where!.op, plan.where!.value)) : rows
    const limited = plan.limit !== null ? filtered.slice(0, plan.limit) : filtered
    const jsonOut = !req.output.csv
    const lines = limited.map((r) => {
      if (plan.columns === '*') return JSON.stringify(r)
      const picked: Record<string, unknown> = {}
      for (const c of plan.columns) picked[c] = r[c]
      return JSON.stringify(picked)
    })
    const payload = jsonOut ? encoder.encode(lines.join(req.output.json?.recordDelimiter ?? '\n')) : emit(lines)
    return { payload, bytesScanned, bytesProcessed: bytesScanned, bytesReturned: payload.length }
  }

  const text = new TextDecoder().decode(data)
  const table = parseCsv(text, req.input.csv)
  if (table.length === 0) return { payload: new Uint8Array(), bytesScanned, bytesProcessed: bytesScanned, bytesReturned: 0 }

  const headerMode = req.input.csv?.fileHeaderInfo ?? 'NONE'
  const hasHeader = headerMode === 'USE' || headerMode === 'IGNORE'
  const headers = hasHeader ? table[0] : table[0].map((_, i) => `_${i + 1}`)
  const dataRows = hasHeader ? table.slice(1) : table

  const indexOf = (name: string): number => headers.findIndex((h) => h === name)
  const whereIdx = plan.where ? indexOf(plan.where.column) : -1
  if (plan.where && whereIdx === -1) return { payload: new Uint8Array(), bytesScanned, bytesProcessed: bytesScanned, bytesReturned: 0 }

  let rows = plan.where ? dataRows.filter((r) => compare(r[whereIdx] ?? '', plan.where!.op, plan.where!.value)) : dataRows
  if (plan.limit !== null) rows = rows.slice(0, plan.limit)

  const outLines: string[] = []
  if (plan.columns !== '*' && headerMode === 'USE') outLines.push(plan.columns.join(outDelim))
  for (const r of rows) {
    if (plan.columns === '*') outLines.push(r.join(outDelim))
    else outLines.push(plan.columns.map((c) => r[indexOf(c)] ?? '').join(outDelim))
  }
  const payload = emit(outLines)
  return { payload, bytesScanned, bytesProcessed: bytesScanned, bytesReturned: payload.length }
}
