import { readFile, writeFile } from 'node:fs/promises'

const data = await readFile('src/data/licenses.generated.ts', 'utf8')
const match = data.match(
  /export const licenses: LicenseEntry\[] = ([\s\S]+?)\s*$/,
)
if (!match) throw new Error('Unable to parse generated license data')
let licenses
try {
  licenses = JSON.parse(match[1])
} catch (error) {
  throw new Error(
    'Unable to parse generated license data JSON: ' +
      (error instanceof Error ? error.message : String(error)),
    { cause: error },
  )
}
if (!Array.isArray(licenses))
  throw new Error('Generated license data must be an array')

function ensureLicenseEntry(license) {
  if (!license || typeof license !== 'object' || Array.isArray(license)) {
    throw new Error('Generated license entry must be an object')
  }
  const label =
    typeof license.licenseId === 'string' && license.licenseId.trim()
      ? license.licenseId
      : 'unknown'
  for (const key of ['licenseId', 'name']) {
    if (typeof license[key] !== 'string' || !license[key].trim()) {
      throw new Error(label + ' invalid ' + key)
    }
  }
}

function escapeMarkdownText(text) {
  return text.replace(/[\\*_[\]`]/g, (character) => '\\' + character)
}

function escapeRegExp(text) {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

const list = licenses
  .map((license) => {
    ensureLicenseEntry(license)
    return license.licenseId + ' - ' + escapeMarkdownText(license.name)
  })
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  .map((line) => '- ' + line)
  .join('\n')

const start = '<!-- supported-licenses:start -->'
const end = '<!-- supported-licenses:end -->'
const readme = await readFile('README.md', 'utf8')
const supportedListPattern = new RegExp(
  escapeRegExp(start) + '[\\s\\S]*?' + escapeRegExp(end),
)
if (!supportedListPattern.test(readme))
  throw new Error('README supported license markers not found or malformed')
const next = readme.replace(
  supportedListPattern,
  () => start + '\n\n' + list + '\n' + end,
)
if (next !== readme) await writeFile('README.md', next)
console.log(
  next === readme
    ? 'README supported license list already up to date'
    : 'Updated README with ' + licenses.length + ' supported licenses',
)
