import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifySignature } from '../server/s3/signature'
import { makeEnv } from './fakes'
import { makeAws } from './helpers'

describe('AWS SigV4 verification', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts valid header auth GET', async () => {
    const signed = await makeAws().sign('http://localhost/test-bucket/hello.txt', { method: 'GET' })
    signed.headers.set('host', 'localhost')
    expect(await verifySignature(makeEnv(), signed)).toEqual({ ok: true, region: 'us-east-1' })
  })

  it('accepts valid header auth PUT with body', async () => {
    const signed = await makeAws().sign('http://localhost/test-bucket/key', { method: 'PUT', body: 'hello world' })
    signed.headers.set('host', 'localhost')
    expect(await verifySignature(makeEnv(), signed)).toEqual({ ok: true, region: 'us-east-1' })
  })

  it('accepts requests with query strings', async () => {
    const signed = await makeAws().sign('http://localhost/test-bucket?list-type=2&delimiter=%2F&prefix=a%2Fb', { method: 'GET' })
    signed.headers.set('host', 'localhost')
    expect(await verifySignature(makeEnv(), signed)).toEqual({ ok: true, region: 'us-east-1' })
  })

  it('rejects wrong secret', async () => {
    const signed = await makeAws().sign('http://localhost/test-bucket/hello.txt', { method: 'GET' })
    signed.headers.set('host', 'localhost')
    const res = await verifySignature(makeEnv({ SECRET_KEY: 'wrong-secret' }), signed)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('SignatureDoesNotMatch')
  })

  it('rejects wrong access key', async () => {
    const signed = await makeAws().sign('http://localhost/test-bucket/hello.txt', { method: 'GET' })
    signed.headers.set('host', 'localhost')
    const res = await verifySignature(makeEnv({ ACCESS_KEY: 'wrong-access' }), signed)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('InvalidAccessKeyId')
  })

  it('rejects missing credentials', async () => {
    const res = await verifySignature(makeEnv(), new Request('http://localhost/test-bucket/hello.txt', { method: 'GET' }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('AccessDenied')
  })

  it('rejects stale x-amz-date (skew)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'))
    const signed = await makeAws().sign('http://localhost/test-bucket/hello.txt', { method: 'GET' })
    signed.headers.set('host', 'localhost')
    vi.setSystemTime(new Date('2024-01-01T00:20:00Z'))
    const res = await verifySignature(makeEnv(), signed)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('RequestTimeTooSkewed')
  })

  it('rejects tampered path', async () => {
    const signed = await makeAws().sign('http://localhost/test-bucket/hello.txt', { method: 'GET' })
    signed.headers.set('host', 'localhost')
    const tampered = new Request(signed.url.replace('hello.txt', 'other.txt'), { method: 'GET', headers: signed.headers })
    const res = await verifySignature(makeEnv(), tampered)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('SignatureDoesNotMatch')
  })

  it('accepts presigned GET', async () => {
    const signed = await makeAws().sign('http://localhost/test-bucket/hello.txt', { method: 'GET', aws: { signQuery: true } })
    signed.headers.set('host', 'localhost')
    expect(await verifySignature(makeEnv(), signed)).toEqual({ ok: true, region: 'us-east-1' })
  })

  it('accepts any signing region and reports it back', async () => {
    for (const region of ['ap-southeast-1', 'eu-west-3', 'us-gov-west-1', 'auto']) {
      const signed = await makeAws(region).sign('http://localhost/test-bucket/hello.txt', { method: 'GET' })
      signed.headers.set('host', 'localhost')
      expect(await verifySignature(makeEnv(), signed), region).toEqual({ ok: true, region })
    }
  })

  it('rejects expired presigned URL (aws4fetch default 86400s expiry)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'))
    const signed = await makeAws().sign('http://localhost/test-bucket/hello.txt', { method: 'GET', aws: { signQuery: true } })
    vi.setSystemTime(new Date('2024-01-02T02:00:00Z'))
    const res = await verifySignature(makeEnv(), signed)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('AccessDenied')
  })

  it('rejects presigned with tampered signature', async () => {
    const signed = await makeAws().sign('http://localhost/test-bucket/hello.txt', { method: 'GET', aws: { signQuery: true } })
    const url = new URL(signed.url)
    url.searchParams.set('X-Amz-Signature', '0'.repeat(64))
    const req = new Request(url.toString(), { method: 'GET' })
    const res = await verifySignature(makeEnv(), req)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('SignatureDoesNotMatch')
  })

  it('rejects STREAMING-AWS4 payloads with NotImplemented', async () => {
    const now = new Date()
    const amzDate =
      now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/g, '').replace(/Z$/, 'Z')
    const headers = new Headers({
      'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
      'x-amz-date': amzDate,
    })
    const req = new Request('http://localhost/test-bucket/hello.txt', { method: 'PUT', headers })
    const res = await verifySignature(makeEnv(), req)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('NotImplemented')
  })

  it('rejects presigned URL dated in the future', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'))
    const signed = await makeAws().sign('http://localhost/test-bucket/hello.txt', { method: 'GET', aws: { signQuery: true } })
    vi.setSystemTime(new Date('2023-12-31T23:00:00Z'))
    const res = await verifySignature(makeEnv(), signed)
    expect(res.ok).toBe(false)
  })
})
