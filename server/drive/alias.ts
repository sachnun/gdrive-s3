import type { Env } from '../env'
import { DRIVE_API, driveFetch } from './auth'
import { DriveError } from './errors'
import { FOLDER_MIME, folderCacheKey } from './folder'

const TTL = 3600
const LIST_PAGE = 1000
const MAX_PAGES = 10

function escapeDriveQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function aliasKey(name: string): string {
  return `bucket-alias:${name}`
}

async function remember(env: Env, requested: string, name: string, id?: string): Promise<void> {
  await env.FOLDER_CACHE.put(aliasKey(requested), name, { expirationTtl: TTL }).catch(() => {})
  if (id) await env.FOLDER_CACHE.put(folderCacheKey(null, name), id, { expirationTtl: TTL }).catch(() => {})
}

export async function resolveBucketAlias(env: Env, requested: string): Promise<string> {
  const cached = await env.FOLDER_CACHE.get(aliasKey(requested))
  if (cached) return cached

  const exactQ = `name='${escapeDriveQuery(requested)}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`
  const exactUrl = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(exactQ)}&pageSize=1&fields=files(id,name)&spaces=drive`
  const exactRes = await driveFetch(env, exactUrl)
  if (!exactRes.ok) throw new DriveError(500, 'InternalError', `bucket lookup failed (HTTP ${exactRes.status})`)
  const exact = ((await exactRes.json()) as { files: { id: string; name: string }[] }).files[0]
  if (exact) {
    await remember(env, requested, exact.name, exact.id)
    return exact.name
  }

  const lower = requested.toLowerCase()
  const rootQ = `mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`
  let pageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    let listUrl = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(rootQ)}&pageSize=${LIST_PAGE}&fields=nextPageToken,files(id,name)&spaces=drive`
    if (pageToken) listUrl += `&pageToken=${pageToken}`
    const listRes = await driveFetch(env, listUrl)
    if (!listRes.ok) throw new DriveError(500, 'InternalError', `bucket lookup failed (HTTP ${listRes.status})`)
    const list = (await listRes.json()) as { nextPageToken?: string; files: { id: string; name: string }[] }
    const match = list.files.find((f) => f.name.toLowerCase() === lower)
    if (match) {
      await remember(env, requested, match.name, match.id)
      return match.name
    }
    pageToken = list.nextPageToken
    if (!pageToken) break
  }

  await remember(env, requested, requested)
  return requested
}
