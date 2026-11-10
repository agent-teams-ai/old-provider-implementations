export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
// /global/health does not initialize the directory-scoped native instance.
// Give the first scoped request the same budget as native host startup.
export const OPEN_CODE_INSTANCE_INITIALIZATION_TIMEOUT_MS = 30_000
export const MCP_REQUEST_TIMEOUT_MS = 35_000
export const PERMISSION_REQUEST_TIMEOUT_MS = 2_500
export const MESSAGE_REQUEST_TIMEOUT_MS = 120_000
export const PROVIDER_OAUTH_AUTHORIZE_TIMEOUT_MS = 30_000
// GitHub device authorization codes can remain valid for up to 15 minutes.
// Keep the transport alive slightly longer so Agent Teams does not abort a
// still-valid browser flow before the provider finishes polling.
export const PROVIDER_OAUTH_CALLBACK_TIMEOUT_MS = 16 * 60_000
