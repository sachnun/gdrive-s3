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
  /** Comma-separated list of bucket names allowed on this worker. */
  ALLOWED_BUCKETS: string
  /** Optional: comma-separated buckets whose GET/HEAD skip signature verification. */
  PUBLIC_READ_BUCKETS?: string
  /** KV namespace caching the Drive OAuth access token. */
  AUTH_KV: KVNamespace
  /** KV namespace caching Drive folder IDs (and multipart session state). */
  FOLDER_CACHE: KVNamespace
}
