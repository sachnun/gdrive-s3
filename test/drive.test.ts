import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVE_API, driveFetch, getAccessToken } from '../src/drive/auth'
import { FOLDER_MIME, findFolder, getOrCreateFolder, resolveExistingPath, resolvePathCreate } from '../src/drive/folder'
import { downloadFile, findFilesInFolder, trashFile, uploadFile } from '../src/drive/files'
import { FakeDrive, makeEnv, makeFetchStub } from './harness'

describe('drive auth (KV-backed token)', () => {
  let drive: FakeDrive
  let stub: ReturnType<typeof makeFetchStub>
  let restore: () => void

  beforeEach(() => {
    drive = new FakeDrive()
    stub = makeFetchStub(drive)
    restore = globalThis.fetch as unknown as () => void
    globalThis.fetch = stub as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = restore as unknown as typeof fetch
  })

  it('refreshes once and caches the token in KV', async () => {
    const env = makeEnv()
    let refreshes = 0
    const orig = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'oauth2.googleapis.com') refreshes++
      return stub(input as RequestInfo | URL, init)
    }) as typeof fetch
    try {
      await getAccessToken(env)
      await getAccessToken(env)
      await getAccessToken(env)
      expect(refreshes).toBe(1)
      expect(await env.AUTH_KV.get('access_token')).toBe('fake-token')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('retries once on 401 after invalidating a stale cached token', async () => {
    const env = makeEnv()
    await env.AUTH_KV.put('access_token', 'stale')
    stub.setValidTokens(['fake-token'])
    const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files?q=trashed=false&fields=files(id)`)
    expect(res.status).toBe(200)
    expect(await env.AUTH_KV.get('access_token')).toBe('fake-token')
  })
})

describe('drive folders (KV cache + lock)', () => {
  let drive: FakeDrive
  let stub: ReturnType<typeof makeFetchStub>
  let restore: () => void

  beforeEach(() => {
    drive = new FakeDrive()
    stub = makeFetchStub(drive)
    restore = globalThis.fetch as unknown as () => void
    globalThis.fetch = stub as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = restore as unknown as typeof fetch
  })

  it('creates and caches a folder (no duplicate on second call)', async () => {
    const env = makeEnv()
    const id = await getOrCreateFolder(env, 'bucket-a', null)
    expect(id).toBeTruthy()
    expect(await env.FOLDER_CACHE.get('folder::bucket-a')).toBe(id)
    const id2 = await getOrCreateFolder(env, 'bucket-a', null)
    expect(id2).toBe(id)
    const matches = drive.allFiles().filter((f) => f.mimeType === FOLDER_MIME && f.name === 'bucket-a' && !f.trashed)
    expect(matches.length).toBe(1)
  })

  it('finds existing folders without creating; returns null for missing', async () => {
    const env = makeEnv()
    drive.addFile({ name: 'existing', mimeType: FOLDER_MIME, parents: ['root'] })
    expect(await findFolder(env, 'existing', null)).toBeTruthy()
    expect(await findFolder(env, 'missing', null)).toBeNull()
  })

  it('resolves keys to parent folder + name, creating folders when asked', async () => {
    const env = makeEnv()
    const root = await getOrCreateFolder(env, 'bucket', null)
    const r = await resolvePathCreate(env, root, 'a/b/c.txt')
    expect(r.name).toBe('c.txt')
    expect(r.parentId).toBeTruthy()
    const existing = await resolveExistingPath(env, root, 'a/b/c.txt')
    expect(existing).toEqual(r)
    expect(await resolveExistingPath(env, root, 'a/nope/c.txt')).toBeNull()
    // create mode created the folder chain in Drive
    const folders = drive.allFiles().filter((f) => f.mimeType === FOLDER_MIME && !f.trashed)
    expect(folders.some((f) => f.name === 'a')).toBe(true)
    expect(folders.some((f) => f.name === 'b')).toBe(true)
  })
})

describe('drive files (resumable upload / download / trash)', () => {
  let drive: FakeDrive
  let stub: ReturnType<typeof makeFetchStub>
  let restore: () => void

  beforeEach(() => {
    drive = new FakeDrive()
    stub = makeFetchStub(drive)
    restore = globalThis.fetch as unknown as () => void
    globalThis.fetch = stub as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = restore as unknown as typeof fetch
  })

  it('uploads, downloads, ranges, finds and trashes', async () => {
    const env = makeEnv()
    const root = await getOrCreateFolder(env, 'bucket', null)
    const content = new TextEncoder().encode('hello drive world')
    const meta = await uploadFile(env, {
      parentId: root,
      name: 'f.txt',
      body: content,
      contentType: 'text/plain',
    })
    expect(meta.size).toBe(String(content.length))

    const res = await downloadFile(env, meta.id)
    expect(await res.text()).toBe('hello drive world')

    const ranged = await downloadFile(env, meta.id, 'bytes=0-4')
    expect(ranged.status).toBe(206)
    expect(await ranged.text()).toBe('hello')

    const found = await findFilesInFolder(env, 'f.txt', root)
    expect(found.length).toBe(1)
    expect(found[0].id).toBe(meta.id)

    await trashFile(env, meta.id)
    expect((await downloadFile(env, meta.id)).status).toBe(404)
  })

  it('uploads with appProperties preserved', async () => {
    const env = makeEnv()
    const root = await getOrCreateFolder(env, 'bucket', null)
    await uploadFile(env, {
      parentId: root,
      name: 'meta.txt',
      body: 'x',
      appProperties: { 'x-amz-meta-foo': 'bar' },
    })
    const found = await findFilesInFolder(env, 'meta.txt', root)
    expect(found[0].appProperties?.['x-amz-meta-foo']).toBe('bar')
  })
})
