import { AwsClient } from 'aws4fetch'
import type { Env } from '../server/env'
import { FakeDrive, makeEnv, makeFetchStub, type FetchStub } from './harness'

export const ACCESS_KEY = 'test-access'
export const SECRET_KEY = 'test-secret-1234567890'

export function makeAws(): AwsClient {
  return new AwsClient({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, service: 's3', region: 'us-east-1' })
}

export interface TestCtx {
  app: { fetch(req: Request): Response | Promise<Response> }
  env: Env
  drive: FakeDrive
  stub: FetchStub
  aws: AwsClient
}

let appPromise: Promise<TestCtx['app']> | null = null
export async function loadApp(): Promise<TestCtx['app']> {
  if (!appPromise) appPromise = import('../server/index').then((m) => m.default)
  return appPromise
}

export type TestSetup = TestCtx & { restore: () => void }

export async function setupTest(overrides: Partial<Env> = {}): Promise<TestSetup> {
  const drive = new FakeDrive()
  const stub = makeFetchStub(drive)
  const original = globalThis.fetch
  globalThis.fetch = stub as unknown as typeof fetch
  const app = await loadApp()
  const env = makeEnv(overrides)
  ;(globalThis as { __env__?: unknown }).__env__ = env
  return {
    app,
    env,
    drive,
    stub,
    aws: makeAws(),
    restore: () => {
      globalThis.fetch = original
      delete (globalThis as { __env__?: unknown }).__env__
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
  return ctx.app.fetch(signed)
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
  return ctx.app.fetch(signed)
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
