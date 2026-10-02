import { defineConfig } from 'nitro'

export default defineConfig({
  preset: 'cloudflare_module',
  compatibilityDate: '2026-08-05',
  serverDir: './server',
  serverEntry: './server/index.ts',
  cloudflare: {
    wrangler: {
      name: 'gdrive-s3',
      account_id: '6e1f4d1b132725bb434cad679004ccb3',
      kv_namespaces: [
        { binding: 'AUTH_KV', id: '20d3356495224a658e481b8d8ff407b5' },
        { binding: 'FOLDER_CACHE', id: '1fc672eb19da4028b2ef35dcb2bf273a' },
      ],
      vars: {},
      observability: {
        enabled: true,
        head_sampling_rate: 1,
      },
    },
  },
})
