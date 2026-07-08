import { readFile } from 'node:fs/promises'
import { SUPPORTED_LICENSE_IDS } from './supported-licenses.mjs'

const source = await readFile('src/data/licenses.generated.ts', 'utf8')
const legacyAliasSource = await readFile('src/data/legacy-aliases.ts', 'utf8')
const licenseIdSource = await readFile(
  'src/data/spdx-license-ids.generated.ts',
  'utf8',
)
const exceptionSource = await readFile(
  'src/data/spdx-exceptions.generated.ts',
  'utf8',
)
const match = source.match(
  /export const licenses: LicenseEntry\[] = ([\s\S]+?)\s*$/,
)
if (!match) throw new Error('Unable to parse generated license data')
const sourceVersionMatch = source.match(
  /export const spdxSourceVersion = (["'])([^"']+)\1/,
)
if (!sourceVersionMatch)
  throw new Error('Unable to parse generated license source version')
const licenseIdVersionMatch = licenseIdSource.match(
  /export const spdxLicenseIdSourceVersion = (["'])([^"']+)\1/,
)
if (!licenseIdVersionMatch) {
  throw new Error('Unable to parse generated SPDX license ID source version')
}
const exceptionVersionMatch = exceptionSource.match(
  /export const spdxExceptionSourceVersion = (["'])([^"']+)\1/,
)
if (!exceptionVersionMatch) {
  throw new Error('Unable to parse generated exception source version')
}
const licenseIdMatch = licenseIdSource.match(
  /export const spdxLicenseIds: string\[] = ([\s\S]+?)\s*$/,
)
if (!licenseIdMatch) throw new Error('Unable to parse generated SPDX IDs')
const exceptionMatch = exceptionSource.match(
  /export const spdxExceptionIds: string\[] = ([\s\S]+?)\s*$/,
)
if (!exceptionMatch) throw new Error('Unable to parse generated exceptions')
let licenses
let licenseIds
let exceptionIds
const sourceVersion = sourceVersionMatch[2]
const licenseIdSourceVersion = licenseIdVersionMatch[2]
const exceptionSourceVersion = exceptionVersionMatch[2]
if (licenseIdSourceVersion !== sourceVersion) {
  throw new Error(
    'Generated SPDX license ID source version ' +
      licenseIdSourceVersion +
      ' does not match license source version ' +
      sourceVersion,
  )
}
if (exceptionSourceVersion !== sourceVersion) {
  throw new Error(
    'Generated exception source version ' +
      exceptionSourceVersion +
      ' does not match license source version ' +
      sourceVersion,
  )
}
try {
  licenses = JSON.parse(match[1])
  licenseIds = JSON.parse(licenseIdMatch[1])
  exceptionIds = JSON.parse(exceptionMatch[1])
} catch (error) {
  throw new Error(
    'Unable to parse generated data JSON: ' +
      (error instanceof Error ? error.message : String(error)),
    { cause: error },
  )
}
if (!Array.isArray(licenses))
  throw new Error('Generated license data must be an array')
if (!Array.isArray(licenseIds)) {
  throw new Error('Generated SPDX license IDs must be an array')
}
if (!Array.isArray(exceptionIds)) {
  throw new Error('Generated SPDX exception IDs must be an array')
}

const expectedIds = new Set(SUPPORTED_LICENSE_IDS)
const legacyIds = new Set(
  Array.from(
    legacyAliasSource.matchAll(/\blegacyId:\s*(['"])([^'"]+)\1/g),
    (match) => match[2],
  ),
)
if (legacyIds.size === 0) throw new Error('Unable to parse legacy aliases')
const ids = new Set()

for (const entry of licenses) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Generated license entry must be an object')
  }

  for (const key of [
    'licenseId',
    'name',
    'text',
    'seeAlso',
    'isOsiApproved',
    'isDeprecated',
    'sourceVersion',
  ]) {
    if (!(key in entry))
      throw new Error((entry.licenseId || 'unknown') + ' missing ' + key)
  }
  for (const key of ['licenseId', 'name', 'text', 'sourceVersion']) {
    if (typeof entry[key] !== 'string' || !entry[key].trim()) {
      throw new Error((entry.licenseId || 'unknown') + ' invalid ' + key)
    }
  }
  if (entry.sourceVersion !== sourceVersion) {
    throw new Error(entry.licenseId + ' sourceVersion mismatch')
  }
  if (!Array.isArray(entry.seeAlso)) {
    throw new Error(entry.licenseId + ' seeAlso must be an array')
  }
  if (!entry.seeAlso.every((value) => typeof value === 'string')) {
    throw new Error(entry.licenseId + ' seeAlso must contain strings')
  }
  for (const key of ['isOsiApproved', 'isDeprecated']) {
    if (typeof entry[key] !== 'boolean') {
      throw new Error(entry.licenseId + ' invalid ' + key)
    }
  }
  if ('isFsfLibre' in entry && typeof entry.isFsfLibre !== 'boolean') {
    throw new Error(entry.licenseId + ' invalid isFsfLibre')
  }
  if (ids.has(entry.licenseId))
    throw new Error('Duplicate license ID: ' + entry.licenseId)
  if (legacyIds.has(entry.licenseId))
    throw new Error('Legacy ID used as primary result: ' + entry.licenseId)
  if (entry.isDeprecated)
    throw new Error('Deprecated ID used as primary result: ' + entry.licenseId)
  if (!expectedIds.has(entry.licenseId))
    throw new Error('Unexpected license ID: ' + entry.licenseId)
  ids.add(entry.licenseId)
}

for (const id of expectedIds) {
  if (!ids.has(id)) throw new Error('Missing license ID: ' + id)
}

const seenLicenseIds = new Set()
for (const id of licenseIds) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid SPDX license ID: ' + id)
  }
  if (seenLicenseIds.has(id)) {
    throw new Error('Duplicate SPDX license ID: ' + id)
  }
  seenLicenseIds.add(id)
}
const sortedLicenseIds = [...licenseIds].sort()
if (JSON.stringify(licenseIds) !== JSON.stringify(sortedLicenseIds)) {
  throw new Error('Generated SPDX license IDs must be sorted')
}
for (const id of expectedIds) {
  if (!seenLicenseIds.has(id)) {
    throw new Error('Generated SPDX license IDs missing supported ID: ' + id)
  }
}

const seenExceptionIds = new Set()
for (const id of exceptionIds) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('Invalid SPDX exception ID: ' + id)
  }
  if (seenExceptionIds.has(id)) {
    throw new Error('Duplicate SPDX exception ID: ' + id)
  }
  seenExceptionIds.add(id)
}
const sortedExceptionIds = [...exceptionIds].sort()
if (JSON.stringify(exceptionIds) !== JSON.stringify(sortedExceptionIds)) {
  throw new Error('Generated SPDX exception IDs must be sorted')
}

console.log(
  'Verified ' +
    licenses.length +
    ' SPDX license entries, ' +
    licenseIds.length +
    ' SPDX license IDs, and ' +
    exceptionIds.length +
    ' exception IDs',
)
