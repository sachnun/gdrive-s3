import type { ListEntry, ListOptions, ListResult } from './list'

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
    resource !== undefined ? `<Resource>${xmlEscape(resourcePath(resource))}</Resource>` : '',
    `<RequestId>${xmlEscape(requestId)}</RequestId>`,
    '</Error>',
  ].join('')
  return new Response(xml, { status, headers: XML_HEADERS })
}

function bucketName(name: string): string {
  return name.toLowerCase()
}

function resourcePath(resource: string): string {
  if (!resource.startsWith('/')) return resource
  const slash = resource.indexOf('/', 1)
  if (slash === -1) return resource.toLowerCase()
  return resource.slice(0, slash).toLowerCase() + resource.slice(slash)
}

export function listBucketsXml(buckets: { name: string; creationDate: string }[]): Response {
  const items = buckets
    .map(
      (b) =>
        `<Bucket><Name>${xmlEscape(bucketName(b.name))}</Name><CreationDate>${xmlEscape(b.creationDate)}</CreationDate></Bucket>`,
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
    `<Bucket>${xmlEscape(bucketName(bucket))}</Bucket>`,
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
  const name = bucketName(bucket)
  const location = `https://${name}.s3.${region}.amazonaws.com/${key}`
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<CompleteMultipartUploadResult xmlns="${XMLNS}">`,
    `<Location>${xmlEscape(location)}</Location>`,
    `<Bucket>${xmlEscape(name)}</Bucket>`,
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

  const head: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', `<ListBucketResult xmlns="${XMLNS}">`]
  const parts: string[] = [`<Name>${xmlEscape(bucketName(opts.bucket))}</Name>`, `<Prefix>${xmlEscape(enc(opts.prefix, encodingType))}</Prefix>`]
  if (opts.delimiter) parts.push(`<Delimiter>${xmlEscape(enc(opts.delimiter, encodingType))}</Delimiter>`)
  parts.push(`<MaxKeys>${opts.maxKeys}</MaxKeys>`)
  if (encodingType) parts.push(`<EncodingType>${xmlEscape(encodingType)}</EncodingType>`)
  parts.push(`<IsTruncated>${result.isTruncated}</IsTruncated>`)
  if (isV2) {
    parts.push(`<KeyCount>${result.keyCount}</KeyCount>`)
    if (opts.continuationToken) parts.push(`<ContinuationToken>${xmlEscape(opts.continuationToken)}</ContinuationToken>`)
    if (result.nextContinuationToken) parts.push(`<NextContinuationToken>${xmlEscape(result.nextContinuationToken)}</NextContinuationToken>`)
    if (opts.startAfter) parts.push(`<StartAfter>${xmlEscape(enc(opts.startAfter, encodingType))}</StartAfter>`)
  } else {
    parts.push(`<Marker>${xmlEscape(opts.marker ?? '')}</Marker>`)
    if (result.nextMarker) parts.push(`<NextMarker>${xmlEscape(result.nextMarker)}</NextMarker>`)
  }
  parts.push(contents)
  parts.push(commonPrefixes)
  return new Response(head.concat(parts, '</ListBucketResult>').join(''), { status: 200, headers: { ...XML_HEADERS, 'x-amz-request-id': requestId } })
}

export function versioningXml(): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="${XMLNS}"><Status>Suspended</Status></VersioningConfiguration>`
  return new Response(xml, { status: 200, headers: { ...XML_HEADERS, 'x-amz-request-id': '' } })
}

export function aclXml(): Response {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<AccessControlPolicy xmlns="${XMLNS}">`,
    '<Owner><ID>gdrive-s3</ID><DisplayName>gdrive-s3</DisplayName></Owner>',
    '<AccessControlList><Grant>',
    '<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">',
    '<ID>gdrive-s3</ID><DisplayName>gdrive-s3</DisplayName>',
    '</Grantee>',
    '<Permission>FULL_CONTROL</Permission>',
    '</Grant></AccessControlList>',
    '</AccessControlPolicy>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function bucketLoggingXml(): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><BucketLoggingStatus xmlns="${XMLNS}"/>`
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function bucketAccelerateXml(): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><AccelerateConfiguration xmlns="${XMLNS}"/>`
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function bucketRequestPaymentXml(): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><RequestPaymentConfiguration xmlns="${XMLNS}"><Payer>BucketOwner</Payer></RequestPaymentConfiguration>`
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function listMultipartUploadsXml(
  bucket: string,
  prefix: string,
  uploads: { key: string; uploadId: string; initiated: string }[],
): Response {
  const items = uploads
    .map((u) =>
      [
        '<Upload>',
        `<Key>${xmlEscape(u.key)}</Key>`,
        `<UploadId>${xmlEscape(u.uploadId)}</UploadId>`,
        '<Initiator><ID>gdrive-s3</ID><DisplayName>gdrive-s3</DisplayName></Initiator>',
        '<Owner><ID>gdrive-s3</ID><DisplayName>gdrive-s3</DisplayName></Owner>',
        '<StorageClass>STANDARD</StorageClass>',
        `<Initiated>${xmlEscape(u.initiated)}</Initiated>`,
        '</Upload>',
      ].join(''),
    )
    .join('')
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ListMultipartUploadsResult xmlns="${XMLNS}">`,
    `<Bucket>${xmlEscape(bucketName(bucket))}</Bucket>`,
    `<KeyMarker></KeyMarker>`,
    `<UploadIdMarker></UploadIdMarker>`,
    `<NextKeyMarker></NextKeyMarker>`,
    `<NextUploadIdMarker></NextUploadIdMarker>`,
    `<Prefix>${xmlEscape(prefix)}</Prefix>`,
    `<MaxUploads>1000</MaxUploads>`,
    '<IsTruncated>false</IsTruncated>',
    items,
    '</ListMultipartUploadsResult>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function taggingXml(appProperties?: Record<string, string>): Response {
  const tags = Object.entries(appProperties ?? {})
    .filter(([k]) => k.startsWith('x-amz-tag-'))
    .map(([k, v]) => `<Tag><Key>${xmlEscape(k.slice('x-amz-tag-'.length))}</Key><Value>${xmlEscape(v)}</Value></Tag>`)
    .join('')
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="${XMLNS}"><TagSet>${tags}</TagSet></Tagging>`
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function listObjectVersionsXml(
  bucket: string,
  prefix: string,
  contents: ListEntry[],
  encodingType?: string,
): Response {
  const enc = (s: string) => (encodingType === 'url' ? encodeURIComponent(s) : s)
  const items = contents
    .map((c) =>
      [
        '<Version>',
        `<Key>${xmlEscape(enc(c.key))}</Key>`,
        '<VersionId>null</VersionId>',
        '<IsLatest>true</IsLatest>',
        `<LastModified>${xmlEscape(c.lastModified)}</LastModified>`,
        `<ETag>&quot;${xmlEscape(c.etag)}&quot;</ETag>`,
        `<Size>${c.size}</Size>`,
        '<StorageClass>STANDARD</StorageClass>',
        '<Owner><ID>gdrive-s3</ID><DisplayName>gdrive-s3</DisplayName></Owner>',
        '</Version>',
      ].join(''),
    )
    .join('')
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ListVersionsResult xmlns="${XMLNS}">`,
    `<Name>${xmlEscape(bucketName(bucket))}</Name>`,
    `<Prefix>${xmlEscape(enc(prefix))}</Prefix>`,
    '<KeyMarker></KeyMarker>',
    '<VersionIdMarker></VersionIdMarker>',
    '<MaxKeys>1000</MaxKeys>',
    '<IsTruncated>false</IsTruncated>',
    items,
    '</ListVersionsResult>',
  ]
  if (encodingType === 'url') parts.splice(parts.length - 1, 0, '<EncodingType>url</EncodingType>')
  return new Response(parts.join(''), { status: 200, headers: XML_HEADERS })
}

export function emptyConfiguration(root: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="${XMLNS}"/>`
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function listPartsXml(
  bucket: string,
  key: string,
  uploadId: string,
  parts: Record<string, { fileId: string; size: number; etag: string }>,
): Response {
  const items = Object.entries(parts)
    .map(([n, p]) =>
      [
        '<Part>',
        `<PartNumber>${n}</PartNumber>`,
        `<LastModified>${new Date(0).toISOString()}</LastModified>`,
        `<ETag>&quot;${xmlEscape(p.etag)}&quot;</ETag>`,
        `<Size>${p.size}</Size>`,
        '</Part>',
      ].join(''),
    )
    .join('')
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ListPartsResult xmlns="${XMLNS}">`,
    `<Bucket>${xmlEscape(bucketName(bucket))}</Bucket>`,
    `<Key>${xmlEscape(key)}</Key>`,
    `<UploadId>${xmlEscape(uploadId)}</UploadId>`,
    '<Initiator><ID>gdrive-s3</ID><DisplayName>gdrive-s3</DisplayName></Initiator>',
    '<Owner><ID>gdrive-s3</ID><DisplayName>gdrive-s3</DisplayName></Owner>',
    '<StorageClass>STANDARD</StorageClass>',
    '<PartNumberMarker>0</PartNumberMarker>',
    '<NextPartNumberMarker>0</NextPartNumberMarker>',
    '<MaxParts>1000</MaxParts>',
    '<IsTruncated>false</IsTruncated>',
    items,
    '</ListPartsResult>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function objectAttributesXml(etag: string, size: string): Response {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<GetObjectAttributesOutput xmlns="${XMLNS}">`,
    `<ETag>${xmlEscape(etag)}</ETag>`,
    `<ObjectSize>${xmlEscape(size)}</ObjectSize>`,
    '<StorageClass>STANDARD</StorageClass>',
    '</GetObjectAttributesOutput>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function copyPartXml(etag: string, lastModified: string, range?: string | null): Response {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<CopyPartResult xmlns="${XMLNS}">`,
    `<LastModified>${xmlEscape(lastModified)}</LastModified>`,
    `<ETag>&quot;${xmlEscape(etag)}&quot;</ETag>`,
  ]
  if (range) parts.push(`<CopySourceRange>${xmlEscape(range)}</CopySourceRange>`)
  parts.push('</CopyPartResult>')
  return new Response(parts.join(''), { status: 200, headers: XML_HEADERS })
}

export function legalHoldXml(status: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><LegalHold xmlns="${XMLNS}"><Status>${xmlEscape(status)}</Status></LegalHold>`
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function retentionXml(mode: string, until: string): Response {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Retention xmlns="${XMLNS}">`,
    `<Mode>${xmlEscape(mode)}</Mode>`,
    `<RetainUntilDate>${xmlEscape(until)}</RetainUntilDate>`,
    '</Retention>',
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function abacXml(): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><GetBucketAbacOutput xmlns="${XMLNS}"><AbacStatus><Status>Disabled</Status></AbacStatus></GetBucketAbacOutput>`
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}

export function emptyListConfigXml(root: string, item: string, bucket: string): Response {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${root} xmlns="${XMLNS}">`,
    `<Bucket>${xmlEscape(bucket)}</Bucket>`,
    '<IsTruncated>false</IsTruncated>',
    `</${root}>`,
  ].join('')
  return new Response(xml, { status: 200, headers: XML_HEADERS })
}
