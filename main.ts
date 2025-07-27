/* eslint-disable no-undef */
// node --loader ts-node/esm cleanup.ts (or transpile with tsc)
// ENV:
//   GCLOUD_PROJECT_ID, GCLOUD_REGISTRY_REGION, GCLOUD_REGISTRY_REPOSITORY, GCLOUD_SERVICE_ACCOUNT_KEY
//   CLEANUP_RULES_JSON - JSON array of rules (see examples at bottom)
//
// The script keeps images that match ANY rule. Overlaps are fine: a single image may satisfy several rules.
// Everything else is deleted.

import 'zx/globals'
import { ArtifactRegistryClient } from '@google-cloud/artifact-registry'
import semver from 'semver'

/** ============= CONFIG ============= */
const REQUESTS_PER_MINUTE = Number(process.env.REQUESTS_PER_MINUTE ?? 30)
const GCLOUD_PROJECT_ID = process.env.GCLOUD_PROJECT_ID
const GCLOUD_REGISTRY_REGION = process.env.GCLOUD_REGISTRY_REGION
const GCLOUD_REGISTRY_REPOSITORY = process.env.GCLOUD_REGISTRY_REPOSITORY
const GCLOUD_SERVICE_ACCOUNT_KEY = process.env.GCLOUD_SERVICE_ACCOUNT_KEY
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'

// Rule schema ---------------------------------------------------------------
// Minimalistic runtime typing w/out bringing zod. Adjust if needed.

type RuleLatest = { type: 'latest' }

type RuleSemver = {
  type: 'semver'
  keep: number // how many images to keep per path
  includePrerelease?: boolean // default false
  prerelease?: string | null // e.g. 'beta' to filter only 1.2.3-beta.4; null = only stable
}

type RulePrefixTimestamp = {
  type: 'prefixTimestamp'
  prefix: string // e.g. 'dev-'
  regex?: string // optional custom regex with 1st capturing group as number, default'^dev-(\\d+)$'
  keep: number
}

type RuleRecent = {
  type: 'recent'
  ms: number // keep anything newer than now - ms
}

type CleanupRule = RuleLatest | RuleSemver | RulePrefixTimestamp | RuleRecent

function parseRules(): CleanupRule[] {
  const raw = process.env.CLEANUP_RULES_JSON

  if (!raw) {
    return [
      { type: 'latest' },
      { type: 'prefixTimestamp', prefix: 'dev-', keep: 2 },
      { type: 'semver', keep: 2, includePrerelease: false },
    ]
  }

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('Rules must be an array')
    return parsed as CleanupRule[]
  } catch (e) {
    console.error('Failed to parse CLEANUP_RULES_JSON:', e)
    process.exit(1)
  }
}

const RULES = parseRules()

/** ============= GCLOUD CLIENT ============= */
if (
  !GCLOUD_PROJECT_ID ||
  !GCLOUD_REGISTRY_REGION ||
  !GCLOUD_REGISTRY_REPOSITORY
) {
  throw new Error('Missing environment variables')
}

const client = new ArtifactRegistryClient({
  credentials: GCLOUD_SERVICE_ACCOUNT_KEY
    ? JSON.parse(GCLOUD_SERVICE_ACCOUNT_KEY)
    : undefined,
})

/** ============= LOAD IMAGES ============= */
const [images] = await client.listDockerImages({
  parent: `projects/${GCLOUD_PROJECT_ID}/locations/${GCLOUD_REGISTRY_REGION}/repositories/${GCLOUD_REGISTRY_REPOSITORY}`,
})

if (!images || images.length === 0) {
  console.info('No images found')
  process.exit(0)
}

/** Normalized entry type */
interface Entry {
  path: string
  name: string
  url: string
  uploadedAt: Date
  tags: string[]
  isLatest: boolean
  semverTags: string[] // valid semver tags
  devTimestamp?: number // largest timestamp extracted from dev-like tags (optional)
}

const entries: Entry[] = []

for (const tag of images) {
  if (!tag?.uri || !tag.uploadTime || !tag.tags) continue

  const path = tag.uri.split('@')[0]
  if (!path) continue

  const uploadedAt = new Date(Number(tag.uploadTime.seconds) * 1000)
  const isLatest = tag.tags.includes('latest')

  const semverTags = tag.tags.filter((t) => Boolean(semver.valid(t)))

  entries.push({
    path,
    name: tag.name!,
    url: tag.uri,
    uploadedAt,
    tags: tag.tags,
    isLatest,
    semverTags,
  })
}

if (entries.length === 0) {
  console.info('No images to delete')
  process.exit(0)
}

