/**
 * Console-based logger for Cloudflare Workers.
 * Logs are visible via `wrangler tail`.
 */

export function logError(...args) {
  console.error(...args);
}

export function logWarn(...args) {
  console.warn(...args);
}

export function logInfo(...args) {
  console.log(...args);
}
