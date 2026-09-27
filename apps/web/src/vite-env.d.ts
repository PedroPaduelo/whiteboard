/// <reference types="vite/client" />

// Editor-only support for import.meta.env in the plain-JSX app. Harmless at
// runtime: the file is a .d.ts, so it is never emitted and never imported.

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
