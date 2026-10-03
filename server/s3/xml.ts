import type { ListOptions, ListResult } from './list'

export const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/'
export const XML_HEADERS: Record<string, string> = { 'Content-Type': 'application/xml; charset=utf-8' }

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function s3Error(status: number, code: string, message: string, resource?: string, requestId = ''): Response {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Error>',
    `<Code>${xmlEscape(code)}</Code>`,
    `<Message>${xmlEscape(message)}</Message>`,
    resource !== undefined ? `<Resource>${xmlEscape(resource)}</Resource>` : '',
    `<RequestId>${xmlEscape(requestId)}</RequestId>`,
    '</Error>',
  ].join('')
  return new Response(xml, { status, headers: XML_HEADERS })
}

export function listBucketsXml(buckets: { name: string; creationDate: string }[]): Response {
  const items = buckets
    .map(
      (b) =>
        `<Bucket><Name>${xmlEscape(b.name)}</Name><CreationDate>${xmlEscape(b.creationDate)}</CreationDate></Bucket>`,
    )
    .join('')
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ListAllMyBucketsResult xmlns="${XMLNS}">`,
    '<Owner><ID>gdrive-s3</ID><DisplayName>gdrive-s3</DisplayName></Owner>',
    `<Buckets>${items}</Buckets>`,
    '</ListAllMyBucketsResult>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function locationXml(region: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="${XMLNS}">${xmlEscape(region)}</LocationConstraint>`
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function initiateMultipartXml(bucket: string, key: string, uploadId: string): Response {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<InitiateMultipartUploadResult xmlns="${XMLNS}">`,
    `<Bucket>${xmlEscape(bucket)}</Bucket>`,
    `<Key>${xmlEscape(key)}</Key>`,
    `<UploadId>${xmlEscape(uploadId)}</UploadId>`,
    '</InitiateMultipartUploadResult>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function uploadPartXml(etag: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><UploadPartResult xmlns="${XMLNS}"><ETag>&quot;${xmlEscape(etag)}&quot;</ETag></UploadPartResult>`
  return new Response(xml, { status: 200, headers: { ...XML_HEADERS, 'ETag': `"${etag}"` } })
}

export function completeMultipartXml(bucket: string, key: string, etag: string, region = 'us-east-1'): Response {
  const location = `https://${bucket}.s3.${region}.amazonaws.com/${key}`
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<CompleteMultipartUploadResult xmlns="${XMLNS}">`,
    `<Location>${xmlEscape(location)}</Location>`,
    `<Bucket>${xmlEscape(bucket)}</Bucket>`,
    `<Key>${xmlEscape(key)}</Key>`,
    `<ETag>&quot;${xmlEscape(etag)}&quot;</ETag>`,
    '</CompleteMultipartUploadResult>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function copyObjectXml(etag: string, lastModified: string): Response {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<CopyObjectResult xmlns="${XMLNS}">`,
    `<LastModified>${xmlEscape(lastModified)}</LastModified>`,
    `<ETag>&quot;${xmlEscape(etag)}&quot;</ETag>`,
    '</CopyObjectResult>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function deleteResultXml(
  deletedKeys: string[],
  errors: { key: string; code: string; message: string }[],
): Response {
  const deleted = deletedKeys.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join('')
  const errs = errors
    .map(
      (e) =>
        `<Error><Key>${xmlEscape(e.key)}</Key><Code>${xmlEscape(e.code)}</Code><Message>${xmlEscape(e.message)}</Message></Error>`,
    )
    .join('')
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<DeleteResult xmlns="${XMLNS}">`,
    deleted,
    errs,
    '</DeleteResult>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

function enc(s: string, encodingType?: string): string {
  return encodingType === 'url' ? encodeURIComponent(s) : s
}

export function listObjectsXml(opts: ListOptions, result: ListResult, requestId = ''): Response {
  const isV2 = opts.isV2
  const encodingType = opts.encodingType === 'url' ? 'url' : undefined
  const contents = result.contents
    .map((c) => {
      const key = enc(c.key, encodingType)
      return [
        '<Contents>',
        `<Key>${xmlEscape(key)}</Key>`,
        `<LastModified>${xmlEscape(c.lastModified)}</LastModified>`,
        `<ETag>&quot;${xmlEscape(c.etag)}&quot;</ETag>`,
        `<Size>${c.size}</Size>`,
        '<StorageClass>STANDARD</StorageClass>',
        '</Contents>',
      ].join('')
    })
    .join('')
  const commonPrefixes = result.commonPrefixes
    .map((p) => `<CommonPrefixes><Prefix>${xmlEscape(enc(p, encodingType))}</Prefix></CommonPrefixes>`)
    .join('')

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ListBucketResult xmlns="${XMLNS}">`,
    `<Name>${xmlEscape(opts.bucket)}</Name>`,
    `<Prefix>${xmlEscape(enc(opts.prefix, encodingType))}</Prefix>`,
  ]
  if (isV2) {
    parts.push(`<KeyCount>${result.keyCount}</KeyCount>`)
    parts.push(`<MaxKeys>${opts.maxKeys}</MaxKeys>`)
    if (opts.continuationToken) parts.push(`<ContinuationToken>${xmlEscape(opts.continuationToken)}</ContinuationToken>`)
    if (result.nextContinuationToken) {
      parts.push(`<NextContinuationToken>${xmlEscape(result.nextContinuationToken)}</NextContinuationToken>`)
    }
    if (opts.startAfter) parts.push(`<StartAfter>${xmlEscape(enc(opts.startAfter, encodingType))}</StartAfter>`)
  } else {
    parts.push(`<Marker>${xmlEscape(opts.marker ?? '')}</Marker>`)
    if (result.nextMarker) parts.push(`<NextMarker>${xmlEscape(result.nextMarker)}</NextMarker>`)
    parts.push(`<MaxKeys>${opts.maxKeys}</MaxKeys>`)
  }
  if (opts.delimiter) parts.push(`<Delimiter>${xmlEscape(enc(opts.delimiter, encodingType))}</Delimiter>`)
  parts.push(`<IsTruncated>${result.isTruncated}</IsTruncated>`)
  parts.push(contents)
  parts.push(commonPrefixes)
  parts.push('</ListBucketResult>')
  return new Response(parts.join(''), { status: 200, headers: { ...XML_HEADERS, 'x-amz-request-id': requestId } })
}
