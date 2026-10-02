import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listObjects } from '../server/s3/list'
import { getOrCreateFolder } from '../server/drive/folder'
import { FakeDrive, makeEnv, makeFetchStub, type FetchStub } from './fakes'

/**
 * A recursive listing costs one Drive call per folder, and Cloudflare Workers
 * cap subrequests per invocation (50 on the free plan). The walk must therefore
 * stop on its own budget and hand back a resumable continuation token rather
 * than letting the platform abort the whole request.
 */
describe('listObjects Drive-call budget', () => {
  let drive: FakeDrive
  let stub: FetchStub
  let restore: () => void

  beforeEach(() => {
    drive = new FakeDrive()
    stub = makeFetchStub(drive)
    restore = globalThis.fetch as unknown as () => void
    globalThis.fetch = stub as unknown as typeof fetch
  })
  afterEach(() => globalThis.fetch = restore as unknown as typeof fetch)

  async function seedTree(env: ReturnType<typeof makeEnv>, folders: number, filesPerFolder: number) {
    const bucketId = await getOrCreateFolder(env, 'test-bucket', null)
    for (let f = 0; f < folders; f++) {
      const dir = drive.addFile({
        name: `dir-${String(f).padStart(3, '0')}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [bucketId],
      })
      for (let i = 0; i < filesPerFolder; i++) {
        drive.addFile({
          name: `f${i}.bin`,
          mimeType: 'application/octet-stream',
          parents: [dir.id],
          content: new TextEncoder().encode('x'),
        })
      }
    }
    return bucketId
  }

  it('stops at the budget and resumes without dropping keys', async () => {
    const env = makeEnv()
    const bucketId = await seedTree(env, 6, 2)

    const collected: string[] = []
    let token: string | undefined
    let pages = 0
    let sawTruncated = false
    for (; pages < 40; pages++) {
      const res = await listObjects(env, bucketId, {
        bucket: 'test-bucket',
        prefix: '',
        delimiter: '',
        maxKeys: 1000,
        isV2: true,
        continuationToken: token,
        budget: 3,
      })
      collected.push(...res.contents.map((c) => c.key))
      if (res.isTruncated) sawTruncated = true
      token = res.nextContinuationToken
      if (!token) break
    }

    expect(sawTruncated).toBe(true)
    expect(pages).toBeGreaterThan(1)
    expect(collected.length).toBe(12)
    expect(new Set(collected).size).toBe(collected.length)
    const expected = Array.from({ length: 6 }, (_, f) =>
      Array.from({ length: 2 }, (_, i) => `dir-${String(f).padStart(3, '0')}/f${i}.bin`),
    ).flat()
    expect([...collected].sort()).toEqual([...expected].sort())
  })

  it('does not mark truncated when the whole tree fits the budget', async () => {
    const env = makeEnv()
    const bucketId = await seedTree(env, 2, 1)
    const res = await listObjects(env, bucketId, {
      bucket: 'test-bucket',
      prefix: '',
      delimiter: '',
      maxKeys: 1000,
      isV2: true,
      budget: 40,
    })
    expect(res.isTruncated).toBe(false)
    expect(res.nextContinuationToken).toBeUndefined()
    expect(res.contents.length).toBe(2)
  })

  it('keeps delimiter listings complete within the budget', async () => {
    const env = makeEnv()
    const bucketId = await seedTree(env, 6, 2)
    const res = await listObjects(env, bucketId, {
      bucket: 'test-bucket',
      prefix: '',
      delimiter: '/',
      maxKeys: 1000,
      isV2: true,
      budget: 40,
    })
    expect(res.isTruncated).toBe(false)
    expect(res.commonPrefixes.length).toBe(6)
  })
})
