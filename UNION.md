# Plan: Union of Google Drive service accounts (rclone-union semantics)

Reverses `rclone backend/union` (v1.75) and maps it onto gdrive-s3's S3 layer.
Scope: **service accounts only**. One service account = one upstream. The OAuth
refresh-token path stays on the single-account model (`UNION_MODE` unset).

Reference mechanics extracted from source:

| rclone union concept | Where | Behavior |
|---|---|---|
| 3 policy categories | `policy/policy.go` | `Action` (modify existing), `Create` (new files/dirs), `Search` (read lookup) |
| `filterRO` / `filterNC` | `policy/policy.go` | ACTION drops `:ro`; CREATE drops `:nc` upstreams |
| path-exists check | `policy/policy.go findEntry` | `List(parent dir)` + exact name match; `ep*` policies use it, plain policies don't |
| candidate set | `union.go NewObject/List`, `entry.go` | entry present in >1 upstream keeps all upstream copies; SEARCH picks the winner, ACTION picks which to modify |
| Put flow | `union.go Put` | new → CREATE policy + recursive parent `mkdir`; existing → `Update` via ACTION |
| create `epall` mirror | `union.go put` `multiReader` | request body tee'd to all selected upstreams |
| usage cache | `upstream/upstream.go` | quota (`About`/free space) cached `cache_time` (default 120 s) |
| upstream flags | `upstream/upstream.go New` | `:ro` read-only, `:nc` no-create, `:writeback` |
| registered policies | `policy/*.go` | `all, epall, epff, eplfs, eplno, eplus, epmfs, eprand, ff, lfs, lno, lus, mfs, newest, rand` |
| defaults | `union.go` options | search `ff`, action `epall`, create `epmfs`, `min_free_space` 1 Gi |

---

## 1. Model

- `UNION_MODE` env (default `round-robin`, current behavior) or `union`.
- Union active only when `UNION_MODE=union` **and** `GOOGLE_SERVICE_ACCOUNTS` is set.
  Misconfig (union mode without SAs, or with `GOOGLE_REFRESH_TOKEN`) → deploy-time/startup error.
- Each service account = one upstream, ordered by the SA list (index 0 = first).
- A bucket exists in **every** upstream as a root folder of that SA's Drive (create policy decides
  which upstreams actually get it; search dedupes by name).
- **Determinism over speed**: SEARCH resolves all upstreams (bounded parallel) and picks the
  lowest index that has the path — unlike rclone's `epff` first-responder race, S3 clients
  re-request the same key and must get the same object. `ff` = strict upstream order.

### Upstream descriptor

```ts
interface Upstream {
  index: number
  sa: ServiceAccount
  writable: boolean   // default true  (":ro"  → writable=false, creatable=false)
  creatable: boolean  // default true  (":nc"  → creatable=false)
}
```

Flags come from optional `writable`/`creatable` fields on each SA JSON entry
(keeps config in one payload; no new secrets needed). ServiceAccount type extended in
`auth.ts` with defaults `true`.

## 2. Config surface (`env.ts`)

| Var | Default | Meaning |
|---|---|---|
| `UNION_MODE` | `round-robin` | `union` enables the feature (SA-only) |
| `UNION_SEARCH_POLICY` | `ff` | search category |
| `UNION_ACTION_POLICY` | `epall` | action category |
| `UNION_CREATE_POLICY` | `epmfs` | create category |
| `UNION_CACHE_TIME` | `120` | quota + path-resolution KV TTL (s) |
| `UNION_MIN_FREE_SPACE` | `1073741824` | lfs/eplfs filter (bytes) |
| `UNION_MAX_UPSTREAMS` | `16` | hard safety cap on SA fan-out |

Supported policy names (validated at startup, unknown → error):
search `ff epff epmfs eplus eprand newest epall`; action `epall epff epmfs eplus eprand`;
create `epmfs epall epro(rand) ff eplus eplfs`. Unlisted rclone policies are out of scope.

## 3. Auth plumbing (`drive/auth.ts`)

- `driveFetch(env, url, init, opts?: { sa?: ServiceAccount, saIndex?: number })` — when
  pinned, use that SA's token (`sa_token:<clientEmail>` KV/memo cache, already exists) and
  401-retry only that SA's token, never `TOKEN_KEY` (refresh-token path is prohibited in
  union mode).
- `getSaToken(env, sa)` extracted from current `getServiceAccountToken` so a request can pin
  one SA or fan out to several.
