/**
 * Update Checker — owns the "is a newer prjct published?" question.
 *
 * Single source of truth for the upgrade-available signal. The DAEMON calls
 * `refreshUpdateStatus(installedVersion)` (on startup + hourly) because it is
 * the one process that reliably knows the installed version; it writes a small
 * global flag file that cheap readers (the Claude statusline, scripts) can
 * consult WITHOUT doing any version comparison themselves.
 *
 * Design notes:
 * - The npm-registry fetch is throttled to 1/hour (network is the expensive
 *   part). `updateAvailable` is recomputed against the CURRENT installed
 *   version on every call, so the moment the CLI is upgraded the flag clears
 *   even if the cached `latest` is reused — no stale "upgrade available" nag.
 * - The flag is GLOBAL (version is global), not project-scoped. It lives under
 *   the CLI state dir alongside the auto-updater log.
 * - Everything is best-effort: a missing file, offline registry, or parse
 *   error simply means "no signal" (statusline shows branding), never a crash.
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveCliHome } from '../infrastructure/cli-home'
import { compareSemver } from '../schemas/model'

const NPM_REGISTRY = 'https://registry.npmjs.org/prjct-cli/latest'
const FETCH_THROTTLE_MS = 60 * 60 * 1000 // 1 hour between registry hits

const stateDir = (): string => path.join(resolveCliHome(), 'state')
const statusPath = (): string => path.join(stateDir(), 'update-status.json')

export interface UpdateStatus {
  /** Version of the running CLI when last checked. */
  installed: string
  /** Latest version published to npm, or null if never successfully fetched. */
  latest: string | null
  /** True when `latest` is strictly newer than `installed`. */
  updateAvailable: boolean
  /** ISO timestamp of the last refresh. */
  checkedAt: string
}

/** Read the persisted update status, or null if absent/unreadable. */
export function readUpdateStatus(): UpdateStatus | null {
  try {
    const raw = fs.readFileSync(statusPath(), 'utf-8')
    const parsed = JSON.parse(raw) as UpdateStatus
    if (typeof parsed.installed !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Refresh and persist the update status for `installedVersion`.
 *
 * Reuses the cached `latest` when the registry was hit < 1h ago, but always
 * recomputes `updateAvailable` against `installedVersion` so an upgrade is
 * reflected immediately. Returns the written status (or a no-network fallback).
 */
export async function refreshUpdateStatus(installedVersion: string): Promise<UpdateStatus | null> {
  if (!installedVersion) return null

  const prev = readUpdateStatus()
  const fetchedRecently =
    prev?.checkedAt && Date.now() - Date.parse(prev.checkedAt) < FETCH_THROTTLE_MS
  const latest = fetchedRecently
    ? (prev?.latest ?? null)
    : ((await fetchLatestVersion()) ?? prev?.latest ?? null)

  const updateAvailable = latest != null && compareSemver(latest, installedVersion) > 0
  const status: UpdateStatus = {
    installed: installedVersion,
    latest,
    updateAvailable,
    checkedAt: new Date().toISOString(),
  }

  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(statusPath(), `${JSON.stringify(status, null, 2)}\n`)
  } catch {
    /* best-effort: failing to persist must never break the caller */
  }

  return status
}

/** Fetch the latest published version from the npm registry, or null on failure. */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    // 6s timeout — the registry answers fast or not at all.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 6000)
    const res = await fetch(NPM_REGISTRY, { signal: ac.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const json = (await res.json()) as { version?: string }
    return typeof json.version === 'string' ? json.version : null
  } catch {
    return null
  }
}
