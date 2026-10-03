import { AwsClient } from 'aws4fetch'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACCESS_KEY, bucketRootId, makeAws, s3, s3Presigned, setupTest, xmlTag, type TestSetup } from './helpers'

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

  it('GetBucketLocation echoes the signing region (any region accepted)', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const signed = await makeAws('ap-southeast-1').sign('http://localhost/test-bucket?location', { method: 'GET' })
    signed.headers.set('host', 'localhost')
    const res = await ctx.app.fetch(signed)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">ap-southeast-1</LocationConstraint>')
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

  it('keeps max-keys across every page and never repeats a key', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    for (let i = 0; i < 3; i++) {
      await s3(ctx, 'PUT', `/test-bucket/k${i}.txt`, { body: String(i) })
    }
    const seen: string[] = []
    let token: string | null = null
    for (let page = 0; page < 5; page++) {
      const qs = `list-type=2&max-keys=1${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`
      const xml = await (await s3(ctx, 'GET', `/test-bucket?${qs}`)).text()
      const key = xmlTag(xml, 'Key')
      if (key) seen.push(key)
      token = xmlTag(xml, 'NextContinuationToken')
      if (xmlTag(xml, 'IsTruncated') === 'false') break
    }
    expect(seen).toEqual(['k0.txt', 'k1.txt', 'k2.txt'])
  })

  it('resumes a page truncated mid-folder without losing or duplicating keys', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/a.txt', { body: 'a' })
    await s3(ctx, 'PUT', '/test-bucket/dir/b.txt', { body: 'b' })
    await s3(ctx, 'PUT', '/test-bucket/dir/c.txt', { body: 'c' })

    const page1 = await (await s3(ctx, 'GET', '/test-bucket?list-type=2&max-keys=2')).text()
    expect(xmlTag(page1, 'KeyCount')).toBe('2')
    expect(xmlTag(page1, 'IsTruncated')).toBe('true')
    expect(page1).toContain('<Key>a.txt</Key>')
    expect(page1).toContain('<Key>dir/b.txt</Key>')
    const token = xmlTag(page1, 'NextContinuationToken')
    expect(token).toBeTruthy()

    const page2 = await (
      await s3(ctx, 'GET', `/test-bucket?list-type=2&max-keys=2&continuation-token=${encodeURIComponent(token!)}`)
    ).text()
    expect(xmlTag(page2, 'IsTruncated')).toBe('false')
    expect(page2).toContain('<Key>dir/c.txt</Key>')
    expect(page2).not.toContain('<Key>a.txt</Key>')
    expect(page2).not.toContain('<Key>dir/b.txt</Key>')
  })

  it('paginates delimiter listings across pages without repeats', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/a.txt', { body: 'a' })
    await s3(ctx, 'PUT', '/test-bucket/b.txt', { body: 'b' })
    await s3(ctx, 'PUT', '/test-bucket/c.txt', { body: 'c' })
    await s3(ctx, 'PUT', '/test-bucket/dir/d.txt', { body: 'd' })

    const seen: string[] = []
    let token: string | null = null
    for (let page = 0; page < 5; page++) {
      const qs = `list-type=2&delimiter=%2F&max-keys=2${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`
      const xml = await (await s3(ctx, 'GET', `/test-bucket?${qs}`)).text()
      seen.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]))
      seen.push(...[...xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)].map((m) => m[1]))
      token = xmlTag(xml, 'NextContinuationToken')
      if (xmlTag(xml, 'IsTruncated') === 'false') break
    }
    expect(seen).toEqual(['a.txt', 'b.txt', 'c.txt', 'dir/'])
  })

  it('paginates recursive listings into subfolders without dropping keys', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/a.txt', { body: 'a' })
    await s3(ctx, 'PUT', '/test-bucket/b.txt', { body: 'b' })
    await s3(ctx, 'PUT', '/test-bucket/dir/c.txt', { body: 'c' })
    await s3(ctx, 'PUT', '/test-bucket/dir/deep/d.txt', { body: 'd' })

    const seen: string[] = []
    let token: string | null = null
    for (let page = 0; page < 10; page++) {
      const qs = `list-type=2&max-keys=1${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`
      const xml = await (await s3(ctx, 'GET', `/test-bucket?${qs}`)).text()
      seen.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]))
      token = xmlTag(xml, 'NextContinuationToken')
      if (xmlTag(xml, 'IsTruncated') === 'false') break
    }
    expect([...seen].sort()).toEqual(['a.txt', 'b.txt', 'dir/c.txt', 'dir/deep/d.txt'])
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('walks deep recursive trees with a bounded token', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/aa.txt', { body: '1' })
    for (let i = 0; i < 12; i++) {
      await s3(ctx, 'PUT', `/test-bucket/d${i}/f.txt`, { body: String(i) })
    }
    await s3(ctx, 'PUT', '/test-bucket/d0/nested/deep.txt', { body: 'deep' })

    const seen: string[] = []
    let token: string | null = null
    let maxToken = 0
    for (let page = 0; page < 30; page++) {
      const qs = `list-type=2&max-keys=1${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`
      const xml = await (await s3(ctx, 'GET', `/test-bucket?${qs}`)).text()
      seen.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]))
      token = xmlTag(xml, 'NextContinuationToken')
      if (token) maxToken = Math.max(maxToken, token.length)
      if (xmlTag(xml, 'IsTruncated') === 'false') break
    }
    expect([...seen].sort()).toEqual(
      ['aa.txt', 'd0/f.txt', 'd0/nested/deep.txt', ...[...Array(12).keys()].slice(1).map((i) => `d${i}/f.txt`)].sort(),
    )
    expect(new Set(seen).size).toBe(seen.length)
    expect(maxToken).toBeLessThan(2000)
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

  it('ListObjects V2 ignores start-after once a continuation token is present', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    for (let i = 0; i < 3; i++) {
      await s3(ctx, 'PUT', `/test-bucket/t${i}.txt`, { body: String(i) })
    }
    const page1 = await (await s3(ctx, 'GET', '/test-bucket?list-type=2&max-keys=1&start-after=t0.txt')).text()
    const token = xmlTag(page1, 'NextContinuationToken')
    expect(token).toBeTruthy()
    expect(page1).toContain('<Key>t1.txt</Key>')

    const page2 = await (
      await s3(ctx, 'GET', `/test-bucket?list-type=2&start-after=t0.txt&continuation-token=${encodeURIComponent(token!)}`)
    ).text()
    expect(page2).toContain('<Key>t2.txt</Key>')
    expect(page2).not.toContain('<Key>t1.txt</Key>')
  })

  it('resolves a bucket name case-insensitively to the Drive folder', async () => {
    ctx.drive.addFile({ name: 'Anime', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] })
    const res = await s3(ctx, 'PUT', '/anime/Show/ep1.mkv', { body: 'x' })
    expect(res.status).toBe(200)

    const list = await (await s3(ctx, 'GET', '/ANIME?list-type=2')).text()
    expect(list).toContain('<Name>anime</Name>')
    expect(list).toContain('<Key>Show/ep1.mkv</Key>')
    expect((await s3(ctx, 'HEAD', '/anime/Show/ep1.mkv')).status).toBe(200)
    expect(await (await s3(ctx, 'GET', '/Anime/Show/ep1.mkv')).text()).toBe('x')
    expect((await s3(ctx, 'PUT', '/anime')).status).toBe(200)
    expect((await s3(ctx, 'PUT', '/anime')).status).toBe(200)
  })

  it('caches the alias so only the first request pays for the lookup', async () => {
    ctx.drive.addFile({ name: 'Movie', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] })
    expect((await s3(ctx, 'PUT', '/movie/m1.mkv', { body: 'x' })).status).toBe(200)
    const lookupsBefore = ctx.stub.calls.filter((c) => c.includes('name%3D%27movie%27')).length
    expect(lookupsBefore).toBeGreaterThan(0)
    expect((await s3(ctx, 'GET', '/movie/m1.mkv')).status).toBe(200)
    const lookupsAfter = ctx.stub.calls.filter((c) => c.includes('name%3D%27movie%27')).length
    expect(lookupsAfter).toBe(lookupsBefore)
  })

  it('keeps unknown bucket names unknown (NoSuchBucket)', async () => {
    const res = await s3(ctx, 'GET', '/missing-bucket')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('NoSuchBucket')
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

  it('unsigned object GET is rejected (no public-read buckets)', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/priv.txt', { body: 'closed' })
    const res = await ctx.app.fetch(new Request('http://localhost/test-bucket/priv.txt', { method: 'GET' }))
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('AccessDenied')
  })

  it('ListBuckets requires a signature and never leaks bucket names anonymously', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const anon = await ctx.app.fetch(new Request('http://localhost/', { method: 'GET' }))
    expect(anon.status).toBe(403)
    const body = await anon.text()
    expect(body).toContain('AccessDenied')
    expect(body).not.toContain('test-bucket')

    const signed = await s3(ctx, 'GET', '/')
    expect(signed.status).toBe(200)
    expect(await signed.text()).toContain('<Name>test-bucket</Name>')
  })

  it('rejects unsigned writes and wrong signatures', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const unsigned = await ctx.app.fetch(new Request('http://localhost/test-bucket/foo.txt', { method: 'PUT', body: 'x' }))
    expect(unsigned.status).toBe(403)

    const bad = await makeBadSignedPut(ctx)
    expect(bad.status).toBe(403)
    expect(await bad.text()).toContain('SignatureDoesNotMatch')
  })

  it('wildcard bucket allowlist grants full access (AWS root semantics)', async () => {
    expect((await s3(ctx, 'PUT', '/anything-goes')).status).toBe(200)
    expect((await s3(ctx, 'HEAD', '/anything-goes')).status).toBe(200)
    const lb = await s3(ctx, 'GET', '/')
    const xml = await lb.text()
    expect(xml).toContain('<Name>anything-goes</Name>')

    expect(xml).not.toContain('.gdrive-s3-multipart')
  })

  it('rejects invalid bucket names per AWS naming rules', async () => {
    for (const name of ['ab', 'Upper-case', 'double..dot', '-leadingdash', 'trailingdash-', 'x'.repeat(64)]) {
      const res = await s3(ctx, 'PUT', `/${name}`)
      expect(res.status, name).toBe(400)
      expect(await res.text(), name).toContain('InvalidBucketName')
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

  it('dot-dot segments never escape into another bucket', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/keep.txt', { body: 'keep' })

    await s3(ctx, 'PUT', '/test-bucket/%2E%2E/escape', { body: 'x' })
    expect((await s3(ctx, 'GET', '/test-bucket/escape')).status).toBe(404)
    expect(await (await s3(ctx, 'GET', '/test-bucket/keep.txt')).text()).toBe('keep')
    expect((await s3(ctx, 'HEAD', '/escape')).status).toBe(200)
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
  const badAws = new AwsClient({ accessKeyId: ACCESS_KEY, secretAccessKey: 'totally-wrong-secret', service: 's3', region: 'us-east-1' })
  const signed = await badAws.sign('http://localhost/test-bucket/foo.txt', { method: 'PUT', body: 'x' })
  signed.headers.set('host', 'localhost')
  return ctx.app.fetch(signed)
}

describe('bucket name casing in responses', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
  })
  afterEach(() => ctx.restore())

  it('reports lowercase bucket names while keeping object keys verbatim', async () => {
    ctx.drive.addFile({ name: 'Anime', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] })
    await s3(ctx, 'PUT', '/anime/Show/Case Sensitive Name.mkv', { body: 'x' })

    const list = await (await s3(ctx, 'GET', '/anime?list-type=2&prefix=Show%2F')).text()
    expect(list).toContain('<Name>anime</Name>')
    expect(list).not.toContain('<Name>Anime</Name>')
    expect(list).toContain('<Key>Show/Case Sensitive Name.mkv</Key>')

    const prefixList = await (await s3(ctx, 'GET', '/Anime?list-type=2&delimiter=%2F')).text()
    expect(prefixList).toContain('<Name>anime</Name>')
    expect(prefixList).toContain('<Prefix>Show/</Prefix>')

    const buckets = await (await s3(ctx, 'GET', '/')).text()
    expect(buckets).toContain('<Name>anime</Name>')
    expect(buckets).not.toContain('<Name>Anime</Name>')
  })

  it('lowercases the bucket in multipart responses but not the key', async () => {
    ctx.drive.addFile({ name: 'Anime', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] })
    const init = await s3(ctx, 'POST', '/anime/Big File.bin?uploads')
    const initXml = await init.text()
    expect(initXml).toContain('<Bucket>anime</Bucket>')
    expect(initXml).toContain('<Key>Big File.bin</Key>')

    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(initXml)![1]
    const part = await s3(ctx, 'PUT', `/anime/Big File.bin?uploadId=${uploadId}&partNumber=1`, { body: 'AAAAA' })
    const etag = part.headers.get('etag')!.replace(/"/g, '')
    const done = await s3(ctx, 'POST', `/anime/Big File.bin?uploadId=${uploadId}`, {
      body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"${etag}"</ETag></Part></CompleteMultipartUpload>`,
    })
    const doneXml = await done.text()
    expect(doneXml).toContain('<Bucket>anime</Bucket>')
    expect(doneXml).toContain('<Key>Big File.bin</Key>')
    expect(doneXml).toContain('https://anime.s3.us-east-1.amazonaws.com/Big File.bin')
    expect(await (await s3(ctx, 'GET', '/anime/Big File.bin')).text()).toBe('AAAAA')
  })

  it('lowercases the bucket in errors and preserves the key casing', async () => {
    ctx.drive.addFile({ name: 'Anime', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] })
    const res = await s3(ctx, 'GET', '/anime/Missing/File.MKV')
    expect(res.status).toBe(404)
    const xml = await res.text()
    expect(xml).toContain('NoSuchKey')
    expect(xml).toContain('<Resource>/anime/Missing/File.MKV</Resource>')
  })
})

describe('encoding-type=url', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
  })
  afterEach(() => ctx.restore())

  it('omits EncodingType and returns raw keys by default', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/a b/c d.txt', { body: 'x' })

    const xml = await (await s3(ctx, 'GET', '/test-bucket?list-type=2&prefix=a%20b%2F')).text()
    expect(xml).not.toContain('<EncodingType>')
    expect(xml).toContain('<Key>a b/c d.txt</Key>')
    expect(xml).toContain('<Prefix>a b/</Prefix>')
  })

  it('percent-encodes keys, prefixes and echoes EncodingType when requested', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/a b/c d.txt', { body: 'x' })

    const xml = await (await s3(ctx, 'GET', '/test-bucket?list-type=2&encoding-type=url&prefix=a%20b%2F')).text()
    expect(xml).toContain('<EncodingType>url</EncodingType>')
    expect(xml).toContain('<Key>a%20b%2Fc%20d.txt</Key>')
    expect(xml).toContain('<Prefix>a%20b%2F</Prefix>')

    const delim = await (await s3(ctx, 'GET', '/test-bucket?list-type=2&encoding-type=url&delimiter=%2F')).text()
    expect(delim).toContain('<EncodingType>url</EncodingType>')
    expect(delim).toContain('<Prefix>a%20b%2F</Prefix>')
  })

  it('decodes encoding-type=url output back to the real key', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/Spaced%20Name/%C3%9Cn%C3%AFcode%20%26%20symbols.txt', { body: 'x' })

    const xml = await (await s3(ctx, 'GET', '/test-bucket?list-type=2&encoding-type=url&prefix=Spaced%20Name%2F')).text()
    const encoded = /<Key>([^<]+)<\/Key>/.exec(xml)?.[1]
    expect(encoded).toBeTruthy()
    expect(encoded).not.toBe('Spaced Name/Ünïcode & symbols.txt')
    expect(decodeURIComponent(encoded!)).toBe('Spaced Name/Ünïcode & symbols.txt')
  })
})

describe('DeleteObjects beyond the subrequest limit', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
  })
  afterEach(() => ctx.restore())

  it('deletes far more keys than the 50-subrequest cap allows', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const total = 120
    for (let i = 0; i < total; i++) {
      await s3(ctx, 'PUT', `/test-bucket/dir/f${String(i).padStart(3, '0')}.txt`, { body: 'x' })
    }

    const before = ctx.stub.calls.length
    const body = `<Delete>${Array.from({ length: total }, (_, i) => `<Object><Key>dir/f${String(i).padStart(3, '0')}.txt</Key></Object>`).join('')}</Delete>`
    const xml = await (await s3(ctx, 'POST', '/test-bucket?delete', { body })).text()

    const deleted = [...xml.matchAll(/<Deleted>/g)].length
    const errors = [...xml.matchAll(/<Error>/g)].length
    expect(deleted).toBe(total)
    expect(errors).toBe(0)

    const calls = ctx.stub.calls.slice(before)
    const batches = calls.filter((c) => c.startsWith('/batch/drive/v3'))
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.length).toBeLessThan(total)
    expect(calls.filter((c) => c.includes('/drive/v3/files/')).length).toBe(0)
  })

  it('reports an error when the batch trash fails', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/dir/a.txt', { body: 'x' })
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/batch/drive/v3')) return new Response('boom', { status: 500 })
      return original(input as RequestInfo, init)
    }) as typeof fetch
    try {
      const xml = await (await s3(ctx, 'POST', '/test-bucket?delete', { body: '<Delete><Object><Key>dir/a.txt</Key></Object></Delete>' })).text()
      expect(xml).toContain('<Error>')
      expect(xml).toContain('dir/a.txt')
    } finally {
      globalThis.fetch = original
    }
  })
})
