import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseServiceAccounts } from '../src/drive/auth'
import { unionConfig, unionActive, loadUnion } from '../src/drive/union/config'
import { actionSelect, createSelect, searchPick, type PolicySource } from '../src/drive/union/policy'
import type { Quota } from '../src/drive/union/quota'
import { unionActionHits, unionCreateTargets, unionFind } from '../src/drive/union/resolve'
import { FOLDER_MIME } from '../src/drive/folder'
import { invalidateTokenCache } from '../src/drive/auth'
import { setupUnionTest, type UnionTestSetup, type UnionSaSpec } from './helpers'

const SA_A = 'sa-a@proj.iam.gserviceaccount.com'
const SA_B = 'sa-b@proj.iam.gserviceaccount.com'

function source(quotas: Record<number, { limit?: string; usage?: string }>, mods: Record<number, string | null> = {}): PolicySource {
  return {
    quota: async (i): Promise<Quota> => {
      const q = quotas[i] ?? { usage: '0' }
      const limit = Number(q.limit ?? 0)
      const usage = Number(q.usage ?? 0)
      return { limit, usage, free: limit > 0 && limit >= usage ? limit - usage : Number.MAX_SAFE_INTEGER - 1 }
    },
    modifiedTime: async (i) => mods[i] ?? null,
  }
}

describe('union config', () => {
  it('applies defaults for round-robin mode and validates policy names', () => {
    const cfg = unionConfig({} as never)
    expect(cfg.mode).toBe('round-robin')
    expect(cfg.searchPolicy).toBe('ff')
    expect(cfg.actionPolicy).toBe('epall')
    expect(cfg.createPolicy).toBe('epmfs')
    expect(unionActive({} as never)).toBe(false)
    expect(unionActive({ UNION_MODE: 'union' } as never)).toBe(true)
  })

  it('parses overrides from env', () => {
    const cfg = unionConfig({
      UNION_MODE: 'union',
      UNION_SEARCH_POLICY: 'newest',
      UNION_ACTION_POLICY: 'epff',
      UNION_CREATE_POLICY: 'epall',
      UNION_CACHE_TIME: '30',
      UNION_MIN_FREE_SPACE: '5',
      UNION_MAX_UPSTREAMS: '8',
    } as never)
    expect(cfg.searchPolicy).toBe('newest')
    expect(cfg.actionPolicy).toBe('epff')
    expect(cfg.createPolicy).toBe('epall')
    expect(cfg.cacheTime).toBe(30)
    expect(cfg.minFreeSpace).toBe(5)
    expect(cfg.maxUpstreams).toBe(8)
  })

  it('rejects unknown policy names', () => {
    expect(() => unionConfig({ UNION_MODE: 'union', UNION_SEARCH_POLICY: 'bogus' } as never)).toThrow(/UNION_SEARCH_POLICY/)
    expect(() => unionConfig({ UNION_MODE: 'union', UNION_ACTION_POLICY: 'bogus' } as never)).toThrow(/UNION_ACTION_POLICY/)
    expect(() => unionConfig({ UNION_MODE: 'union', UNION_CREATE_POLICY: 'bogus' } as never)).toThrow(/UNION_CREATE_POLICY/)
  })

  it('fails startup when union mode mixes with a refresh token or has no SAs', async () => {
    await expect(
      loadUnion({ UNION_MODE: 'union', GOOGLE_REFRESH_TOKEN: 'x', GOOGLE_SERVICE_ACCOUNTS: '[{}]' } as never),
    ).rejects.toThrow(/GOOGLE_REFRESH_TOKEN/)
    await expect(loadUnion({ UNION_MODE: 'union', GOOGLE_REFRESH_TOKEN: '', GOOGLE_SERVICE_ACCOUNTS: '' } as never)).rejects.toThrow(
      /requires GOOGLE_SERVICE_ACCOUNTS|at least one service account/,
    )
  })
})

