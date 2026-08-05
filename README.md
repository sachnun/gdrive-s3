# gdrive-s3

A **Cloudflare Worker** that exposes a Google Drive folder tree as an **S3-compatible
HTTP API** (AWS Signature V4), so S3 clients like **rclone**, **aws cli**, **s3cmd**
and the AWS SDK work against Google Drive.

It is a from-scratch, hardened reimplementation of the ideas in
[nexryai/google-drive-s3 (I.R.I.S.)](https://github.com/nexryai/google-drive-s3),
fixing its known gaps: no multipart, listings truncated at 100 files, no prefix /
delimiter / pagination, no overwrite, permanent deletes, no Range, no expiry
enforcement, and no S3 error XML.

---

## Architecture

```
S3 Client (rclone / aws cli / s3cmd / SDKs)
   │  S3 request (SigV4), path-style: /<bucket>/<key>
   ▼
Cloudflare Worker (Hono)
   ├─ bucket allowlist (ALLOWED_BUCKETS) + optional public read
   ├─ AWS SigV4 verify (Web Crypto) + presigned expiry + ±15 min freshness
   ├─ S3 ops ──▶ Google Drive API
   │     PUT/POST     → resumable upload (streaming, overwrite-aware)
   │     GET          → ListObjects(V1/V2) XML / streaming download (+Range)
   │     HEAD/DELETE  → metadata / move-to-trash
   │     multipart    → temp part folders + stream-concat on Complete
   ├─ KV: AUTH_KV (OAuth token) + FOLDER_CACHE (folder IDs, multipart state)
   ▼
Google Drive API (Drive v3)
```

### Concept mapping

| S3            | Google Drive                                    |
|---------------|--------------------------------------------------|
| Bucket        | Root folder in Drive (one folder per bucket)     |
| Key `a/b/c`   | Folder hierarchy `a/b` + file `c`                |
| Object        | Drive file (ETag = Drive file ID)                |
| List bucket   | `files.list` (`'<folder>' in parents`, pageSize 1000, paginated) |
| Multipart     | Temp folder `.gdrive-s3-multipart/<bucket>/<id>` (outside buckets) |

---

## Deploy

1. Create a Google Cloud project and a Drive-scoped OAuth client. Generate a
   refresh token with rclone: <https://rclone.org/drive/#making-your-own-client-id>.

2. Create the two KV namespaces and put their IDs into `wrangler.jsonc`:

   ```
   wrangler kv namespace create AUTH_KV          # "id" → AUTH_KV
   wrangler kv namespace create FOLDER_CACHE    # "id" → FOLDER_CACHE
   ```

3. Set secrets:

   ```
   wrangler secret put ACCESS_KEY
   wrangler secret put SECRET_KEY
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   wrangler secret put GOOGLE_REFRESH_TOKEN
   wrangler secret put ALLOWED_BUCKETS        # e.g. "my-bucket,public" (or a var)
   wrangler secret put PUBLIC_READ_BUCKETS    # optional: "public" (subset of allowed)
   ```

   `ACCESS_KEY` is bound to a single `SECRET_KEY` (like the reference) — use a
   long random string for `SECRET_KEY` because it is the actual signing key.

4. `wrangler deploy`

### rclone

```
[gdrive-s3]
type = s3
provider = Other
endpoint = https://<worker>/          # path-style
access_key_id = <ACCESS_KEY>
secret_access_key = <SECRET_KEY>
region = auto
force_path_style = true

```

### aws cli

```
aws configure set aws_access_key_id <ACCESS_KEY>
aws configure set aws_secret_access_key <SECRET_KEY>
aws --endpoint-url https://<worker>/ s3 ls
```

---

## Supported S3 operations (P0 core + easy P1)

| Operation | Notes |
|---|---|
| ListBuckets, HeadBucket, CreateBucket, GetBucketLocation | `PUT /bucket` creates the Drive folder |
| PutObject                     | streaming resumable upload; overwrite = upload-new-then-trash-old |
| GetObject, HeadObject         | streaming download, `Range` → 206, `x-amz-meta-*` ↔ `appProperties` |
| DeleteObject                  | move-to-trash (safe, no permanent delete) |
| ListObjects V1 + V2            | `prefix`, `delimiter`, `max-keys`, `marker`, `start-after`, `continuation-token`, `encoding-type=url` |
| CopyObject                    | via Drive `files.copy` + rename |
| DeleteObjects                 | batch move-to-trash |
| Create/Upload/Complete/Abort MultipartUpload | streamed copy-concat |
| Presigned URLs                | header + query auth, `X-Amz-Expires`, ±15 min freshness |

S3 auth is **AWS Signature V4** verified with Web Crypto (header auth +
presigned query auth), constant-time comparison, and `UNSIGNED-PAYLOAD` support.

---

## Known limitations (deliberate / documented)

- **>100 MB uploads only via multipart** (Workers caps a single request body at
  100 MB). Each part ≤100 MB; typical clients use 5–64 MiB parts.
- **ETag = Drive file ID, not MD5.** `rclone check` will re-download (no MD5 hash).
- **Drive rate limit ~400 req/100 s** → folder caching is essential; large listings
  are slower than S3.
- **Free plan:** 10 ms CPU (streaming keeps us under), **50 sub-requests/request**
  (multipart concat ≈ 2× #parts — fine for ≤ ~20 typical parts), 100k req/day.
- **`STREAMING-AWS4-HMAC-SHA256-PAYLOAD` (signed chunked) is Not Implemented**.
  `STREAMING-UNSIGNED-PAYLOAD-TRAILER` (used by aws-sdk v3 / aws cli for stream
  uploads with CRC32) is decoded automatically.
- **No versioning, tagging, ACLs, lifecycle, CORS-on-workers.dev** (use a custom
  domain + RTR/response headers, or app-level `Access-Control-Allow-Origin`).
- **Drive ToS**: personal use, no illegal content (same stance as the reference).
- **Multi-user**: anyone with `SECRET_KEY` reaches every allowed bucket.

---

## Development

```
npm install
npm test          # vitest suite (fake Drive + in-memory KV + aws4fetch + aws-sdk v3)
npm run typecheck
npm run dev       # wrangler dev
```

Tests cover, with a fully mocked Drive API and in-memory KV:
- SigV4 header + presigned verification, expiry, freshness, secret/access-key/STREAMING cases
- OAuth token caching + 401 retry-invalidate
- folder create/cache/search, path resolution
- resumable upload / download / Range / trash / metadata
- full object/bucket/listing/multipart flows via aws4fetch
- real `@aws-sdk/client-s3` compatibility (custom request handler)

---

## Layout

```
src/
  index.ts          # Hono router, dispatch, handler, error XML
  env.ts            # Env + secrets + KV bindings
  middleware.ts     # path parse, bucket allowlist, public-read, signature gate
  util.ts
  drive/
    auth.ts         # OAuth token + KV cache + 401 retry
    folder.ts        # getOrCreateFolder + KV cache/lock + path resolution
    files.ts          # resumable upload / download / metadata / trash / copy
    multipart.ts      # multipart sessions + concat + GC
  s3/
    signature.ts      # SigV4 verify (Web Crypto), presigned, freshness
    list.ts           # ListObjects V1/V2 engine (prefix/delimiter/pagination)
    xml.ts            # all S3 XML responses
```