# Plan: Google Drive as S3-Compatible Storage (gdrive-s3)

Deploy target: **Cloudflare Workers** (free, serverless).
Primary reference: https://github.com/nexryai/google-drive-s3 (I.R.I.S.) — reviewed at code
level (`src/index.ts`, 581 lines) and test level (`test/s3.test.ts`, 1097 lines).
This plan folds in the deep analysis (platform limits, Drive API constraints, reference bugs,
client compatibility, security) so it can be executed directly.

---

## 1. Architecture

```
S3 Client (rclone, aws cli, s3cmd, SDKs)
        │  S3 request (SigV4), path-style: /<bucket>/<key>
        ▼
Cloudflare Worker (Hono)
        ├─ 1. Bucket validation (ALLOWED_BUCKETS)
        ├─ 2. AWS SigV4 verification (Web Crypto) + presigned expiry + date freshness
        ├─ 3. Translate S3 ops → Google Drive API:
        │      • PUT/POST          → resumable upload (streaming, overwrite-aware)
        │      • GET               → ListObjects(V2) XML / streaming download (+ Range)
        │      • HEAD / DELETE     → metadata / delete (trash)
        │      • multipart         → temp part folder + stream-concat on complete
        ├─ 4. Cache OAuth token + folder IDs in KV
        ▼
Google Drive API (Drive v3)
```

Concept mapping:

| S3                | Google Drive                              |
|-------------------|-------------------------------------------|
| Bucket            | Root folder in Drive (one folder per bucket) |
| Object key `a/b/c`| Folder hierarchy `a/b` + file `c`         |
| Object            | Drive file (mimeType, size, ETag = file ID) |
| List bucket       | `files.list` (`'<folder>' in parents`, pageSize 1000, nextPageToken) |
| Multipart session | Temp folder `.<bucket>/.multipart/<uploadId>` |

---

## 2. Deep-analysis findings that shape the design

### 2.1 Hard platform facts

| Fact | Consequence |
|---|---|
| Workers caps **incoming request body at 100 MB** | Single-PUT objects >100 MB impossible. **Multipart is the only path to large objects.** |
| Workers free: 10 ms CPU, 50 subrequests/req, 128 MB memory | Streaming only; no body hashing/buffering; deep uncached paths must be avoided (see §5.3). |
| Drive `files.list` default pageSize **100** (max 1000) + `nextPageToken` | Reference silently truncates buckets at 100 files. Must paginate. |
| Drive per-user rate limit **400 req/100 s** | Aggressive folder caching is mandatory. |
| Drive `files.delete` is **permanent** (no recycle bin) | Safety decision D2 (move-to-trash). |
| Drive allows **duplicate names in one parent** | Overwrite must be explicit (delete-old); naive upload creates duplicate files. |

### 2.2 Reference bugs / gaps found (all to fix)

1. **No multipart** — rclone uploads >200 MiB (default `--s3-upload-cutoff`) and aws cli
   >8 MiB fail.
2. **Listing truncated at 100 files** — no pageSize/nextPageToken.
3. **No prefix/delimiter/pagination** in ListObjects — rclone subdirectory listing broken.
4. **Upload never overwrites** → duplicate files per key; `findFileInFolder` picks first.
5. **ETag = Drive file ID** (not MD5) → rclone reports no hash; `rclone check` re-downloads.
6. **Presigned URL expiry not enforced**; no request date freshness → replayable forever.
7. **`ACCESS_KEY` not bound to `SECRET_KEY`** — signature derived from secret only.
8. **DELETE permanent** — destructive on a personal Drive.
9. **No Range support** — broken partial/resumed downloads. (Drive `alt=media` supports Range.)
10. **No CopyObject / HeadBucket / ListBuckets / GetBucketLocation** — rclone `move`, `lsd`,
    and bucket-existence checks fail.
11. **Plain-text errors** instead of S3 error XML.
12. **No chunked `STREAMING-AWS4-HMAC-SHA256-PAYLOAD`** handling (aws-sdk v3 stream bodies).

### 2.3 Client compatibility matrix (target)

