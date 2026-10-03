import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { s3, setupTest, xmlTag, type TestSetup } from './helpers'

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/'

function rootOf(xml: string): string | null {
  const m = /<([A-Za-z][\w]*)\s+xmlns="[^"]*"/.exec(xml)
  return m ? m[1] : null
}

function orderOf(xml: string, tags: string[]): string[] {
  const found: { tag: string; at: number }[] = []
  for (const tag of tags) {
    const at = xml.indexOf(`<${tag}`)
    if (at !== -1) found.push({ tag, at })
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.tag)
}

describe('bucket sub-resources', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
    await s3(ctx, 'PUT', '/test-bucket')
  })
  afterEach(() => ctx.restore())

  it('does not answer an unknown sub-resource with a bucket listing', async () => {
    const res = await s3(ctx, 'GET', '/test-bucket?frobnicate')
    expect(res.status).toBe(501)
    const xml = await res.text()
    expect(xml).toContain('<Code>NotImplemented</Code>')
    expect(xml).not.toContain('ListBucketResult')
  })

  it('never leaks a listing for known-but-unsupported config sub-resources', async () => {
    const unsupported = ['tagging', 'policy', 'cors', 'lifecycle', 'encryption', 'website', 'replication', 'publicAccessBlock', 'ownershipControls', 'object-lock']
    for (const sub of unsupported) {
      const res = await s3(ctx, 'GET', `/test-bucket?${sub}`)
      const xml = await res.text()
      expect(xml, sub).not.toContain('ListBucketResult')
      expect(res.status, sub).toBeGreaterThanOrEqual(400)
    }
  })

  it('returns the right empty configuration roots', async () => {
    const cases: [string, number, string | null][] = [
      ['versioning', 200, 'VersioningConfiguration'],
      ['acl', 200, 'AccessControlPolicy'],
      ['logging', 200, 'BucketLoggingStatus'],
      ['accelerate', 200, 'AccelerateConfiguration'],
      ['requestPayment', 200, 'RequestPaymentConfiguration'],
      ['notification', 200, 'NotificationConfiguration'],
    ]
    for (const [sub, status, root] of cases) {
      const res = await s3(ctx, 'GET', `/test-bucket?${sub}`)
      const xml = await res.text()
      expect(res.status, sub).toBe(status)
      expect(rootOf(xml), sub).toBe(root)
    }
  })

  it('uses the AWS error codes for absent bucket configuration', async () => {
    const cases: [string, string][] = [
      ['tagging', 'NoSuchTagSet'],
      ['policy', 'NoSuchBucketPolicy'],
      ['cors', 'NoSuchCORSConfiguration'],
      ['lifecycle', 'NoSuchLifecycleConfiguration'],
      ['website', 'NoSuchWebsiteConfiguration'],
      ['replication', 'ReplicationConfigurationNotFoundError'],
      ['publicAccessBlock', 'NoSuchPublicAccessBlockConfiguration'],
      ['ownershipControls', 'OwnershipControlsNotFoundError'],
      ['object-lock', 'ObjectLockConfigurationNotFoundError'],
      ['encryption', 'ServerSideEncryptionConfigurationNotFoundError'],
    ]
    for (const [sub, code] of cases) {
      const res = await s3(ctx, 'GET', `/test-bucket?${sub}`)
      expect(res.status, sub).toBe(404)
      expect(await res.text(), sub).toContain(`<Code>${code}</Code>`)
    }
  })

  it('reports NoSuchBucket before any configuration for a missing bucket', async () => {
    for (const sub of ['versioning', 'acl', 'tagging', 'policy', 'cors', 'lifecycle', 'logging']) {
      const res = await s3(ctx, 'GET', `/missing-bucket?${sub}`)
      expect(res.status, sub).toBe(404)
      expect(await res.text(), sub).toContain('NoSuchBucket')
    }
  })

  it('lists multipart uploads as ListMultipartUploadsResult', async () => {
    const res = await s3(ctx, 'GET', '/test-bucket?uploads')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(rootOf(xml)).toBe('ListMultipartUploadsResult')
    expect(xml).toContain('<Bucket>test-bucket</Bucket>')
    expect(xml).toContain('<IsTruncated>false</IsTruncated>')
  })

  it('reports in-flight uploads in ListMultipartUploads', async () => {
    const init = await s3(ctx, 'POST', '/test-bucket/inflight.bin?uploads')
    const uploadId = xmlTag(await init.text(), 'UploadId')!
    expect(uploadId).toBeTruthy()

    const xml = await (await s3(ctx, 'GET', '/test-bucket?uploads')).text()
    expect(xml).toContain('<Key>inflight.bin</Key>')
    expect(xml).toContain(`<UploadId>${uploadId}</UploadId>`)
  })

  it('lists object versions as ListVersionsResult', async () => {
    await s3(ctx, 'PUT', '/test-bucket/v.txt', { body: 'x' })
    const res = await s3(ctx, 'GET', '/test-bucket?versions')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(rootOf(xml)).toBe('ListVersionsResult')
    expect(xml).toContain('<Key>v.txt</Key>')
    expect(xml).toContain('<VersionId>null</VersionId>')
    expect(xml).toContain('<IsLatest>true</IsLatest>')
  })

  it('rejects PUT on unsupported bucket configuration', async () => {
    for (const sub of ['tagging', 'cors', 'lifecycle', 'policy']) {
      const res = await s3(ctx, 'PUT', `/test-bucket?${sub}`, { body: '<x/>' })
      expect(res.status, sub).toBe(501)
    }
  })
})

