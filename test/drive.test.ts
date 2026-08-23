import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DRIVE_API, driveFetch, getAccessToken, invalidateTokenCache, parseServiceAccounts } from '../src/drive/auth'
import { FOLDER_MIME, findFolder, getOrCreateFolder, resolveExistingPath, resolvePathCreate } from '../src/drive/folder'
import { downloadFile, findFilesInFolder, trashFile, uploadFile } from '../src/drive/files'
import { FakeDrive, makeEnv, makeFetchStub } from './harness'

describe('drive auth (KV-backed token)', () => {
  let drive: FakeDrive
  let stub: ReturnType<typeof makeFetchStub>
  let restore: () => void

  beforeEach(() => {
    invalidateTokenCache() // memo is module-level; reset so each test starts cold
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

describe('drive auth with service accounts (JWT bearer)', () => {
  let drive: FakeDrive
  let stub: ReturnType<typeof makeFetchStub>
  let restore: () => void

  beforeEach(() => {
    invalidateTokenCache() // memo is module-level; reset so each test starts cold
    drive = new FakeDrive()
    stub = makeFetchStub(drive)
    restore = globalThis.fetch as unknown as () => void
    globalThis.fetch = stub as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = restore as unknown as typeof fetch
  })

  async function makeSaPem(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
    const b64 = btoa(String.fromCharCode(...der))
    return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
  }

  function saBlob(email: string, pem: string): string {
    return JSON.stringify(
      {
        type: 'service_account',
        project_id: 'p',
        private_key_id: 'k',
        private_key: pem,
        client_email: email,
        client_id: '1',
        token_uri: 'https://oauth2.googleapis.com/token',
        universe_domain: 'googleapis.com',
      },
      null,
      2,
    )
  }

  it('parses concatenated service-account JSON blobs and JSON arrays', async () => {
    const pem = await makeSaPem()
    const a = saBlob('sa-001@proj.iam.gserviceaccount.com', pem)
    const b = saBlob('sa-002@proj.iam.gserviceaccount.com', pem)
    expect(parseServiceAccounts(`${a}\n${b}`).map((s) => s.clientEmail)).toEqual([
      'sa-001@proj.iam.gserviceaccount.com',
      'sa-002@proj.iam.gserviceaccount.com',
    ])
    expect(parseServiceAccounts(`[${a},${b}]`).length).toBe(2)
    expect(parseServiceAccounts('').length).toBe(0)
    expect(parseServiceAccounts('garbage').length).toBe(0)
  })

  it('round-robins service accounts and caches per-SA tokens', async () => {
    const pem = await makeSaPem()
    const raw =
      saBlob('sa-001@proj.iam.gserviceaccount.com', pem) +
      '\n' +
      saBlob('sa-002@proj.iam.gserviceaccount.com', pem)
    const env = makeEnv({ GOOGLE_REFRESH_TOKEN: '', GOOGLE_SERVICE_ACCOUNTS: raw })

    const tokens: string[] = []
    for (let i = 0; i < 4; i++) tokens.push(await getAccessToken(env))

    // alternates between the two SAs; calls 3-4 are cache hits
    expect(tokens[0]).not.toBe(tokens[1])
    expect(tokens[2]).toBe(tokens[0])
    expect(tokens[3]).toBe(tokens[1])
    expect(new Set(tokens).size).toBe(2)
    // only two oauth exchanges total (one per SA), the rest served from KV
    expect(stub.oauthLog.length).toBe(2)
    expect(decodeURIComponent(stub.oauthLog[0])).toContain('grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer')
  })

  it('loads service accounts from AUTH_KV when the env var is absent', async () => {
    const pem = await makeSaPem()
    const env = makeEnv({ GOOGLE_REFRESH_TOKEN: '', GOOGLE_SERVICE_ACCOUNTS: '' })
    await env.AUTH_KV.put('service_accounts', saBlob('sa-kv@proj.iam.gserviceaccount.com', pem))
    expect(await getAccessToken(env)).toBe('sa-token-sa-kv')
  })

  it('invalidates cached SA tokens and retries once on 401', async () => {
    const pem = await makeSaPem()
    const email = 'sa-001@proj.iam.gserviceaccount.com'
    const env = makeEnv({ GOOGLE_REFRESH_TOKEN: '', GOOGLE_SERVICE_ACCOUNTS: saBlob(email, pem) })
    await env.AUTH_KV.put(`sa_token:${email}`, 'stale')
    stub.setValidTokens(['sa-token-sa-001'])

    const res = await driveFetch(env, `${DRIVE_API}/drive/v3/files?q=trashed=false&fields=files(id)`)
    expect(res.status).toBe(200)
    expect(await env.AUTH_KV.get(`sa_token:${email}`)).toBe('sa-token-sa-001')
  })

  it('errors clearly when no credentials are configured', async () => {
    const env = makeEnv({ GOOGLE_REFRESH_TOKEN: '', GOOGLE_SERVICE_ACCOUNTS: '' })
    await expect(getAccessToken(env)).rejects.toThrow(/No Google credentials configured/)
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
