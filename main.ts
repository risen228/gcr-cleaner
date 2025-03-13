/* eslint-disable no-undef */

import 'zx/globals'
import { ArtifactRegistryClient } from '@google-cloud/artifact-registry'
import semver from 'semver'

const REQUESTS_PER_MINUTE = 30
const GCLOUD_PROJECT_ID = process.env.GCLOUD_PROJECT_ID
const GCLOUD_REGISTRY_REGION = process.env.GCLOUD_REGISTRY_REGION
const GCLOUD_REGISTRY_REPOSITORY = process.env.GCLOUD_REGISTRY_REPOSITORY
const GCLOUD_SERVICE_ACCOUNT_KEY = process.env.GCLOUD_SERVICE_ACCOUNT_KEY

if (
  !GCLOUD_PROJECT_ID ||
  !GCLOUD_REGISTRY_REGION ||
  !GCLOUD_REGISTRY_REPOSITORY ||
  !GCLOUD_SERVICE_ACCOUNT_KEY
) {
  throw new Error('Missing environment variables')
}

const AUTH_KEYS = JSON.parse(GCLOUD_SERVICE_ACCOUNT_KEY)

const client = new ArtifactRegistryClient({
  credentials: AUTH_KEYS,
})

const [images] = await client.listDockerImages({
  parent: `projects/${GCLOUD_PROJECT_ID}/locations/${GCLOUD_REGISTRY_REGION}/repositories/${GCLOUD_REGISTRY_REPOSITORY}`,
})

const entries = []
const hourAgo = new Date(Date.now() - 60 * 60 * 1000)

for (const tag of images) {
  if (!tag) continue
  if (!tag.uri) continue
  if (!tag.uploadTime) continue
  if (!tag.tags) continue

  const path = tag.uri.split('@')[0]
  if (!path) continue

  const uploadedAt = new Date(Number(tag.uploadTime.seconds) * 1000)

  const isLatest = tag.tags.includes('latest')
  const hasVersion = tag.tags.some((tag) => Boolean(semver.valid(tag)))
  const isDev = tag.tags.some((tag) => tag.startsWith('dev-'))

  entries.push({
    path,
    name: tag.name,
    url: tag.uri,
    uploadedAt,
    tags: tag.tags,
    hasVersion,
    isLatest,
    isDev,
  })
}

if (entries.length === 0) {
  console.info('No images to delete')
  process.exit(0)
}

console.info(`Found ${entries.length} images to delete`)

/*
 * Recently uploaded images first
 */
entries.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())

const exceptions = new Set()

const semverCountByPath: Record<string, number> = {}
const devCountByPath: Record<string, number> = {}

for (const entry of entries) {
  console.info(`Processing ${entry.url}`)
  console.info(`Path: ${entry.path}`)

  const reasons = []

  /*
   * Always keep the latest image
   */
  if (entry.isLatest) {
    exceptions.add(entry)
    reasons.push('latest')
  }

  /**
   * Keep recently uploaded images
   */
  if (entry.uploadedAt > hourAgo) {
    exceptions.add(entry)
    reasons.push('recently uploaded')
  }

  const semverCount = semverCountByPath[entry.path] || 0
  const devCount = devCountByPath[entry.path] || 0

  /*
   * Keep the latest 2 semver tags of each image
   */
  if (semverCount < 2) {
    semverCountByPath[entry.path] = semverCount + 1
    exceptions.add(entry)
    reasons.push('semver')
  }

  /*
   * Keep the latest 2 dev tags of each image
   */
  if (devCount < 2) {
    devCountByPath[entry.path] = devCount + 1
    exceptions.add(entry)
    reasons.push('dev')
  }

  if (reasons.length > 0) {
    console.info(`Skipping (${reasons.join(', ')})`)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let triesCount = 0
let successCount = 0

function getVersionNameFromUrl(url: string) {
  const [path, digest] = url.split('@') as [string, string]
  const pathParts = path.split('/')
  const packageNameParts = pathParts.slice(3).join('%2F')
  const versionName = `projects/${GCLOUD_PROJECT_ID}/locations/${GCLOUD_REGISTRY_REGION}/repositories/${GCLOUD_REGISTRY_REPOSITORY}/packages/${packageNameParts}/versions/${digest}`
  return versionName
}

for (const entry of entries) {
  if (exceptions.has(entry)) continue

  triesCount += 1

  try {
    await client.deleteVersion({
      name: getVersionNameFromUrl(entry.url),
      force: true,
    })

    successCount += 1
  } catch (error) {
    console.info(`Failed to delete ${entry.url}`, error)
  }

  await sleep((60 / REQUESTS_PER_MINUTE) * 1000)
}

if (triesCount > 0 && successCount === 0) {
  console.error('No images deleted successfully')
  process.exit(1)
}

// Exit with success
process.exit(0)