describe('parseServiceAccounts union flags', () => {
  it('derives readonly (:ro) and no-create (:nc) upstreams from the payload', async () => {
    const payload = await (async () => {
      const { saPayload } = await import('./helpers')
      return saPayload([
        { email: SA_A },
        { email: SA_B, writable: false },
        { email: 'sa-c@proj.iam.gserviceaccount.com', creatable: false },
      ])
    })()
    const parsed = parseServiceAccounts(payload)
    expect(parsed[0].writable).toBe(true)
    expect(parsed[0].creatable).toBe(true)
    const union = await loadUnion({
      UNION_MODE: 'union',
      GOOGLE_REFRESH_TOKEN: '',
      GOOGLE_SERVICE_ACCOUNTS: payload,
    } as never)
    expect(union.upstreams[0].writable).toBe(true)
    expect(union.upstreams[0].creatable).toBe(true)
    expect(union.upstreams[1].writable).toBe(false)
    expect(union.upstreams[1].creatable).toBe(false)
    expect(union.upstreams[2].writable).toBe(true)
    expect(union.upstreams[2].creatable).toBe(false)
  })

  it('caps upstream fan-out with UNION_MAX_UPSTREAMS', async () => {
    const payload = await (async () => {
      const { saPayload } = await import('./helpers')
      return saPayload([{ email: SA_A }, { email: SA_B }])
    })()
    const env = {
      UNION_MODE: 'union',
      GOOGLE_REFRESH_TOKEN: '',
      GOOGLE_SERVICE_ACCOUNTS: payload,
      UNION_MAX_UPSTREAMS: '1',
    } as never
    const union = await loadUnion(env)
    expect(union.upstreams.length).toBe(1)
  })
})

describe('union policy engines', () => {
  it('search ff picks the lowest index; epmfs picks the most free; newest picks latest', async () => {
    const src = source(
      { 0: { limit: '1000', usage: '900' }, 1: { limit: '1000', usage: '100' }, 3: { limit: '1000', usage: '0' } },
      { 1: '2024-01-01T00:00:00Z', 3: '2024-06-01T00:00:00Z' },
    )
    expect(await searchPick('ff', [2, 0, 3], src)).toBe(0)
    expect(await searchPick('epff', [2, 1], src)).toBe(1)
    expect(await searchPick('epmfs', [0, 1, 3], src)).toBe(3)
    expect(await searchPick('eplus', [0, 1, 3], src)).toBe(3)
    expect(await searchPick('newest', [1, 3], src)).toBe(3)
    expect(await searchPick('epmfs', [0, 1], source({ 0: {}, 1: {} }))).toBe(0)
    expect(await searchPick('ff', [], src)).toBeNull()
  })

  it('action epall returns all; epff returns the first', async () => {
    const src = source({})
    expect(await actionSelect('epall', [1, 0, 2], src)).toEqual([1, 0, 2])
    expect(await actionSelect('epff', [2, 0], src)).toEqual([0])
    expect(await actionSelect('epall', [], src)).toEqual([])
  })

  it('create epmfs picks most free among candidates; epall returns all; eplfs picks least free; ff picks min', async () => {
    const src = source({ 0: { limit: '1000', usage: '900' }, 1: { limit: '1000', usage: '100' } })
    expect(await createSelect('epmfs', [0, 1], src)).toEqual([1])
    expect(await createSelect('epall', [0, 1], src)).toEqual([0, 1])
    expect(await createSelect('eplfs', [0, 1], src)).toEqual([0])
    expect(await createSelect('ff', [1, 2, 3], src)).toEqual([1])
    expect(await createSelect('eprand', [0], src)).toEqual([0])
  })

  it('create epmfs falls back to the lowest candidate when quota info ties', async () => {
    const src = source({})
    expect(await createSelect('epmfs', [1, 3], src)).toEqual([1])
  })

  it('create eplfs applies the min-free-space filter then picks least free', async () => {
    const src = source(
      { 0: { limit: '1000', usage: '100' }, 1: { limit: '1000', usage: '950' } },
    )
    // free: 0 → 900, 1 → 50. min-free 100 → only upstream 0 eligible.
    expect(await createSelect('eplfs', [0, 1], src, 100)).toEqual([0])
    // min-free 1000 → nobody eligible → fall back to all, least free wins (1).
    expect(await createSelect('eplfs', [0, 1], src, 1000)).toEqual([1])
  })
})

