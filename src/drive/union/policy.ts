import type { Quota } from './quota'

export interface PolicySource {
  /** Per-upstream quota (memoized by the caller). */
  quota(i: number): Promise<Quota>
  /** Per-upstream candidate file modified time (for `newest`). */
  modifiedTime(i: number): Promise<string | null>
}

export const SEARCH_POLICY_DEFAULT = 'ff'
export const ACTION_POLICY_DEFAULT = 'epall'
export const CREATE_POLICY_DEFAULT = 'epmfs'

async function withMinFree(cands: number[], src: PolicySource, minFree: number): Promise<number[]> {
  if (minFree <= 0) return cands
  const keep: number[] = []
  for (const i of cands) {
    const q = await src.quota(i)
    if (q.free >= minFree) keep.push(i)
  }
  return keep
}

async function rankedBy<T>(
  cands: number[],
  src: PolicySource,
  rank: (i: number) => Promise<[number, T]>,
  best: (a: T, b: T) => boolean,
): Promise<number | null> {
  let winner: number | null = null
  let winnerRank: T | null = null
  for (const i of cands) {
    const [, r] = await rank(i)
    if (winner === null) {
      winner = i
      winnerRank = r
    } else if (winnerRank !== null && best(r, winnerRank)) {
      winner = i
      winnerRank = r
    }
  }
  return winner
}

async function mostFree(cands: number[], src: PolicySource): Promise<number | null> {
  return rankedBy(cands, src, async (i) => [i, (await src.quota(i)).free], (a, b) => a > b)
}

async function leastUsed(cands: number[], src: PolicySource): Promise<number | null> {
  return rankedBy(cands, src, async (i) => [i, (await src.quota(i)).usage], (a, b) => a < b)
}

async function leastFree(cands: number[], src: PolicySource): Promise<number | null> {
  return rankedBy(cands, src, async (i) => [i, (await src.quota(i)).free], (a, b) => a < b)
}

async function newest(cands: number[], src: PolicySource): Promise<number | null> {
  return rankedBy(cands, src, async (i) => [i, (await src.modifiedTime(i)) ?? ''], (a, b) => a > b)
}

/** SEARCH: pick the winning upstream index among `cands` (all have the path). */
export async function searchPick(policy: string, cands: number[], src: PolicySource): Promise<number | null> {
  if (cands.length === 0) return null
  switch (policy) {
    case 'ff':
    case 'epff':
    case 'epall':
      return Math.min(...cands)
    case 'epmfs':
      return (await mostFree(cands, src)) ?? Math.min(...cands)
    case 'eplus':
      return (await leastUsed(cands, src)) ?? Math.min(...cands)
    case 'eprand':
      return cands[Math.floor(Math.random() * cands.length)]
    case 'newest':
      return (await newest(cands, src)) ?? Math.min(...cands)
    default:
      return Math.min(...cands)
  }
}

/** ACTION: upstreams to modify among `cands` (writable, have the path). */
export async function actionSelect(policy: string, cands: number[], src: PolicySource): Promise<number[]> {
  if (cands.length === 0) return []
  switch (policy) {
    case 'epall':
      return cands
    case 'epff': {
      const w = await searchPick('ff', cands, src)
      return w === null ? [] : [w]
    }
    case 'epmfs': {
      const w = await searchPick('epmfs', cands, src)
      return w === null ? [] : [w]
    }
    case 'eplus': {
      const w = await searchPick('eplus', cands, src)
      return w === null ? [] : [w]
    }
    case 'eprand': {
      const w = await searchPick('eprand', cands, src)
      return w === null ? [] : [w]
    }
    default:
      return cands
  }
}

/** CREATE: upstreams to write into among `cands` (creatable, parent exists where required). */
export async function createSelect(policy: string, cands: number[], src: PolicySource, minFreeSpace = 0): Promise<number[]> {
  if (cands.length === 0) return []
  switch (policy) {
    case 'epall':
      return cands
    case 'epmfs': {
      const w = await searchPick('epmfs', cands, src)
      return w === null ? [] : [w]
    }
    case 'eplus': {
      const w = await searchPick('eplus', cands, src)
      return w === null ? [] : [w]
    }
    case 'eplfs': {
      const eligible = await withMinFree(cands, src, minFreeSpace)
      const w = await leastFree(eligible.length > 0 ? eligible : cands, src)
      return w === null ? [] : [w]
    }
    case 'eprand': {
      const w = await searchPick('eprand', cands, src)
      return w === null ? [] : [w]
    }
    default:
      // ff and unknown → lowest index
      return [Math.min(...cands)]
  }
}