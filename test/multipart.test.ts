import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bucketRootId, s3, setupTest, xmlTag, type TestSetup } from './helpers'

describe('multipart upload', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
  })
  afterEach(() => ctx.restore())

  async function createUpload(bucket: string, key: string): Promise<string> {
    const res = await s3(ctx, 'POST', `/${bucket}/${key}?uploads`)
    expect(res.status).toBe(200)
    const xml = await res.text()
    const uploadId = xmlTag(xml, 'UploadId')
    expect(uploadId).toBeTruthy()
    return uploadId!
  }

  async function uploadPart(bucket: string, key: string, uploadId: string, partNumber: number, body: string): Promise<string> {
    const res = await s3(ctx, 'PUT', `/${bucket}/${key}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`, {
      body,
    })
    expect(res.status).toBe(200)
    const xml = await res.text()
    const etag = /<ETag>&quot;([\s\S]*?)&quot;<\/ETag>/.exec(xml)?.[1]
    expect(etag).toBeTruthy()
    return etag!
  }

  function completeBody(parts: { partNumber: number; etag: string }[]): string {
    const inner = parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`)
      .join('')
    return `<CompleteMultipartUpload>${inner}</CompleteMultipartUpload>`
  }

  it('roundtrip: create → 3 parts → complete → concatenated object, temp cleaned up', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const uploadId = await createUpload('test-bucket', 'big.bin')
    const etag1 = await uploadPart('test-bucket', 'big.bin', uploadId, 1, 'AAAAA')
    const etag2 = await uploadPart('test-bucket', 'big.bin', uploadId, 2, 'BBBBB')
    const etag3 = await uploadPart('test-bucket', 'big.bin', uploadId, 3, 'CCCCC')

    const done = await s3(ctx, 'POST', `/test-bucket/big.bin?uploadId=${encodeURIComponent(uploadId)}`, {
      body: completeBody([
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
        { partNumber: 3, etag: etag3 },
      ]),
    })
    expect(done.status).toBe(200)
    const doneXml = await done.text()
    expect(doneXml).toContain('CompleteMultipartUploadResult')
    expect(xmlTag(doneXml, 'ETag')).toBeTruthy()

    const get = await s3(ctx, 'GET', '/test-bucket/big.bin')
    expect(await get.text()).toBe('AAAAABBBBBCCCCC')

    const leftovers = ctx.drive.allFiles().filter((f) => f.name === uploadId && !f.trashed)
    expect(leftovers.length).toBe(0)
    const root = await bucketRootId(ctx, 'test-bucket')
    expect(ctx.drive.countUntrashed(root, 'big.bin')).toBe(1)
  })

  it('multipart replaces an existing object (overwrite semantics)', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    await s3(ctx, 'PUT', '/test-bucket/big.bin', { body: 'old content' })
    const uploadId = await createUpload('test-bucket', 'big.bin')
    const etag1 = await uploadPart('test-bucket', 'big.bin', uploadId, 1, 'NEW')
    await s3(ctx, 'POST', `/test-bucket/big.bin?uploadId=${encodeURIComponent(uploadId)}`, {
      body: completeBody([{ partNumber: 1, etag: etag1 }]),
    })
    expect(await (await s3(ctx, 'GET', '/test-bucket/big.bin')).text()).toBe('NEW')
    const root = await bucketRootId(ctx, 'test-bucket')
    expect(ctx.drive.countUntrashed(root, 'big.bin')).toBe(1)
  })

  it('abort trashes the session and makes complete fail with NoSuchUpload', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const uploadId = await createUpload('test-bucket', 'abort.bin')
    await uploadPart('test-bucket', 'abort.bin', uploadId, 1, 'x')
    const abort = await s3(ctx, 'DELETE', `/test-bucket/abort.bin?uploadId=${encodeURIComponent(uploadId)}`)
    expect(abort.status).toBe(204)
    const done = await s3(ctx, 'POST', `/test-bucket/abort.bin?uploadId=${encodeURIComponent(uploadId)}`, {
      body: completeBody([]),
    })
    expect(done.status).toBe(404)
    expect(await done.text()).toContain('NoSuchUpload')
  })

  it('complete with an un-uploaded part → InvalidPart', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const uploadId = await createUpload('test-bucket', 'invalid.bin')
    const etag1 = await uploadPart('test-bucket', 'invalid.bin', uploadId, 1, 'x')
    const done = await s3(ctx, 'POST', `/test-bucket/invalid.bin?uploadId=${encodeURIComponent(uploadId)}`, {
      body: completeBody([
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag1 },
      ]),
    })
    expect(done.status).toBe(400)
    expect(await done.text()).toContain('InvalidPart')
  })

  it('complete with a wrong ETag → InvalidPart', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const uploadId = await createUpload('test-bucket', 'etag.bin')
    await uploadPart('test-bucket', 'etag.bin', uploadId, 1, 'x')
    const done = await s3(ctx, 'POST', `/test-bucket/etag.bin?uploadId=${encodeURIComponent(uploadId)}`, {
      body: completeBody([{ partNumber: 1, etag: 'bogus' }]),
    })
    expect(done.status).toBe(400)
    expect(await done.text()).toContain('InvalidPart')
  })

  it('UploadPart to a missing session → NoSuchUpload', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const res = await s3(ctx, 'PUT', '/test-bucket/x.bin?partNumber=1&uploadId=does-not-exist', { body: 'x' })
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('NoSuchUpload')
  })

  it('re-uploading the same part number replaces the previous part (retries)', async () => {
    await s3(ctx, 'PUT', '/test-bucket', {})
    const uploadId = await createUpload('test-bucket', 'retry.bin')
    const etag1a = await uploadPart('test-bucket', 'retry.bin', uploadId, 1, 'AAAAA')
    const etag1b = await uploadPart('test-bucket', 'retry.bin', uploadId, 1, 'BBBBB')
    expect(etag1a).not.toBe(etag1b)
    await s3(ctx, 'POST', `/test-bucket/retry.bin?uploadId=${encodeURIComponent(uploadId)}`, {
      body: completeBody([{ partNumber: 1, etag: etag1b }]),
    })
    expect(await (await s3(ctx, 'GET', '/test-bucket/retry.bin')).text()).toBe('BBBBB')
  })
})
