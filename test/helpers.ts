import type { Hono } from 'hono'
import { AwsClient } from 'aws4fetch'
import type { Env } from '../src/env'
import { FakeDrive, makeEnv, makeFetchStub, type FetchStub } from './harness'

export const ACCESS_KEY = 'test-access'
export const SECRET_KEY = 'test-secret-1234567890'

export function makeAws(): AwsClient {
  return new AwsClient({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, service: 's3', region: 'us-east-1' })
}

export interface TestCtx {
  app: Hono<{ Bindings: Env }>
  env: Env
  drive: FakeDrive
  stub: FetchStub
  aws: AwsClient
}

let appPromise: Promise<Hono<{ Bindings: Env }>> | null = null
export async function loadApp(): Promise<Hono<{ Bindings: Env }>> {
  if (!appPromise) appPromise = import('../src/index').then((m) => m.default)
  return appPromise
}

export type TestSetup = TestCtx & { restore: () => void }

export interface UnionSaSpec {
  email: string
  quota?: { limit?: string; usage?: string }
  writable?: boolean
  creatable?: boolean
}

export interface UnionTestSetup extends TestCtx {
  /** One fake Drive per service account, keyed by token. */
  drives: Map<string, FakeDrive>
  stub: FetchStub
  restore: () => void
}

/** Generates an RSA private key once per process and caches the PEM. */
let pemCache: string | null = null
export async function saPem(): Promise<string> {
  if (pemCache) return pemCache
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
  const b64 = btoa(String.fromCharCode(...der))
  pemCache = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
  return pemCache
}

/** Builds the GOOGLE_SERVICE_ACCOUNTS payload (JSON array) for a set of SAs. */
export async function saPayload(sas: UnionSaSpec[]): Promise<string> {
  const pem = await saPem()
  return JSON.stringify(
    sas.map((s) => ({
      type: 'service_account',
      project_id: 'p',
      private_key_id: 'k',
      private_key: pem,
      client_email: s.email,
      client_id: '1',
      token_uri: 'https://oauth2.googleapis.com/token',
      universe_domain: 'googleapis.com',
      ...(s.writable !== undefined ? { writable: s.writable } : {}),
      ...(s.creatable !== undefined ? { creatable: s.creatable } : {}),
    })),
  )
}

/**
 * A fetch stub backing one fake Drive per SA, routing oauth exchanges to the
 * matching per-SA token and Drive API calls by the Bearer token.
 */
export function makeUnionStub(sas: UnionSaSpec[]): { drive: Map<string, FakeDrive>; stub: FetchStub } {
  const drives = new Map<string, FakeDrive>()
  const perToken = new Map<string, FetchStub>()
  for (const s of sas) {
    const token = `sa-token-${s.email.split('@')[0]}`
    const drive = new FakeDrive()
    drives.set(token, drive)
    perToken.set(token, makeFetchStub(drive, { validTokens: [token], quota: s.quota }))
  }
  const oauthStub = [...perToken.values()][0]
  const stub = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.hostname === 'oauth2.googleapis.com') return oauthStub(input, init)
    const headers = new Headers(init?.headers ?? {})
    const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const inner = perToken.get(token)
    if (!inner) {
      throw new Error(`no fake Drive for token ${token}`)
    }
    return inner(input, init)
  }) as FetchStub
  stub.setValidTokens = () => {}
  stub.oauthLog = []
  return { drive: drives, stub }
}

export async function setupUnionTest(
  sas: UnionSaSpec[],
  overrides: Partial<Env> = {},
): Promise<UnionTestSetup> {
  const { drive: drives, stub } = makeUnionStub(sas)
  const original = globalThis.fetch
  globalThis.fetch = stub as unknown as typeof fetch
  const app = await loadApp()
  const env = makeEnv({
    GOOGLE_REFRESH_TOKEN: '',
    GOOGLE_SERVICE_ACCOUNTS: await saPayload(sas),
    UNION_MODE: 'union',
    ALLOWED_BUCKETS: '*',
    ...overrides,
  })
  return {
    app,
    env,
    drive: drives.values().next().value as FakeDrive,
    drives,
    stub,
    aws: makeAws(),
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/** Finds the (untrashed) Drive root folder of a bucket inside one fake Drive. */
export function unionBucketId(drive: FakeDrive, bucket: string): string | null {
  const f = drive
    .allFiles()
    .find(
      (x) =>
        !x.trashed &&
        x.mimeType === 'application/vnd.google-apps.folder' &&
        x.name === bucket &&
        x.parents.includes('root'),
    )
  return f?.id ?? null
}

/** True when the key exists (untrashed file) under the bucket root of one fake Drive. */
export function unionDriveHasKey(drive: FakeDrive, bucket: string, key: string): boolean {
  const rootId = unionBucketId(drive, bucket)
  if (!rootId) return false
  const walk = (parentId: string, segs: string[]): boolean => {
    if (segs.length === 1) {
      return drive
        .allFiles()
        .some(
          (f) =>
            !f.trashed && f.mimeType !== 'application/vnd.google-apps.folder' && f.name === segs[0] && f.parents.includes(parentId),
        )
    }
    const dir = drive
      .allFiles()
      .find(
        (f) =>
          !f.trashed &&
          f.mimeType === 'application/vnd.google-apps.folder' &&
          f.name === segs[0] &&
          f.parents.includes(parentId),
      )
    return dir ? walk(dir.id, segs.slice(1)) : false
  }
  return walk(rootId, key.split('/').filter(Boolean))
}

export async function setupTest(overrides: Partial<Env> = {}): Promise<TestSetup> {
  const drive = new FakeDrive()
  const stub = makeFetchStub(drive)
  const original = globalThis.fetch
  globalThis.fetch = stub as unknown as typeof fetch
  const app = await loadApp()
  const env = makeEnv(overrides)
  return {
    app,
    env,
    drive,
    stub,
    aws: makeAws(),
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/** Sign with aws4fetch (header auth) and dispatch to the app. */
export async function s3(
  ctx: TestCtx,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
  const url = `http://localhost${path}`
  const signed = await ctx.aws.sign(url, { method, headers: opts.headers ?? {}, body: opts.body })
  signed.headers.set('host', 'localhost')
  return ctx.app.fetch(signed, ctx.env)
}

/** Sign a presigned (query auth) URL and dispatch without Authorization. */
export async function s3Presigned(
  ctx: TestCtx,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: BodyInit } = {},
): Promise<Response> {
  const url = `http://localhost${path}`
  const signed = await ctx.aws.sign(url, { method, headers: opts.headers ?? {}, body: opts.body, aws: { signQuery: true } })
  signed.headers.set('host', 'localhost')
  return ctx.app.fetch(signed, ctx.env)
}

export async function bucketRootId(ctx: TestCtx, bucket: string): Promise<string> {
  const f = ctx.drive.allFiles().find((x) => !x.trashed && x.mimeType === 'application/vnd.google-apps.folder' && x.name === bucket && x.parents.includes('root'))
  if (!f) throw new Error(`bucket ${bucket} not created`)
  return f.id
}

export function xmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml)
  return m ? m[1] : null
}

export function textOf(res: Response): Promise<string> {
  return res.text()
}
