import type { Env } from '../env'
import { BUCKETS } from '../config'
import { DRIVE_API, driveFetch } from '../drive/auth'
import { deleteVersioning, getVersioning, setVersioning } from '../drive/bucket-config'
import { DriveError } from '../drive/errors'
import { FOLDER_MIME, findCachedFolder, folderCacheKey, getOrCreateFolder, resolveExistingFolderId, resolveExistingPath } from '../drive/folder'
import { findFilesInFolder, listFolderFiles, trashFile, trashFiles } from '../drive/files'
import { MULTIPART_ROOT, listUploads } from '../drive/multipart'
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

export async function handleCreateBucket(env: Env, bucket: string, requested = bucket): Promise<Response> {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(requested) || requested.includes('..')) {
    return xml.s3Error(400, 'InvalidBucketName', 'The specified bucket is not valid.', `/${requested}`, requestId())
  }

  const existing = await findCachedFolder(env, bucket, null)
  if (existing) {
    return xml.s3Error(
      409,
      'BucketAlreadyOwnedByYou',
      'Your previous request to create the named bucket succeeded and you already own it.',
      `/${bucket}`,
      requestId(),
    )
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
  if (!bucketFolderId) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
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
  const bucketFolderId = keys.length > 0 ? await findCachedFolder(env, bucket, null).catch(() => null) : null

  const byDir = new Map<string, { dirPath: string; names: Set<string> }>()
  for (const k of keys) {
    const slash = k.lastIndexOf('/')
    const dirPath = slash === -1 ? '' : k.slice(0, slash)
    const name = slash === -1 ? k : k.slice(slash + 1)
    let group = byDir.get(dirPath)
    if (!group) {
      group = { dirPath, names: new Set() }
      byDir.set(dirPath, group)
    }
    group.names.add(name)
  }

  const idByName = new Map<string, string>()
  await mapLimit([...byDir.values()], DELETE_OBJECTS_CONCURRENCY, async (group) => {
    if (!bucketFolderId) return
    try {
      const dirId = group.dirPath
        ? await resolveExistingFolderId(env, bucketFolderId, group.dirPath)
        : bucketFolderId
      if (!dirId) return
      for (const f of await listFolderFiles(env, dirId)) {
        if (group.names.has(f.name)) idByName.set(group.dirPath ? `${group.dirPath}/${f.name}` : f.name, f.id)
      }
    } catch {}
  })

  const ids = keys.map((k) => idByName.get(k)).filter((id): id is string => id !== undefined)
  const failed = ids.length > 0 ? await trashFiles(env, ids) : new Map<string, string | null>()
  const deleted: string[] = []
  const errors: { key: string; code: string; message: string }[] = []
  for (const k of keys) {
    const id = idByName.get(k)
    if (!id) {
      deleted.push(k)
      continue
    }
    const err = failed.get(id)
    if (err) errors.push({ key: k, code: 'InternalError', message: `failed to delete object (${err})` })
    else deleted.push(k)
  }
  return xml.deleteResultXml(deleted, errors)
}

export async function handleListMultipartUploads(env: Env, bucket: string, params: URLSearchParams): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  const maxUploads = Math.min(Math.max(parseInt(params.get('max-uploads') ?? '1000', 10) || 1000, 0), 1000)
  const prefix = params.get('prefix') ?? ''
  const uploads = await listUploads(env, bucket, prefix, maxUploads)
  return xml.listMultipartUploadsXml(bucket, prefix, uploads)
}

export async function handleGetBucketVersioning(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.versioningXml(await getVersioning(env, bucket))
}

export async function handleGetBucketAcl(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.aclXml()
}

export async function handleGetBucketPolicy(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'NoSuchBucketPolicy', 'The bucket policy does not exist', `/${bucket}`, requestId())
}

export async function handleGetBucketTagging(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'NoSuchTagSet', 'The TagSet does not exist', `/${bucket}`, requestId())
}

export async function handleGetBucketCors(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'NoSuchCORSConfiguration', 'The CORS configuration does not exist', `/${bucket}`, requestId())
}

export async function handleGetBucketLifecycle(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'NoSuchLifecycleConfiguration', 'The lifecycle configuration does not exist', `/${bucket}`, requestId())
}

export async function handleGetBucketWebsite(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'NoSuchWebsiteConfiguration', 'The specified bucket does not have a website configuration', `/${bucket}`, requestId())
}

export async function handleGetBucketLogging(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.bucketLoggingXml()
}

export async function handleGetBucketAccelerate(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.bucketAccelerateXml()
}

export async function handleGetBucketRequestPayment(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.bucketRequestPaymentXml()
}

export async function handleGetBucketEncryption(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'ServerSideEncryptionConfigurationNotFoundError', 'The server side encryption configuration was not found', `/${bucket}`, requestId())
}

export async function handleListObjectVersions(env: Env, bucket: string, params: URLSearchParams): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  const prefix = params.get('prefix') ?? ''
  const maxKeys = Math.min(Math.max(parseInt(params.get('max-keys') ?? '1000', 10) || 1000, 0), 1000)
  const result = await listObjects(env, id, {
    bucket,
    prefix,
    delimiter: params.get('delimiter') ?? '',
    maxKeys,
    isV2: false,
    encodingType: params.get('encoding-type') ?? undefined,
  })
  return xml.listObjectVersionsXml(bucket, prefix, result.contents, params.get('encoding-type') ?? undefined)
}

