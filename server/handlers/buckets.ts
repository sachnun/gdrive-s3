import type { Env } from '../env'
import { BUCKETS } from '../config'
import { DRIVE_API, driveFetch } from '../drive/auth'
import { DriveError } from '../drive/errors'
import { FOLDER_MIME, findCachedFolder, folderCacheKey, getOrCreateFolder, resolveExistingPath } from '../drive/folder'
import { findFilesInFolder, trashFile } from '../drive/files'
import { MULTIPART_ROOT } from '../drive/multipart'
import { extractXmlKeys } from '../s3/request'
import { listObjects, type ListOptions } from '../s3/list'
import * as xml from '../s3/xml'
import { mapLimit, requestId } from '../util'

const DELETE_OBJECTS_CONCURRENCY = 8

export async function handleListBuckets(env: Env): Promise<Response> {
  const allowed = BUCKETS === '*' ? null : BUCKETS
  const buckets: { name: string; creationDate: string }[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const q = `mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`
    let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,createdTime)&spaces=drive&orderBy=name`
    if (pageToken) url += `&pageToken=${pageToken}`
    const res = await driveFetch(env, url)
    if (!res.ok) throw new DriveError(500, 'InternalError', `bucket list failed (HTTP ${res.status})`)
    const data = (await res.json()) as { nextPageToken?: string; files: { id: string; name: string; createdTime: string }[] }
    for (const f of data.files) {
      if (f.name === MULTIPART_ROOT) continue
      if (allowed && !allowed.includes(f.name)) continue
      buckets.push({ name: f.name, creationDate: f.createdTime })
    }
    pageToken = data.nextPageToken
    if (!pageToken) break
  }
  buckets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return xml.listBucketsXml(buckets)
}

export async function handleHeadBucket(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleCreateBucket(env: Env, bucket: string): Promise<Response> {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    return xml.s3Error(400, 'InvalidBucketName', 'The specified bucket is not valid.', `/${bucket}`, requestId())
  }
  await getOrCreateFolder(env, bucket, null)
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleGetBucketLocation(env: Env, bucket: string, region: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.locationXml(region)
}

export async function handleListObjects(
  env: Env,
  bucket: string,
  params: URLSearchParams,
  isV2: boolean,
): Promise<Response> {
  const bucketFolderId = await findCachedFolder(env, bucket, null)
  const maxKeysRaw = parseInt(params.get('max-keys') ?? '1000', 10)
  const maxKeys = isNaN(maxKeysRaw) ? 1000 : Math.min(Math.max(maxKeysRaw, 0), 1000)
  const opts: ListOptions = {
    bucket,
    prefix: (params.get('prefix') ?? '').replace(/^\/+/, ''),
    delimiter: params.get('delimiter') ?? '',
    maxKeys,
    marker: params.get('marker') ?? undefined,
    continuationToken: params.get('continuation-token') ?? undefined,
    startAfter: params.get('start-after') ?? undefined,
    isV2,
    encodingType: params.get('encoding-type') ?? undefined,
  }
  const result = await listObjects(env, bucketFolderId, opts)
  return xml.listObjectsXml(opts, result, requestId())
}

export async function handleDeleteBucket(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  await trashFile(env, id)
  await env.FOLDER_CACHE.delete(folderCacheKey(null, bucket)).catch(() => {})
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleDeleteObjects(env: Env, req: Request, bucket: string): Promise<Response> {
  const body = await req.text()
  const keys = extractXmlKeys(body)
  let bucketFolderId: string | null = null
  if (keys.length > 0) bucketFolderId = await findCachedFolder(env, bucket, null).catch(() => null)
  const results = await mapLimit(keys, DELETE_OBJECTS_CONCURRENCY, async (k): Promise<boolean> => {
    try {
      const target = bucketFolderId ? await resolveExistingPath(env, bucketFolderId, k) : null
      const file = target ? (await findFilesInFolder(env, target.name, target.parentId))[0] : undefined
      if (file) await trashFile(env, file.id)
      return true
    } catch {
      return false
    }
  })
  const deleted: string[] = []
  const errors: { key: string; code: string; message: string }[] = []
  results.forEach((ok, i) => {
    if (ok) deleted.push(keys[i])
    else errors.push({ key: keys[i], code: 'InternalError', message: 'failed to delete object' })
  })
  return xml.deleteResultXml(deleted, errors)
}
