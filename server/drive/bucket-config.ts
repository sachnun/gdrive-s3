import type { Env } from '../env'

const VERSIONING_KEY = (bucket: string) => `bucket-versioning:${bucket}`
const NO_TTL = undefined

export async function getVersioning(env: Env, bucket: string): Promise<'Enabled' | 'Suspended' | null> {
  const raw = await env.FOLDER_CACHE.get(VERSIONING_KEY(bucket)).catch(() => null)
  if (raw === 'Enabled' || raw === 'Suspended') return raw
  return null
}

export async function setVersioning(env: Env, bucket: string, status: 'Enabled' | 'Suspended'): Promise<void> {
  await env.FOLDER_CACHE.put(VERSIONING_KEY(bucket), status, { expirationTtl: NO_TTL })
}

export async function deleteVersioning(env: Env, bucket: string): Promise<void> {
  await env.FOLDER_CACHE.delete(VERSIONING_KEY(bucket)).catch(() => {})
}
