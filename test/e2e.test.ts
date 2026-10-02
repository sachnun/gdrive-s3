import { AwsClient } from 'aws4fetch'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACCESS_KEY, bucketRootId, s3, s3Presigned, setupTest, xmlTag, type TestSetup } from './helpers'

/** Installs an in-memory Cache API so edge-cache code paths run under Node. */
function installMemoryCache(): () => void {
  const store = new Map<string, Response>()
  ;(globalThis as { caches?: unknown }).caches = {
    default: {
      match: async (req: Request) => store.get(req.url),
      put: async (req: Request, res: Response) => {
        store.set(req.url, new Response(await res.text(), { status: res.status, headers: res.headers }))
      },
      delete: async (req: Request) => store.delete(req.url),
    },
  }
  return () => {
    delete (globalThis as { caches?: unknown }).caches
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('S3 e2e (aws4fetch as client)', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
  })
  afterEach(() => ctx.restore())

  it('bucket ops: create, head, location, list buckets', async () => {
    expect((await s3(ctx, 'HEAD', '/test-bucket')).status).toBe(404)

    expect((await s3(ctx, 'PUT', '/test-bucket')).status).toBe(200)
    expect((await s3(ctx, 'HEAD', '/test-bucket')).status).toBe(200)
    expect((await s3(ctx, 'GET', '/test-bucket?location')).status).toBe(200)

    const lb = await s3(ctx, 'GET', '/')
    expect(lb.status).toBe(200)
    expect(await lb.text()).toContain('<Name>test-bucket</Name>')
  })

  it('put/get/head/delete object with folder hierarchy', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const put = await s3(ctx, 'PUT', '/test-bucket/dir/a.txt', {
      body: 'alpha',
      headers: { 'Content-Type': 'text/plain', 'x-amz-meta-color': 'red' },
    })
    expect(put.status).toBe(200)
    expect(put.headers.get('etag')).toMatch(/^".+"$/)

    const get = await s3(ctx, 'GET', '/test-bucket/dir/a.txt')
    expect(get.status).toBe(200)
    expect(await get.text()).toBe('alpha')
    expect(get.headers.get('etag')).toMatch(/^".+"$/)
    expect(get.headers.get('x-amz-meta-color')).toBe('red')
    expect(get.headers.get('content-type')).toBe('text/plain')

    const head = await s3(ctx, 'HEAD', '/test-bucket/dir/a.txt')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('5')
    expect(head.headers.get('x-amz-meta-color')).toBe('red')

    expect((await s3(ctx, 'DELETE', '/test-bucket/dir/a.txt')).status).toBe(204)
    expect((await s3(ctx, 'GET', '/test-bucket/dir/a.txt')).status).toBe(404)
    // S3-style idempotent delete
    expect((await s3(ctx, 'DELETE', '/test-bucket/dir/a.txt')).status).toBe(204)
  })

  it('delete bucket trashes the root folder (DeleteBucket)', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/x.txt', { body: 'x' })
    expect((await s3(ctx, 'DELETE', '/test-bucket')).status).toBe(204)
    expect((await s3(ctx, 'HEAD', '/test-bucket')).status).toBe(404)
    expect((await s3(ctx, 'GET', '/test-bucket/x.txt')).status).toBe(404)
    expect(ctx.drive.allFiles().find((f) => f.name === 'test-bucket' && !f.trashed)).toBeUndefined()
  })

  it('delete missing bucket → NoSuchBucket', async () => {
    const res = await s3(ctx, 'DELETE', '/test-bucket')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('NoSuchBucket')
  })

  it('overwrite semantics: newest content wins, no duplicate Drive files', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/k.txt', { body: 'v1' })
    await s3(ctx, 'PUT', '/test-bucket/k.txt', { body: 'v2' })
    await s3(ctx, 'PUT', '/test-bucket/k.txt', { body: 'v3' })
    const get = await s3(ctx, 'GET', '/test-bucket/k.txt')
    expect(await get.text()).toBe('v3')
    const root = await bucketRootId(ctx, 'test-bucket')
    expect(ctx.drive.countUntrashed(root, 'k.txt')).toBe(1)
  })

  it('range GET returns 206 with Content-Range', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/r.txt', { body: '0123456789' })
    const res = await s3(ctx, 'GET', '/test-bucket/r.txt', { headers: { Range: 'bytes=2-5' } })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('2345')
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
  })

  it('missing object → NoSuchKey XML', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const res = await s3(ctx, 'GET', '/test-bucket/nope.txt')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('NoSuchKey')
  })

  it('ListObjects V2 with delimiter and common prefixes', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/a.txt', { body: '1' })
    await s3(ctx, 'PUT', '/test-bucket/b/c.txt', { body: '2' })
    await s3(ctx, 'PUT', '/test-bucket/b/d/e.txt', { body: '3' })
    await s3(ctx, 'PUT', '/test-bucket/f.txt', { body: '4' })

    const res = await s3(ctx, 'GET', '/test-bucket?list-type=2&delimiter=%2F')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<Key>a.txt</Key>')
    expect(xml).toContain('<Key>f.txt</Key>')
    expect(xml).toContain('<Prefix>b/</Prefix>')
    expect(xml).not.toContain('<Key>b/c.txt</Key>')
    expect(xmlTag(xml, 'KeyCount')).toBe('3')
    expect(xmlTag(xml, 'IsTruncated')).toBe('false')
  })

  it('ListObjects V2 recursive (delimiter empty) under prefix', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/a.txt', { body: '1' })
    await s3(ctx, 'PUT', '/test-bucket/b/c.txt', { body: '2' })
    await s3(ctx, 'PUT', '/test-bucket/b/d/e.txt', { body: '3' })

    const res = await s3(ctx, 'GET', '/test-bucket?list-type=2&prefix=b%2F')
    const xml = await res.text()
    expect(xml).toContain('<Key>b/c.txt</Key>')
    expect(xml).toContain('<Key>b/d/e.txt</Key>')
    expect(xml).not.toContain('<Key>a.txt</Key>')
  })

  it('ListObjects V2 mid-folder prefix (no trailing slash) with delimiter', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/b/c.txt', { body: '2' })
    const res = await s3(ctx, 'GET', '/test-bucket?list-type=2&delimiter=%2F&prefix=b')
    const xml = await res.text()
    expect(xml).toContain('<Prefix>b/</Prefix>')
    expect(xml).not.toContain('<Key>')
  })

  it('paginates V2 with max-keys + continuation token', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    for (let i = 0; i < 3; i++) {
      await s3(ctx, 'PUT', `/test-bucket/k${i}.txt`, { body: String(i) })
    }
    const page1 = await s3(ctx, 'GET', '/test-bucket?list-type=2&max-keys=2')
    const xml1 = await page1.text()
    expect(xmlTag(xml1, 'IsTruncated')).toBe('true')
    expect(xml1).toContain('<Key>k0.txt</Key>')
    expect(xml1).toContain('<Key>k1.txt</Key>')
    expect(xml1).not.toContain('k2.txt')
    const token = xmlTag(xml1, 'NextContinuationToken')
    expect(token).toBeTruthy()

    const page2 = await s3(ctx, 'GET', `/test-bucket?list-type=2&continuation-token=${encodeURIComponent(token!)}`)
    const xml2 = await page2.text()
    expect(xmlTag(xml2, 'IsTruncated')).toBe('false')
    expect(xml2).toContain('<Key>k2.txt</Key>')
  })

  it('lists an ETag that matches the object GET/HEAD ETag', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/e.txt', { body: 'etag' })
    const listed = await (await s3(ctx, 'GET', '/test-bucket?list-type=2')).text()
    const listEtag = /<ETag>&quot;([\s\S]*?)&quot;<\/ETag>/.exec(listed)?.[1]
    const head = await s3(ctx, 'HEAD', '/test-bucket/e.txt')
    expect(listEtag).toBeTruthy()
    expect(head.headers.get('ETag')).toBe(`"${listEtag}"`)
  })

  it('ListObjects V1 with marker continuation', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    for (let i = 0; i < 3; i++) {
      await s3(ctx, 'PUT', `/test-bucket/m${i}.txt`, { body: String(i) })
    }
    const page1 = await s3(ctx, 'GET', '/test-bucket?max-keys=2')
    const xml1 = await page1.text()
    expect(xmlTag(xml1, 'IsTruncated')).toBe('true')
    const marker = xmlTag(xml1, 'NextMarker')
    expect(marker).toBeTruthy()

    const page2 = await s3(ctx, 'GET', `/test-bucket?marker=${encodeURIComponent(marker!)}`)
    const xml2 = await page2.text()
    expect(xmlTag(xml2, 'IsTruncated')).toBe('false')
    expect(xml2).toContain('<Key>m2.txt</Key>')
  })

  it('ListObjects V1 with a plain key marker skips earlier keys', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/p0.txt', { body: '0' })
    await s3(ctx, 'PUT', '/test-bucket/p1.txt', { body: '1' })
    await s3(ctx, 'PUT', '/test-bucket/p2.txt', { body: '2' })
    const res = await s3(ctx, 'GET', '/test-bucket?marker=p1.txt')
    const xml = await res.text()
    expect(xml).toContain('<Key>p2.txt</Key>')
    expect(xml).not.toContain('<Key>p0.txt</Key>')
    expect(xml).not.toContain('<Key>p1.txt</Key>')
  })

  it('ListObjects V2 start-after', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/s0.txt', { body: '0' })
    await s3(ctx, 'PUT', '/test-bucket/s1.txt', { body: '1' })
    const res = await s3(ctx, 'GET', '/test-bucket?list-type=2&start-after=s0.txt')
    const xml = await res.text()
    expect(xml).toContain('<Key>s1.txt</Key>')
    expect(xml).not.toContain('<Key>s0.txt</Key>')
  })

  it('CopyObject within the same bucket', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/src.txt', { body: 'copy me' })
    const res = await s3(ctx, 'PUT', '/test-bucket/dst.txt', {
      headers: { 'x-amz-copy-source': '/test-bucket/src.txt' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('CopyObjectResult')
    expect(await (await s3(ctx, 'GET', '/test-bucket/dst.txt')).text()).toBe('copy me')
  })

  it('DeleteObjects (batch trash)', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/x1.txt', { body: '1' })
    await s3(ctx, 'PUT', '/test-bucket/x2.txt', { body: '2' })
    const body =
      '<Delete><Object><Key>x1.txt</Key></Object><Object><Key>x2.txt</Key></Object><Object><Key>missing.txt</Key></Object></Delete>'
    const res = await s3(ctx, 'POST', '/test-bucket?delete', { body })
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<Deleted><Key>x1.txt</Key></Deleted>')
    expect(xml).toContain('<Deleted><Key>missing.txt</Key></Deleted>')
    expect((await s3(ctx, 'GET', '/test-bucket/x1.txt')).status).toBe(404)
    expect((await s3(ctx, 'GET', '/test-bucket/x2.txt')).status).toBe(404)
  })

  it('public read bucket: unsigned GET works; private bucket requires signature', async () => {
    await s3(ctx, 'PUT', '/public-bucket', {})
    await s3(ctx, 'PUT', '/public-bucket/pub.txt', { body: 'open' })
    // unsigned request
    const publicGet = await ctx.app.fetch(new Request('http://localhost/public-bucket/pub.txt', { method: 'GET' }))
    expect(publicGet.status).toBe(200)
    expect(await publicGet.text()).toBe('open')

    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/priv.txt', { body: 'closed' })
    const privateGet = await ctx.app.fetch(new Request('http://localhost/test-bucket/priv.txt', { method: 'GET' }))
    expect(privateGet.status).toBe(403)
  })

  it('public bucket GET is edge-cached and purged on overwrite', async () => {
    const removeCache = installMemoryCache()
    try {
      await s3(ctx, 'PUT', '/public-bucket', {})
      await s3(ctx, 'PUT', '/public-bucket/pub.txt', { body: 'v1' })

      let driveDownloads = 0
      const inner = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('alt=media')) driveDownloads++
        return inner(input, init)
      }) as typeof fetch

      const get = () => ctx.app.fetch(new Request('http://localhost/public-bucket/pub.txt', { method: 'GET' }))

      // First GET goes to Drive and populates the cache.
      expect(await (await get()).text()).toBe('v1')
      await tick()
      // Second GET is served from the cache without touching Drive.
      const r2 = await get()
      expect(await r2.text()).toBe('v1')
      expect(r2.headers.get('Cache-Control')).toContain('max-age=300')
      expect(driveDownloads).toBe(1)

      // Overwrite purges the entry; the next GET fetches fresh content.
      await s3(ctx, 'PUT', '/public-bucket/pub.txt', { body: 'v2' })
      await tick()
      expect(await (await get()).text()).toBe('v2')
      expect(driveDownloads).toBe(2)
    } finally {
      removeCache()
    }
  })

  it('range GETs on public buckets bypass the edge cache', async () => {
    const removeCache = installMemoryCache()
    try {
      await s3(ctx, 'PUT', '/public-bucket', {})
      await s3(ctx, 'PUT', '/public-bucket/range.txt', { body: 'abcdef' })
      const r = await ctx.app.fetch(new Request('http://localhost/public-bucket/range.txt', { headers: { Range: 'bytes=0-2' } }))
      expect(r.status).toBe(206)
      expect(await r.text()).toBe('abc')
      // Nothing was cached by the range request.
      const full = await ctx.app.fetch(new Request('http://localhost/public-bucket/range.txt', { method: 'GET' }))
      expect(await full.text()).toBe('abcdef')
    } finally {
      removeCache()
    }
  })

  it('rejects unsigned writes and wrong signatures', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const unsigned = await ctx.app.fetch(new Request('http://localhost/test-bucket/foo.txt', { method: 'PUT', body: 'x' }))
    expect(unsigned.status).toBe(403)

    const bad = await makeBadSignedPut(ctx)
    expect(bad.status).toBe(403)
    expect(await bad.text()).toContain('SignatureDoesNotMatch')
  })

  it('rejects disallowed buckets', async () => {
    const res = await s3(ctx, 'GET', '/other-bucket')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('AccessDenied')
  })

  it('wildcard ALLOWED_BUCKETS grants full access (AWS root semantics)', async () => {
    const w = await setupTest({ ALLOWED_BUCKETS: '*' })
    try {
      expect((await s3(w, 'PUT', '/anything-goes')).status).toBe(200)
      expect((await s3(w, 'HEAD', '/anything-goes')).status).toBe(200)
      const lb = await s3(w, 'GET', '/')
      const xml = await lb.text()
      expect(xml).toContain('<Name>anything-goes</Name>')
      // internal multipart storage must never surface as a bucket
      expect(xml).not.toContain('.gdrive-s3-multipart')
    } finally {
      w.restore()
    }
  })

  it('rejects invalid bucket names per AWS naming rules', async () => {
    const w = await setupTest({ ALLOWED_BUCKETS: '*' })
    try {
      for (const name of ['ab', 'Upper-case', 'double..dot', '-leadingdash', 'trailingdash-', 'x'.repeat(64)]) {
        const res = await s3(w, 'PUT', `/${name}`)
        expect(res.status, name).toBe(400)
        expect(await res.text(), name).toContain('InvalidBucketName')
      }
    } finally {
      w.restore()
    }
  })

  it('presigned PUT then GET works end to end', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const put = await s3Presigned(ctx, 'PUT', '/test-bucket/pre.txt', { body: 'presigned content' })
    expect(put.status).toBe(200)
    const get = await s3Presigned(ctx, 'GET', '/test-bucket/pre.txt')
    expect(get.status).toBe(200)
    expect(await get.text()).toBe('presigned content')
  })

  it('streaming upload (UNSIGNED-PAYLOAD ReadableStream body)', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stream'))
        controller.enqueue(new TextEncoder().encode('-uploaded'))
        controller.close()
      },
    })
    const res = await s3(ctx, 'PUT', '/test-bucket/stream.bin', { body: stream })
    expect(res.status).toBe(200)
    expect(await (await s3(ctx, 'GET', '/test-bucket/stream.bin')).text()).toBe('stream-uploaded')
  })

  it('aws-chunked upload (STREAMING-UNSIGNED-PAYLOAD-TRAILER, aws-sdk v3 style)', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const enc = new TextEncoder()
    const parts = [enc.encode('part1-'), enc.encode('part2')]
    const encoded: number[] = []
    for (const p of parts) {
      encoded.push(...enc.encode(p.length.toString(16) + '\r\n'))
      encoded.push(...p)
      encoded.push(...enc.encode('\r\n'))
    }
    encoded.push(...enc.encode('0\r\n'))
    encoded.push(...enc.encode('x-amz-checksum-crc32: dummy==\r\n\r\n'))
    const chunkedBody = new Uint8Array(encoded)

    const url = 'http://localhost/test-bucket/chunked.bin'
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunkedBody)
        controller.close()
      },
    })
    const signed = await ctx.aws.sign(url, {
      method: 'PUT',
      headers: {
        'X-Amz-Content-Sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER',
        'x-amz-decoded-content-length': '11',
        'Content-Encoding': 'aws-chunked',
      },
      body: stream,
    })
    signed.headers.set('host', 'localhost')
    const res = await ctx.app.fetch(signed)
    expect(res.status).toBe(200)
    expect(await (await s3(ctx, 'GET', '/test-bucket/chunked.bin')).text()).toBe('part1-part2')
  })

  it('rejects dot-dot segments (URL normalization → unknown bucket → AccessDenied)', async () => {
    const res = await s3(ctx, 'PUT', '/test-bucket/%2E%2E/escape', { body: 'x' })
    // the URL parser collapses dot segments, so this must never reach a Drive path
    expect(res.status).toBe(403)
  })

  it('CORS preflight responds 204 with allow headers', async () => {
    const res = await ctx.app.fetch(
      new Request('http://localhost/test-bucket', {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'PUT' },
      }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

async function makeBadSignedPut(ctx: TestSetup): Promise<Response> {
  // sign with wrong secret
  const badAws = new AwsClient({ accessKeyId: ACCESS_KEY, secretAccessKey: 'totally-wrong-secret', service: 's3', region: 'us-east-1' })
  const signed = await badAws.sign('http://localhost/test-bucket/foo.txt', { method: 'PUT', body: 'x' })
  signed.headers.set('host', 'localhost')
  return ctx.app.fetch(signed)
}