- `loadServiceAccounts(env)` stays; `parseServiceAccounts` extended for
  `writable`/`creatable` fields. Round-robin counter is only used in `round-robin` mode.

## 4. KV keys

| Key | TTL | Purpose |
|---|---|---|
| `folder:<parentId>:<name>` | 1 h | unchanged for interior nodes — Drive file IDs are globally unique, so parentId already scopes to an SA |
| `folder:sa:<email>:root:<name>` | 1 h | SA-scoped root lookup (`'root' in parents` resolves to whichever account the token belongs to) |
| `path:<bucket>:<key>` | `UNION_CACHE_TIME` | cache of SEARCH winner `{saIndex, fileId}` — prevents N-way fan-out on every HEAD/GET |
| `quota:<email>` | `UNION_CACHE_TIME` | `about?fields=storageQuota` per SA: `{limit, usage}` |
| `mp:<uploadId>` | — | multipart session state gains `saIndex` (target) |
| `sa_token:<email>` | token expiry | unchanged |

`path:<bucket>:<key>` is invalidated on any write to that key (PUT/DELETE/Complete) and on
404 re-resolution.

## 5. Policy engine (`drive/union/policy.ts`)

```ts
interface Policy {
  search(upstreams, exists: (u) => Promise<boolean|null>): Promise<number|null>   // winner index
  action(upstreams, exists): Promise<number[]>          // modify set (writable only)
  create(upstreams, parentExists): Promise<number[]>    // write set (creatable only); ep* checks parent, plain doesn't
}
```

- `exists` for ep* policies: folder-walk per SA using SA-scoped folder cache (search) or
  parent path walk (create). For create on `path`, rclone checks `path + "/.."` — flat keys
  always have parent "" = root = exists.
- `epmfs`/`eplus`/`eplfs` resolve through quota cache (`quota:<email>`), `eprand` picks
  random among existing, `newest` picks largest `modifiedTime` (drives one extra metadata
  fetch per candidate).
- `filterRO`/`filterNC` mirrors rclone.
- Missing free-space info (Drive `about` unsupported/rate-limited) → treated as infinite
  (rclone: `fs.LogPrintf` + sentinel `math.MaxInt64-1`). If ALL upstreams lack it, search
  falls back to lowest index.

## 6. Per-S3-op behavior

| Op | Union behavior |
|---|---|
| ListBuckets | merge root folders of all upstreams (SA-scoped root lookup, bounded parallel), dedupe by name, min index wins |
| HeadBucket | exists iff SEARCH finds the bucket folder in ≥1 upstream |
| CreateBucket | CREATE policy → create root folder in each selected upstream (S3 naming validation kept) |
| DeleteBucket | ACTION policy → trash bucket folder in every upstream that has it |
| ListObjects V1/V2 | k-way merged walk, see §7 |
| PUT (new) | CREATE policy → `resolvePathCreate` per selected upstream; `epall` = tee body into N resumable sessions (small bodies: duplicate the buffered `Uint8Array`), then overwrite-cleanup per upstream |
| PUT (overwrite) | `NewObject` first (SEARCH) → exists: Update = per selected-ACTION-upstream upload-new + trash-old (mirror refresh under `epall`); not-exists: create flow |
| HEAD/GET (incl. Range) | SEARCH winner → stream from that SA; edge-cache key unchanged |
| DELETE | ACTION policy → trash in every upstream that has the key (epall default = delete everywhere, matches rclone) |
| DeleteObjects | same per key, `mapLimit` concurrency kept |
| CopyObject | dest = CREATE policy; same upstream → `files.copy` server-side; cross-upstream → download + resumable upload stream (documented 2× bandwidth) |
| Multipart | §8 |
| GetBucketLocation / HEAD | unchanged (REGION) |

Errors: SEARCH empty → `NoSuchKey`; no creatable upstream → `AccessDenied`; union misconfig
→ startup error, never per-request 500.

## 7. ListObjects merge (`s3/list.ts`)

Rewrite the single-SD walk into a k-way merge over upstreams:

- Per upstream, reuse the existing grid-walk (`dirId, dirKey, pageToken, queue, tail`).
- Continuation token stores the per-upstream `ListState[]` (N × ~200 B base64 — fine in an
  S3 token; ~3–4 KB at `UNION_MAX_UPSTREAMS=16`).
