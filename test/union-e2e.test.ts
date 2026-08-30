import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FOLDER_MIME } from '../src/drive/folder'
import { invalidateTokenCache } from '../src/drive/auth'
import {
  s3,
  setupUnionTest,
  unionBucketId,
  unionDriveHasKey,
  xmlTag,
  type UnionSaSpec,
  type UnionTestSetup,
} from './helpers'
import type { FakeDrive } from './harness'

const SA_A = 'sa-a@proj.iam.gserviceaccount.com'
const SA_B = 'sa-b@proj.iam.gserviceaccount.com'

function driveOf(t: UnionTestSetup, sa: string): FakeDrive {
  return t.drives.get(`sa-token-${sa.split('@')[0]}`)!
}

function seedBucketRoot(drive: FakeDrive, bucket: string): void {
  if (unionBucketId(drive, bucket)) return
  drive.addFile({ name: bucket, mimeType: FOLDER_MIME, parents: ['root'] })
}

function seedKey(drive: FakeDrive, bucket: string, key: string, content: string): void {
  const root = unionBucketId(drive, bucket)
  if (!root) throw new Error(`bucket ${bucket} missing in drive`)
  const segs = key.split('/').filter(Boolean)
  let parent = root
  for (let i = 0; i < segs.length - 1; i++) {
    const dir = drive.addFile({ name: segs[i], mimeType: FOLDER_MIME, parents: [parent] })
    parent = dir.id
  }
  drive.addFile({ name: segs[segs.length - 1], mimeType: 'text/plain', parents: [parent], content: new TextEncoder().encode(content) })
}

function readKey(drive: FakeDrive, bucket: string, key: string): string | null {
  const root = unionBucketId(drive, bucket)
  if (!root) return null
  const segs = key.split('/').filter(Boolean)
  let parent = root
  for (let i = 0; i < segs.length - 1; i++) {
    const dir = drive.allFiles().find((f) => !f.trashed && f.mimeType === FOLDER_MIME && f.name === segs[i] && f.parents.includes(parent))
    if (!dir) return null
    parent = dir.id
  }
  const file = drive
    .allFiles()
    .find((f) => !f.trashed && f.mimeType !== FOLDER_MIME && f.name === segs[segs.length - 1] && f.parents.includes(parent))
  return file ? new TextDecoder().decode(file.content) : null
}