| Client | Ops used | Multipart? | Sig payload |
|---|---|---|---|
| rclone (primary) | HeadBucket, ListV2, Put/Get/Head/Delete, Copy, multipart, ListBuckets | yes (>200 MiB, 5 MiB parts) | `UNSIGNED-PAYLOAD` ✓ |
| aws cli v2 | ListV2, multipart >8 MiB, HeadBucket, DeleteObjects | yes | `UNSIGNED-PAYLOAD` parts ✓ |
| s3cmd | ListObjects **V1**, multipart >15 MiB | yes | verify |
| aws-sdk v3 | header auth, presigned URLs | via Upload API | in-memory: real SHA256 ✓; streams: `STREAMING-*` ✗ (P2) |
| aws4fetch | presigned/header | — | `UNSIGNED-PAYLOAD` ✓ |

---

## 3. Components to build

### a. S3 auth — AWS Signature V4 (`s3/signature.ts`)
- Verify header auth (`Authorization: AWS4-HMAC-SHA256 ...`) and query auth (presigned).
- Build canonical request → string-to-sign → derive signing key (HMAC) → constant-time compare.
- `x-amz-content-sha256` = `UNSIGNED-PAYLOAD` for streams; use client-sent hash when present.
- **Enforce presigned `X-Amz-Expires` and ±15 min date freshness (replay protection).**
- P2: `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` chunked framing.

