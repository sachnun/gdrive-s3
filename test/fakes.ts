import type { Env } from '../server/env'
import { FOLDER_MIME } from '../server/drive/folder'

export interface FakeDriveFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  trashed: boolean
  content: Uint8Array
  appProperties?: Record<string, string>
  createdTime: string
  modifiedTime: string
}

interface Session {
  metadata: { name: string; mimeType?: string; parents?: string[]; appProperties?: Record<string, string> }
  chunks: Uint8Array[]
  total?: number
}

async function readBody(body: unknown): Promise<Uint8Array> {
  if (body == null) return new Uint8Array()
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (body instanceof ReadableStream) {
    const reader = body.getReader()
    const parts: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    const total = parts.reduce((s, p) => s + p.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const p of parts) {
      out.set(p, off)
      off += p.length
    }
    return out
  }
  throw new Error('unsupported body type')
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function indexOfSeq(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = Math.max(from, 0); i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function toFile(f: FakeDriveFile): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    createdTime: f.createdTime,
    trashed: f.trashed,
  }
  if (f.appProperties) base.appProperties = f.appProperties
  if (f.mimeType !== FOLDER_MIME) base.size = String(f.content.length)
  return base
}

function pickFields(f: FakeDriveFile, fields: string): Record<string, unknown> {
  const full = toFile(f)
  const inner = /files\(([^)]*)\)/.exec(fields)
  if (!inner) return full
  const keys = inner[1].split(',').map((k) => k.trim()).filter(Boolean)
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (k in full) out[k] = full[k]
  }
  return out
}

function matchesQuery(f: FakeDriveFile, q: string): boolean {
  if (q.includes('trashed=false') && f.trashed) return false
  const nameMatch = /name='([^']*)'/.exec(q)
  if (nameMatch && f.name !== nameMatch[1]) return false
  const mimeEq = /mimeType='([^']*)'/.exec(q)
  if (mimeEq && f.mimeType !== mimeEq[1]) return false
  const mimeNe = /mimeType!='([^']*)'/.exec(q)
  if (mimeNe && f.mimeType === mimeNe[1]) return false
  const parentMatch = /'([^']+)' in parents/.exec(q)
  if (parentMatch) {
    const p = parentMatch[1]
    if (p === 'root') {
      if (!f.parents.includes('root')) return false
    } else if (!f.parents.includes(p)) {
      return false
    }
  }
  return true
}

export class FakeDrive {
  files = new Map<string, FakeDriveFile>()
  sessions = new Map<string, Session>()
  private seq = 1

  newSeq(): number {
    return this.seq++
  }

  addFile(args: Partial<FakeDriveFile> & { name: string; mimeType: string; parents: string[] }): FakeDriveFile {
    const now = new Date().toISOString()
    const f: FakeDriveFile = {
      id: args.id ?? `file_${this.seq++}`,
      name: args.name,
      mimeType: args.mimeType,
      parents: args.parents,
      trashed: args.trashed ?? false,
      content: args.content ?? new Uint8Array(),
      appProperties: args.appProperties,
      createdTime: now,
      modifiedTime: now,
    }
    this.files.set(f.id, f)
    return f
  }

  allFiles(): FakeDriveFile[] {
    return [...this.files.values()]
  }

  countUntrashed(parentId: string, name: string): number {
    return this.allFiles().filter((f) => !f.trashed && f.parents.includes(parentId) && f.name === name).length
  }
}

export interface StubOptions {
  /** Bearer tokens accepted by the fake Drive API (defaults to ['fake-token']). */
  validTokens?: string[]
  /** Token returned by the oauth refresh endpoint (defaults to 'fake-token'). */
  refreshToken?: string
}

export interface FetchStub {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  setValidTokens: (tokens: string[]) => void
  /** Raw bodies of every POST sent to the oauth token endpoint. */
  oauthLog: string[]
}

