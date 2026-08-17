/** Context7 verification cache TTL (syncs are session-spaced; 5min meant nearly every sync re-ran the npx smoke check, ~1.4s) */
export const CONTEXT7_VERIFY_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Session idle timeout before auto-expire */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

/** AI provider CLI spawn timeout */
export const PROVIDER_SPAWN_TIMEOUT_MS = 2000 // 2 seconds