describe('S3 union e2e (2 service accounts)', () => {
  let t: UnionTestSetup

  beforeEach(async () => {
    invalidateTokenCache()
    t = await setupUnionTest([{ email: SA_A }, { email: SA_B }])
  })
  afterEach(() => t.restore())

  it('bucket ops: create, head, location, merged ListBuckets', async () => {
    expect((await s3(t, 'HEAD', '/test-bucket')).status).toBe(404)
    expect((await s3(t, 'PUT', '/test-bucket')).status).toBe(200)
    expect((await s3(t, 'HEAD', '/test-bucket')).status).toBe(200)
    expect((await s3(t, 'GET', '/test-bucket?location')).status).toBe(200)

    const lb = await s3(t, 'GET', '/')
    const xml = await lb.text()
    expect(xml).toContain('<Name>test-bucket</Name>')
    // the bucket root lives in exactly one upstream (CREATE policy epmfs)
    expect(unionBucketId(driveOf(t, SA_A), 'test-bucket')).toBeTruthy()
    expect(unionBucketId(driveOf(t, SA_B), 'test-bucket')).toBeNull()
  })

  it('put/get/head/delete roundtrip — key lands in one upstream, reads resolve the winner', async () => {
    await s3(t, 'PUT', '/test-bucket', {})
    const put = await s3(t, 'PUT', '/test-bucket/dir/a.txt', { body: 'alpha', headers: { 'Content-Type': 'text/plain' } })
    expect(put.status).toBe(200)

    expect(unionDriveHasKey(driveOf(t, SA_A), 'test-bucket', 'dir/a.txt')).toBe(true)
    expect(unionDriveHasKey(driveOf(t, SA_B), 'test-bucket', 'dir/a.txt')).toBe(false)

    const get = await s3(t, 'GET', '/test-bucket/dir/a.txt')
    expect(get.status).toBe(200)
    expect(await get.text()).toBe('alpha')
    expect(get.headers.get('content-type')).toBe('text/plain')

    const head = await s3(t, 'HEAD', '/test-bucket/dir/a.txt')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('5')

    expect((await s3(t, 'DELETE', '/test-bucket/dir/a.txt')).status).toBe(204)
    expect((await s3(t, 'GET', '/test-bucket/dir/a.txt')).status).toBe(404)
    expect(unionDriveHasKey(driveOf(t, SA_A), 'test-bucket', 'dir/a.txt')).toBe(false)
  })

  it('epall create mirrors the object to every upstream; delete trashes every copy', async () => {
    const ep = await setupUnionTest([{ email: SA_A }, { email: SA_B }], { UNION_CREATE_POLICY: 'epall' })
    try {
      await s3(ep, 'PUT', '/test-bucket', {})
      const put = await s3(ep, 'PUT', '/test-bucket/mirror.txt', { body: 'raid1' })
      expect(put.status).toBe(200)
      expect(unionDriveHasKey(driveOf(ep, SA_A), 'test-bucket', 'mirror.txt')).toBe(true)
      expect(unionDriveHasKey(driveOf(ep, SA_B), 'test-bucket', 'mirror.txt')).toBe(true)
      expect(readKey(driveOf(ep, SA_A), 'test-bucket', 'mirror.txt')).toBe('raid1')
      expect(readKey(driveOf(ep, SA_B), 'test-bucket', 'mirror.txt')).toBe('raid1')
      expect(await (await s3(ep, 'GET', '/test-bucket/mirror.txt')).text()).toBe('raid1')

      // overwrite refreshes every ACTION target (epall default)
      await s3(ep, 'PUT', '/test-bucket/mirror.txt', { body: 'raid1-v2' })
      expect(readKey(driveOf(ep, SA_A), 'test-bucket', 'mirror.txt')).toBe('raid1-v2')
      expect(readKey(driveOf(ep, SA_B), 'test-bucket', 'mirror.txt')).toBe('raid1-v2')

      // delete trashes in every upstream that has it
      expect((await s3(ep, 'DELETE', '/test-bucket/mirror.txt')).status).toBe(204)
      expect(unionDriveHasKey(driveOf(ep, SA_A), 'test-bucket', 'mirror.txt')).toBe(false)
      expect(unionDriveHasKey(driveOf(ep, SA_B), 'test-bucket', 'mirror.txt')).toBe(false)
      expect((await s3(ep, 'GET', '/test-bucket/mirror.txt')).status).toBe(404)
    } finally {
      ep.restore()
    }
  })

  it('ListObjects V2 merges keys from both upstreams, dedupes, honors delimiter', async () => {
    await s3(t, 'PUT', '/test-bucket', {})
    await s3(t, 'PUT', '/test-bucket/a.txt', { body: '1' })
    await s3(t, 'PUT', '/test-bucket/b/c.txt', { body: '2' })
    // seed a second copy in SA-b + a key only SA-b has
    seedBucketRoot(driveOf(t, SA_B), 'test-bucket')
    seedKey(driveOf(t, SA_B), 'test-bucket', 'a.txt', '1-dupe')
    seedKey(driveOf(t, SA_B), 'test-bucket', 'd.txt', '4')

    const res = await s3(t, 'GET', '/test-bucket?list-type=2&delimiter=%2F')
    const xml = await res.text()
    expect(res.status).toBe(200)
    expect(xml).toContain('<Key>a.txt</Key>')
    expect(xml).toContain('<Key>d.txt</Key>')
    expect(xml).toContain('<Prefix>b/</Prefix>')
    expect(xml).not.toContain('<Key>b/c.txt</Key>')
    // dedupe: a.txt appears once despite living in both upstreams
    expect(xml.match(/<Key>a\.txt<\/Key>/g)?.length).toBe(1)
    expect(xmlTag(xml, 'KeyCount')).toBe('3')
    expect(xmlTag(xml, 'IsTruncated')).toBe('false')
  })

  it('ListObjects V2 recursive merge with prefix', async () => {
    await s3(t, 'PUT', '/test-bucket', {})
    seedKey(driveOf(t, SA_A), 'test-bucket', 'x/a.txt', '1')
    seedBucketRoot(driveOf(t, SA_B), 'test-bucket')
    seedKey(driveOf(t, SA_B), 'test-bucket', 'x/b/c.txt', '2')
    const res = await s3(t, 'GET', '/test-bucket?list-type=2&prefix=x%2F')
    const xml = await res.text()
    expect(xml).toContain('<Key>x/a.txt</Key>')
    expect(xml).toContain('<Key>x/b/c.txt</Key>')
  })

  it('paginates the merged listing with a continuation token', async () => {
    await s3(t, 'PUT', '/test-bucket', {})
    for (let i = 0; i < 3; i++) await s3(t, 'PUT', `/test-bucket/k${i}.txt`, { body: String(i) })
    seedBucketRoot(driveOf(t, SA_B), 'test-bucket')
    seedKey(driveOf(t, SA_B), 'test-bucket', 'k1.txt', 'dupe')
    seedKey(driveOf(t, SA_B), 'test-bucket', 'z.txt', 'zz')

    const page1 = await s3(t, 'GET', '/test-bucket?list-type=2&max-keys=2')
    const xml1 = await page1.text()
    expect(xmlTag(xml1, 'IsTruncated')).toBe('true')
    expect(xml1).toContain('<Key>k0.txt</Key>')
    expect(xml1).toContain('<Key>k1.txt</Key>')
    expect(xml1).not.toContain('k2.txt')
    const token = xmlTag(xml1, 'NextContinuationToken')!

    const page2 = await s3(t, 'GET', `/test-bucket?list-type=2&continuation-token=${encodeURIComponent(token)}`)
    const xml2 = await page2.text()
    expect(xml2).toContain('<Key>k2.txt</Key>')
    expect(xml2).toContain('<Key>z.txt</Key>')
    expect(xmlTag(xml2, 'IsTruncated')).toBe('false')
  })

  it('ListObjects V1 with marker across the merged stream', async () => {
    await s3(t, 'PUT', '/test-bucket', {})
    await s3(t, 'PUT', '/test-bucket/m0.txt', { body: '0' })
    seedBucketRoot(driveOf(t, SA_B), 'test-bucket')
    seedKey(driveOf(t, SA_B), 'test-bucket', 'm1.txt', '1')
    seedKey(driveOf(t, SA_B), 'test-bucket', 'm2.txt', '2')
    const res = await s3(t, 'GET', '/test-bucket?marker=m1.txt')
    const xml = await res.text()
    expect(xml).toContain('<Key>m2.txt</Key>')
    expect(xml).not.toContain('<Key>m0.txt</Key>')
    expect(xml).not.toContain('<Key>m1.txt</Key>')
  })

  it('range GET streams from the winning upstream', async () => {
    await s3(t, 'PUT', '/test-bucket', {})
    await s3(t, 'PUT', '/test-bucket/r.txt', { body: '0123456789' })
    const res = await s3(t, 'GET', '/test-bucket/r.txt', { headers: { Range: 'bytes=2-5' } })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('2345')
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
  })

  it('DELETE on a missing key is a no-op 204 (idempotent)', async () => {
    await s3(t, 'PUT', '/test-bucket', {})
    expect((await s3(t, 'DELETE', '/test-bucket/never.txt')).status).toBe(204)
  })

  it('DeleteObjects removes keys across upstreams', async () => {
    await s3(t, 'PUT', '/test-bucket', {})
    await s3(t, 'PUT', '/test-bucket/x1.txt', { body: '1' })
    seedBucketRoot(driveOf(t, SA_B), 'test-bucket')
    seedKey(driveOf(t, SA_B), 'test-bucket', 'x2.txt', '2')
    const body = '<Delete><Object><Key>x1.txt</Key></Object><Object><Key>x2.txt</Key></Object></Delete>'
    const res = await s3(t, 'POST', '/test-bucket?delete', { body })
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('<Deleted><Key>x1.txt</Key></Deleted>')
    expect(xml).toContain('<Deleted><Key>x2.txt</Key></Deleted>')
    expect(unionDriveHasKey(driveOf(t, SA_A), 'test-bucket', 'x1.txt')).toBe(false)
    expect(unionDriveHasKey(driveOf(t, SA_B), 'test-bucket', 'x2.txt')).toBe(false)
  })

  it('CopyObject: dest picked by CREATE policy (cross-upstream stream copy)', async () => {
    const cp = await setupUnionTest(
      [
        { email: SA_A, quota: { limit: '1000', usage: '900' } },
        { email: SA_B, quota: { limit: '1000', usage: '100' } },
      ],
      { UNION_CREATE_POLICY: 'epall', UNION_SEARCH_POLICY: 'ff' },
    )
    try {
      await s3(cp, 'PUT', '/test-bucket', {})
      await s3(cp, 'PUT', '/test-bucket/src.txt', { body: 'copy me' })
      const res = await s3(cp, 'PUT', '/test-bucket/dst.txt', { headers: { 'x-amz-copy-source': '/test-bucket/src.txt' } })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('CopyObjectResult')
      // dest mirrored to both upstreams (epall create)
      expect(readKey(driveOf(cp, SA_A), 'test-bucket', 'dst.txt')).toBe('copy me')
      expect(readKey(driveOf(cp, SA_B), 'test-bucket', 'dst.txt')).toBe('copy me')
      expect(await (await s3(cp, 'GET', '/test-bucket/dst.txt')).text()).toBe('copy me')
    } finally {
      cp.restore()
    }
  })

  it('multipart roundtrip completes into every CREATE target', async () => {
    const mp = await setupUnionTest([{ email: SA_A }, { email: SA_B }], { UNION_CREATE_POLICY: 'epall' })
    try {
      await s3(mp, 'PUT', '/test-bucket', {})
      const created = await s3(mp, 'POST', '/test-bucket/big.bin?uploads')
      const uploadId = xmlTag(await created.text(), 'UploadId')!
      const part1 = await s3(mp, 'PUT', `/test-bucket/big.bin?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`, { body: 'AAAAA' })
      const etag1 = /<ETag>([\s\S]*?)<\/ETag>/.exec(await part1.text())![1]
      const part2 = await s3(mp, 'PUT', `/test-bucket/big.bin?partNumber=2&uploadId=${encodeURIComponent(uploadId)}`, { body: 'BBBBB' })
      const etag2 = /<ETag>([\s\S]*?)<\/ETag>/.exec(await part2.text())![1]

      const done = await s3(mp, 'POST', `/test-bucket/big.bin?uploadId=${encodeURIComponent(uploadId)}`, {
        body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag1}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${etag2}</ETag></Part></CompleteMultipartUpload>`,
      })
      expect(done.status).toBe(200)
      expect(await (await s3(mp, 'GET', '/test-bucket/big.bin')).text()).toBe('AAAAABBBBB')

      expect(readKey(driveOf(mp, SA_A), 'test-bucket', 'big.bin')).toBe('AAAAABBBBB')
      expect(readKey(driveOf(mp, SA_B), 'test-bucket', 'big.bin')).toBe('AAAAABBBBB')
      // temp session folder cleaned up
      expect(mp.drives.get('sa-token-sa-a')!.allFiles().filter((f) => f.name === uploadId && !f.trashed).length).toBe(0)
    } finally {
      mp.restore()
    }
  })

  it('writable:false upstream: reads fall back to it, writes/trashes skip it', async () => {
    const ro = await setupUnionTest([{ email: SA_A }, { email: SA_B, writable: false }])
    try {
      await s3(ro, 'PUT', '/test-bucket', {})
      // seed a read-only copy in SA-b that must survive writes and deletes
      seedBucketRoot(driveOf(ro, SA_B), 'test-bucket')
      seedKey(driveOf(ro, SA_B), 'test-bucket', 'ro.txt', 'readonly-copy')

      await s3(ro, 'PUT', '/test-bucket/ro.txt', { body: 'writable-copy' })
      // written copy lands in the writable upstream only
      expect(readKey(driveOf(ro, SA_A), 'test-bucket', 'ro.txt')).toBe('writable-copy')
      expect(readKey(driveOf(ro, SA_B), 'test-bucket', 'ro.txt')).toBe('readonly-copy')

      // ff search → lowest index (SA-a) wins
      expect(await (await s3(ro, 'GET', '/test-bucket/ro.txt')).text()).toBe('writable-copy')

      // delete trashes only the writable copy; SA-b copy stays readable
      expect((await s3(ro, 'DELETE', '/test-bucket/ro.txt')).status).toBe(204)
      expect(readKey(driveOf(ro, SA_A), 'test-bucket', 'ro.txt')).toBeNull()
      expect(readKey(driveOf(ro, SA_B), 'test-bucket', 'ro.txt')).toBe('readonly-copy')
      expect(await (await s3(ro, 'GET', '/test-bucket/ro.txt')).text()).toBe('readonly-copy')
    } finally {
      ro.restore()
    }
  })

  it('creatable:false upstream: new objects never land there, reads/writes on existing still work', async () => {
    const nc = await setupUnionTest([{ email: SA_A }, { email: SA_B, creatable: false }], { UNION_CREATE_POLICY: 'epall' })
    try {
      await s3(nc, 'PUT', '/test-bucket', {})
      await s3(nc, 'PUT', '/test-bucket/new.txt', { body: 'n' })
      // uploaded only into the creatable upstream
      expect(unionDriveHasKey(driveOf(nc, SA_A), 'test-bucket', 'new.txt')).toBe(true)
      expect(unionDriveHasKey(driveOf(nc, SA_B), 'test-bucket', 'new.txt')).toBe(false)

      // an existing copy in SA-b can still be found, overwritten (action) and deleted
      seedBucketRoot(driveOf(nc, SA_B), 'test-bucket')
      seedKey(driveOf(nc, SA_B), 'test-bucket', 'old.txt', 'b-copy')
      await s3(nc, 'PUT', '/test-bucket/old.txt', { body: 'a-copy' })
      // overwrite refreshes the ACTION targets — the upstream that holds the key (SA-b)
      expect(readKey(driveOf(nc, SA_B), 'test-bucket', 'old.txt')).toBe('a-copy')
      expect(readKey(driveOf(nc, SA_A), 'test-bucket', 'old.txt')).toBeNull()
      expect((await s3(nc, 'DELETE', '/test-bucket/old.txt')).status).toBe(204)
      expect(unionDriveHasKey(driveOf(nc, SA_B), 'test-bucket', 'old.txt')).toBe(false)
    } finally {
      nc.restore()
    }
  })

  it('DeleteBucket trashes the bucket root in every upstream that has it', async () => {
    const db = await setupUnionTest([{ email: SA_A }, { email: SA_B }], { UNION_CREATE_POLICY: 'epall' })
    try {
      await s3(db, 'PUT', '/test-bucket', {})
      await s3(db, 'PUT', '/test-bucket/x.txt', { body: 'x' })
      expect((await s3(db, 'DELETE', '/test-bucket')).status).toBe(204)
      expect((await s3(db, 'HEAD', '/test-bucket')).status).toBe(404)
      expect(unionBucketId(driveOf(db, SA_A), 'test-bucket')).toBeNull()
      expect(unionBucketId(driveOf(db, SA_B), 'test-bucket')).toBeNull()
    } finally {
      db.restore()
    }
  })

  it('missing objects/buckets return S3 error XML', async () => {
    const res = await s3(t, 'GET', '/test-bucket/nope.txt')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('NoSuchKey')
    expect((await s3(t, 'HEAD', '/nonexistent-bucket')).status).toBe(404)
    expect((await s3(t, 'DELETE', '/nonexistent-bucket')).status).toBe(404)
  })
})