// sort newest first (used for some fallbacks)
entries.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())

/** ============= APPLY RULES ============= */
const keep = new Set<Entry>()

// Group by path so that counts apply per-image-path
const byPath = entries.reduce<Record<string, Entry[]>>((acc, e) => {
  ;(acc[e.path] ||= []).push(e)
  return acc
}, {})

// Helper: mark top N by comparator
function markTopN<T>(arr: T[], n: number, getEntry: (t: T) => Entry) {
  for (let i = 0; i < Math.min(n, arr.length); i++) keep.add(getEntry(arr[i]!))
}

for (const rule of RULES) {
  switch (rule.type) {
    case 'latest': {
      for (const e of entries) if (e.isLatest) keep.add(e)
      break
    }

    case 'recent': {
      const threshold = Date.now() - rule.ms
      for (const e of entries)
        if (e.uploadedAt.getTime() >= threshold) keep.add(e)
      break
    }

    case 'semver': {
      for (const path in byPath) {
        const group = byPath[path]!
        const filtered = group
          .map((e) => {
            // pick the best semver tag of this entry under the filter
            const tags = e.semverTags.filter((t) => {
              if (rule.prerelease != null) {
                const p = semver.prerelease(t)
                return Array.isArray(p) && p[0] === rule.prerelease
              }
              if (rule.includePrerelease) return true
              return !semver.prerelease(t)
            })
            if (tags.length === 0) return null
            // choose highest semver in this entry
            const best = tags.sort(semver.rcompare)[0]
            return { entry: e, best }
          })
          .filter(Boolean) as { entry: Entry; best: string }[]

        filtered.sort((a, b) => semver.rcompare(a.best, b.best))
        markTopN(filtered, rule.keep, (t) => t.entry)
      }
      break
    }

    case 'prefixTimestamp': {
      const rx = new RegExp(
        rule.regex ??
          `^${rule.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`,
      )

      for (const path in byPath) {
        const group = byPath[path]!
        const devs: { entry: Entry; ts: number }[] = []

        for (const e of group) {
          for (const t of e.tags) {
            const m = rx.exec(t)
            if (m) {
              const ts = Number(m[1])
              if (!Number.isNaN(ts)) devs.push({ entry: e, ts })
            }
          }
        }

        // Sort by timestamp desc, but if same entry appears many times just keep once
        devs.sort((a, b) => b.ts - a.ts)

        const picked: Entry[] = []
        for (const d of devs) {
          if (picked.includes(d.entry)) continue
          picked.push(d.entry)
          if (picked.length >= rule.keep) break
        }

        for (const e of picked) keep.add(e)
      }
      break
    }

    default:
      console.warn('Unknown rule:', rule)
  }
}

/** ============= DELETE ============= */
if (keep.size === entries.length) {
  console.info('Nothing to delete (all kept by rules)')
  process.exit(0)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let triesCount = 0
let successCount = 0

function getVersionNameFromUrl(url: string) {
  const [path, digest] = url.split('@') as [string, string]
  const pathParts = path.split('/')
  const packageNameParts = pathParts.slice(3).join('%2F')
  return `projects/${GCLOUD_PROJECT_ID}/locations/${GCLOUD_REGISTRY_REGION}/repositories/${GCLOUD_REGISTRY_REPOSITORY}/packages/${packageNameParts}/versions/${digest}`
}

for (const entry of entries) {
  if (keep.has(entry)) continue

  triesCount += 1

  if (DRY_RUN) {
    console.info('[DRY-RUN] Would delete', entry.url)
    continue
  }

  try {
    await client.deleteVersion({
      name: getVersionNameFromUrl(entry.url),
      force: true,
    })
    successCount += 1
    console.info('Deleted', entry.url)
  } catch (error) {
    console.info(`Failed to delete ${entry.url}`, error)
  }

  await sleep((60 / REQUESTS_PER_MINUTE) * 1000)
}

if (!DRY_RUN && triesCount > 0 && successCount === 0) {
  console.error('No images deleted successfully')
  process.exit(1)
}

process.exit(0)

/* ================== EXAMPLES ==================

export CLEANUP_RULES_JSON='[
  {"type":"latest"},
  {"type":"prefixTimestamp","prefix":"dev-","keep":2},
  {"type":"semver","keep":2,"includePrerelease":false},
  {"type":"semver","keep":2,"prerelease":"beta"}
]'

# Keep latest, 3 most recent builds (last 24h), and 5 rc prereleases
export CLEANUP_RULES_JSON='[
  {"type":"latest"},
  {"type":"recent","ms":86400000},
  {"type":"semver","keep":5,"prerelease":"rc"}
]'

*/
