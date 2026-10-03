import { Readable } from 'node:stream'
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { HttpRequest, HttpResponse } from '@smithy/protocol-http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACCESS_KEY, SECRET_KEY, setupTest, type TestSetup } from './helpers'

class S3RequestHandler {
  constructor(private readonly ctx: TestSetup) {}

  async handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const params = new URLSearchParams()
    if (request.query) {
      for (const [k, v] of Object.entries(request.query)) {
        const val = Array.isArray(v) ? v[0] : v
        if (val !== undefined) params.set(k, String(val))
      }
    }
    const qs = params.toString()
    const url = `http://localhost${request.path}${qs ? '?' + qs : ''}`
    const headers = new Headers()
    for (const [k, v] of Object.entries(request.headers)) {
      headers.set(k, String(v))
    }
    const body = (request.body as BodyInit | undefined) ?? undefined
    const signed = await this.ctx.aws.sign(url, { method: request.method, headers, body })
    signed.headers.set('host', new URL(url).host)
    const res = await this.ctx.app.fetch(signed)
    const buf = new Uint8Array(await res.arrayBuffer())
    const outHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      outHeaders[k] = v
    })
    return { response: new HttpResponse({ statusCode: res.status, headers: outHeaders, body: Readable.from([buf]) }) }
  }

  updateHttpClientConfig(): void {
  }

  httpHandlerConfigs(): Record<string, unknown> {
    return {}
  }

  destroy(): void {
  }
}

describe('@aws-sdk/client-s3 compatibility', () => {
  let ctx: TestSetup
  let client: S3Client

  beforeEach(async () => {
    ctx = await setupTest()
    client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: new S3RequestHandler(ctx) as never,
    })
  })
  afterEach(() => ctx.restore())

  it('bucket + object lifecycle', async () => {
    const create = await client.send(new CreateBucketCommand({ Bucket: 'test-bucket' }))
    expect(create.$metadata.httpStatusCode).toBe(200)

    const head = await client.send(new HeadBucketCommand({ Bucket: 'test-bucket' }))
    expect(head.$metadata.httpStatusCode).toBe(200)

    const loc = await client.send(new GetBucketLocationCommand({ Bucket: 'test-bucket' }))
    expect(loc.LocationConstraint).toBe('us-east-1')

    const put = await client.send(new PutObjectCommand({ Bucket: 'test-bucket', Key: 'sdk/a.txt', Body: 'sdk body' }))
    expect(put.ETag).toMatch(/^".+"$/)

    const got = await client.send(new GetObjectCommand({ Bucket: 'test-bucket', Key: 'sdk/a.txt' }))
    expect(await got.Body!.transformToString()).toBe('sdk body')
  })

  it('ListObjectsV2 returns SDK objects', async () => {
    await client.send(new CreateBucketCommand({ Bucket: 'test-bucket' }))
    await client.send(new PutObjectCommand({ Bucket: 'test-bucket', Key: 'one.txt', Body: '1' }))
    await client.send(new PutObjectCommand({ Bucket: 'test-bucket', Key: 'two.txt', Body: '2' }))

    const list = await client.send(new ListObjectsV2Command({ Bucket: 'test-bucket' }))
    expect(list.IsTruncated).toBe(false)
    expect(list.KeyCount).toBe(2)
    expect(list.Contents?.map((c) => c.Key)).toEqual(expect.arrayContaining(['one.txt', 'two.txt']))
  })

  it('ListBuckets returns created buckets', async () => {
    await client.send(new CreateBucketCommand({ Bucket: 'test-bucket' }))
    const list = await client.send(new ListBucketsCommand({}))
    expect(list.Buckets?.map((b) => b.Name)).toContain('test-bucket')
  })

  it('CopyObject and DeleteObjects', async () => {
    await client.send(new CreateBucketCommand({ Bucket: 'test-bucket' }))
    await client.send(new PutObjectCommand({ Bucket: 'test-bucket', Key: 'src.txt', Body: 'data' }))
    await client.send(
      new CopyObjectCommand({ Bucket: 'test-bucket', Key: 'dst.txt', CopySource: '/test-bucket/src.txt' }),
    )
    const copy = await client.send(new GetObjectCommand({ Bucket: 'test-bucket', Key: 'dst.txt' }))
    expect(await copy.Body!.transformToString()).toBe('data')

    const del = await client.send(
      new DeleteObjectsCommand({
        Bucket: 'test-bucket',
        Delete: { Objects: [{ Key: 'src.txt' }, { Key: 'dst.txt' }] },
      }),
    )
    expect(del.Deleted?.length).toBe(2)
  })
})
