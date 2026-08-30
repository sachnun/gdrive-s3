export interface Env {
  /** AWS-style access key id (bound to a single secret key, like the reference). */
  ACCESS_KEY: string
  /** AWS-style secret access key (entropy guidance: use a long random string). */
  SECRET_KEY: string
  /** Region returned by GetBucketLocation. Signature scope accepts any region. */
  REGION: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GOOGLE_REFRESH_TOKEN: string
  /**
   * Optional: service accounts replacing GOOGLE_REFRESH_TOKEN auth. Raw
   * concatenated service-account JSON blobs (rclone service_account_file
   * format) or a JSON array. May also be stored in AUTH_KV under the key
   * "service_accounts" (KV values hold up to 25 MB, secrets only 5 KB).
   */
  GOOGLE_SERVICE_ACCOUNTS?: string
  /** Comma-separated list of bucket names allowed on this worker. */
  ALLOWED_BUCKETS: string
  /** Optional: comma-separated buckets whose GET/HEAD skip signature verification. */
  PUBLIC_READ_BUCKETS?: string
  /** Optional: edge-cache TTL in seconds for public-read object GETs (default 300). */
  PUBLIC_CACHE_TTL?: string
  /** KV namespace caching the Drive OAuth access token. */
  AUTH_KV: KVNamespace
  /** KV namespace caching Drive folder IDs (and multipart session state). */
  FOLDER_CACHE: KVNamespace
  /**
   * `round-robin` (default) or `union`. Union merges multiple service accounts
   * into one logical namespace (rclone-union semantics, SA-only).
   */
  UNION_MODE?: string
  /** Union SEARCH policy (default `ff`). */
  UNION_SEARCH_POLICY?: string
  /** Union ACTION policy (default `epall`). */
  UNION_ACTION_POLICY?: string
  /** Union CREATE policy (default `epmfs`). */
  UNION_CREATE_POLICY?: string
  /** Union quota/path-memo KV TTL in seconds (default 120). */
  UNION_CACHE_TIME?: string
  /** Union min free space (bytes) for lfs/eplfs filters (default 1 GiB). */
  UNION_MIN_FREE_SPACE?: string
  /** Hard safety cap on the SA fan-out (default 16). */
  UNION_MAX_UPSTREAMS?: string
  /**
   * Shared Drive id. Service accounts cannot upload to their own My Drive
   * (no storage quota) — with a shared drive set, all SA roots resolve to the
   * shared drive root and every call uses supportsAllDrives/team-drive semantics.
   */
  SHARED_DRIVE_ID?: string
}