export function makeFetchStub(drive: FakeDrive, opts: StubOptions = {}): FetchStub {
  const state = {
    validTokens: opts.validTokens ?? ['fake-token'],
    refreshToken: opts.refreshToken ?? 'fake-token',
    oauthLog: [] as string[],
  }
  const stub = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? {})
    const body = init?.body ?? null

    if (url.hostname === 'oauth2.googleapis.com') {
      const bodyText =
        body instanceof URLSearchParams ? body.toString() : typeof body === 'string' ? body : ''
      state.oauthLog.push(bodyText)
      const grant = new URLSearchParams(bodyText).get('grant_type')
      const assertion = new URLSearchParams(bodyText).get('assertion')
      let token = state.refreshToken
      if (grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && assertion) {
        // Derive the token from the JWT issuer so tests can tell SAs apart.
        const payload = assertion.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
        const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
        const claims = JSON.parse(atob(padded)) as { iss?: string }
        token = `sa-token-${(claims.iss ?? 'unknown').split('@')[0]}`
      }
      return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.hostname !== 'www.googleapis.com') {
      throw new Error(`unexpected host: ${url.host}`)
    }
    const auth = headers.get('authorization') ?? ''
    const token = auth.replace(/^Bearer\s+/i, '')
    if (token && !state.validTokens.includes(token)) {
      return new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), { status: 401 })
    }

    const path = url.pathname
    if (path.startsWith('/upload/drive/v3/files')) {
      if (method === 'POST' && url.searchParams.get('uploadType') === 'multipart') {
        // Single-shot upload: multipart/related with a JSON metadata part and a
        // binary content part delimited by the request's boundary.
        const raw = await readBody(body)
        const ct = headers.get('content-type') ?? ''
        const boundary = /boundary=([^;\s]+)/.exec(ct)?.[1]
        if (!boundary) return new Response('missing boundary', { status: 400 })
        const marker = new TextEncoder().encode(`\r\n--${boundary}`)
        const findMarker = (from: number): number => {
          outer: for (let i = from; i <= raw.length - marker.length; i++) {
            for (let j = 0; j < marker.length; j++) if (raw[i + j] !== marker[j]) continue outer
            return i
          }
          return -1
        }
        const jsonHdrEnd = indexOfSeq(raw, new TextEncoder().encode('\r\n\r\n'), 0)
        const metaStart = jsonHdrEnd + 4
        const metaEnd = findMarker(metaStart)
        const metadata = JSON.parse(new TextDecoder().decode(raw.subarray(metaStart, metaEnd))) as Session['metadata']
        const contentHdrEnd = indexOfSeq(raw, new TextEncoder().encode('\r\n\r\n'), metaEnd + marker.length)
        const contentStart = contentHdrEnd + 4
        const contentEnd = findMarker(contentStart)
        const f = drive.addFile({
          name: metadata.name,
          mimeType: metadata.mimeType ?? 'application/octet-stream',
          parents: metadata.parents ?? ['root'],
          appProperties: metadata.appProperties,
          content: raw.slice(contentStart, contentEnd),
        })
        return new Response(JSON.stringify(toFile(f)), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      if (method === 'POST') {
        const metadata = JSON.parse(new TextDecoder().decode(await readBody(body)))
        const sessionId = `session_${drive.newSeq()}`
        const uploadLen = headers.get('x-upload-content-length')
        const total = uploadLen ? Number(uploadLen) : undefined
        drive.sessions.set(sessionId, { metadata, chunks: [], total })
        return new Response('', {
          status: 200,
          headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${sessionId}` },
        })
      }
      const uploadId = url.searchParams.get('upload_id')
      const session = uploadId ? drive.sessions.get(uploadId) : undefined
      if (!session) return new Response('not found', { status: 404 })
      const chunk = await readBody(body)
      session.chunks.push(chunk)
      const received = session.chunks.reduce((s, c) => s + c.length, 0)
      if (session.total !== undefined && received < session.total) {
        return new Response('', { status: 308, headers: { 'Range': `bytes=0-${received - 1}` } })
      }
      const meta = session.metadata
      const f = drive.addFile({
        name: meta.name,
        mimeType: meta.mimeType ?? 'application/octet-stream',
        parents: meta.parents ?? ['root'],
        appProperties: meta.appProperties,
        content: concatBytes(session.chunks),
      })
      drive.sessions.delete(uploadId!)
      return new Response(JSON.stringify(toFile(f)), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }

    if (path === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const orderBy = url.searchParams.get('orderBy') ?? ''
      const pageSize = Number(url.searchParams.get('pageSize') ?? '1000')
      const pageToken = Number(url.searchParams.get('pageToken') ?? '0')
      const fields = url.searchParams.get('fields') ?? 'files'
      let all = drive.allFiles().filter((f) => matchesQuery(f, q))
      if (orderBy === 'createdTime desc') all.sort((a, b) => (a.createdTime < b.createdTime ? 1 : -1))
      else if (orderBy === 'name') all.sort((a, b) => (a.name < b.name ? -1 : 1))
      else all.sort((a, b) => (a.id < b.id ? -1 : 1))
      const slice = all.slice(pageToken, pageToken + pageSize)
      const result: Record<string, unknown> = {}
      if (fields.includes('nextPageToken') && pageToken + pageSize < all.length) {
        result.nextPageToken = String(pageToken + pageSize)
      }
      result.files = slice.map((f) => pickFields(f, fields))
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    if (path === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(new TextDecoder().decode(await readBody(body)))
      const f = drive.addFile({
        name: meta.name,
        mimeType: meta.mimeType ?? 'application/octet-stream',
        parents: meta.parents ?? ['root'],
        appProperties: meta.appProperties,
      })
      return new Response(JSON.stringify(toFile(f)), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    if (method === 'POST' && /^\/drive\/v3\/files\/[^/]+\/copy$/.test(path)) {
      const fileId = path.split('/')[4]
      const src = drive.files.get(fileId)
      if (!src) return new Response('not found', { status: 404 })
      const meta = JSON.parse(new TextDecoder().decode(await readBody(body)))
      const copy = drive.addFile({
        name: meta.name ?? src.name,
        mimeType: src.mimeType,
        parents: meta.parents ?? src.parents,
        content: src.content,
        appProperties: src.appProperties,
      })
      return new Response(JSON.stringify(toFile(copy)), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    if (method === 'PATCH' && /^\/drive\/v3\/files\/[^/]+$/.test(path)) {
      const fileId = path.split('/')[4]
      const f = drive.files.get(fileId)
      if (!f) return new Response('not found', { status: 404 })
      const patch = JSON.parse(new TextDecoder().decode(await readBody(body)))
      if (patch.trashed) f.trashed = true
      f.modifiedTime = new Date().toISOString()
      return new Response(JSON.stringify(toFile(f)), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    if (method === 'GET' && /^\/drive\/v3\/files\/[^/]+$/.test(path)) {
      const fileId = path.split('/')[4]
      const f = drive.files.get(fileId)
      if (!f || f.trashed) return new Response('not found', { status: 404 })
      const alt = url.searchParams.get('alt')
      if (alt === 'media') {
        const range = headers.get('range')
        if (range) {
          const m = /^bytes=(\d+)-(\d+)?$/.exec(range)
          if (m) {
            const start = Number(m[1])
            const end = m[2] !== undefined ? Number(m[2]) : f.content.length - 1
            if (start >= f.content.length || start > end) {
              return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${f.content.length}` } })
            }
            const slice = f.content.slice(start, end + 1)
            return new Response(slice, {
              status: 206,
              headers: {
                'Content-Range': `bytes ${start}-${end}/${f.content.length}`,
                'Content-Length': String(slice.length),
              },
            })
          }
        }
        return new Response(f.content, { status: 200, headers: { 'Content-Length': String(f.content.length) } })
      }
      return new Response(JSON.stringify(toFile(f)), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    throw new Error(`unhandled Drive API call: ${method} ${path}`)
  }) as FetchStub
  stub.setValidTokens = (tokens: string[]) => {
    state.validTokens = tokens
  }
  stub.oauthLog = state.oauthLog
  return stub
}

export class FakeKV {
  private store = new Map<string, { value: string; expiry?: number }>()

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key)
    if (!e) return null
    if (e.expiry !== undefined && e.expiry < Date.now()) {
      this.store.delete(key)
      return null
    }
    return e.value
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) {
      throw new Error('KV PUT failed: expiration_ttl must be at least 60')
    }
    this.store.set(key, {
      value,
      expiry: opts?.expirationTtl !== undefined ? Date.now() + opts.expirationTtl * 1000 : undefined,
    })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async list(): Promise<{ keys: { name: string }[] }> {
    return { keys: [...this.store.keys()].map((name) => ({ name })) }
  }
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ACCESS_KEY: 'test-access',
    SECRET_KEY: 'test-secret-1234567890',
    REGION: 'us-east-1',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token',
    ALLOWED_BUCKETS: 'test-bucket,public-bucket',
    PUBLIC_READ_BUCKETS: 'public-bucket',
    AUTH_KV: new FakeKV() as unknown as KVNamespace,
    FOLDER_CACHE: new FakeKV() as unknown as KVNamespace,
    ...overrides,
  }
}
