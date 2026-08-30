import type { Env } from '../../env'
import { DriveError } from '../errors'
import { loadServiceAccounts, type ServiceAccount } from '../auth'

export interface Upstream {
  index: number
  sa: ServiceAccount
  writable: boolean
  creatable: boolean
}

export interface UnionConfig {
  mode: 'round-robin' | 'union'
  searchPolicy: string
  actionPolicy: string
  createPolicy: string
  cacheTime: number
  minFreeSpace: number
  maxUpstreams: number
}

export interface Union {
  cfg: UnionConfig
  upstreams: Upstream[]
}

const SEARCH_POLICIES = new Set(['ff', 'epff', 'epmfs', 'eplus', 'eprand', 'newest', 'epall'])
const ACTION_POLICIES = new Set(['epall', 'epff', 'epmfs', 'eplus', 'eprand'])
const CREATE_POLICIES = new Set(['epmfs', 'epall', 'eprand', 'ff', 'eplus', 'eplfs'])

const DEFAULTS = {
  mode: 'round-robin',
  searchPolicy: 'ff',
  actionPolicy: 'epall',
  createPolicy: 'epmfs',
  cacheTime: 120,
  minFreeSpace: 1073741824,
  maxUpstreams: 16,
}

export function unionConfig(env: Env): UnionConfig {
  const mode = (env.UNION_MODE ?? DEFAULTS.mode) === 'union' ? 'union' : 'round-robin'
  const searchPolicy = env.UNION_SEARCH_POLICY ?? DEFAULTS.searchPolicy
  const actionPolicy = env.UNION_ACTION_POLICY ?? DEFAULTS.actionPolicy
  const createPolicy = env.UNION_CREATE_POLICY ?? DEFAULTS.createPolicy
  const num = (v: string | undefined, d: number): number => {
    const n = parseInt(v ?? '', 10)
    return isNaN(n) || n <= 0 ? d : n
  }
  const cacheTime = num(env.UNION_CACHE_TIME, DEFAULTS.cacheTime)
  const minFreeSpace = num(env.UNION_MIN_FREE_SPACE, DEFAULTS.minFreeSpace)
  const maxUpstreams = Math.max(1, num(env.UNION_MAX_UPSTREAMS, DEFAULTS.maxUpstreams))
  if (!SEARCH_POLICIES.has(searchPolicy)) throw new DriveError(500, 'InternalError', `unknown UNION_SEARCH_POLICY: ${searchPolicy}`)
  if (!ACTION_POLICIES.has(actionPolicy)) throw new DriveError(500, 'InternalError', `unknown UNION_ACTION_POLICY: ${actionPolicy}`)
  if (!CREATE_POLICIES.has(createPolicy)) throw new DriveError(500, 'InternalError', `unknown UNION_CREATE_POLICY: ${createPolicy}`)
  return { mode, searchPolicy, actionPolicy, createPolicy, cacheTime, minFreeSpace, maxUpstreams }
}

/** True when the union feature is active (UNION_MODE=union + service accounts set). */
export function unionActive(env: Env): boolean {
  return env.UNION_MODE === 'union'
}

/** Validates the union configuration; throws on misconfig. */
export function validateUnion(env: Env, cfg: UnionConfig): void {
  if (cfg.mode === 'round-robin') return
  if (env.GOOGLE_REFRESH_TOKEN) {
    throw new DriveError(500, 'InternalError', 'UNION_MODE=union cannot be combined with GOOGLE_REFRESH_TOKEN (service accounts only)')
  }
  if (!(env.GOOGLE_SERVICE_ACCOUNTS?.trim() || '')) {
    throw new DriveError(500, 'InternalError', 'UNION_MODE=union requires GOOGLE_SERVICE_ACCOUNTS (or AUTH_KV "service_accounts")')
  }
}

/** Builds the ordered upstream list from the service-account payload. */
export async function buildUpstreams(env: Env, cfg: UnionConfig): Promise<Upstream[]> {
  const list = await loadServiceAccounts(env)
  const capped = list.slice(0, cfg.maxUpstreams)
  return capped.map((sa, i) => {
    const writable = sa.writable !== false
    const creatable = sa.creatable !== false && writable
    return { index: i, sa, writable, creatable }
  })
}

/**
 * Loads the union configuration + upstreams for a request. In union mode a
 * missing SA payload (or a mixed refresh-token config) is a startup error.
 */
export async function loadUnion(env: Env): Promise<Union> {
  const cfg = unionConfig(env)
  if (cfg.mode === 'round-robin') return { cfg, upstreams: [] }
  validateUnion(env, cfg)
  const upstreams = await buildUpstreams(env, cfg)
  if (upstreams.length === 0) {
    throw new DriveError(500, 'InternalError', 'UNION_MODE=union requires at least one service account')
  }
  return { cfg, upstreams }
}