describe('union resolve (2-SA harness)', () => {
  let t: UnionTestSetup
  let restore: () => void

  beforeEach(async () => {
    restore = invalidateTokenCache as unknown as () => void
    invalidateTokenCache()
    t = await setupUnionTest([{ email: SA_A }, { email: SA_B }])
  })
  afterEach(() => {
    t.restore()
  })

  function driveOf(sa: string) {
    return t.drives.get(`sa-token-${sa.split('@')[0]}`)!
  }

  function seedBucket(sa: string, bucket: string): string {
    const d = driveOf(sa)
    const f = d.addFile({ name: bucket, mimeType: FOLDER_MIME, parents: ['root'] })
    return f.id
  }

  function seedFile(sa: string, bucketId: string, key: string, content: string): void {
    const d = driveOf(sa)
    const segs = key.split('/').filter(Boolean)
    let parent = bucketId
    for (let i = 0; i < segs.length - 1; i++) {
      const dir = d.addFile({ name: segs[i], mimeType: FOLDER_MIME, parents: [parent] })
      parent = dir.id
    }
    d.addFile({ name: segs[segs.length - 1], mimeType: 'text/plain', parents: [parent], content: new TextEncoder().encode(content) })
  }

  it('SEARCH resolves the winner deterministically (ff = lowest index)', async () => {
    const bucket = 'bkt'
    const idA = seedBucket(SA_A, bucket)
    const idB = seedBucket(SA_B, bucket)
    seedFile(SA_A, idA, 'both.txt', 'a')
    seedFile(SA_B, idB, 'both.txt', 'b')
    seedFile(SA_B, idB, 'only-b.txt', 'b')

    const union = await loadUnion(t.env)
    const onlyA = await unionFind(t.env, union, bucket, 'only-a.txt')
    expect(onlyA).toBeNull()
    const onlyB = await unionFind(t.env, union, bucket, 'only-b.txt')
    expect(onlyB?.saIndex).toBe(1)
    expect(onlyB?.file.name).toBe('only-b.txt')
    const both = await unionFind(t.env, union, bucket, 'both.txt')
    expect(both?.saIndex).toBe(0)
    expect(await unionFind(t.env, union, bucket, 'both.txt')).toEqual(both) // memo hit
  })

  it('CREATE epmfs picks the upstream with the most free space (per-SA quota)', async () => {
    const tq = await setupUnionTest([
      { email: SA_A, quota: { limit: '1000', usage: '900' } },
      { email: SA_B, quota: { limit: '1000', usage: '100' } },
    ], { UNION_CREATE_POLICY: 'epmfs' })
    try {
      const idA = tq.drives.get('sa-token-sa-a')!
      const idB = tq.drives.get('sa-token-sa-b')!
      idA.addFile({ name: 'bkt', mimeType: FOLDER_MIME, parents: ['root'] })
      idB.addFile({ name: 'bkt', mimeType: FOLDER_MIME, parents: ['root'] })
      const union = await loadUnion(tq.env)
      const targets = await unionCreateTargets(tq.env, union, 'bkt', 'new.txt')
      expect(targets).toEqual([1])
    } finally {
      tq.restore()
    }
  })

  it('CREATE epall selects every creatable upstream', async () => {
    const t2 = await setupUnionTest([{ email: SA_A }, { email: SA_B }], { UNION_CREATE_POLICY: 'epall' })
    try {
      const dA = t2.drives.get('sa-token-sa-a')!
      const dB = t2.drives.get('sa-token-sa-b')!
      dA.addFile({ name: 'bkt', mimeType: FOLDER_MIME, parents: ['root'] })
      dB.addFile({ name: 'bkt', mimeType: FOLDER_MIME, parents: ['root'] })
      const union = await loadUnion(t2.env)
      expect(await unionCreateTargets(t2.env, union, 'bkt', 'x.txt')).toEqual([0, 1])
    } finally {
      t2.restore()
    }
  })

  it('CREATE with a non-creatable upstream excludes it; empty creatable → AccessDenied', async () => {
    const t2 = await setupUnionTest([
      { email: SA_A },
      { email: SA_B, creatable: false },
    ], { UNION_CREATE_POLICY: 'epall' })
    try {
      const dA = t2.drives.get('sa-token-sa-a')!
      const dB = t2.drives.get('sa-token-sa-b')!
      dA.addFile({ name: 'bkt', mimeType: FOLDER_MIME, parents: ['root'] })
      dB.addFile({ name: 'bkt', mimeType: FOLDER_MIME, parents: ['root'] })
      const union = await loadUnion(t2.env)
      expect(await unionCreateTargets(t2.env, union, 'bkt', 'x.txt')).toEqual([0])
      const t3 = await setupUnionTest([{ email: SA_A, creatable: false }])
      try {
        const union3 = await loadUnion(t3.env)
        await expect(unionCreateTargets(t3.env, union3, 'bkt', 'x.txt')).rejects.toThrow(/no creatable upstream/)
      } finally {
        t3.restore()
      }
    } finally {
      t2.restore()
    }
  })

  it('ACTION epall returns every writable upstream that has the key', async () => {
    const bucket = 'bkt'
    const idA = seedBucket(SA_A, bucket)
    const idB = seedBucket(SA_B, bucket)
    seedFile(SA_A, idA, 'k.txt', 'a')
    seedFile(SA_B, idB, 'k.txt', 'b')
    const union = await loadUnion(t.env)
    const hits = await unionActionHits(t.env, union, bucket, 'k.txt')
    expect(hits.map((h) => h.saIndex)).toEqual([0, 1])
  })
})