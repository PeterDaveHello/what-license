import { mkdir, writeFile } from 'node:fs/promises'
import { SUPPORTED_LICENSE_IDS } from './supported-licenses.mjs'

const requestedSourceVersion =
  process.env.SPDX_LICENSE_LIST_VERSION || 'v3.28.0'
if (!/^v\d+\.\d+(?:\.\d+)?$/.test(requestedSourceVersion)) {
  throw new Error(
    'SPDX_LICENSE_LIST_VERSION must use a tag like v3.28.0 or v3.25, got ' +
      requestedSourceVersion,
  )
}
function sourceVersionFetchCandidates(sourceVersion) {
  const match = /^v(\d+\.\d+)(?:\.(\d+))?$/.exec(sourceVersion)
  if (!match) return [sourceVersion]
  const aliases = [sourceVersion]
  // Git tag fallback is strict: only vX.Y and vX.Y.0 are interchangeable.
  if (match[2] === undefined) {
    aliases.push('v' + match[1] + '.0')
  } else if (match[2] === '0') {
    aliases.push('v' + match[1])
  }
  return Array.from(new Set(aliases))
}

function sourceVersionMetadataAliases(sourceVersion) {
  const match = /^v(\d+\.\d+)(?:\.(\d+))?$/.exec(sourceVersion)
  if (!match) return [sourceVersion]
  const aliases = [sourceVersion]
  // SPDX JSON may report licenseListVersion as major.minor for patch tags.
  if (match[2] === undefined) {
    aliases.push('v' + match[1] + '.0')
  } else {
    aliases.push('v' + match[1])
  }
  return Array.from(new Set(aliases))
}

const sourceVersionCandidates = sourceVersionFetchCandidates(
  requestedSourceVersion,
)
const configuredFetchTimeoutMs = Number(process.env.SPDX_FETCH_TIMEOUT_MS)
const fetchTimeoutMs =
  Number.isFinite(configuredFetchTimeoutMs) && configuredFetchTimeoutMs > 0
    ? configuredFetchTimeoutMs
    : 30000
const licenseDetailFetchConcurrency = 5

async function fetchJson(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      const error = new Error(
        response.status + ' ' + response.statusText + ': ' + url,
      )
      error.status = response.status
      throw error
    }
    return await response.json()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Timed out fetching SPDX data: ' + url, {
        cause: error,
      })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = []
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency)
    results.push(...(await Promise.all(batch.map(callback))))
  }
  return results
}

async function fetchSpdxJson(path) {
  let lastError
  for (const candidateSourceVersion of sourceVersionCandidates) {
    try {
      return {
        sourceVersion: candidateSourceVersion,
        data: await fetchJson(
          'https://raw.githubusercontent.com/spdx/license-list-data/' +
            candidateSourceVersion +
            path,
        ),
      }
    } catch (error) {
      lastError = error
      if (!(error instanceof Error) || error.status !== 404) {
        throw error
      }
    }
  }
  throw lastError || new Error('Unable to resolve SPDX source version')
}

const licenseListResult = await fetchSpdxJson('/json/licenses.json')
const exceptionListResult = await fetchSpdxJson('/json/exceptions.json')
const sourceVersion = licenseListResult.sourceVersion
if (exceptionListResult.sourceVersion !== sourceVersion) {
  throw new Error(
    'SPDX license and exception source versions differ: ' +
      sourceVersion +
      ' vs ' +
      exceptionListResult.sourceVersion,
  )
}
const baseUrl =
  'https://raw.githubusercontent.com/spdx/license-list-data/' +
  sourceVersion +
  '/json/details'

