/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CUMORA_API_BASE?: string
  readonly VITE_CUMORA_DEV_API_TARGET?: string
  readonly VITE_PUBLIC_POSTHOG_KEY?: string
  readonly VITE_PUBLIC_POSTHOG_HOST?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
