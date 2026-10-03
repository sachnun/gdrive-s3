import type { Env } from '../env'
import { s3Error } from './xml'
import { requestId } from '../util'

type SubResource =
  | { kind: 'none' }
  | { kind: 'location' }
  | { kind: 'uploads' }
  | { kind: 'versions' }
  | { kind: 'versioning' }
  | { kind: 'acl' }
  | { kind: 'tagging' }
  | { kind: 'policy' }
  | { kind: 'cors' }
  | { kind: 'lifecycle' }
  | { kind: 'encryption' }
  | { kind: 'notification' }
  | { kind: 'replication' }
  | { kind: 'website' }
  | { kind: 'logging' }
  | { kind: 'accelerate' }
  | { kind: 'requestPayment' }
  | { kind: 'publicAccessBlock' }
  | { kind: 'ownershipControls' }
  | { kind: 'objectLock' }
  | { kind: 'objectLockEnabled' }
  | { kind: 'delete' }
  | { kind: 'attributes' }
  | { kind: 'legal-hold' }
  | { kind: 'retention' }
  | { kind: 'rename' }
  | { kind: 'abac' }
  | { kind: 'policyStatus' }
  | { kind: 'metadataTable' }
  | { kind: 'restore' }
  | { kind: 'select' }
  | { kind: 'listConfig'; name: string }
  | { kind: 'unknown'; name: string }

const KNOWN = new Set([
  'location',
  'uploads',
  'versions',
  'versioning',
  'acl',
  'tagging',
  'policy',
  'cors',
  'lifecycle',
  'encryption',
  'notification',
  'replication',
  'website',
  'logging',
  'accelerate',
  'requestPayment',
  'publicAccessBlock',
  'ownershipControls',
  'objectLock',
  'object-lock',
  'delete',
  'list-type',
  'prefix',
  'delimiter',
  'max-keys',
  'marker',
  'continuation-token',
  'start-after',
  'encoding-type',
  'fetch-owner',
  'max-uploads',
  'key-marker',
  'upload-id-marker',
  'part-number-marker',
  'max-parts',
  'uploadId',
  'partNumber',
  'response-content-type',
  'response-content-disposition',
  'response-cache-control',
  'response-content-encoding',
  'response-content-language',
  'response-expires',
  'x-id',
  'attributes',
  'policyStatus',
  'metadataTable',
  'restore',
  'renameObject',
  'legal-hold',
  'retention',
  'abac',
  'annotation',
  'torrent',
  'session',
  'select',
  'select-type',
])

/** Bucket-level sub-resource carried in the query string. */
export function bucketSubResource(params: URLSearchParams): SubResource {
  if (params.has('location')) return { kind: 'location' }
  if (params.has('uploads')) return { kind: 'uploads' }
  if (params.has('versions')) return { kind: 'versions' }
  if (params.has('versioning')) return { kind: 'versioning' }
  if (params.has('acl')) return { kind: 'acl' }
  if (params.has('tagging')) return { kind: 'tagging' }
  if (params.has('policy')) return { kind: 'policy' }
  if (params.has('cors')) return { kind: 'cors' }
  if (params.has('lifecycle')) return { kind: 'lifecycle' }
  if (params.has('encryption')) return { kind: 'encryption' }
  if (params.has('notification')) return { kind: 'notification' }
  if (params.has('replication')) return { kind: 'replication' }
  if (params.has('website')) return { kind: 'website' }
  if (params.has('logging')) return { kind: 'logging' }
  if (params.has('accelerate')) return { kind: 'accelerate' }
  if (params.has('requestPayment')) return { kind: 'requestPayment' }
  if (params.has('publicAccessBlock')) return { kind: 'publicAccessBlock' }
  if (params.has('ownershipControls')) return { kind: 'ownershipControls' }
  if (params.has('object-lock')) return { kind: 'objectLock' }
  if (params.has('objectLockEnabled')) return { kind: 'objectLockEnabled' }
  if (params.has('abac')) return { kind: 'abac' }
  if (params.has('policyStatus')) return { kind: 'policyStatus' }
  if (params.has('metadataTable')) return { kind: 'metadataTable' }
  if (params.has('session')) return { kind: 'unknown', name: 'session' }
  if (params.has('annotation')) return { kind: 'unknown', name: 'annotation' }
  for (const name of ['inventory', 'metrics', 'analytics', 'intelligent-tiering']) {
    if (params.has(name)) return { kind: 'listConfig', name }
  }
  if (params.has('delete')) return { kind: 'delete' }

  for (const name of params.keys()) {
    if (!KNOWN.has(name)) return { kind: 'unknown', name }
  }
  return { kind: 'none' }
}

/** Object-level sub-resource carried in the query string. */
export function objectSubResource(params: URLSearchParams): SubResource {
  if (params.has('acl')) return { kind: 'acl' }
  if (params.has('tagging')) return { kind: 'tagging' }
  if (params.has('attributes')) return { kind: 'attributes' }
  if (params.has('torrent')) return { kind: 'unknown', name: 'torrent' }
  if (params.has('annotation')) return { kind: 'unknown', name: 'annotation' }
  if (params.has('legal-hold')) return { kind: 'legal-hold' }
  if (params.has('retention')) return { kind: 'retention' }
  if (params.has('renameObject')) return { kind: 'rename' }
  if (params.has('restore')) return { kind: 'restore' }
  if (params.has('select')) return { kind: 'select' }
  return { kind: 'none' }
}

export function notImplemented(rawPath: string, detail: string): Response {
  return s3Error(501, 'NotImplemented', detail, rawPath, requestId())
}

export function notFound(rawPath: string, code: string, message: string): Response {
  return s3Error(404, code, message, rawPath, requestId())
}

export function ok(): Response {
  return new Response(null, { status: 200, headers: { 'x-amz-request-id': requestId() } })
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'x-amz-request-id': requestId() } })
}

export function emptyConfiguration(root: string): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'x-amz-request-id': requestId() },
  })
}

export type { Env }