function toEntry(detail, requestedLicenseId) {
  const label = requestedLicenseId || detail?.licenseId || 'unknown license'

  for (const key of ['licenseId', 'name', 'licenseText']) {
    if (typeof detail?.[key] !== 'string' || !detail[key].trim()) {
      throw new Error('Invalid SPDX detail for ' + label + ': missing ' + key)
    }
  }

  if (requestedLicenseId && detail.licenseId !== requestedLicenseId) {
    throw new Error(
      'Invalid SPDX detail for ' +
        label +
        ': expected licenseId ' +
        requestedLicenseId +
        ' but got ' +
        detail.licenseId,
    )
  }

  if (!Array.isArray(detail.seeAlso)) {
    throw new Error(
      'Invalid SPDX detail for ' + label + ': seeAlso must be an array',
    )
  }
  if (!detail.seeAlso.every((value) => typeof value === 'string')) {
    throw new Error(
      'Invalid SPDX detail for ' + label + ': seeAlso must contain strings',
    )
  }

  if (typeof detail.isOsiApproved !== 'boolean') {
    throw new Error(
      'Invalid SPDX detail for ' + label + ': isOsiApproved must be a boolean',
    )
  }

  if (
    detail.isFsfLibre !== undefined &&
    typeof detail.isFsfLibre !== 'boolean'
  ) {
    throw new Error(
      'Invalid SPDX detail for ' + label + ': isFsfLibre must be a boolean',
    )
  }

  if (typeof detail.isDeprecatedLicenseId !== 'boolean') {
    throw new Error(
      'Invalid SPDX detail for ' +
        label +
        ': isDeprecatedLicenseId must be a boolean',
    )
  }

  return {
    licenseId: detail.licenseId,
    name: detail.name,
    text: detail.licenseText,
    seeAlso: detail.seeAlso,
    isOsiApproved: detail.isOsiApproved,
    isFsfLibre: detail.isFsfLibre,
    isDeprecated: detail.isDeprecatedLicenseId,
    sourceVersion,
  }
}

function exceptionIdsFromList(data) {
  const acceptableSourceVersions = sourceVersionMetadataAliases(sourceVersion)
  if (
    typeof data?.licenseListVersion !== 'string' ||
    !acceptableSourceVersions.includes('v' + data.licenseListVersion)
  ) {
    throw new Error(
      'Invalid SPDX exceptions list: expected version ' +
        acceptableSourceVersions.join(' or ') +
        ' but got ' +
        (data?.licenseListVersion || 'unknown'),
    )
  }
  if (!Array.isArray(data.exceptions)) {
    throw new Error('Invalid SPDX exceptions list: exceptions must be an array')
  }

  const ids = data.exceptions.map((exception, index) => {
    const id = exception?.licenseExceptionId
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error(
        'Invalid SPDX exception at index ' + index + ': missing ID',
      )
    }
    return id
  })
  return Array.from(new Set(ids)).sort()
}

function licenseIdsFromList(data) {
  const acceptableSourceVersions = sourceVersionMetadataAliases(sourceVersion)
  if (
    typeof data?.licenseListVersion !== 'string' ||
    !acceptableSourceVersions.includes('v' + data.licenseListVersion)
  ) {
    throw new Error(
      'Invalid SPDX license list: expected version ' +
        acceptableSourceVersions.join(' or ') +
        ' but got ' +
        (data?.licenseListVersion || 'unknown'),
    )
  }
  if (!Array.isArray(data.licenses)) {
    throw new Error('Invalid SPDX license list: licenses must be an array')
  }

  const ids = data.licenses.map((license, index) => {
    const id = license?.licenseId
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('Invalid SPDX license at index ' + index + ': missing ID')
    }
    return id
  })
  return Array.from(new Set(ids)).sort()
}

const entries = await mapWithConcurrency(
  SUPPORTED_LICENSE_IDS,
  licenseDetailFetchConcurrency,
  async (licenseId) => {
    const detail = await fetchJson(baseUrl + '/' + licenseId + '.json')
    return toEntry(detail, licenseId)
  },
)
const licenseIds = licenseIdsFromList(licenseListResult.data)
const exceptionIds = exceptionIdsFromList(exceptionListResult.data)

await mkdir('src/data', { recursive: true })
const body =
  "import type { LicenseEntry } from './types'\n\n" +
  'export const spdxSourceVersion = ' +
  JSON.stringify(sourceVersion) +
  '\n\n' +
  'export const licenses: LicenseEntry[] = ' +
  JSON.stringify(entries, null, 2) +
  '\n'
await writeFile('src/data/licenses.generated.ts', body)
const licenseIdBody =
  'export const spdxLicenseIdSourceVersion = ' +
  JSON.stringify(sourceVersion) +
  '\n\n' +
  'export const spdxLicenseIds: string[] = ' +
  JSON.stringify(licenseIds, null, 2) +
  '\n'
await writeFile('src/data/spdx-license-ids.generated.ts', licenseIdBody)
const exceptionBody =
  'export const spdxExceptionSourceVersion = ' +
  JSON.stringify(sourceVersion) +
  '\n\n' +
  'export const spdxExceptionIds: string[] = ' +
  JSON.stringify(exceptionIds, null, 2) +
  '\n'
await writeFile('src/data/spdx-exceptions.generated.ts', exceptionBody)
console.log(
  'Generated ' +
    entries.length +
    ' supported licenses, ' +
    licenseIds.length +
    ' SPDX license IDs, and ' +
    exceptionIds.length +
    ' exceptions from SPDX ' +
    sourceVersion,
)