describe('object sub-resources', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
    await s3(ctx, 'PUT', '/test-bucket')
    await s3(ctx, 'PUT', '/test-bucket/obj.txt', { body: 'x' })
  })
  afterEach(() => ctx.restore())

  it('returns the object ACL', async () => {
    const res = await s3(ctx, 'GET', '/test-bucket/obj.txt?acl')
    expect(res.status).toBe(200)
    expect(rootOf(await res.text())).toBe('AccessControlPolicy')
  })

  it('returns an empty tag set for an untagged object', async () => {
    const res = await s3(ctx, 'GET', '/test-bucket/obj.txt?tagging')
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(rootOf(xml)).toBe('Tagging')
    expect(xml).toContain('<TagSet></TagSet>')
  })

  it('returns NoSuchKey for sub-resources on a missing object', async () => {
    for (const sub of ['acl', 'tagging']) {
      const res = await s3(ctx, 'GET', `/test-bucket/missing.txt?${sub}`)
      expect(res.status, sub).toBe(404)
      expect(await res.text(), sub).toContain('NoSuchKey')
    }
  })

  it('returns NotImplemented for unsupported object sub-resources', async () => {
    for (const sub of ['attributes', 'torrent', 'legal-hold', 'retention']) {
      const res = await s3(ctx, 'GET', `/test-bucket/obj.txt?${sub}`)
      expect(res.status, sub).toBe(501)
      expect(await res.text(), sub).toContain('NotImplemented')
    }
  })

  it('lists uploaded parts as ListPartsResult', async () => {
    const init = await s3(ctx, 'POST', '/test-bucket/multi.bin?uploads')
    const uploadId = xmlTag(await init.text(), 'UploadId')!
    const part = await s3(ctx, 'PUT', `/test-bucket/multi.bin?uploadId=${uploadId}&partNumber=1`, { body: 'AAAA' })
    expect(part.status).toBe(200)

    const res = await s3(ctx, 'GET', `/test-bucket/multi.bin?uploadId=${uploadId}`)
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(rootOf(xml)).toBe('ListPartsResult')
    expect(xml).toContain('<PartNumber>1</PartNumber>')
    expect(xml).toContain('<Size>4</Size>')
  })

  it('reports NoSuchUpload for ListParts on an unknown upload', async () => {
    const res = await s3(ctx, 'GET', '/test-bucket/multi.bin?uploadId=does-not-exist')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('NoSuchUpload')
  })
})

describe('ListObjectsV2 element order matches the S3 model', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
    await s3(ctx, 'PUT', '/test-bucket')
    await s3(ctx, 'PUT', '/test-bucket/a.txt', { body: '1' })
    await s3(ctx, 'PUT', '/test-bucket/dir/b.txt', { body: '2' })
  })
  afterEach(() => ctx.restore())

  it('emits Name, Prefix, Delimiter, MaxKeys, EncodingType, IsTruncated, KeyCount before contents', async () => {
    const xml = await (await s3(ctx, 'GET', '/test-bucket?list-type=2&delimiter=%2F')).text()
    const order = orderOf(xml, ['Name', 'Prefix', 'Delimiter', 'MaxKeys', 'EncodingType', 'IsTruncated', 'KeyCount', 'Contents', 'CommonPrefixes'])
    expect(order).toEqual(['Name', 'Prefix', 'Delimiter', 'MaxKeys', 'IsTruncated', 'KeyCount', 'Contents', 'CommonPrefixes'])
  })

  it('places ContinuationToken and NextContinuationToken after KeyCount', async () => {
    await s3(ctx, 'PUT', '/test-bucket/c.txt', { body: '3' })
    const xml = await (await s3(ctx, 'GET', '/test-bucket?list-type=2&max-keys=1')).text()
    const order = orderOf(xml, ['KeyCount', 'ContinuationToken', 'NextContinuationToken'])
    expect(order.indexOf('NextContinuationToken')).toBeGreaterThan(order.indexOf('KeyCount'))
  })

  it('keeps the V1 shape with Marker and NextMarker', async () => {
    const xml = await (await s3(ctx, 'GET', '/test-bucket?max-keys=1')).text()
    expect(rootOf(xml)).toBe('ListBucketResult')
    expect(xml).toContain('<Marker>')
    const order = orderOf(xml, ['MaxKeys', 'IsTruncated', 'Marker', 'NextMarker', 'Contents'])
    expect(order.indexOf('Marker')).toBeLessThan(order.indexOf('Contents'))
  })
})