export async function handleGetBucketNotification(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.emptyConfiguration('NotificationConfiguration')
}

export async function handleGetBucketReplication(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'ReplicationConfigurationNotFoundError', 'The replication configuration was not found', `/${bucket}`, requestId())
}

export async function handleGetPublicAccessBlock(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'NoSuchPublicAccessBlockConfiguration', 'The public access block configuration was not found', `/${bucket}`, requestId())
}

export async function handleGetBucketOwnershipControls(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'OwnershipControlsNotFoundError', 'The bucket ownership controls were not found', `/${bucket}`, requestId())
}

export async function handleGetObjectLockConfiguration(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'ObjectLockConfigurationNotFoundError', 'Object Lock configuration does not exist for this bucket', `/${bucket}`, requestId())
}

const BUCKET_CONFIG_ROOT: Record<string, string> = {
  tagging: 'Tagging',
  cors: 'CORSConfiguration',
  lifecycle: 'LifecycleConfiguration',
  policy: 'Policy',
  website: 'WebsiteConfiguration',
  replication: 'ReplicationConfiguration',
  encryption: 'ServerSideEncryptionConfiguration',
  notification: 'NotificationConfiguration',
  logging: 'BucketLoggingStatus',
  accelerate: 'AccelerateConfiguration',
  requestPayment: 'RequestPaymentConfiguration',
  publicAccessBlock: 'PublicAccessBlockConfiguration',
  ownershipControls: 'OwnershipControls',
  'object-lock': 'ObjectLockConfiguration',
  versioning: 'VersioningConfiguration',
}

export async function handlePutBucketConfig(env: Env, bucket: string, sub: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  if (!(sub in BUCKET_CONFIG_ROOT)) {
    return xml.s3Error(501, 'NotImplemented', `PUT ${sub} is not supported by this gateway`, `/${bucket}`, requestId())
  }
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleDeleteBucketConfig(env: Env, bucket: string, sub: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  if (!(sub in BUCKET_CONFIG_ROOT)) {
    return xml.s3Error(501, 'NotImplemented', `DELETE ${sub} is not supported by this gateway`, `/${bucket}`, requestId())
  }
  if (sub === 'versioning') await deleteVersioning(env, bucket)
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

async function findObject(
  env: Env,
  bucket: string,
  key: string,
): Promise<{ id: string } | null> {
  const bucketFolderId = await findCachedFolder(env, bucket, null)
  if (!bucketFolderId) return null
  const target = await resolveExistingPath(env, bucketFolderId, key)
  if (!target) return null
  const files = await findFilesInFolder(env, target.name, target.parentId)
  return files[0] ? { id: files[0].id } : null
}

export async function handlePutBucketAcl(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleGetBucketAbac(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.abacXml()
}

export async function handleListBucketConfig(env: Env, bucket: string, kind: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  const roots: Record<string, [string, string]> = {
    inventory: ['ListInventoryConfigurationsResult', 'InventoryConfiguration'],
    metrics: ['ListMetricsConfigurationsResult', 'MetricsConfiguration'],
    analytics: ['ListAnalyticsConfigurationsResult', 'AnalyticsConfiguration'],
    'intelligent-tiering': ['ListIntelligentTieringConfigurationsResult', 'IntelligentTieringConfiguration'],
  }
  const entry = roots[kind]
  if (!entry) {
    return xml.s3Error(501, 'NotImplemented', `${kind} is not supported by this gateway`, `/${bucket}`, requestId())
  }
  return xml.emptyListConfigXml(entry[0], entry[1], bucket)
}

export async function handleGetBucketConfigById(env: Env, bucket: string, kind: string, id: string): Promise<Response> {
  const bucketId = await findCachedFolder(env, bucket, null)
  if (!bucketId) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  const codes: Record<string, string> = {
    inventory: 'NoSuchConfiguration',
    metrics: 'NoSuchConfiguration',
    analytics: 'NoSuchConfiguration',
    'intelligent-tiering': 'NoSuchConfiguration',
  }
  const code = codes[kind] ?? 'NoSuchConfiguration'
  return xml.s3Error(404, code, `The specified ${kind} configuration does not exist`, `/${bucket}`, requestId())
}

export async function handlePutBucketVersioning(env: Env, req: Request, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  const body = await req.text()
  const status = /<Status>\s*(Enabled|Suspended)\s*<\/Status>/i.exec(body)?.[1]
  if (!status) return xml.s3Error(400, 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema', `/${bucket}`, requestId())
  await setVersioning(env, bucket, status === 'Enabled' ? 'Enabled' : 'Suspended')
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export async function handleGetBucketPolicyStatus(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.policyStatusXml()
}

export async function handleGetBucketMetadataTable(env: Env, bucket: string): Promise<Response> {
  const id = await findCachedFolder(env, bucket, null)
  if (!id) return xml.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', `/${bucket}`, requestId())
  return xml.s3Error(404, 'NoSuchConfiguration', 'The metadata table configuration does not exist', `/${bucket}`, requestId())
}