### b. Google Drive integration (`drive/auth.ts`, `drive/folder.ts`, `drive/files.ts`)
- OAuth: refresh token → access token, cache in KV (`expirationTtl = expires_in − 60`),
  retry once on 401 with cache invalidation. Credentials from rclone
  (https://rclone.org/drive/#making-your-own-client-id).
- `getOrCreateFolder(name, parentId)`: search (`name='...'` exact, folder mimeType,
  `'<parent>' in parents`, `trashed=false`) → create if missing → cache `folder:<parent>:<name>`
  (TTL 1 h). KV lock (short TTL) to reduce duplicate-folder races.
- Files: resumable upload (init POST → `Location` → stream PUT with `duplex: "half"`),
  streaming download (`alt=media`, forward `Range`), metadata, delete.

### c. Path mapping (`index.ts`)
- Parse `/<bucket>/<key>` (path-style only). Normalize/decode key; reject `..` segments.
- `resolvePathToFolderAndFile()`: walk segments, resolve from cache/API → `(parentFolderId, fileName)`.

### d. Object operations
- **PUT:** upload-new-then-delete-old (keeps reads alive; see D1). Return JSON + `ETag: "<fileId>"`.
- **GET:** forward `Range`; stream Drive body + Content-Type/Length/ETag; 404 → `NoSuchKey` XML.
- **HEAD:** metadata only. **DELETE:** move-to-trash (D2), 204.
- **Multipart (`drive/multipart.ts`):** see §4.

### e. Listings (`s3/xml.ts`)
- ListBuckets, ListObjects **V1 + V2** with `prefix`, `delimiter`, `continuation-token`/`marker`,
  `max-keys`, `start-after`; `IsTruncated` + `NextContinuationToken`/`NextMarker`.
- Drive: `pageSize=1000` + `nextPageToken` loop; common-prefix aggregation for delimiter.
- HeadBucket (bucket exists → 200), GetBucketLocation (return REGION).
- S3 error XML for all failures (403/404/405/500/429→`SlowDown`).

### f. Caching (2 KV namespaces)
- `AUTH_KV`: OAuth access token. `FOLDER_CACHE`: folder IDs (TTL 1 h).
- Never cache listings (stale `modifiedTime` confuses rclone).

---

## 4. Multipart design (the key feature)

Drive has no file-concat API, and the worker can't buffer parts (>128 MB). Design:

1. `CreateMultipartUpload` → create temp folder `.<bucket>/.multipart/<uploadId>` (uploadId =
   random hex), return `InitiateMultipartUploadResult` XML.
2. `UploadPart` → resumable-upload each part body into that folder (each part ≤100 MB cap,
   clients use 5–64 MB) → store `(partNumber, fileId, size)`.
3. `CompleteMultipartUpload` → **stream-concatenate** part files (GET each `alt=media`,
   pipe sequentially into one resumable session to the final key) → delete temp folder →
   return `CompleteMultipartUploadResult` XML (ETag = final file ID).
4. `AbortMultipartUpload` → delete temp folder.
5. GC: lazily delete `.multipart` folders older than 24 h (on list or scheduled trigger);
   Drive also expires abandoned resumable sessions (~7 days).

Cost: 2× Drive bandwidth on complete + ~2n subrequests (free-plan cap 50 — fine for
n ≤ ~20 typical parts; document).

---

## 5. Configuration & operational notes

Secrets (wrangler secret / dashboard): `ACCESS_KEY`, `SECRET_KEY`, `REGION`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `ALLOWED_BUCKETS`,
`PUBLIC_READ_BUCKETS` (optional).

KV bindings in `wrangler.jsonc`: `AUTH_KV`, `FOLDER_CACHE`.

rclone test config:
```
[gdrive-s3]
type = s3
provider = Other
endpoint = https://<worker>/ 
access_key_id = <ACCESS_KEY>
secret_access_key = <SECRET_KEY>
region = auto
force_path_style = true
```

CORS (if needed): not possible via transform rules on workers.dev → custom domain +
Response Header Transform Rules, or app-level `Access-Control-Allow-Origin`.

---

## 6. Implementation steps

| Phase | Content | Done when |
|---|---|---|
| 0 | Setup wrangler.jsonc (KV, vars), devDeps (`@aws-sdk/client-s3`, `aws4fetch`) | `wrangler dev` runs |
| 1 | Drive module: auth + folders + files (upload/download/delete/metadata) | unit tests, mocked fetch |
| 2 | SigV4 verify: header + query auth, expiry/freshness | tests via aws4fetch |
| 3 | Router: PUT/GET/HEAD/DELETE + List V1/V2 + bucket ops + error XML | e2e via `@aws-sdk/client-s3` |
| 4 | Multipart (create/upload/complete/abort + concat + GC) | e2e multipart test |
| 5 | KV caching, KV lock, token 401-retry, public-read buckets | tests + review |
| 6 | README (rclone setup, limits, ToS), deploy | deployed |

File structure:

```
src/
  index.ts          # Hono router, dispatch, error XML
  env.ts            # Env types
  s3/
    signature.ts    # SigV4 verify, expiry/freshness, (P2 chunked)
    xml.ts          # all S3 XML responses
  drive/
    auth.ts         # OAuth token + cache + 401 retry
    folder.ts       # getOrCreateFolder + KV lock + cache
    files.ts        # upload/download/delete/metadata (Range)
    multipart.ts    # multipart sessions + concat + GC
  middleware.ts     # bucket allowlist, public-read, signature gate
```

---

## 7. Roadmap

- **P0 — rclone-usable core:** overwrite semantics; List V1+V2 (prefix/delimiter/pagination,
  pageSize 1000); multipart (concat); Range; HeadBucket/ListBuckets/GetBucketLocation;
  presigned expiry + freshness; error XML; Drive 401/429 handling; integration test matrix.
- **P1 — client comfort:** CopyObject (`files.copy` + rename/parents); DeleteObjects;
  `x-amz-meta-*` ↔ Drive `appProperties`; CORS; multipart-folder GC hardening.
- **P2 — fidelity:** `STREAMING-*` chunked signing; real MD5 ETag for objects ≤16 MB
  (computed in memory), file-ID ETag for larger; conditional requests (If-Match/
  If-None-Match/If-Modified-Since); GetObjectAttributes/tagging stubs.

---

## 8. Known limitations (document in README)

- Uploads >100 MB only via multipart (each part ≤100 MB); single PUT capped at 100 MB.
- ETag = Drive file ID, not MD5 (except P2 small-object MD5) → `rclone check` re-downloads.
- Drive rate limit 400 req/100 s → folder cache is essential; large listings are slow.
- Free plan: 10 ms CPU (streaming keeps us under), 50 subrequests/req, 100k req/day.
- Drive ToS: personal use, no illegal content (same stance as reference).
- Multi-user: anyone with `SECRET_KEY` reaches all allowed buckets.

---

## 9. Decisions

Confirmed defaults (flaggable):
1. **Overwrite:** upload-then-delete-old (reads stay alive; brief duplicate window).
2. **Delete:** move-to-trash (`update {trashed:true}`) — safer for a personal Drive.
3. **ACCESS_KEY binding:** signature-only like reference + entropy guidance for `SECRET_KEY`.
4. **ListObjects:** implement both V1 and V2 (shared code path; s3cmd needs V1).
5. **Multipart:** implement in P0 (only way around the 100 MB cap; rclone needs it).
6. **MD5 ETag for small objects:** P2 (improves `rclone check` UX).
7. **Virtual-hosted-style buckets:** skip — path-style only.
