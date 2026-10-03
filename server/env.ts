export interface Env {
  ACCESS_KEY: string
  SECRET_KEY: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GOOGLE_REFRESH_TOKEN: string
  GOOGLE_SERVICE_ACCOUNTS?: string
  AUTH_KV: KVNamespace
  FOLDER_CACHE: KVNamespace
}
