import { normalizeLoose } from './normalize'
import { detectSpdxIdentifier } from './detect-spdx'
import { hasSpdxIdToken, spdxLineExpressions } from './spdx-expression'
import type { InputType } from './types'

const permissionGrantNegationQualifierWords = new Set([
  'additional',
  'any',
  'copyright',
  'explicit',
  'express',
  'further',
  'implied',
  'other',
  'patent',
  'prior',
  'separate',
  'similar',
  'special',
  'such',
  'written',
])
const permissionGrantNegationDeterminerWords = new Set([
  'a',
  'an',
  'its',
  'our',
  'that',
  'the',
  'their',
  'these',
  'this',
  'those',
])
const coordinatedPermissionGrantNegationNouns = new Set([
  'authorization',
  'authorizations',
  'authorisation',
  'authorisations',
  'claim',
  'claims',
  'copyright',
  'copyrights',
  'license',
  'licenses',
  'licence',
  'licences',
  'patent',
  'patents',
  'permission',
  'permissions',
  'right',
  'rights',
])
// Covers full-text clauses where grant verbs and license-right nouns are
// separated by warranty, patent, or sublicense terms in the same sentence.
const permissionGrantLookaheadWords = 42
const clauseInitialNorPattern = /(^|[.!?;:][ \t]+|[\r\n]+[ \t]*)nor\b/gi

function countWords(text: string): number {
  // normalizeLoose collapses word separators to spaces before this count.
  let count = 0
  let inWord = false
  for (const char of text) {
    if (char === ' ') {
      inWord = false
    } else if (!inWord) {
      count += 1
      inWord = true
    }
  }
  return count
}

// Recognizes grants such as "permission is granted" while filtering negated
// forms like "no permission is granted", "neither permission nor license is
// granted", and chained "nor ... nor ..." clauses.
function hasUnnegatedPermissionGrant(words: string[]): boolean {
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== 'permission') continue
    if (!hasPermissionGrantAfter(words, index)) continue
    if (hasPermissionGrantNegationBefore(words, index)) continue
    return true
  }
  return false
}

function normalizePermissionGrantLoose(text: string): string {
  return normalizeLoose(
    /\bnor\b/i.test(text)
      ? text.replace(clauseInitialNorPattern, '$1no')
      : text,
  )
}

function hasPermissionGrantAfter(words: string[], index: number): boolean {
  if (words[index + 1] !== 'is') {
    if (words[index + 1] !== 'to') return false
    const grantSearchEnd = Math.min(
      words.length - 2,
      index + permissionGrantLookaheadWords,
    )
    for (
      let grantIndex = index + 2;
      grantIndex <= grantSearchEnd;
      grantIndex += 1
    ) {
      if (words[grantIndex] === 'permission') return false
      if (
        words[grantIndex] === 'is' &&
        grantIndex + 1 < words.length &&
        words[grantIndex + 1] === 'granted'
      )
        return true
      if (
        words[grantIndex] === 'is' &&
        grantIndex + 2 < words.length &&
        words[grantIndex + 1] === 'hereby' &&
        words[grantIndex + 2] === 'granted'
      )
        return true
    }
    return false
  }
  if (index + 2 < words.length && words[index + 2] === 'granted') return true
  return (
    index + 3 < words.length &&
    words[index + 2] === 'hereby' &&
    words[index + 3] === 'granted'
  )
}

function isPermissionGrantNegationConnector(word: string | undefined): boolean {
  return word === 'and' || word === 'nor' || word === 'or'
}

function skipPermissionGrantNegationQualifiers(
  words: string[],
  index: number,
): number {
  let prefixIndex = index
  while (
    prefixIndex >= 0 &&
    permissionGrantNegationQualifierWords.has(words[prefixIndex])
  ) {
    prefixIndex -= 1
    if (
      prefixIndex >= 0 &&
      isPermissionGrantNegationConnector(words[prefixIndex])
    )
      prefixIndex -= 1
  }
  return prefixIndex
}

function skipPermissionGrantNegationQualifiersBeforeConnector(
  words: string[],
  index: number,
): number {
  let prefixIndex = index
  while (
    prefixIndex >= 0 &&
    (permissionGrantNegationQualifierWords.has(words[prefixIndex]) ||
      permissionGrantNegationDeterminerWords.has(words[prefixIndex]))
  ) {
    prefixIndex -= 1
  }
  return prefixIndex
}