describe('error codes and statuses match the S3 model', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
  })
  afterEach(() => ctx.restore())

  it('CreateBucket returns BucketAlreadyOwnedByYou 409 for an owned bucket', async () => {
    expect((await s3(ctx, 'PUT', '/test-bucket')).status).toBe(200)
    const res = await s3(ctx, 'PUT', '/test-bucket')
    expect(res.status).toBe(409)
    const xml = await res.text()
    expect(xml).toContain('<Code>BucketAlreadyOwnedByYou</Code>')
  })

  it('DeleteBucket and DeleteObject return 204', async () => {
    await s3(ctx, 'PUT', '/test-bucket')
    await s3(ctx, 'PUT', '/test-bucket/o.txt', { body: 'x' })
    expect((await s3(ctx, 'DELETE', '/test-bucket/o.txt')).status).toBe(204)
    expect((await s3(ctx, 'DELETE', '/test-bucket')).status).toBe(204)
  })

  it('AbortMultipartUpload returns NoSuchUpload 404 for an unknown id', async () => {
    await s3(ctx, 'PUT', '/test-bucket')
    const res = await s3(ctx, 'DELETE', '/test-bucket/o.txt?uploadId=nope')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('NoSuchUpload')
  })

  it('ListObjects on a missing bucket returns NoSuchBucket', async () => {
    for (const q of ['', '?list-type=2', '?versions']) {
      const res = await s3(ctx, 'GET', `/missing-bucket${q}`)
      expect(res.status, q).toBe(404)
      expect(await res.text(), q).toContain('NoSuchBucket')
    }
  })
})

describe('XML namespace coverage', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
    await s3(ctx, 'PUT', '/test-bucket')
    await s3(ctx, 'PUT', '/test-bucket/a.txt', { body: '1' })
  })
  afterEach(() => ctx.restore())

  it('namespaces every success root except Error', async () => {
    const responses = [
      await s3(ctx, 'GET', '/'),
      await s3(ctx, 'GET', '/test-bucket?list-type=2'),
      await s3(ctx, 'GET', '/test-bucket?location'),
      await s3(ctx, 'GET', '/test-bucket?versioning'),
      await s3(ctx, 'GET', '/test-bucket?acl'),
      await s3(ctx, 'GET', '/test-bucket?uploads'),
      await s3(ctx, 'GET', '/test-bucket?versions'),
      await s3(ctx, 'POST', '/test-bucket/m.bin?uploads'),
      await s3(ctx, 'POST', '/test-bucket?delete', { body: '<Delete><Object><Key>a.txt</Key></Object></Delete>' }),
    ]
    for (const res of responses) {
      const xml = await res.text()
      expect(xml, xml.slice(0, 80)).toContain(`xmlns="${XMLNS}"`)
    }
  })

  it('omits the namespace on Error, like AWS', async () => {
    const xml = await (await s3(ctx, 'GET', '/test-bucket/missing.txt')).text()
    expect(xml).toContain('<Error>')
    expect(xml).not.toContain(`<Error xmlns=`)
  })
})

describe('sub-resource routing never falls through to a listing', () => {
  let ctx: TestSetup

  beforeEach(async () => {
    ctx = await setupTest()
    await s3(ctx, 'PUT', '/test-bucket')
    await s3(ctx, 'PUT', '/test-bucket/a.txt', { body: '1' })
    await s3(ctx, 'PUT', '/test-bucket/b.txt', { body: '2' })
  })
  afterEach(() => ctx.restore())

  it('every known sub-resource returns a non-listing root', async () => {
    const subs = [
      'versioning', 'acl', 'logging', 'accelerate', 'requestPayment', 'notification',
      'tagging', 'policy', 'cors', 'lifecycle', 'encryption', 'website', 'replication',
      'publicAccessBlock', 'ownershipControls', 'object-lock', 'uploads', 'versions',
    ]
    for (const sub of subs) {
      const xml = await (await s3(ctx, 'GET', `/test-bucket?${sub}`)).text()
      expect(xml, sub).not.toContain('<ListBucketResult')
      if (sub !== 'versions') expect(xml, sub).not.toContain('<Key>a.txt</Key>')
    }
  })

  it('still lists objects when only listing parameters are present', async () => {
    for (const q of ['', '?list-type=2', '?list-type=2&delimiter=%2F', '?prefix=a', '?max-keys=1']) {
      const xml = await (await s3(ctx, 'GET', `/test-bucket${q}`)).text()
      expect(rootOf(xml), q).toBe('ListBucketResult')
    }
  })

  it('keeps query parameters that AWS also uses for listing from being treated as sub-resources', async () => {
    const xml = await (await s3(ctx, 'GET', '/test-bucket?list-type=2&encoding-type=url&fetch-owner=true&max-keys=10')).text()
    expect(rootOf(xml)).toBe('ListBucketResult')
    expect(xml).not.toContain('NotImplemented')
  })

  it('DELETE on an unknown sub-resource does not delete the bucket', async () => {
    const res = await s3(ctx, 'DELETE', '/test-bucket?frobnicate')
    expect(res.status).toBe(501)
    expect((await s3(ctx, 'HEAD', '/test-bucket')).status).toBe(200)
  })
})