- Merge: advance the cursor with the smallest key across upstreams; a key present in several
  upstreams emits **one** entry using the SEARCH winner's metadata (must match subsequent
  HEAD/GET semantics: winners agree). CommonPrefixes aggregated the same way.
- Bound concurrency to 4 simultaneous upstream page fetches; `maxKeys` semantics preserved.
- Drive page size stays 1000 per upstream; `nextPageToken` per upstream carried in token.

## 8. Multipart (`drive/multipart.ts`)

- `CreateMultipartUpload` → resolve CREATE policy targets; sessions bind to exactly one
  **primary** upstream (lowest-index selected) to keep part storage single-copy. Session
  state records `saIndex` + policy targets.
- `UploadPart` → parts into the primary upstream's temp folder (unchanged mechanics).
- `CompleteMultipartUpload` → stream-concat parts (from primary) into final key on each
  CREATE-policy target (`epall` = N final objects, matching rclone's tee-on-Put semantics);
  trash temp folder.
- `Abort` / lazy GC unchanged.

## 9. File structure

```
src/
  drive/
    union/
      config.ts    # parse UNION_* envs, build Upstream[], validate SA-only, cap MAX_UPSTREAMS
      policy.ts    # registry + engines (search/action/create), filters, quota lookup
      quota.ts     # about() per SA, KV+memo cache, min-free-space filter
      resolve.ts   # per-SA folder walks (search/parent-exists/create), KV path memo
    auth.ts        # driveFetch pinned-SA option, getSaToken, writable/creatable fields
    folder.ts      # SA-scoped root cache keys
    files.ts       # accept explicit saIndex in upload/download/trash/copy
    multipart.ts   # saIndex + create-targets in session state
  s3/
    list.ts        # k-way merge, token with per-upstream state
  index.ts         # wire union.resolve into bucket/object handlers
  env.ts           # UNION_* vars
```

## 10. Phases

| Phase | Content | Done when |
|---|---|---|
| 0 | env vars + `union/config.ts` + pinned-SA `driveFetch`/`getSaToken`; `parseServiceAccounts` flags | unit tests: config validation, token pinning (mocked fetch), round-robin mode unaffected |
| 1 | `quota.ts` + `policy.ts` engine (ff/epff/epall/epmfs/eplus/eprand; filterRO/NC; quota cache; min-free-space fallback) | unit tests: policy matrices (exists-set, parents, quota ordering, no-quota fallback) |
| 2 | `resolve.ts` + SA-scoped folder cache; SEARCH wired into HEAD/GET/DELETE via `path:<bucket>:<key>` memo | tests: 2-SA harness, key present in SA1 only / both / SA0 only |
| 3 | PUT (new + overwrite) + CopyObject under CREATE/ACTION; epall tee upload | e2e: epmfs put lands on one SA, epall mirrors to all, overwrite refreshes all ACTION targets |
| 4 | ListObjects k-way merge + token | e2e: 2 SAs, overlapped prefixes, delimiter, pagination resume |
| 5 | multipart targets + bucket ops (List/Head/Create/Delete) + DeleteObjects | e2e multipart across 2 SAs; DeleteBucket trashes all copies |
| 6 | README/docs, `UNION_MAX_UPSTREAMS` cap check, deploy | config doc + limits (below) |

Test harness (`test/harness.ts`) gains mock-Drive fetch keyed per SA email so e2e tests run
two service accounts without real credentials — same mocking style as today, but the fake
`driveFetch` now routes on the pinned SA.

## 11. Limits & tradeoffs (document in README)

- Fan-out: SEARCH = N parallel folder walks (bounded 4), ListObjects = N page fetches/page,
  ACTION epall = N writes. `UNION_MAX_UPSTREAMS=16` (drive safety cap with the 50-subrequest
  budget; practical N ≤ 10 for snappy listing).
- epall CREATE mirrors storage: N× quota use and N× upload bandwidth (true RAID-1; that is
  the point when quota per SA is the constraint).
- ETag = winner SA's Drive file ID; changes if placement moves (ff/epmfs) — same caveat as
  single-account mode (no MD5).
- DELETE epall is irreversible per SA (trash), consistent with single-account behavior.
- No per-upstream root sub-path (rclone `remote:path`) in v1 — every SA contributes its
  bucket folder at its own Drive root.
- Rate limits legitimately multiply with N SAs; folder + path + quota KV caching keeps
  requests low.