function skipSimplePermissionGrantNegationPrefix(
  words: string[],
  index: number,
): number {
  let prefixIndex = skipPermissionGrantNegationQualifiersBeforeConnector(
    words,
    index,
  )
  if (isPermissionGrantNegationConnector(words[prefixIndex])) {
    prefixIndex = skipPermissionGrantNegationQualifiers(words, prefixIndex - 1)
  }
  return prefixIndex
}

function hasNegationBeforePermissionGrantNor(
  words: string[],
  connectorIndex: number,
): boolean {
  for (
    let prefixIndex = connectorIndex - 1;
    prefixIndex >= 0 &&
    connectorIndex - prefixIndex <= permissionGrantLookaheadWords;
    prefixIndex -= 1
  ) {
    if (words[prefixIndex] === 'neither' || words[prefixIndex] === 'no')
      return true
    if (words[prefixIndex] === 'permission') return false
  }
  return false
}

function hasPermissionGrantNegationBefore(
  words: string[],
  index: number,
): boolean {
  let prefixIndex = skipSimplePermissionGrantNegationPrefix(words, index - 1)
  if (
    prefixIndex >= 0 &&
    (words[prefixIndex] === 'neither' || words[prefixIndex] === 'no')
  )
    return true

  prefixIndex = index - 1
  prefixIndex = skipPermissionGrantNegationQualifiersBeforeConnector(
    words,
    prefixIndex,
  )
  if (
    prefixIndex < 0 ||
    (words[prefixIndex] !== 'and' &&
      words[prefixIndex] !== 'nor' &&
      words[prefixIndex] !== 'or')
  )
    return false
  let connector = words[prefixIndex]
  while (true) {
    const connectorIndex = prefixIndex
    prefixIndex -= 1
    if (prefixIndex >= 0 && words[prefixIndex] === 'granted') {
      if (connector === 'and') return false
      prefixIndex -=
        prefixIndex >= 1 &&
        (words[prefixIndex - 1] === 'is' || words[prefixIndex - 1] === 'are')
          ? 2
          : 1
    }
    if (
      prefixIndex < 0 ||
      !coordinatedPermissionGrantNegationNouns.has(words[prefixIndex])
    ) {
      if (
        connector === 'nor' &&
        hasNegationBeforePermissionGrantNor(words, connectorIndex)
      )
        return true
      return false
    }

    const chainConnectorIndex =
      skipPermissionGrantNegationQualifiersBeforeConnector(
        words,
        prefixIndex - 1,
      )
    if (isPermissionGrantNegationConnector(words[chainConnectorIndex])) {
      const previousNounIndex =
        skipPermissionGrantNegationQualifiersBeforeConnector(
          words,
          chainConnectorIndex - 1,
        )
      if (
        previousNounIndex >= 0 &&
        coordinatedPermissionGrantNegationNouns.has(words[previousNounIndex])
      ) {
        prefixIndex = chainConnectorIndex
        connector = words[prefixIndex]
        continue
      }
    }

    prefixIndex -= 1
    prefixIndex = skipPermissionGrantNegationQualifiers(words, prefixIndex)
    while (
      prefixIndex >= 0 &&
      permissionGrantNegationDeterminerWords.has(words[prefixIndex])
    ) {
      prefixIndex -= 1
      prefixIndex = skipPermissionGrantNegationQualifiers(words, prefixIndex)
    }
    break
  }
  return (
    prefixIndex >= 0 &&
    (words[prefixIndex] === 'neither' || words[prefixIndex] === 'no')
  )
}

export function classifyInput(
  input: string,
  knownIds?: Set<string>,
): InputType {
  const trimmed = input.trim()
  if (!trimmed) return 'unknown'
  const spdxExpressions = spdxLineExpressions(trimmed, knownIds)
  if (spdxExpressions.length > 0) {
    if (
      spdxExpressions.every((expression) =>
        hasSpdxIdToken(expression, knownIds),
      )
    ) {
      return 'spdx-expression'
    }
  }
  if (
    hasSpdxIdToken(trimmed, knownIds) &&
    (!knownIds || detectSpdxIdentifier(trimmed, knownIds))
  )
    return 'spdx-expression'

  const loose = normalizeLoose(trimmed)
  const words = countWords(loose)
  const permissionLoose = /\bpermission\b/i.test(trimmed)
    ? normalizePermissionGrantLoose(trimmed)
    : ''
  const looseWords = permissionLoose ? permissionLoose.split(' ') : []
  const hasPermissionGrant =
    looseWords.length > 0 && hasUnnegatedPermissionGrant(looseWords)
  const hasApacheHeader =
    /\b(?:(?:licensed|released|distributed|provided|offered|covered) under (?:the )?(?:terms (?:and conditions )?of (?:the )?)?|governed by (?:the )?|(?:is|are) under (?:the )?|subject to (?:the )?terms (?:and conditions )?of (?:the )?)(?:apache license (?:version )?2(?: 0)?|apache 2 0)(?: licen[cs]e)?\b/.test(
      loose,
    )
  const hasNamedLicenseHeader =
    /\b(?:(?:licensed|released|distributed|provided|offered|covered) under (?:the )?(?:terms (?:and conditions )?of (?:the )?)?|governed by (?:the )?|(?:is|are) under (?:the )?|subject to (?:the )?terms (?:and conditions )?of (?:the )?)(?:mit|mit 0|expat|bsd [23] clause|isc|zlib|the unlicense|unlicense|mozilla public license (?:v )?(?:1 [01]|2 0)|mpl (?:v )?(?:1 [01]|2 0)|mplv(?:1 [01]|2)|mpl 2)(?: licen[cs]e)?\b/.test(
      loose,
    )
  const hasCc0DedicationHeader =
    /^(?:(?:cc0 1 0 universal public domain dedication|creative commons zero (?:v ?)?1 0 universal public domain dedication)|(?:(?:this|the|our|these|those) (?:code|content|data|file|files|project|software|source code|source|work|works) (?:is|are) )?dedicated to (?:the )?public domain under (?:the )?(?:cc0 1 0(?: universal public domain dedication)?|creative commons zero (?:v ?)?1 0 universal public domain dedication))\b/.test(
      loose,
    )
  const hasBareLicenseTitle =
    words <= 11 &&
    !/\bspdx\b/.test(loose) &&
    /^(?:(?:a|an|the) )?(?:mit licen[cs]e|mit 0 licen[cs]e|expat licen[cs]e|apache (?:(?:software )?licen[cs]e(?: version)? 2(?: 0)?|2(?: 0)? licen[cs]e)|(?:0bsd|0 clause bsd|bsd zero clause|bsd 0 clause|zero clause bsd) licen[cs]e|bsd [23] clause licen[cs]e|isc licen[cs]e|zlib licen[cs]e|boost software licen[cs]e(?: 1 0)?|mozilla public licen[cs]e (?:version |v ?)?(?:1 [01]|2 0)|mpl (?:(?:version |v ?)?(?:1 [01]|2(?: 0)?) licen[cs]e|licen[cs]e (?:version |v ?)?(?:1 [01]|2(?: 0)?))|eclipse public licen[cs]e (?:version |v ?)?[12] 0|epl (?:version |v ?)?[12] 0 licen[cs]e|gnu (?:affero )?(?:lesser )?general public licen[cs]e(?: (?:version |v ?)?[23](?: [01])?(?: (?:only|or later))?)?|agpl (?:version |v ?)?3(?: 0)?(?: (?:only|or later))? licen[cs]e|lgpl (?:version |v ?)?[23](?: [01])?(?: (?:only|or later))? licen[cs]e|gpl (?:version |v ?)?[23](?: 0)?(?: (?:only|or later))? licen[cs]e|artistic licen[cs]e(?: 2 0)?|academic free licen[cs]e(?: afl)? (?:version |v ?)?3(?: 0)?|common development and distribution licen[cs]e(?: 1 [01])?|cddl(?: 1 [01])? licen[cs]e|european union public licen[cs]e(?: (?:version |v ?)?1 2)?|eupl(?: 1 2)? licen[cs]e|microsoft public licen[cs]e|ncsa open source licen[cs]e|postgresql licen[cs]e|blue oak model licen[cs]e(?: (?:version |v ?)?1 0 0)?|creative commons zero(?: 1 0)? universal public domain dedication|cc0(?: 1 0)? universal public domain dedication|do what the f(?:uck| ck) you want to public licen[cs]e|wtfpl licen[cs]e|unlicense(?: licen[cs]e)?)$/.test(
      loose,
    )
  const hasOfficialDatedBareLicenseTitle =
    words <= 12 &&
    /^(?:(?:a|an|the) )?apache licen[cs]e version 2 0 january 2004$/.test(loose)
  const explicitLicenseHeaderMatch =
    /\b(?:(?:licensed|released|distributed|provided|offered|covered) under|governed by|(?:is|are) under|subject to (?:the )?terms (?:and conditions )?of) (?:a |an |the )?(?:terms (?:and conditions )?of (?:the )?)?([a-z0-9.+-][a-z0-9.+ -]{0,80})(?: licen[cs]e)?\b/.exec(
      loose,
    )
  const explicitLicenseHeaderClauseBoundaryPattern =
    /\b(?:and|or) (?=(?:(?:licensed|released|distributed|provided|offered|covered) under|governed by|(?:is|are) under|subject to\b|(?:the )?[a-z0-9.+-]+(?: [a-z0-9.+-]+){0,6} licen[cs]e agreements?\b))|[.;,]/
  const explicitLicenseHeaderText =
    (explicitLicenseHeaderMatch?.[1] ?? '')
      .split(explicitLicenseHeaderClauseBoundaryPattern, 1)[0]
      .trim() || ''
  const explicitLicenseHeaderCuePattern =
    /^(?:0bsd|agpl|apache|asl|artistic|blue oak|boost|bsd|cddl|cc0|creative commons|eclipse public|epl|eupl|expat|gnu|gpl|isc|lgpl|mit|mozilla public|mplv?[0-9]?|microsoft public|ms pl|ncsa|postgresql|the unlicense|unlicense|wtfpl|zlib)\b/
  const explicitLicenseHeaderTitlePattern =
    /\b[a-z0-9.+-]+(?: [a-z0-9.+-]+){0,8} licen[cs]e(?: (?:version |v )?[0-9][a-z0-9.]*)?\b/
  const genericExplicitLicenseHeaderTitlePattern =
    /^(?:(?:application|code|commercial|content|data|documentation|docs|end user|free|open source|package|product|program|project|proprietary|public|service|software|source|user) ){0,3}(?:application|code|commercial|content|data|documentation|docs|end user|free|open source|package|product|program|project|proprietary|public|service|software|source|user) licen[cs]e(?: (?:(?:version|v) )?v?[0-9]+(?: [a-z0-9]+)*)?$/
  const explicitLicenseAgreementTitlePattern = /\blicen[cs]e agreements?\b/
  const hasExplicitLicenseAgreementHeader = Boolean(
    explicitLicenseHeaderText &&
    explicitLicenseAgreementTitlePattern.test(explicitLicenseHeaderText),
  )
  const hasExplicitLicenseHeader = Boolean(
    explicitLicenseHeaderText &&
    !hasExplicitLicenseAgreementHeader &&
    !genericExplicitLicenseHeaderTitlePattern.test(explicitLicenseHeaderText) &&
    (explicitLicenseHeaderCuePattern.test(explicitLicenseHeaderText) ||
      explicitLicenseHeaderTitlePattern.test(explicitLicenseHeaderText)),
  )
  const hasGnuPreamble =
    /gnu (?:affero )?(?:lesser )?general public license/.test(loose)
  const hasTerms =
    /terms and conditions|redistribution and use|copying distribution and modification/.test(
      loose,
    )
  const hasWarranty =
    /without warranty|disclaimer of warranty|no warranty|\b(?:provided )?as is\b|\bwarranties(?: [a-z]+){0,40} are disclaimed\b/.test(
      loose,
    )
  const hasCopyright = /copyright/.test(loose)

  if (
    (hasPermissionGrant || hasGnuPreamble || hasTerms) &&
    hasWarranty &&
    words >= 90
  ) {
    return 'full-license-text'
  }
  if (
    !hasExplicitLicenseAgreementHeader &&
    (hasApacheHeader ||
      hasNamedLicenseHeader ||
      hasCc0DedicationHeader ||
      hasBareLicenseTitle ||
      hasOfficialDatedBareLicenseTitle ||
      (words <= 24 && hasExplicitLicenseHeader))
  )
    return 'license-header'
  if (words < 12) return 'unknown'
  if (hasGnuPreamble && /redistribute|modify|terms/.test(loose) && words >= 20)
    return 'license-header'
  if (hasCopyright && (hasPermissionGrant || hasTerms) && words < 180)
    return 'license-notice'
  if ((hasPermissionGrant || hasGnuPreamble || hasTerms) && words >= 80)
    return 'license-header'
  return 'unknown'
}
