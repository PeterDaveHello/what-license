import { legacyAliases } from '../data/legacy-aliases'
import { namedHeaderAliases } from '../data/license-header-aliases'
import { gnuFamilyIds } from '../data/license-meta'
import { spdxLicenseIds } from '../data/spdx-license-ids.generated'
import { inputTooLargeMessage, maxDiffResults, maxInputSize } from './constants'
import { detectSpdxIdentifier, type SpdxDetection } from './detect-spdx'
import {
  buildExplanation,
  explainNormalizedDiffSegments,
  formatDiffSegments,
} from './explain'
import {
  lineCommentShellPattern,
  normalizeLoose,
  normalizeStrict,
} from './normalize'
import { confidenceFromScore, resetInputShingleCache, scoreText } from './score'
import {
  hasValidSpdxExpressionShape,
  hasSpdxIdToken,
  isMalformedCustomSpdxReferenceToken,
  isSpdxExceptionIdToken,
  isSpdxExpressionIdToken,
  isSpdxLikeIdToken,
  isStandaloneDocumentRefToken,
  spdxLikeAnnotatedLicenseNameLeadingId,
  spdxLineExpressions,
  trimSpdxExpressionTail,
  trimSpdxInlineCommentTail,
} from './spdx-expression'
import { cachedLowercaseSetFor, cachedSetSnapshotMatches } from './set-cache'
import type {
  Confidence,
  LegacyAlias,
  LicenseEntry,
  MatchResponse,
  MatchResult,
} from './types'
import { classifyInput } from './classify-input'

const legacyIds = new Set(legacyAliases.map((alias) => alias.legacyId))
const officialSpdxLicenseIds = new Set(spdxLicenseIds)
const lowercaseLegacyIds = new Set(
  legacyAliases.map((alias) => alias.legacyId.toLowerCase()),
)
const legacyAliasCandidatesByLowercase = new Map(
  legacyAliases.map((alias) => [
    alias.legacyId.toLowerCase(),
    alias.candidates,
  ]),
)
const gnuCounterparts = new Map([
  ['GPL-2.0-only', 'GPL-2.0-or-later'],
  ['GPL-2.0-or-later', 'GPL-2.0-only'],
  ['GPL-3.0-only', 'GPL-3.0-or-later'],
  ['GPL-3.0-or-later', 'GPL-3.0-only'],
  ['AGPL-3.0-only', 'AGPL-3.0-or-later'],
  ['AGPL-3.0-or-later', 'AGPL-3.0-only'],
  ['LGPL-2.1-only', 'LGPL-2.1-or-later'],
  ['LGPL-2.1-or-later', 'LGPL-2.1-only'],
  ['LGPL-3.0-only', 'LGPL-3.0-or-later'],
  ['LGPL-3.0-or-later', 'LGPL-3.0-only'],
])
const confidenceOrder: Record<Confidence, number> = {
  Exact: 4,
  Likely: 3,
  Possible: 2,
  Unknown: 1,
}
const licenseLabelSubjectPrefixPattern =
  'current|main|primary|project|source|package'
const normalizedLicenseLabelPattern = `(?:(?:${licenseLabelSubjectPrefixPattern}) )?licen[cs]es?(?: identifiers?)?`
const normalizedPrefixedLicenseLabelPattern = `(?:${licenseLabelSubjectPrefixPattern}) licen[cs]es?(?: identifiers?)?`
const normalizedLicenseLabelDeclarationPattern = new RegExp(
  `^${normalizedLicenseLabelPattern}(?:$| (?!information\\b|details\\b|notice\\b|notices\\b|overviews?\\b|summar(?:y|ies)\\b|text\\b|terms\\b)\\S)`,
)
const normalizedStandaloneLicenseLabelPattern = new RegExp(
  `^${normalizedLicenseLabelPattern}$`,
)
const normalizedStandaloneLicenseLabelWithPrefixPattern = new RegExp(
  `^(?:(${licenseLabelSubjectPrefixPattern}) )?licen[cs]es?(?: identifiers?)?$`,
)
const normalizedInlineLicenseLabelPattern = new RegExp(
  `^${normalizedLicenseLabelPattern} `,
)
const normalizedPrefixedInlineLicenseLabelPattern = new RegExp(
  `^${normalizedPrefixedLicenseLabelPattern} $`,
)
const rawSpdxLikeBodyDeclarationLabelPattern = new RegExp(
  `^(?:(?:${normalizedLicenseLabelPattern})|license-identifier):\\s*`,
  'i',
)
const modalRestrictionActionWords = new Set([
  'copy',
  'distribute',
  'modify',
  'reproduce',
  'redistribute',
  'sell',
  'sublicense',
])
const modalPassiveRestrictionActionWords = new Set([
  'copied',
  'distributed',
  'modified',
  'reproduced',
  'redistributed',
  'sold',
  'sublicensed',
])
const modalBrandingUseWords = new Set([
  'brand',
  'brands',
  'logo',
  'logos',
  'mark',
  'marks',
  'name',
  'names',
  'trademark',
  'trademarks',
])
const modalBrandingDescriptorStopWords = new Set([
  'and',
  'but',
  'by',
  'for',
  'in',
  'or',
  'the',
  'this',
  'to',
  'under',
  'with',
])
const modalUseObjectWords = new Set([
  'application',
  'app',
  'apps',
  'cli',
  'code',
  'codebase',
  'component',
  'file',
  'files',
  'library',
  'package',
  'product',
  'program',
  'project',
  'repo',
  'repos',
  'repository',
  'service',
  'software',
  'source',
  'tool',
  'tools',
  'work',
])
const modalUseScopeAdverbs = new Set([
  'commercially',
  'internally',
  'noncommercially',
  'personally',
])
const modalObjectDeterminers = new Set([
  'my',
  'our',
  'the',
  'these',
  'this',
  'those',
])
const noPrefixedRestrictionActionWords = new Set([
  'copying',
  'derivative',
  'derivatives',
  'distribution',
  'modification',
  'redistribution',
  'sublicensing',
])
const noPrefixedRestrictionScopedActionWords = new Set([
  ...noPrefixedRestrictionActionWords,
  'use',
  'usage',
])
const noPrefixedRestrictionNegationWords = new Set([
  'limitation',
  'limitations',
  'restriction',
  'restrictions',
])
const noPrefixedRestrictionScopeWords = new Set([
  'academic',
  'commercial',
  'demo',
  'documentation',
  'educational',
  'evaluation',
  'internal',
  'military',
  'noncommercial',
  'nonprofit',
  'personal',
  'private',
  'research',
  'test',
  'testing',
  'trial',
])
const knownIdsCache = new WeakMap<LicenseEntry[], Set<string>>()
const canonicalKnownIdByLowercaseCache = new WeakMap<
  Set<string>,
  { ids: string[]; map: Map<string, string> }
>()
const permissionRequiredRightWords = new Set([
  'changes',
  'copying',
  'derivative',
  'derivatives',
  'distribution',
  'modification',
  'modifications',
  'redistribution',
  'sublicensing',
  'use',
  'usage',
])
const permissionRequirementWords = new Set([
  'approval',
  'approvals',
  'authorisation',
  'authorisations',
  'authorization',
  'authorizations',
  'consent',
  'permission',
  'permissions',
])
const permissionRequirementNegationWords = new Set(['no', 'not', 'without'])
const permissionNoticeWords = new Set(['notice', 'notices'])
const noticeDescriptorWords = new Set(['copyright', 'licence', 'license'])
const restrictiveTailSubjectDeterminers = new Set([
  'our',
  'that',
  'the',
  'these',
  'this',
  'those',
])
const sourceDisclosureSubjectWords = new Set([
  'changes',
  'derivative',
  'derivatives',
  'modification',
  'modifications',
])
const noPrefixedDerivativeWorkWords = new Set(['work', 'works'])
const warrantyWords = new Set(['warranty', 'warranties'])

function knownIdsFor(licenses: LicenseEntry[]): Set<string> {
  let knownIds = knownIdsCache.get(licenses)
  if (!knownIds) {
    knownIds = new Set(licenses.map((license) => license.licenseId))
    knownIdsCache.set(licenses, knownIds)
  }
  return knownIds
}

function canonicalKnownIdByLowercaseFor(
  knownIds: Set<string>,
): Map<string, string> {
  const cached = canonicalKnownIdByLowercaseCache.get(knownIds)
  if (cached && cachedSetSnapshotMatches(knownIds, cached.ids)) {
    return cached.map
  }

  const ids = Array.from(knownIds)
  const map = new Map(ids.map((id) => [id.toLowerCase(), id]))
  canonicalKnownIdByLowercaseCache.set(knownIds, { ids, map })
  return map
}

const licenseLineCache = new WeakMap<LicenseEntry, string[]>()
const licenseWordCache = new WeakMap<LicenseEntry, string[]>()
const minLicenseWordCountCache = new WeakMap<LicenseEntry[], number>()
const normalizedLicenseTextCache = new WeakMap<LicenseEntry[], string[]>()
const projectAllRightsReservedSubjectSource =
  '(?:(?:this|the|our) (?:project|project source|source code|codebase|software|package|repository|repo|library|program|application|component|product|service|code|source|work|file|source file)|(?:these|those) files|(?:main|primary) (?:project )?(?:source|code|software|package|library|program|application|repository|repo|files|file|source file))'
const projectAllRightsReservedSubjectBoundary =
  projectAllRightsReservedSubjectSource + '\\b(?! s\\b)'
const projectAllRightsReservedStrictGapWordSource =
  '(?:all|rights|has|have|retains|retain|reserves|reserve|is|are|was|were|remains|remain|uses?|includes?|bundles?|vendors?|contains?|depends|requires?|ships|third|party|dependenc(?:y|ies)|components?|modules?|libraries?|packages?|parsers?|helpers?|tools?|assets?|fonts?|plugins?|extensions?|addons?|that|which|it|they|these|those)'
const directProjectAllRightsReservedPattern = new RegExp(
  '\\b' +
    projectAllRightsReservedSubjectBoundary +
    '(?: (?!all\\b|rights\\b)[a-z0-9<>]+){0,16} (?:has|have|retains|retain|reserves|reserve|is|are|was|were|remains|remain) all rights reserved\\b',
)
const strictDirectProjectAllRightsReservedPattern = new RegExp(
  '\\b' +
    projectAllRightsReservedSubjectBoundary +
    `(?: (?!${projectAllRightsReservedStrictGapWordSource}\\b)[a-z0-9<>]+){0,3} (?:has|have|retains|retain|reserves|reserve|is|are|was|were|remains|remain) all rights reserved\\b`,
)
const allRightsReservedByProjectPattern = new RegExp(
  '\\ball rights reserved by ' + projectAllRightsReservedSubjectBoundary,
)
const thirdPartyAllRightsReservedSubjectNounSource =
  '(?:dependenc(?:y|ies)|components?|modules?|libraries?|packages?|parsers?|helpers?|tools?|assets?|fonts?|plugins?|extensions?|add ons?|addons?)'
// These patterns run on loose-normalized text where apostrophes become spaces.
const allRightsReservedByProjectDependencyPattern = new RegExp(
  `\\ball rights reserved by (?:(?:this|the|our) project(?: s|s)?|(?:these|those) files(?: s)?) ${thirdPartyAllRightsReservedSubjectNounSource}\\b`,
)
const explicitThirdPartyAllRightsReservedSubjectPattern = new RegExp(
  `\\b(?:third party|bundled|vendored|external|included|embedded) (?:${thirdPartyAllRightsReservedSubjectNounSource}|code|source|software)(?: (?!and\\b|or\\b|but\\b)[a-z0-9<>]+){0,8} (?:that|which) (?:has|have|retains|retain|reserves|reserve|is|are|was|were|remains|remain) all rights reserved\\b`,
)
const bareThirdPartyAllRightsReservedSubjectPattern = new RegExp(
  `\\b${thirdPartyAllRightsReservedSubjectNounSource} (?:has|have|retains|retain|reserves|reserve|is|are|was|were|remains|remain) all rights reserved\\b`,
)
const projectDependencyAllRightsReservedSubjectPattern = new RegExp(
  `\\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|ships with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!and\\b|or\\b|but\\b|no\\b)[a-z0-9<>]+){0,8} ${thirdPartyAllRightsReservedSubjectNounSource}(?: (?!and\\b|or\\b|but\\b)[a-z0-9<>]+){0,8} (?:that|which) (?:has|have|retains|retain|reserves|reserve|is|are|was|were|remains|remain) all rights reserved\\b`,
)
const projectDependencyPronounAllRightsReservedSubjectPattern = new RegExp(
  `\\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|ships with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!and\\b|or\\b|but\\b|no\\b)[a-z0-9<>]+){0,8} ${thirdPartyAllRightsReservedSubjectNounSource}(?: (?!and\\b|or\\b|but\\b)[a-z0-9<>]+){0,4} (?:it|they|this|that|these|those) (?:has|have|retains|retain|reserves|reserve|is|are|was|were|remains|remain) all rights reserved\\b`,
)
const explicitThirdPartyBodyContextPattern =
  /\b(?:third party|bundled|vendored|(?:external|included|embedded) (?:asset|assets|font|fonts|component|components|module|modules|library|libraries|package|packages|parser|parsers|helper|helpers|tool|tools|plugin|plugins|extension|extensions|add on|add ons|addon|addons|code|source|software|dependency|dependencies))\b/
const negatedThirdPartyBodyContextPattern =
  /\b(?:no|without(?: any)?) (?:(?:third party|bundled|vendored|external|included|embedded) )?(?:asset|assets|font|fonts|component|components|module|modules|library|libraries|package|packages|parser|parsers|helper|helpers|tool|tools|plugin|plugins|extension|extensions|add on|add ons|addon|addons|code|source|software|dependency|dependencies)\b|\b(?:no|without(?: any)?) third party\b/g
const maxFullLicensePrefixBodyWords = 20_000
// This caps the prefix matching window, not the tail scanned after a match.
const maxFullLicensePrefixBodyCharacters = 200_000
const maxFullLicensePrefixAnchorChecks = 100_000
const maxFullLicensePrefixAnchorOccurrences = 256
const maxTotalFullLicensePrefixAnchorChecks = 1_000_000
const maxSpdxDeclarationPrefixTokens = 64
const maxThirdPartyRestrictiveScopeSkippedTokens = 48
const minGnuBodyRecall = 0.98
const minGnuBodyPrecision = 0.95
const minGnuNoticeFamilyBodyRecall = 0.95
const minHeaderF1ForLikely = 0.002
const minHeaderF1ForPossible = 0.001
const spdxIdentifierDeclarationLinePattern =
  /^\s*(?:(?:<!--|\/\/[/!]*|\/\*+!?|\*+|#|;|--|-)\s*)?SPDX-License-Identifier:[ \t]*/i
const thirdPartyRestrictiveScopeAnchorSource = String.raw`\b(?:third party|bundled|vendored|external|included|embedded)\b`
const thirdPartyRestrictiveScopeAnchorPattern = new RegExp(
  thirdPartyRestrictiveScopeAnchorSource,
  'g',
)
const thirdPartyRestrictiveScopePhrasePattern =
  /^(?:for|only for|not for|restricted to|limited to) (?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo)\b/
type FullLicensePrefixTotalBudget = { anchorChecks: number }
type FullLicensePrefixBudget = {
  anchorChecks: number
  totalBudget?: FullLicensePrefixTotalBudget
}
const licenseByIdCache = new WeakMap<
  LicenseEntry[],
  Map<string, LicenseEntry>
>()
const headerAliasCache = new WeakMap<LicenseEntry[], HeaderAlias[]>()
const negatedHeaderPrefixWordLimit = 32

interface HeaderAlias {
  licenseId: string
  words: string[]
  sameLicenseWords?: string[][]
  allowBareTitle?: boolean
  legacyAlias?: LegacyAlias
}

type GnuFamily = 'AGPL' | 'LGPL' | 'GPL'

interface GnuNotice {
  family: GnuFamily
  version?: string
  wording: string
}

interface GnuReviewContext {
  notice?: GnuNotice
  inputOrLater: boolean
}

type LicenseLabelSpdxDetection =
  | {
      detection: SpdxDetection
      malformedDeclaredIds?: never
      body: string
    }
  | {
      detection?: never
      malformedDeclaredIds: Set<string>
      body: string
    }

const blockCommentOpenShellPattern = /^\s*\/\*/
const blockCommentCloseShellPattern = /\*+\/\s*$/
const blockCommentCloseTailPattern = /\*+\//

const thirdPartyGnuNoticeNouns = new Set([
  'dependency',
  'dependencies',
  'component',
  'components',
  'module',
  'modules',
  'library',
  'libraries',
  'package',
  'packages',
  'parser',
  'parsers',
  'helper',
  'helpers',
  'tool',
  'tools',
  'font',
  'fonts',
  'sdk',
  'sdks',
  'framework',
  'frameworks',
  'service',
  'services',
  'product',
  'products',
  'application',
  'applications',
  'program',
  'programs',
  'software',
  'code',
  'binary',
  'binaries',
  'file',
  'files',
  'work',
  'works',
  'portion',
  'portions',
  'artifact',
  'artifacts',
  'bundle',
  'bundles',
  'bundled',
  'distribution',
  'distributions',
  'plugin',
  'plugins',
  'extension',
  'extensions',
])
const thirdPartyGnuNoticeModifiers = new Set([
  'popular',
  'modified',
  'common',
  'standard',
])
const thirdPartyGnuNoticeStates = [
  ['uses'],
  ['uses', 'the'],
  ['utilizes'],
  ['utilizes', 'the'],
  ['utilize'],
  ['utilize', 'the'],
  ['incorporates'],
  ['incorporates', 'the'],
  ['incorporate'],
  ['incorporate', 'the'],
  ['include'],
  ['include', 'the'],
  ['includes'],
  ['includes', 'the'],
  ['with'],
  ['with', 'the'],
  ['is', 'shipped', 'with'],
  ['is', 'shipped', 'with', 'the'],
  ['are', 'shipped', 'with'],
  ['are', 'shipped', 'with', 'the'],
  ['use'],
  ['use', 'the'],
  ['is', 'under'],
  ['is', 'under', 'the'],
  ['are', 'under'],
  ['are', 'under', 'the'],
  ['is', 'licensed', 'under'],
  ['is', 'licenced', 'under'],
  ['is', 'licensed', 'under', 'the'],
  ['is', 'licenced', 'under', 'the'],
  ['is', 'licensed', 'under', 'terms', 'of'],
  ['is', 'licenced', 'under', 'terms', 'of'],
  ['is', 'licensed', 'under', 'terms', 'of', 'the'],
  ['is', 'licenced', 'under', 'terms', 'of', 'the'],
  ['is', 'licensed', 'under', 'the', 'terms', 'of'],
  ['is', 'licenced', 'under', 'the', 'terms', 'of'],
  ['is', 'licensed', 'under', 'the', 'terms', 'of', 'the'],
  ['is', 'licenced', 'under', 'the', 'terms', 'of', 'the'],
  ['are', 'licensed', 'under'],
  ['are', 'licenced', 'under'],
  ['are', 'licensed', 'under', 'the'],
  ['are', 'licenced', 'under', 'the'],
  ['are', 'licensed', 'under', 'terms', 'of'],
  ['are', 'licenced', 'under', 'terms', 'of'],
  ['are', 'licensed', 'under', 'terms', 'of', 'the'],
  ['are', 'licenced', 'under', 'terms', 'of', 'the'],
  ['are', 'licensed', 'under', 'the', 'terms', 'of'],
  ['are', 'licenced', 'under', 'the', 'terms', 'of'],
  ['are', 'licensed', 'under', 'the', 'terms', 'of', 'the'],
  ['are', 'licenced', 'under', 'the', 'terms', 'of', 'the'],
  ['subject', 'to', 'terms', 'of'],
  ['subject', 'to', 'terms', 'of', 'the'],
  ['subject', 'to', 'the', 'terms', 'of'],
  ['subject', 'to', 'the', 'terms', 'of', 'the'],
]
const gnuFamilyPattern =
  /\b(?:gnu\s+(?:(affero)\s+|((?:lesser|library))\s+)?general\s+public\s+license|(agpl|lgpl|gpl)(?=\b|v\s*[0-9]))/
const gnuAdjacentSpdxPattern =
  /^\s*-\s*([0-9]+(?:\.[0-9]+)?)\s*-\s*(only|or-later)\b/
const gnuAdjacentLegacyPlusPattern =
  /^(?:-|\s*(?:version\s+|v)?)([0-9]+(?:\.[0-9]+)?)\+/
const gnuVersionPattern =
  /\b(?:either\s+)?version\s+([0-9]+(?:\.[0-9]+)?)\b|\bv\s*([0-9]+(?:\.[0-9]+)?)\b/

function normalizeGnuVersion(version: string): string {
  return version.includes('.') ? version : version + '.0'
}

function detectGnuNotice(text: string): GnuNotice | undefined {
  const strict = normalizeStrict(text)
  const familyMatch = gnuFamilyPattern.exec(strict)
  if (!familyMatch) return undefined

  let family: GnuFamily = 'GPL'
  if (familyMatch[1] || familyMatch[3] === 'agpl') {
    family = 'AGPL'
  } else if (familyMatch[2] || familyMatch[3] === 'lgpl') {
    family = 'LGPL'
  }

  const noticeStart = familyMatch.index
  const nearbyStart = familyMatch.index + familyMatch[0].length
  const nearbyText = strict.slice(nearbyStart, nearbyStart + 240)
  const paragraphEnd = nearbyText.search(/\n\s*\n/)
  const nearbyParagraph =
    paragraphEnd === -1 ? nearbyText : nearbyText.slice(0, paragraphEnd)
  const adjacentSpdxMatch = gnuAdjacentSpdxPattern.exec(nearbyText)
  if (adjacentSpdxMatch) {
    const parsed = parseGnuLicenseId(
      `${family}-${normalizeGnuVersion(adjacentSpdxMatch[1])}-${adjacentSpdxMatch[2]}`,
    )
    if (parsed) {
      const versionEnd = nearbyStart + adjacentSpdxMatch[0].length
      return {
        family: parsed.family,
        version: parsed.version,
        wording: strict.slice(noticeStart, versionEnd),
      }
    }
  }

  const adjacentLegacyPlusMatch = gnuAdjacentLegacyPlusPattern.exec(nearbyText)
  if (adjacentLegacyPlusMatch) {
    const parsed = parseGnuLicenseId(
      `${family}-${normalizeGnuVersion(adjacentLegacyPlusMatch[1])}-or-later`,
    )
    if (parsed) {
      const versionEnd = nearbyStart + adjacentLegacyPlusMatch[0].length
      return {
        family: parsed.family,
        version: parsed.version,
        wording: strict.slice(noticeStart, versionEnd),
      }
    }
  }

  const versionMatch = gnuVersionPattern.exec(nearbyParagraph)
  if (!versionMatch) {
    const wordingTail = strict.slice(nearbyStart, nearbyStart + 120)
    const sentenceEnd = wordingTail.search(/[.!?](?:\s|$)/)
    const noticeEnd =
      sentenceEnd === -1 ? nearbyStart + 120 : nearbyStart + sentenceEnd + 1
    return { family, wording: strict.slice(noticeStart, noticeEnd) }
  }

  const version = normalizeGnuVersion(versionMatch[1] || versionMatch[2])
  const versionEnd = nearbyStart + versionMatch.index + versionMatch[0].length
  const wordingTail = strict.slice(versionEnd, versionEnd + 160)
  const onlyMatch = /^\s*only\b/.exec(wordingTail)
  if (onlyMatch) {
    return {
      family,
      version,
      wording: strict.slice(noticeStart, versionEnd + onlyMatch[0].length),
    }
  }
  const sentenceEnd = wordingTail.search(/[.!?](?:\s|$)/)
  const noticeEnd =
    sentenceEnd === -1 ? versionEnd + 160 : versionEnd + sentenceEnd + 1

  return {
    family,
    version,
    wording: strict.slice(noticeStart, noticeEnd),
  }
}

function parseGnuLicenseId(
  licenseId: string,
): { family: GnuFamily; version: string } | undefined {
  const match = /^(AGPL|LGPL|GPL)-([0-9]+\.[0-9]+)-(?:only|or-later)$/.exec(
    licenseId,
  )
  if (!match) return undefined
  return { family: match[1] as GnuFamily, version: match[2] }
}

function isRelevantGnuCandidate(
  context: GnuReviewContext,
  licenseId: string,
): boolean {
  const parsed = parseGnuLicenseId(licenseId)
  if (!parsed || !context.notice) return true
  if (parsed.family !== context.notice.family) return false
  return !context.notice.version || parsed.version === context.notice.version
}

function hasStrongGnuBodyMatch(
  inputType: MatchResult['inputType'],
  score: MatchResult['score'],
): boolean {
  return (
    inputType === 'full-license-text' ||
    (inputType === 'mixed-license-text' && score.recall >= minGnuBodyRecall)
  )
}

function isRelevantGnuResult(
  context: GnuReviewContext,
  licenseId: string,
  input: string,
  inputType: MatchResult['inputType'],
  score: MatchResult['score'],
): boolean {
  const parsed = parseGnuLicenseId(licenseId)
  if (!parsed) return true
  const fullOrContainedBody = hasStrongGnuBodyMatch(inputType, score)
  if (!fullOrContainedBody) return isRelevantGnuCandidate(context, licenseId)
  if (
    isRelevantGnuCandidate(context, licenseId) &&
    score.recall >= minGnuNoticeFamilyBodyRecall
  ) {
    return true
  }
  if (
    score.recall >= minGnuBodyRecall &&
    score.precision >= minGnuBodyPrecision
  ) {
    return true
  }
  return hasThirdPartyGnuNoticeContext(input, context.notice)
}

function hasOrLaterWording(notice?: GnuNotice): boolean {
  if (!notice) return false
  if (
    /\b(?:a?gpl|lgpl)\s*-?\s*v?\s*[0-9]+(?:\.[0-9]+)?\+/.test(notice.wording) ||
    /\bgnu\s+(?:affero\s+|lesser\s+)?gpl\s*-?\s*v?\s*[0-9]+(?:\.[0-9]+)?\+/.test(
      notice.wording,
    ) ||
    /\bgnu\s+(?:affero\s+|(?:lesser|library)\s+)?general\s+public\s+license\s+(?:version\s+|v)?[0-9]+(?:\.[0-9]+)?\+/.test(
      notice.wording,
    )
  )
    return true

  const loose = normalizeLoose(notice.wording)
  return /\bor(?: at your option)? any later version\b|\beither version [0-9]+(?: [0-9]+)? of the license or\b|\b(?:gnu (?:affero )?(?:(?:lesser|library) )?general public license|(?:a?gpl|lgpl))(?: (?:version |v)?|v)[0-9]+(?: [0-9]+)? or (?:any )?later(?: version)?\b/.test(
    loose,
  )
}

function explicitGnuGrantKind(
  context: GnuReviewContext,
): 'only' | 'or-later' | undefined {
  if (!context.notice?.version) return undefined
  if (context.inputOrLater) return 'or-later'
  return /\bonly\b/.test(context.notice.wording) ? 'only' : undefined
}

function gnuManualReview(
  context: GnuReviewContext,
  licenseId: string,
): boolean {
  if (!isRelevantGnuCandidate(context, licenseId)) return false
  if (!gnuFamilyIds.has(licenseId)) return false
  if (context.notice && !context.notice.version) return true
  if (context.notice?.version && !explicitGnuGrantKind(context)) return true
  const wantsOrLater = licenseId.endsWith('-or-later')
  return wantsOrLater ? !context.inputOrLater : context.inputOrLater
}

function capConfidenceForInputType(
  confidence: Confidence,
  inputType: MatchResult['inputType'],
  score: MatchResult['score'],
): Confidence {
  if (
    inputType === 'mixed-license-text' &&
    (score.precision >= 0.82 || (score.recall >= 0.98 && score.precision > 0))
  ) {
    return confidence === 'Unknown' ? 'Possible' : confidence
  }

  if (inputType === 'license-notice') {
    if (score.precision >= 0.82 && score.recall >= 0.25)
      return confidence === 'Unknown'
        ? 'Likely'
        : confidence === 'Exact'
          ? 'Likely'
          : confidence
    return score.precision >= 0.55 ? 'Possible' : 'Unknown'
  }

  if (inputType === 'license-header') {
    if (score.precision >= 0.82 && score.f1 >= minHeaderF1ForLikely)
      return confidence === 'Unknown'
        ? 'Likely'
        : confidence === 'Exact'
          ? 'Likely'
          : confidence
    return score.precision >= 0.55 && score.f1 >= minHeaderF1ForPossible
      ? 'Possible'
      : 'Unknown'
  }
  return confidence
}

function hasThirdPartyGnuNoticeContext(
  input: string,
  notice: GnuNotice | undefined,
): boolean {
  if (!notice) return false

  const strict = normalizeStrict(input)
  const noticeIndex = strict.indexOf(notice.wording)
  if (noticeIndex < 0) return false

  const words = aliasWords(
    strict.slice(Math.max(0, noticeIndex - 240), noticeIndex),
  )

  for (let index = 0; index < words.length; index += 1) {
    if (!thirdPartyGnuNoticeNouns.has(words[index])) continue

    const stateSearchEnd = Math.min(words.length, index + 16)
    for (
      let stateStart = index + 1;
      stateStart < stateSearchEnd;
      stateStart += 1
    ) {
      if (
        thirdPartyGnuNoticeStates.some((state) => {
          if (!matchesWordsAt(words, stateStart, state)) return false

          const stateEnd = stateStart + state.length
          return (
            stateEnd === words.length ||
            words
              .slice(stateEnd)
              .every((word) => thirdPartyGnuNoticeModifiers.has(word))
          )
        })
      ) {
        return true
      }
    }
  }
  return false
}

function resultFromEntry(
  entry: LicenseEntry,
  input: string,
  inputType: MatchResult['inputType'],
  gnuContext: GnuReviewContext,
): MatchResult {
  const score = scoreText(input, entry.text)
  const isRelevant = isRelevantGnuResult(
    gnuContext,
    entry.licenseId,
    input,
    inputType,
    score,
  )
  const needsManualReview = gnuManualReview(gnuContext, entry.licenseId)
  const cappedConfidence = capConfidenceForInputType(
    confidenceFromScore(score),
    inputType,
    score,
  )
  const confidence = !isRelevant
    ? 'Unknown'
    : needsManualReview && cappedConfidence !== 'Unknown'
      ? 'Possible'
      : cappedConfidence
  return {
    licenseId: entry.licenseId,
    name: entry.name,
    confidence,
    inputType,
    score,
    flags: {
      isDeprecated: entry.isDeprecated,
      isOsiApproved: entry.isOsiApproved,
      isFsfLibre: entry.isFsfLibre,
      needsManualReview,
      isLegacyId: legacyIds.has(entry.licenseId),
    },
    explanation: buildExplanation(
      entry.licenseId,
      inputType,
      score.f1,
      needsManualReview,
    ),
    seeAlso: entry.seeAlso,
  }
}

function resultFromNamedHeader(
  entry: LicenseEntry,
  gnuContext: GnuReviewContext,
  legacyAlias?: LegacyAlias,
): MatchResult {
  const score = legacyAlias
    ? { precision: 0, recall: 0, f1: 0 }
    : { precision: 1, recall: 1, f1: 1 }
  const needsManualReview = legacyAlias
    ? true
    : gnuManualReview(gnuContext, entry.licenseId)
  return {
    licenseId: entry.licenseId,
    name: entry.name,
    inputType: 'license-header',
    confidence: needsManualReview ? 'Possible' : 'Likely',
    score,
    flags: {
      isDeprecated: entry.isDeprecated,
      isOsiApproved: entry.isOsiApproved,
      isFsfLibre: entry.isFsfLibre,
      isLegacyId: legacyAlias ? true : legacyIds.has(entry.licenseId),
      needsManualReview,
    },
    explanation:
      legacyAlias?.message ||
      buildExplanation(
        entry.licenseId,
        'license-header',
        score.f1,
        needsManualReview,
      ),
    seeAlso: entry.seeAlso,
  }
}

function legacySpdxCandidateResults(
  legacyAlias: LegacyAlias,
  inputType: MatchResult['inputType'],
  licenseById: Map<string, LicenseEntry>,
): MatchResult[] {
  return legacyAlias.candidates
    .map((id) => licenseById.get(id))
    .filter((entry): entry is LicenseEntry => Boolean(entry))
    .map((entry) => ({
      licenseId: entry.licenseId,
      name: entry.name,
      confidence: 'Possible' as const,
      inputType,
      score: { precision: 0, recall: 0, f1: 0 },
      flags: {
        isDeprecated: entry.isDeprecated,
        isOsiApproved: entry.isOsiApproved,
        isFsfLibre: entry.isFsfLibre,
        isLegacyId: true,
        needsManualReview: true,
      },
      explanation: legacyAlias.message || 'Legacy SPDX ID detected.',
      seeAlso: entry.seeAlso,
    }))
}

function exactSpdxResults(
  ids: string[],
  inputType: MatchResult['inputType'],
  licenseById: Map<string, LicenseEntry>,
): MatchResult[] {
  return ids
    .map((id) => licenseById.get(id))
    .filter((entry): entry is LicenseEntry => Boolean(entry))
    .map((entry) => ({
      licenseId: entry.licenseId,
      name: entry.name,
      confidence: 'Exact' as const,
      inputType,
      score: { precision: 1, recall: 1, f1: 1 },
      flags: {
        isDeprecated: entry.isDeprecated,
        isOsiApproved: entry.isOsiApproved,
        isFsfLibre: entry.isFsfLibre,
        needsManualReview: false,
        isLegacyId: false,
      },
      explanation: buildExplanation(entry.licenseId, inputType, 1, false),
      seeAlso: entry.seeAlso,
    }))
}

function markGnuAmbiguity(
  results: MatchResult[],
  context: GnuReviewContext,
): MatchResult[] {
  return results.map((result) => {
    if (result.confidence === 'Unknown') return result
    if (context.inputOrLater && parseGnuLicenseId(result.licenseId)) {
      return result
    }

    const counterpart = gnuCounterparts.get(result.licenseId)
    const paired = counterpart
      ? results.find((candidate) => candidate.licenseId === counterpart)
      : undefined
    const fullOrContainedLicense =
      result.inputType === 'full-license-text' ||
      (result.inputType === 'mixed-license-text' &&
        result.score.recall >= minGnuBodyRecall)
    const ambiguous =
      fullOrContainedLicense &&
      paired &&
      (result.score.f1 >= 0.9 || result.score.precision >= 0.55) &&
      Math.abs(result.score.precision - paired.score.precision) < 0.02
    if (!ambiguous) return result
    return {
      ...result,
      confidence: 'Possible',
      flags: { ...result.flags, needsManualReview: true },
      explanation: buildExplanation(
        result.licenseId,
        result.inputType,
        result.score.f1,
        true,
      ),
    }
  })
}

function sortResults(results: MatchResult[]): MatchResult[] {
  return [...results].sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return confidenceOrder[b.confidence] - confidenceOrder[a.confidence]
    }
    if (a.flags.needsManualReview !== b.flags.needsManualReview) {
      return a.flags.needsManualReview ? 1 : -1
    }
    if (b.score.f1 !== a.score.f1) return b.score.f1 - a.score.f1
    return b.score.precision - a.score.precision
  })
}

function deduplicateBestResultsByLicenseId(
  results: MatchResult[],
): MatchResult[] {
  const resultsByLicenseId = new Map<string, MatchResult>()
  for (const result of results) {
    const existing = resultsByLicenseId.get(result.licenseId)
    resultsByLicenseId.set(
      result.licenseId,
      existing ? sortResults([existing, result])[0] : result,
    )
  }
  return Array.from(resultsByLicenseId.values())
}

function normalizeHeaderLoose(text: string): string {
  return normalizeLoose(text.replace(/\+/g, ' plus '))
    .replace(/\blicence\b/g, 'license')
    .replace(/\blicences\b/g, 'licenses')
    .replace(/\blicenced\b/g, 'licensed')
    .replace(/\blicencing\b/g, 'licensing')
}

function aliasWords(text: string): string[] {
  return normalizeHeaderLoose(text).split(' ').filter(Boolean)
}

function hasOpeningLicenseTitle(text: string): boolean {
  const firstLine = text.match(/^[^\r\n]{1,120}/)?.[0] || ''
  const loose = normalizeHeaderLoose(firstLine)
  const words = loose.split(' ').filter(Boolean)
  return (
    words.length <= 8 &&
    /\blicen[cs]e\b/.test(loose) &&
    !/\blicen[cs]ed\b/.test(loose)
  )
}

function hasFullLicenseTermsMarker(text: string): boolean {
  return /terms and conditions|redistribution and use|copying distribution and modification/.test(
    normalizeHeaderLoose(text),
  )
}

function getHeaderAliases(licenses: LicenseEntry[]): HeaderAlias[] {
  const cached = headerAliasCache.get(licenses)
  if (cached) return cached

  const byKey = new Map<string, HeaderAlias>()
  const addAliasText = (
    licenseId: string,
    text: string,
    legacyAlias?: LegacyAlias,
    allowBareTitle = true,
  ): void => {
    const words = aliasWords(text)
    if (words.length === 0) return
    byKey.set(licenseId + ':' + words.join(' '), {
      licenseId,
      words,
      allowBareTitle,
      legacyAlias,
    })
  }

  const addAlias = (
    licenseId: string,
    text: string,
    legacyAlias?: LegacyAlias,
    allowBareTitle = true,
  ): void => {
    addAliasText(licenseId, text, legacyAlias, allowBareTitle)
    if (!/\bor later\b/i.test(text)) return
    for (const orLaterPhrase of [
      'or any later version',
      'or at your option any later version',
    ]) {
      addAliasText(
        licenseId,
        text.replace(/\bor later\b/gi, orLaterPhrase),
        legacyAlias,
        allowBareTitle,
      )
    }
  }

  for (const entry of licenses) {
    addAlias(entry.licenseId, entry.licenseId)
    addAlias(entry.licenseId, entry.name)
    if (entry.licenseId === 'BlueOak-1.0.0') {
      addAlias(entry.licenseId, 'Blue Oak Model License')
    }
    const idVersion = /^([A-Za-z]+)-(\d+(?:\.\d+)+)$/.exec(entry.licenseId)
    if (idVersion) {
      const [, prefix, version] = idVersion
      addAlias(entry.licenseId, prefix + ' v' + version)
      addAlias(entry.licenseId, prefix + ' v ' + version)
      const majorVersion = /^(\d+)\.0$/.exec(version)?.[1]
      if (majorVersion) {
        addAlias(entry.licenseId, prefix + ' v' + majorVersion)
        addAlias(entry.licenseId, prefix + ' v ' + majorVersion)
      }
    }
    for (const match of entry.name.matchAll(/\bv?(\d+(?:\.\d+)+)\b/g)) {
      const matchedVersion = match[0]
      const version = match[1]
      addAlias(entry.licenseId, entry.name.replace(matchedVersion, version))
      addAlias(
        entry.licenseId,
        entry.name.replace(matchedVersion, 'version ' + version),
      )
      addAlias(
        entry.licenseId,
        entry.name.replace(matchedVersion, 'v ' + version),
      )
      addAlias(
        entry.licenseId,
        entry.name.replace(matchedVersion, 'v' + version),
      )
      const majorVersion = /^(\d+)\.0$/.exec(version)?.[1]
      if (majorVersion) {
        addAlias(
          entry.licenseId,
          entry.name.replace(matchedVersion, majorVersion),
        )
        addAlias(
          entry.licenseId,
          entry.name.replace(matchedVersion, 'version ' + majorVersion),
        )
        addAlias(
          entry.licenseId,
          entry.name.replace(matchedVersion, 'v ' + majorVersion),
        )
        addAlias(
          entry.licenseId,
          entry.name.replace(matchedVersion, 'v' + majorVersion),
        )
      }
    }
  }
  for (const alias of namedHeaderAliases) {
    for (const text of alias.aliases)
      addAlias(alias.licenseId, text, undefined, false)
  }
  for (const alias of legacyAliases) {
    for (const licenseId of alias.candidates)
      addAlias(licenseId, alias.legacyId, alias)
  }

  const aliases = Array.from(byKey.values()).sort(
    (a, b) => b.words.length - a.words.length,
  )
  const aliasesByLicenseId = new Map<string, string[][]>()
  for (const alias of aliases) {
    const sameLicenseWords = aliasesByLicenseId.get(alias.licenseId) || []
    sameLicenseWords.push(alias.words)
    aliasesByLicenseId.set(alias.licenseId, sameLicenseWords)
  }
  for (const alias of aliases) {
    alias.sameLicenseWords = aliasesByLicenseId.get(alias.licenseId)
  }
  headerAliasCache.set(licenses, aliases)
  return aliases
}

const projectHeaderContextPattern =
  /\b(?:this|it|they|these|those|project|codebase|software|package|repository|repo|files|library|program|application|source|code|our|main|primary|command|line|interface|browser|build|tool|app|cli)\b/
const strongProjectHeaderContextPattern =
  /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)|(?:main|primary) (?:project )?(?:source code|source|code|software|package|library|program|application|repository|repo|files|tool|app|cli)|command line interface|browser build)\b/
const thirdPartyHeaderContextPattern =
  /\b(?:third party|bundled|vendored)\b.{0,240}\b(?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?$/
const reducedThirdPartyHeaderContextPattern =
  /\b(?:(?:the|a|an|this|that) )?(?:third party|bundled|vendored|external|included|embedded)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:helper|dependency|component|module|library|package|parser|tool|asset|assets|font|fonts|plugin|extension|add on|addon|application|program|product|service)(?: source| code| software| library| component| module| package)?$/
const externalComponentHeaderContextPattern =
  /\bexternal(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:component|module|library|package|parser|helper|tool|asset|assets|font|fonts|plugin|extension|add on|addon)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,10} (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?$/
const dependencyHeaderContextPattern =
  /\b(?:(?:the|a|an|this|that|these|those|each|every|any) )?(?:external )?(?:dependency|dependencies)(?! (?:free|less)\b)(?: (?!and\b|or\b|but\b|is\b|are\b|was\b|were\b|has\b|have\b|had\b|be\b|been\b|being\b)[a-z0-9<>]+){0,10} (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?$/
const projectDependencyHeaderContextPattern =
  /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|ships with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!and\b|or\b|but\b|no\b)[a-z0-9<>]+){0,6} (?:dependency|dependencies|component|module|library|package|parser|helper|tool|asset|assets|font|fonts|plugin|extension|add on|addon)(?: (?!and\b|or\b|but\b|the\b|this\b|these\b|those\b|our\b|project\b|codebase\b|software\b|package\b|repository\b|repo\b|library\b|program\b|application\b|code\b|source\b|files\b|is\b|are\b|was\b|were\b|has\b|have\b)[a-z0-9<>]+){0,6}$/
const namedDependencyHeaderContextPattern =
  /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|ships with|ship with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!and\b|or\b|but\b|no\b|which\b|that\b|is\b|are\b|was\b|were\b|has\b|have\b)[a-z0-9<>]+){1,8} (?:which|that) (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?$/
const coordinatedNamedDependencyHeaderContextPattern =
  /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|ships with|ship with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!and\b|or\b|but\b|no\b|which\b|that\b|is\b|are\b|was\b|were\b|has\b|have\b)[a-z0-9<>]+){1,8} (?:and|or)(?: (?!and\b|or\b|but\b|no\b|which\b|that\b|is\b|are\b|was\b|were\b|has\b|have\b)[a-z0-9<>]+){1,8}(?: (?:(?:which|that)|they) (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?)?$/
const projectUsedPackageHeaderContextPattern =
  /\b(?:(?:the|a|an) )?(?:[a-z0-9<>]+ ){1,6}(?:dependency|component|module|library|package|parser|helper|tool|asset|assets|font|fonts|plugin|extension|add on|addon)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,6} (?:used by|used in|bundled by|included by|vendored by|included in|shipped with) (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?$/
const namedDependencyIntroPattern =
  /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|ships with|ship with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!and\b|or\b|but\b|no\b|which\b|that\b|is\b|are\b|was\b|were\b|has\b|have\b)[a-z0-9<>]+){1,8}$/
const bundledNamedSubjectIntroPattern =
  /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|ships with|ship with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!which\b|that\b|is\b|are\b|was\b|were\b|has\b|have\b)[a-z0-9<>]+){1,24}(?![\s\S])/
const namedDependencyAppositiveIntroPattern =
  /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:uses|use|includes|include|bundles|bundle|vendors|vendor|ships with|ship with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!and\b|or\b|but\b|no\b|which\b|that\b|is\b|are\b|was\b|were\b|has\b|have\b)[a-z0-9<>]+){1,8}$/
const namedDependencyCarrySubjectStopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'been',
  'being',
  'browser',
  'build',
  'bundle',
  'bundles',
  'but',
  'cli',
  'code',
  'codebase',
  'command',
  'contain',
  'contains',
  'currently',
  'files',
  'has',
  'have',
  'include',
  'includes',
  'interface',
  'is',
  'library',
  'line',
  'main',
  'no',
  'now',
  'or',
  'our',
  'package',
  'primary',
  'program',
  'project',
  'repo',
  'repository',
  'ship',
  'ships',
  'software',
  'source',
  'that',
  'the',
  'these',
  'this',
  'those',
  'tool',
  'use',
  'uses',
  'vendor',
  'vendors',
  'was',
  'we',
  'were',
  'which',
  'with',
])
const namedDependencyCarryTrailingAdverbs = new Set([
  'currently',
  'now',
  'presently',
])
const namedDependencyCarryStatePhrases = [
  ['continues', 'to', 'be'],
  ['continue', 'to', 'be'],
  ['is', 'still'],
  ['are', 'still'],
  ['has', 'since', 'been'],
  ['has', 'been'],
  ['have', 'been'],
  ['had', 'been'],
  ['is'],
  ['are'],
  ['was'],
  ['were'],
  ['has'],
  ['have'],
  ['remains'],
  ['remain'],
]
const includedThirdPartyHeaderContextPattern =
  /\b(?:includes|include|included|uses|use|bundles|bundle|vendors|vendor|ships with|ship with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,8} (?:third party|bundled|vendored|external|included|embedded)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,8}$/

const headerContextCharacterLimit = 1024
const licenseHeaderPatternExpression =
  /\b(?:(?:(?:re)?licen[cs]ed|released|distributed|provided|offered|covered|made available|available|(?:is|are) available) under (?:the )?(?:terms (?:and conditions )?of (?:the )?)?|released (?:into|to) (?:the )?public domain under (?:the )?(?=cc0\b|creative commons zero\b)|dedicated to (?:the )?public domain under (?:the )?(?=cc0\b|creative commons zero\b)|governed by (?:the )?|(?:is|are) under (?:the )?|subject to (?:(?:the )?terms (?:and conditions )?of (?:the )?|the )|(?:(?:this|the) (?:(?:main|primary) )?(?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli|source code|code|source|work)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application|work)|(?:main|primary) (?:project )?(?:source code|source|code|software|package|library|program|application|repository|repo|files|tool|app|cli)|command line interface|browser build) (?:is|are) (?!under\b|available\b|(?:re)?licen[cs]ed\b|released\b|distributed\b|provided\b|offered\b|covered\b|governed\b|made\b|subject\b))/g

function cloneLicenseHeaderPattern(): RegExp {
  return new RegExp(
    licenseHeaderPatternExpression.source,
    licenseHeaderPatternExpression.flags,
  )
}

function resetLicenseHeaderPattern(pattern: RegExp): RegExp {
  pattern.lastIndex = 0
  return pattern
}

const licenseHeaderContextPattern = cloneLicenseHeaderPattern()
const previousLicenseHeaderPrefixPattern = cloneLicenseHeaderPattern()
const explicitLicenseHeaderCuePattern = cloneLicenseHeaderPattern()
const currentLicenseSegmentBoundaryPattern = cloneLicenseHeaderPattern()
const wordsAfterLicenseHeaderPattern = cloneLicenseHeaderPattern()
const currentProjectNamedHeaderPattern = cloneLicenseHeaderPattern()
const projectLicenseHeaderContextPattern = cloneLicenseHeaderPattern()
const restrictiveProjectLicenseHeaderBodyPattern = cloneLicenseHeaderPattern()
const thirdPartyLicenseBodySegmentPattern = cloneLicenseHeaderPattern()

function isRelicenseHeaderText(text: string): boolean {
  return /^relicen[cs]ed under\b/.test(text)
}

function isAdjectiveLicenseHeaderPrefix(matchText: string): boolean {
  return /(?:^| )(?:is|are) $/.test(matchText)
}

function isGenericUnderLicenseHeaderPrefix(matchText: string): boolean {
  return /(?:^| )(?:is|are) under $/.test(matchText)
}

function isLicenseHeaderBoundary(
  text: string,
  match: RegExpExecArray,
  licenseAliasWords: string[][],
): boolean {
  if (
    !match[0].startsWith('subject to ') &&
    !isAdjectiveLicenseHeaderPrefix(match[0])
  )
    return true
  return hasPotentialHeaderAlias(
    wordsAfterHeaderMatch(text, match.index + match[0].length),
    licenseAliasWords,
  )
}

function boundedHeaderPrefix(loose: string, headerIndex: number): string {
  const startIndex = Math.max(0, headerIndex - headerContextCharacterLimit)
  let prefix = loose.slice(startIndex, headerIndex).trim()
  if (startIndex > 0) prefix = prefix.replace(/^\S+\s*/, '').trim()
  return prefix
}

function licenseHeaderPrefix(
  loose: string,
  headerIndex: number,
  wordCount: number,
): string {
  return boundedHeaderPrefix(loose, headerIndex)
    .split(' ')
    .slice(-wordCount)
    .join(' ')
}

function licenseHeaderContext(
  loose: string,
  headerIndex: number,
  licenseAliasWords: string[][],
): string {
  const prefix = boundedHeaderPrefix(loose, headerIndex)
  const headerPattern = resetLicenseHeaderPattern(licenseHeaderContextPattern)
  let previousHeader: RegExpExecArray | undefined
  let match: RegExpExecArray | null
  while ((match = headerPattern.exec(prefix))) {
    if (isLicenseHeaderBoundary(prefix, match, licenseAliasWords)) {
      previousHeader = match
    }
  }
  if (!previousHeader || previousHeader.index === undefined) return prefix
  return prefix.slice(previousHeader.index + previousHeader[0].length).trim()
}

function previousLicenseHeaderPrefix(
  loose: string,
  headerIndex: number,
  licenseAliasWords: string[][],
): string {
  const prefix = boundedHeaderPrefix(loose, headerIndex)
  const headerPattern = resetLicenseHeaderPattern(
    previousLicenseHeaderPrefixPattern,
  )
  let previousHeader: RegExpExecArray | undefined
  let match: RegExpExecArray | null
  while ((match = headerPattern.exec(prefix))) {
    if (isLicenseHeaderBoundary(prefix, match, licenseAliasWords)) {
      previousHeader = match
    }
  }
  if (!previousHeader || previousHeader.index === undefined) return ''
  return prefix
    .slice(0, previousHeader.index)
    .trim()
    .split(' ')
    .slice(-16)
    .join(' ')
}

function endsWithWords(
  words: string[],
  endIndex: number,
  phrase: string[],
): boolean {
  if (endIndex < phrase.length) return false
  return phrase.every(
    (word, offset) => words[endIndex - phrase.length + offset] === word,
  )
}

function namedDependencyStateVerbStart(words: string[]): number | undefined {
  let endIndex = words.length
  if (namedDependencyCarryTrailingAdverbs.has(words[endIndex - 1])) {
    endIndex -= 1
  }

  for (const phrase of namedDependencyCarryStatePhrases) {
    if (endsWithWords(words, endIndex, phrase)) {
      return endIndex - phrase.length
    }
  }
  return undefined
}

function isNamedDependencyCarrySubject(words: string[]): boolean {
  if (words.length === 0) return false
  if (words.length === 1 && (words[0] === 'it' || words[0] === 'they')) {
    return true
  }
  return words.every((word) => !namedDependencyCarrySubjectStopWords.has(word))
}

function hasNamedDependencyCarryHeaderContext(prefix: string): boolean {
  const words = prefix.split(' ').filter(Boolean)
  const verbStart = namedDependencyStateVerbStart(words)
  if (verbStart === undefined) return false

  for (let wordCount = 1; wordCount <= 3; wordCount += 1) {
    const subjectStart = verbStart - wordCount
    if (subjectStart < 0) break

    const subjectWords = words.slice(subjectStart, verbStart)
    if (!isNamedDependencyCarrySubject(subjectWords)) continue
    if (
      namedDependencyIntroPattern.test(
        words.slice(0, subjectStart).join(' '),
      ) ||
      coordinatedNamedDependencyHeaderContextPattern.test(
        words.slice(0, subjectStart).join(' '),
      )
    ) {
      return true
    }
  }

  return false
}

function hasBundledNamedSubjectHeaderContext(prefix: string): boolean {
  const words = prefix.split(' ').filter(Boolean)
  const verbStart = namedDependencyStateVerbStart(words)
  if (verbStart === undefined) return false

  for (let wordCount = 1; wordCount <= 3; wordCount += 1) {
    const subjectStart = verbStart - wordCount
    if (subjectStart < 0) break

    const subjectWords = words.slice(subjectStart, verbStart)
    if (!isNamedDependencyCarrySubject(subjectWords)) continue
    if (
      bundledNamedSubjectIntroPattern.test(
        words.slice(0, subjectStart).join(' '),
      )
    ) {
      return true
    }
  }

  return false
}

function hasThirdPartyPredicateNamedSubjectHeaderContext(
  prefix: string,
): boolean {
  const words = prefix.split(' ').filter(Boolean)
  const verbStart = namedDependencyStateVerbStart(words)
  if (verbStart === undefined) return false

  for (let wordCount = 1; wordCount <= 3; wordCount += 1) {
    const subjectStart = verbStart - wordCount
    if (subjectStart < 0) break

    const subjectWords = words.slice(subjectStart, verbStart)
    if (!isNamedDependencyCarrySubject(subjectWords)) continue
    if (
      /\b(?:which|that) (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)? (?:third party|bundled|vendored|external|included|embedded)$/.test(
        words.slice(0, subjectStart).join(' '),
      )
    ) {
      return true
    }
  }

  return false
}

function hasThirdPartyHeaderContext(prefix: string): boolean {
  return (
    thirdPartyHeaderContextPattern.test(prefix) ||
    reducedThirdPartyHeaderContextPattern.test(prefix) ||
    externalComponentHeaderContextPattern.test(prefix) ||
    dependencyHeaderContextPattern.test(prefix) ||
    projectDependencyHeaderContextPattern.test(prefix) ||
    namedDependencyHeaderContextPattern.test(prefix) ||
    coordinatedNamedDependencyHeaderContextPattern.test(prefix) ||
    namedDependencyAppositiveIntroPattern.test(prefix) ||
    projectUsedPackageHeaderContextPattern.test(prefix) ||
    hasNamedDependencyCarryHeaderContext(prefix) ||
    hasThirdPartyPredicateNamedSubjectHeaderContext(prefix) ||
    includedThirdPartyHeaderContextPattern.test(prefix)
  )
}

function hasProjectSubjectHeaderContext(prefix: string): boolean {
  return /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application|code|source|work)|(?:these|those) files|(?:this|the) source files|our (?:project|code|source|software|library|package|repository|repo|program|application|files|work)|(?:main|primary) (?:project )?(?:source|code|software|package|library|program|application|repository|repo|files))\b(?: (?!but\b)[a-z0-9<>]+){0,12} (?:continues to be|continue to be|is still|are still|is|are|was|were|has|have)(?: now| currently| presently)?$/.test(
    prefix,
  )
}

function hasEmbeddedProjectSubjectHeaderContext(prefix: string): boolean {
  if (
    /^(?:(?:the|this|that|our) )?source code (?:of|for) (?:(?:this|the|our) )?(?:project|codebase|software|package|repository|repo|library|program|application)(?: (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?)?$/.test(
      prefix,
    )
  )
    return false
  return /\b(?:(?:the|a|an|this|that) )?(?:(?:(?:third party|bundled|vendored|external|included|embedded) )?(?:dependenc(?:y|ies)|components?|modules?|librar(?:y|ies)|packages?|code|source|software|helpers?|parsers?|tools?|assets?|plugins?|extensions?|add ons?|addons?)(?: (?!and\b|or\b|but\b|by\b|for\b|from\b|of\b|in\b|inside\b|into\b|onto\b|through\b|throughout\b|to\b|with\b|within\b|as\b)[a-z0-9<>]+){1,8}|(?:third party|bundled|vendored|external|included|embedded) (?:dependenc(?:y|ies)|components?|modules?|librar(?:y|ies)|packages?|code|source|software|helpers?|parsers?|tools?|assets?|plugins?|extensions?|add ons?|addons?)(?: (?!and\b|or\b|but\b|by\b|for\b|from\b|of\b|in\b|inside\b|into\b|onto\b|through\b|throughout\b|to\b|with\b|within\b|as\b)[a-z0-9<>]+){0,8}|(?:dependenc(?:y|ies)|components?|modules?|librar(?:y|ies)|packages?|helpers?|parsers?|tools?|assets?|plugins?|extensions?|add ons?|addons?) (?:of|for|in|inside|within)) (?:by|for|from|of|in|inside|into|onto|through|throughout|to|with|within|as part of)? ?(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application))(?: (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?)?$/.test(
    prefix,
  )
}

function hasTrailingThirdPartySubjectContext(prefix: string): boolean {
  return /\b(?:(?:the|a|an|this|that) )?(?:third party|bundled|vendored|external|included|embedded)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:helper|dependency|component|module|library|package|parser|tool|asset|assets|font|fonts|plugin|extension|add on|addon|application|program|product|service)(?: source| code| software| library| component| module| package)?(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,10} (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?$/.test(
    prefix,
  )
}

function hasNoDependencyProjectHeaderContext(prefix: string): boolean {
  return /\bno (?:external )?dependenc(?:y|ies)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:is|are|was|were|has|have)(?: now| currently| presently)?$/.test(
    prefix,
  )
}

function hasNoDependencyAsideContext(prefix: string): boolean {
  return (
    hasProjectHeaderContext(prefix) &&
    /\bno (?:external )?dependenc(?:y|ies)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?$/.test(
      prefix,
    )
  )
}

function startsWithDependencySubject(prefix: string): boolean {
  return /^\s*(?:(?:the|a|an|this|that|these|those|each|every|any) )?(?:external )?(?:dependency|dependencies)(?! (?:free|less)\b)\b/.test(
    prefix,
  )
}

function hasGenericComponentHeaderContext(prefix: string): boolean {
  return /\b(?:the|a|an) (?:plugin|extension|add on|addon)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)(?: now| currently| presently)?$/.test(
    prefix,
  )
}

function isThirdPartyOwnedHeaderContext(prefix: string): boolean {
  if (
    hasNoDependencyProjectHeaderContext(prefix) ||
    (hasNoDependencyAsideContext(prefix) &&
      hasProjectSubjectHeaderContext(prefix))
  )
    return false
  if (
    projectDependencyHeaderContextPattern.test(prefix) ||
    namedDependencyHeaderContextPattern.test(prefix) ||
    coordinatedNamedDependencyHeaderContextPattern.test(prefix) ||
    projectUsedPackageHeaderContextPattern.test(prefix) ||
    hasNamedDependencyCarryHeaderContext(prefix) ||
    externalComponentHeaderContextPattern.test(prefix) ||
    hasTrailingThirdPartySubjectContext(prefix) ||
    hasThirdPartyPredicateNamedSubjectHeaderContext(prefix) ||
    hasEmbeddedProjectSubjectHeaderContext(prefix) ||
    hasGenericComponentHeaderContext(prefix)
  )
    return true
  if (hasNoDependencyAsideContext(prefix)) return false
  if (/\bthis bundled project\b/.test(prefix)) return false
  if (startsWithDependencySubject(prefix)) return true
  if (dependencyHeaderContextPattern.test(prefix)) return true
  if (
    hasProjectSubjectHeaderContext(prefix) &&
    !startsWithDependencySubject(prefix)
  )
    return false
  return hasThirdPartyHeaderContext(prefix)
}

function isScopedAwayLicenseHeaderContext(prefix: string): boolean {
  if (/^copyright(?: [a-z0-9<>]+){0,12}$/.test(prefix)) return false
  if (
    /^(?:(?:the|this|that|our|a|an) )?(?:documentation|docs|test|tests|sample|samples|example|examples|fixture|fixtures) code (?:in|within|inside|for|of) (?:(?:this|the|our) )?(?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli|code|source|work)(?: (?:is|are|was|were|has|have|remains|remain))?$/.test(
      prefix,
    )
  )
    return true
  if (
    /^(?:(?:the|this|that|these|those|our) )?(?:docs|documentation|manual|manuals|guide|guides|example|examples|sample|samples|test|tests|fixture|fixtures|asset|assets|image|images|font|fonts|readme|website|site) for (?:(?:this|the|our) )?(?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli|code|source|work)(?: (?:is|are|was|were|has|have|remains|remain))?$/.test(
      prefix,
    )
  )
    return true
  if (
    /^(?:(?:the|this|that|these|those|our) )?(?:(?!no\b|not\b|neither\b|nor\b|which\b|has\b|have\b|had\b|without\b|part\b)[a-z0-9<>]+ ){0,5}(?:sample|samples|test|tests|example|examples) code(?: (?:is|are|was|were|has|have|remains|remain))?$/.test(
      prefix,
    )
  )
    return true
  return /^(?:(?:the|this|that|these|those|our) )?(?:(?!no\b|not\b|neither\b|nor\b|which\b|has\b|have\b|had\b|without\b|part\b)[a-z0-9<>]+ ){0,5}(?:docs|documentation|manual|manuals|guide|guides|example|examples|sample|samples|test|tests|fixture|fixtures|asset|assets|image|images|font|fonts|readme|website|site)(?: (?!and\b|or\b|but\b|no\b|not\b|neither\b|nor\b|which\b|has\b|have\b|had\b|without\b|part\b|project\b|code\b|source\b|software\b|package\b|library\b|program\b|application\b|repo\b|repository\b)[a-z0-9<>]+){0,8}(?: (?:is|are|was|were|has|have|remains|remain))?$/.test(
    prefix,
  )
}

function hasProjectHeaderContext(prefix: string): boolean {
  return projectHeaderContextPattern.test(prefix)
}

function hasStrongProjectHeaderContext(prefix: string): boolean {
  return strongProjectHeaderContextPattern.test(prefix)
}

function hasExplicitThirdPartyReferenceContext(prefix: string): boolean {
  return (
    /\b(?:it|they) (?:continues to be|continue to be|is still|are still|is|are|remains|remain)(?: now| currently| presently)?$/.test(
      prefix,
    ) ||
    /\bits(?: (?:source|code|software|library|component|module|package))? (?:continues to be|continue to be|is still|are still|is|are|remains|remain)(?: now| currently| presently)?$/.test(
      prefix,
    ) ||
    /\b(?:the|this|that) (?:helper|dependency|component|module|library|package|parser|tool|asset|assets|font|fonts|plugin|extension|add on|addon)(?: source| code| software| library| component| module| package)? (?:continues to be|continue to be|is still|are still|is|are|remains|remain)(?: now| currently| presently)?$/.test(
      prefix,
    )
  )
}

function hasWeakThirdPartyReferenceContext(prefix: string): boolean {
  return (
    /\band (?:continues to be|continue to be|is still|are still|is|are|remains|remain)(?: now| currently| presently)?$/.test(
      prefix,
    ) || hasExplicitThirdPartyReferenceContext(prefix)
  )
}

function hasCarriedThirdPartyHeaderContext(
  loose: string,
  headerIndex: number,
  licenseAliasWords: string[][],
): boolean {
  const previousPrefix = previousLicenseHeaderPrefix(
    loose,
    headerIndex,
    licenseAliasWords,
  )
  const contextPrefix = licenseHeaderContext(
    loose,
    headerIndex,
    licenseAliasWords,
  )
    .split(' ')
    .slice(-16)
    .join(' ')
  const previousHasProject = hasProjectHeaderContext(previousPrefix)
  const hasExplicitThirdPartyReference =
    hasExplicitThirdPartyReferenceContext(contextPrefix)
  return (
    hasThirdPartyHeaderContext(previousPrefix) &&
    (previousHasProject
      ? hasExplicitThirdPartyReference
      : !hasStrongProjectHeaderContext(contextPrefix) &&
        hasWeakThirdPartyReferenceContext(contextPrefix))
  )
}

function hasHistoricalRelicenseContext(contextPrefix: string): boolean {
  return /\b(?:(?:was|were|had been)(?: [a-z0-9]+){0,3} )?(?:previously|formerly|originally|initially|first|once)(?: [a-z0-9]+){0,2}$/.test(
    contextPrefix,
  )
}

const noPartHeaderSubjectPattern =
  '(?:(?:this|the) (?:(?:main|primary) )?(?:project|codebase|software|package|repository|repo|library|program|application|source code|source|code|work|tool|app|cli|browser build|command line interface)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application|work|tool|app|cli)|(?:main|primary) (?:project )?(?:source code|source|code|software|package|library|program|application|repository|repo|files|tool|app|cli)|(?:file|files|code|source|software|component|module|project|work|tool|app|cli))'
const noPartHeaderStatePattern =
  '(?:is|are|was|were|has|have|had|can|will|be|been|being|now|currently|presently|yet|ever|actually|explicitly|itself|directly)'
const noPartHeaderQualifierPattern =
  '(?: (?!is\\b|are\\b|was\\b|were\\b|has\\b|have\\b|had\\b|can\\b|will\\b|be\\b|been\\b|being\\b|now\\b|currently\\b|presently\\b|yet\\b|ever\\b|actually\\b|explicitly\\b|itself\\b|directly\\b)[a-z0-9<>]+){0,8}'
const noPartHeaderNegationPattern = new RegExp(
  '(?:^| )no (?:part|portion) of ' +
    noPartHeaderSubjectPattern +
    noPartHeaderQualifierPattern +
    '(?: ' +
    noPartHeaderStatePattern +
    '){1,8}$',
)
const noPartAdjectiveHeaderNegationPattern = new RegExp(
  '^' + noPartHeaderSubjectPattern + ' (?:is|are)(?: |$)',
)
const noThirdPartyHeaderSubjectNegationPattern =
  /^no (?:external )?(?:dependency|dependencies|component|components|module|modules|library|libraries|package|packages|parser|parsers|helper|helpers|tool|tools|asset|assets|font|fonts|plugin|plugins|extension|extensions|add on|add ons|addon|addons)(?: of (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|our (?:project|code|source|software|library|package|repository|repo|files|program|application)))?(?: (?:is|are|was|were|has|have|had|can|will|be|been|being|now|currently|presently|yet|ever|actually|explicitly|itself|directly)){1,8}$/

function hasNegatedLicenseHeaderContext(
  loose: string,
  headerIndex: number,
  licenseAliasWords: string[][],
  rawInput = loose,
  precomputedHeaderContext?: string,
): boolean {
  const localPrefix = licenseHeaderPrefix(loose, headerIndex, 16)
  const headerContext =
    precomputedHeaderContext ??
    licenseHeaderContext(loose, headerIndex, licenseAliasWords)
  const unboundedContextPrefix = headerContext.split(' ').slice(-16).join(' ')
  const contextPrefix =
    /\b(?:no|none|nor|neither|not|never|without|previously|formerly|originally|initially|once|used|had|was|were)\b/.test(
      unboundedContextPrefix,
    )
      ? (rawSentencePrefixBeforeLooseHeader(rawInput, loose, headerIndex) ??
        unboundedContextPrefix)
      : unboundedContextPrefix
  const isRelicenseHeader = isRelicenseHeaderText(loose.slice(headerIndex))
  const hasNegatedRelicenseCue =
    isRelicenseHeader &&
    /\b(?:not|never|no longer|(?:isn|aren|wasn|weren|hasn|haven|hadn|cannot|can not|can t|won t|wouldn|couldn|shouldn|mustn) t?)\b/.test(
      contextPrefix,
    )
  if (
    isRelicenseHeader &&
    !hasNegatedRelicenseCue &&
    !hasHistoricalRelicenseContext(contextPrefix) &&
    hasProjectHeaderContext(localPrefix) &&
    !hasThirdPartyHeaderContext(localPrefix)
  )
    return false

  const hasCurrentCue =
    (/\b(?:now|currently|presently)$/.test(contextPrefix) ||
      (isRelicenseHeader && hasProjectHeaderContext(localPrefix))) &&
    !hasThirdPartyHeaderContext(localPrefix)
  const hasNoProjectNegation =
    /\bno (?:(?:part|portion) of )?(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application|source|code|work)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)|(?:file|files|code|source|software|component|module|project|work))(?: (?:is|are|was|were|has|have|had|can|will|be|been|being|now|currently|presently|yet|ever|actually|explicitly|itself|directly)){1,8}$/.test(
      contextPrefix,
    )
  const hasNoPartHeaderNegation =
    noPartHeaderNegationPattern.test(contextPrefix)
  const hasNoPartAdjectiveNegation =
    /(?:^| )no (?:part|portion) of$/.test(contextPrefix) &&
    noPartAdjectiveHeaderNegationPattern.test(loose.slice(headerIndex))
  const hasNoThirdPartySubjectNegation =
    noThirdPartyHeaderSubjectNegationPattern.test(contextPrefix)
  const hasNoDependencyLicenseHeader =
    /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|contains|contain)?(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} no (?:external )?(?:(?:parser|helper|plugin|extension|add on|addon) )?(?:dependency|dependencies|component|module|library|package|parser|helper|tool|asset|assets|font|fonts|plugin|extension|add on|addon)(?: (?!and\b|or\b|but\b|the\b|this\b|these\b|those\b|our\b|project\b|codebase\b|software\b|package\b|repository\b|repo\b|library\b|program\b|application\b|code\b|source\b|files\b|is\b|are\b|was\b|were\b|has\b|have\b)[a-z0-9<>]+){0,4}$/.test(
      contextPrefix,
    )
  const hasNoneProjectNegation =
    /\bnone (?:of them )?(?:is|are|was|were|has|have|had|can|will|be|been|being)(?: (?:now|currently|presently|yet|ever|actually|explicitly)){0,4}$/.test(
      contextPrefix,
    ) && hasProjectHeaderContext(headerContext)
  const hasNorProjectNegation =
    /\bnor (?:(?:is|are)(?: the)? (?:(?:it|they)|(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)|(?:main|primary) (?:project )?(?:source|code|software|package|library|program|application|repository|repo|files))|(?:has|have) (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) been|(?:can|will) (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) be)$/.test(
      contextPrefix,
    )
  const hasNeitherNorProjectNegation =
    /\bneither (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application))(?: [a-z0-9]+){0,8} nor (?:its [a-z0-9]+|(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application))(?: [a-z0-9]+){0,8} (?:is|are)$/.test(
      contextPrefix,
    )
  const hasFutureNegation =
    /\b(?:not going to be|not(?: [a-z0-9]+){0,3} never will be|never will be)$/.test(
      contextPrefix,
    )
  const hasNotNorNegation =
    /\bnot(?: (?:now|currently|presently|yet|ever|really|actually|explicitly|itself|directly)){0,4} nor(?: ever)?$/.test(
      contextPrefix,
    )
  const hasNotOrNegation =
    /\bnot(?: (?:now|currently|presently|yet|ever|really|actually|explicitly|itself|directly|in|any|sense)){0,6} or(?: (?:now|currently|presently|yet|ever|really|actually|explicitly)){0,2}$/.test(
      contextPrefix,
    ) || /\bnot in any sense$/.test(contextPrefix)
  const hasNoMeansNegation =
    /\bby no means(?: now| currently| presently| yet| ever| really| actually| explicitly)?$/.test(
      contextPrefix,
    )
  const hasNoCircumstancesNegation = /\bunder no circumstances$/.test(
    contextPrefix,
  )
  const hasNorFuturePronounNegation =
    /\bnor (?:can|will|should|would|could) (?:it|they) be$/.test(contextPrefix)
  const hasHistoricalCue =
    (/\b(?:was|were|had been)(?: (?:previously|formerly|originally|initially|first|once|also)){0,4}$/.test(
      contextPrefix,
    ) ||
      /\b(?:previous|old|older|prior|past|historical|earlier) (?:release|releases|version|versions) (?:is|are|was|were|had been)(?: (?:previously|formerly|originally|initially|first|once|also)){0,4}$/.test(
        contextPrefix,
      ) ||
      /\b(?:previously|formerly|originally|once)(?: been| also)?$/.test(
        contextPrefix,
      ) ||
      /\b(?:was|were|had been)(?: (?:previously|formerly|originally|initially|first|once|also)){1,4} (?:released|distributed|published)(?: [a-z0-9]+){0,4} and$/.test(
        contextPrefix,
      ) ||
      (/\bused to be(?: [a-z0-9]+){0,6}$/.test(contextPrefix) &&
        !/\b(?:is|are)$/.test(contextPrefix))) &&
    !hasCurrentCue
  const hasFutureCue =
    /\b(?:can|could|may|might|should|will|would)(?: (?:also|eventually|later|soon|still|then|therefore|be|become)){0,5}$/.test(
      contextPrefix,
    ) ||
    /\b(?:expect(?:s|ed)?|intend(?:s|ed)?|plan(?:s|ned)?|schedule(?:s|d)?)(?: (?:also|eventually|later|soon|still|then|therefore|to|be)){0,5}$/.test(
      contextPrefix,
    ) ||
    /\bgoing to be$/.test(contextPrefix)
  return (
    hasNegatedLicenseHeaderPrefix(localPrefix) ||
    hasNoProjectNegation ||
    hasNoPartHeaderNegation ||
    hasNoPartAdjectiveNegation ||
    hasNoThirdPartySubjectNegation ||
    hasNoDependencyLicenseHeader ||
    hasNoneProjectNegation ||
    hasNorProjectNegation ||
    hasNeitherNorProjectNegation ||
    hasFutureNegation ||
    hasNotNorNegation ||
    hasNotOrNegation ||
    hasNoMeansNegation ||
    hasNoCircumstancesNegation ||
    hasNorFuturePronounNegation ||
    hasHistoricalCue ||
    hasFutureCue ||
    /\b(?:not(?: (?:now|currently|presently|yet|ever|really|actually|explicitly|itself|directly)){0,4}(?: be| been| being)?|not(?: [a-z0-9]+){1,4} or(?: currently| presently| yet| really| actually| explicitly)?|(?:isn|aren|wasn|weren|hasn|haven|hadn|shouldn|wouldn|couldn|mustn) t(?: (?:now|currently|presently|yet|ever|really|actually|explicitly|itself|directly)){0,4}(?: be| been| being)?|(?:cannot|can not|can t|won t)(?: (?:now|currently|presently|yet|ever|really|actually|explicitly)){0,4} be|never(?: be| been| being)?|never(?: [a-z0-9]+){1,4} or|neither|no longer(?: be| been| being)?|no longer(?: [a-z0-9]+){1,4} or|nor(?: is it| are they)?|previously(?: been)?|formerly(?: been)?|originally(?: been)?|once(?: been)?|used to be|without being|had been|(?:was|were))$/.test(
      contextPrefix,
    ) ||
    (/^(?:previously|formerly|originally|initially|first|once)\b/.test(
      headerContext,
    ) &&
      !/\b(?:(?:re)?licen[cs]ed|released|distributed) under\b/.test(
        headerContext,
      ) &&
      !hasCurrentCue &&
      !hasAffirmativeProjectHeaderContext(
        loose,
        headerIndex,
        licenseAliasWords,
      ))
  )
}

function hasImmediateProjectHeaderSubject(
  loose: string,
  headerIndex: number,
  matchText = '',
  rawInput = loose,
): boolean {
  const words = licenseHeaderPrefix(loose, headerIndex, 16)
    .split(' ')
    .filter(Boolean)
  const matchState = matchText.split(' ')[0]
  const subjectWords =
    matchState === 'is' || matchState === 'are'
      ? words
      : words[words.length - 1] === 're' && words[words.length - 2] === 'we'
        ? words.slice(0, -1)
        : words[words.length - 1] === 'is' || words[words.length - 1] === 'are'
          ? words.slice(0, -1)
          : matchState === 'licensed' || matchState === 'licenced'
            ? words
            : undefined
  if (!subjectWords) return false

  const subjects = [
    ['we'],
    ['this', 'project'],
    ['the', 'project'],
    ['this', 'main', 'project'],
    ['the', 'main', 'project'],
    ['this', 'primary', 'project'],
    ['the', 'primary', 'project'],
    ['this', 'codebase'],
    ['the', 'codebase'],
    ['this', 'software'],
    ['the', 'software'],
    ['this', 'package'],
    ['the', 'package'],
    ['this', 'repository'],
    ['the', 'repository'],
    ['this', 'repo'],
    ['the', 'repo'],
    ['this', 'library'],
    ['the', 'library'],
    ['this', 'program'],
    ['the', 'program'],
    ['this', 'application'],
    ['the', 'application'],
    ['this', 'tool'],
    ['the', 'tool'],
    ['this', 'app'],
    ['the', 'app'],
    ['this', 'cli'],
    ['the', 'cli'],
    ['this', 'source', 'code'],
    ['the', 'source', 'code'],
    ['this', 'code'],
    ['the', 'code'],
    ['this', 'source'],
    ['the', 'source'],
    ['this', 'work'],
    ['the', 'work'],
    ['these', 'files'],
    ['those', 'files'],
    ['our', 'project'],
    ['our', 'code'],
    ['our', 'source'],
    ['our', 'software'],
    ['our', 'library'],
    ['our', 'package'],
    ['our', 'repository'],
    ['our', 'repo'],
    ['our', 'files'],
    ['our', 'program'],
    ['our', 'application'],
    ['our', 'work'],
    ['main', 'project'],
    ['primary', 'project'],
    ['main', 'project', 'software'],
    ['primary', 'project', 'software'],
    ['main', 'source', 'code'],
    ['primary', 'source', 'code'],
    ['main', 'source'],
    ['primary', 'source'],
    ['main', 'code'],
    ['primary', 'code'],
    ['main', 'tool'],
    ['primary', 'tool'],
    ['command', 'line', 'interface'],
    ['browser', 'build'],
  ]

  if (hasProjectOwnedBareHeaderSubject(subjectWords)) return true

  return subjects.some((subject) => {
    if (!endsWithWords(subjectWords, subjectWords.length, subject)) return false
    const beforeSubject = subjectWords.slice(
      0,
      subjectWords.length - subject.length,
    )
    if (subject.length === 1 && subject[0] === 'we') {
      if (!hasSentenceInitialWeHeader(rawInput, loose, headerIndex))
        return false
    }
    return !isEmbeddedProjectHeaderSubjectPrefix(
      beforeSubject[beforeSubject.length - 1],
    )
  })
}

function rawPrefixBeforeLooseHeader(
  rawInput: string,
  loose: string,
  headerIndex: number,
): string | undefined {
  const loosePrefix = loose.slice(0, headerIndex).trim()
  if (loosePrefix.length > headerContextCharacterLimit) return undefined

  const headerPattern =
    /\b(?:(?:re)?licen[cs]ed|released|distributed|made\s+available)\s+under\b|\b(?:is|are)(?:\s+available)?\s+under\b|\bsubject\s+to\s+(?:the\s+)?terms(?:\s+(?:and\s+conditions\s+)?of(?:\s+the)?)?\b/gi

  for (const match of rawInput.matchAll(headerPattern)) {
    if (match.index === undefined) continue
    const rawPrefix = rawInput.slice(0, match.index)
    const looseRawPrefix = normalizeHeaderLoose(rawPrefix)
    if (looseRawPrefix === loosePrefix) return rawPrefix
    if (looseRawPrefix.length > loosePrefix.length) break
  }

  return undefined
}

function isAbbreviationSentenceBoundary(text: string, index: number): boolean {
  return /\b(?:e\.g|i\.e|inc|ltd|corp|co|llc|u\.s|u\.k|vs|v)$/i.test(
    text.slice(0, index),
  )
}

function lastRawSentenceBoundaryIndex(rawPrefix: string): number {
  const sentenceBoundary = /[.!?;](?=\s|$)|[\n\r]/g
  let sentenceStart = -1
  let match: RegExpExecArray | null
  while ((match = sentenceBoundary.exec(rawPrefix))) {
    if (
      rawPrefix[match.index] === '.' &&
      isAbbreviationSentenceBoundary(rawPrefix, match.index)
    )
      continue
    sentenceStart = match.index
  }
  return sentenceStart
}

function rawSentencePrefixBeforeLooseHeader(
  rawInput: string,
  loose: string,
  headerIndex: number,
): string | undefined {
  const rawPrefix = rawPrefixBeforeLooseHeader(rawInput, loose, headerIndex)
  if (rawPrefix === undefined) return undefined

  const sentenceStart = lastRawSentenceBoundaryIndex(rawPrefix)
  return normalizeHeaderLoose(rawPrefix.slice(sentenceStart + 1))
}

function hasSentenceInitialWePrefix(rawPrefix: string): boolean {
  const sentenceStart = lastRawSentenceBoundaryIndex(rawPrefix)
  const sentencePrefix = rawPrefix.slice(sentenceStart + 1).trim()
  return /^(?:we|we\s+are|we['’]re)$/i.test(sentencePrefix)
}

function hasSentenceInitialWeHeader(
  rawInput: string,
  loose: string,
  headerIndex: number,
): boolean {
  const rawPrefix = rawPrefixBeforeLooseHeader(rawInput, loose, headerIndex)
  return rawPrefix !== undefined && hasSentenceInitialWePrefix(rawPrefix)
}

function hasProjectOwnedBareHeaderSubject(subjectWords: string[]): boolean {
  const bareSubjects = [['code'], ['source'], ['source', 'code'], ['software']]
  const projectRefs = [
    ['this', 'project'],
    ['the', 'project'],
    ['our', 'project'],
    ['this', 'codebase'],
    ['the', 'codebase'],
    ['our', 'codebase'],
    ['this', 'repository'],
    ['the', 'repository'],
    ['our', 'repository'],
    ['this', 'repo'],
    ['the', 'repo'],
    ['our', 'repo'],
  ]
  for (const bareSubject of bareSubjects) {
    for (const connector of ['for', 'of']) {
      for (const projectRef of projectRefs) {
        const subject = [...bareSubject, connector, ...projectRef]
        if (!endsWithWords(subjectWords, subjectWords.length, subject)) {
          continue
        }
        const prefix = subjectWords.slice(
          0,
          subjectWords.length - subject.length,
        )
        return (
          prefix.length === 0 ||
          (prefix.length === 1 &&
            (prefix[0] === 'the' ||
              prefix[0] === 'this' ||
              prefix[0] === 'that' ||
              prefix[0] === 'our'))
        )
      }
    }
  }
  return false
}

function isEmbeddedProjectHeaderSubjectPrefix(word: string | undefined) {
  return (
    word === 'of' ||
    word === 'part' ||
    word === 'by' ||
    word === 'for' ||
    word === 'from' ||
    word === 'in' ||
    word === 'inside' ||
    word === 'into' ||
    word === 'onto' ||
    word === 'through' ||
    word === 'throughout' ||
    word === 'to' ||
    word === 'with' ||
    word === 'within'
  )
}

function hasCurrentLicenseHeaderContext(
  loose: string,
  headerIndex: number,
  licenseAliasWords: string[][],
  matchText = '',
  rawInput = loose,
  precomputedHeaderContext?: string,
): boolean {
  const localPrefix = licenseHeaderPrefix(loose, headerIndex, 16)
  const hasImmediateProjectSubject = hasImmediateProjectHeaderSubject(
    loose,
    headerIndex,
    matchText,
    rawInput,
  )
  const headerContext =
    precomputedHeaderContext ??
    licenseHeaderContext(loose, headerIndex, licenseAliasWords)
  const contextPrefix = headerContext.split(' ').slice(-16).join(' ')
  const contextHasProject = hasProjectHeaderContext(contextPrefix)
  const contextHasStrongProject = hasStrongProjectHeaderContext(contextPrefix)
  if (hasNegatedLicenseHeaderPrefix(localPrefix)) return false
  if (
    !hasImmediateProjectSubject &&
    (isThirdPartyOwnedHeaderContext(headerContext) ||
      hasCarriedThirdPartyHeaderContext(
        loose,
        headerIndex,
        licenseAliasWords,
      ) ||
      (hasThirdPartyHeaderContext(localPrefix) && !contextHasStrongProject))
  )
    return false

  const immediatePrefix = licenseHeaderPrefix(loose, headerIndex, 10)
  const isRelicenseHeader = isRelicenseHeaderText(loose.slice(headerIndex))
  const hasCurrentCue =
    /\b(?:now|currently|presently|remains|remain|is still|are still|continues to be|continue to be)\b/.test(
      immediatePrefix,
    ) || /\bhas since been\b/.test(immediatePrefix)
  return (
    (contextHasProject ||
      hasProjectHeaderContext(localPrefix) ||
      hasImmediateProjectSubject) &&
    (hasCurrentCue ||
      isRelicenseHeader ||
      contextHasStrongProject ||
      hasImmediateProjectSubject)
  )
}

function hasNegatedLicenseHeaderPrefix(prefix: string): boolean {
  const contextPrefix = prefix
    .split(' ')
    .filter(Boolean)
    .slice(-negatedHeaderPrefixWordLimit)
    .join(' ')

  return (
    /\bnot(?: (?:currently|presently|actually|explicitly|itself|directly)){0,6} (?:(?:licen[cs]ed|released|distributed|made available|available) (?:(?:or|and|nor) )?)*(?:licen[cs]ed|released|distributed|made available|available) under(?: (?:(?:the|a|an) )?terms (?:and conditions )?of(?: (?:the|a|an))?| (?:the|a|an))?$/.test(
      contextPrefix,
    ) ||
    /\bno part of (?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli|product|code|source|work|file|source file) (?:is|are|was|were|has been|have been) (?:(?:licen[cs]ed|released|distributed|made available|available) (?:(?:or|and|nor) )?)*(?:licen[cs]ed|released|distributed|made available|available) under(?: (?:(?:the|a|an) )?terms (?:and conditions )?of(?: (?:the|a|an))?| (?:the|a|an))?$/.test(
      contextPrefix,
    )
  )
}

function hasAffirmativeProjectHeaderContext(
  loose: string,
  headerIndex: number,
  licenseAliasWords: string[][],
): boolean {
  const contextPrefix = licenseHeaderContext(
    loose,
    headerIndex,
    licenseAliasWords,
  )
    .split(' ')
    .slice(-10)
    .join(' ')
  if (isThirdPartyOwnedHeaderContext(contextPrefix)) return false
  if (/\bbut (?:is|are)(?: instead)?$/.test(contextPrefix)) return true
  if (
    /\bour (?:project|code|source|software|library|package|repository|repo|files|program|application|work) (?:is|are) now(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,6} and$/.test(
      contextPrefix,
    )
  )
    return true
  return /\b(?:(?:it|they) (?:is|are|is still|are still|remains|remain|has been|have been)|(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli) (?:is|are|is still|are still|remains|remain|has been)|(?:these|those) (?:source )?files (?:are|have been)|our (?:project|code|source|software|library|package|repository|repo|files|program|application|work) (?:is|are|has been|have been)|(?:main|primary) (?:project )?(?:source code|source|code|software|package|library|program|application|repository|repo|files|tool|app|cli) (?:is|are|has been|have been)|(?:command line interface|browser build) (?:is|are|has been))$/.test(
    contextPrefix,
  )
}

function hasLaterProjectHeaderContext(inputWords: string[]): boolean {
  return /\b(?:and|but) (?:is|are|has been|have been|remains|remain|is still|are still|was|were) (?:instead )?$/.test(
    inputWords.slice(0, 16).join(' '),
  )
}

function hasLaterSupersedingCurrentLicenseHeader(
  inputWords: string[],
): boolean {
  return /\bbut (?:(?:(?:it|they)|(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application|work)) )?(?:(?:is|are) )?(?:now|currently|presently) (?:(?:re)?licen[cs]ed|released|distributed) under\b/.test(
    inputWords.slice(0, 64).join(' '),
  )
}

function hasLaterCurrentLicenseHeader(inputWords: string[]): boolean {
  const text = inputWords.slice(0, 64).join(' ')
  return (
    hasLaterSupersedingCurrentLicenseHeader(inputWords) ||
    /\b(?:(?:it|they)|(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application|work)|(?:main|primary) (?:project )?(?:source code|source|code|software|package|library|program|application|repository|repo|files|tool|app|cli)) (?:(?:is|are|has been|have been|was|were) )?(?:(?:re)?licen[cs]ed|released|distributed|provided|offered|covered|made available|available) under\b/.test(
      text,
    )
  )
}

function hasSourceHeaderPreamble(loose: string, headerIndex: number): boolean {
  const prefix = boundedHeaderPrefix(loose, headerIndex)
  if (
    !/\b(?:copyright|author|authors|contributor|contributors|all rights reserved)\b/.test(
      prefix,
    )
  )
    return false
  const words = prefix.split(' ').filter(Boolean)
  return (
    words.length <= 96 &&
    !hasBundledNamedSubjectHeaderContext(prefix) &&
    !hasThirdPartyHeaderContext(prefix) &&
    !isThirdPartyOwnedHeaderContext(prefix)
  )
}

function hasRestrictiveLicenseHeaderPrefix(
  loose: string,
  headerIndex: number,
): boolean {
  const prefix = boundedHeaderPrefix(loose, headerIndex)
  if (!prefix) return false
  if (
    /\b(?:previously|formerly|originally|initially|first|used to)\b.{0,120}\b(?:proprietary|closed source|all rights reserved)\b/.test(
      prefix,
    )
  ) {
    return false
  }
  return hasRestrictiveLicenseLabelLine(prefix)
}

function trimLeadingLicenseArticle(inputWords: string[]): string[] {
  return ['the', 'a', 'an'].includes(inputWords[0])
    ? inputWords.slice(1)
    : inputWords
}

function trimLicenseTermsPrefix(inputWords: string[]): string[] {
  if (inputWords[0] !== 'terms') return trimLeadingLicenseArticle(inputWords)
  const ofIndex =
    inputWords[1] === 'of'
      ? 1
      : inputWords[1] === 'and' &&
          inputWords[2] === 'conditions' &&
          inputWords[3] === 'of'
        ? 3
        : -1
  if (ofIndex < 0) return inputWords
  const startIndex =
    inputWords[ofIndex + 1] === 'the' ? ofIndex + 2 : ofIndex + 1
  return trimLeadingLicenseArticle(inputWords.slice(startIndex))
}

function wordsAfterHeaderMatch(loose: string, startIndex: number): string[] {
  const suffix = loose.slice(
    startIndex,
    Math.min(loose.length, startIndex + headerContextCharacterLimit),
  )
  return trimLicenseTermsPrefix(suffix.split(' ').filter(Boolean))
}

function boundedHeaderContext(text: string): string {
  return text.slice(0, headerContextCharacterLimit).trim()
}

function hasPotentialHeaderAlias(
  inputWords: string[],
  licenseAliasWords: string[][],
): boolean {
  return licenseAliasWords.some((words) => matchesWordsAt(inputWords, 0, words))
}

function hasCleanHeaderAlias(
  inputWords: string[],
  licenseAliasWords: string[][],
): boolean {
  return licenseAliasWords.some((words) =>
    matchesHeaderAlias(inputWords, words, licenseAliasWords),
  )
}

function hasLicenseLabelDeclarationLine(input: string): boolean {
  return input
    .split(/\r\n?|\n/)
    .some((line) =>
      normalizedLicenseLabelDeclarationPattern.test(normalizeHeaderLoose(line)),
    )
}

function hasRestrictiveLicenseLabelValueDeclaration(input: string): boolean {
  const lines = input.split(/\r\n?|\n/)
  const looseLines = lines.map(normalizeHeaderLoose)
  const hasScopedAwaySuffixFromIndex =
    scopedAwayLicenseLabelSuffixLookup(looseLines)
  const prefixLines: string[] = []
  const stickyContextLines: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const looseLine = looseLines[index] || ''
    if (!looseLine) {
      if (hasCurrentLicenseLabelSectionContext(prefixLines)) {
        stickyContextLines.length = 0
      } else {
        for (const prefixLine of prefixLines) {
          if (isStickyLicenseLabelContextLine(prefixLine)) {
            stickyContextLines.push(prefixLine)
          }
        }
      }
      prefixLines.length = 0
      continue
    }

    let labelLine = looseLine
    let labelValueIndex = index
    const standaloneLabelMatch =
      normalizedStandaloneLicenseLabelPattern.exec(looseLine)
    if (standaloneLabelMatch) {
      const nextValueIndex = nextNonEmptyLooseLineIndex(looseLines, index)
      const nextValueLine =
        nextValueIndex > index ? looseLines[nextValueIndex] || '' : ''
      if (
        nextValueIndex > index &&
        hasRestrictiveLicenseLabelValue(nextValueLine)
      ) {
        labelLine = looseLine + ' ' + nextValueLine
        labelValueIndex = nextValueIndex
      }
    }

    const labelMatch = normalizedInlineLicenseLabelPattern.exec(labelLine)
    if (labelMatch) {
      const context = licenseLabelContextLinesForMatch(
        stickyContextLines,
        prefixLines,
      ).join('\n')
      const hasInactiveContext =
        !hasCurrentLicenseLabelPrefix(labelMatch[0]) &&
        hasInactiveRestrictiveLicenseLabelValueContext(context)
      const hasRestrictiveValue = hasRestrictiveLicenseLabelConflictValue(
        wordsAfterHeaderMatch(labelLine, labelMatch[0].length).join(' '),
      )
      const hasCurrentContext =
        hasCurrentLicenseLabelPrefix(labelMatch[0]) ||
        hasCurrentLicenseLabelSectionContext(licenseLabelContextLines(context))
      if (
        hasRestrictiveValue &&
        !hasInactiveContext &&
        (hasCurrentContext ||
          !hasScopedAwaySuffixFromIndex[labelValueIndex + 1])
      )
        return true
      if (!hasInactiveContext) prefixLines.length = 0
      index = labelValueIndex
      continue
    }

    prefixLines.push(looseLine)
  }
  return false
}

function hasInactiveRestrictiveLicenseLabelValueContext(
  context: string,
): boolean {
  return (
    hasHistoricalLicenseLabelContext(context) ||
    hasThirdPartyLicenseLabelContext(context) ||
    hasScopedAwayLicenseLabelContext(context)
  )
}

function hasRestrictiveLicenseLabelValue(value: string): boolean {
  const valueWords = aliasWords(value)
  return (
    hasRestrictiveLicenseLabelConflictValue(value) ||
    hasProjectRestrictiveBodySegment(value, true) ||
    hasRestrictiveLicenseTail(valueWords, 0)
  )
}

function hasRestrictiveLicenseLabelConflictValue(value: string): boolean {
  const looseValue = normalizeHeaderLoose(value)
  return (
    /^(?:proprietary|closed source|source available only|source code available only|confidential|private|all rights reserved|unlicensed|no license|no open source license|not open source|not licensed|non commercial|noncommercial|personal use only|internal use only|private use only|commercial use prohibited|redistribution prohibited|distribution prohibited)$/.test(
      looseValue,
    ) ||
    hasProjectScopedRestrictiveLicenseOnlySegment(value) ||
    hasStandaloneRestrictiveLicenseOnlySegment(value, false) ||
    hasRestrictiveLicenseLabelLine(value)
  )
}

function bodyWithoutInactiveRestrictiveLicenseLabelValueDeclarations(
  input: string,
): string {
  const bodyLines: string[] = []
  const lines = input.split(/\r\n?|\n/)
  const looseLines = lines.map(normalizeHeaderLoose)
  const hasScopedAwaySuffixFromIndex =
    scopedAwayLicenseLabelSuffixLookup(looseLines)
  const prefixLines: string[] = []
  const stickyContextLines: string[] = []
  let skipScopedAwayLabelSuffix = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const looseLine = looseLines[index] || ''
    if (!looseLine) {
      if (hasCurrentLicenseLabelSectionContext(prefixLines)) {
        stickyContextLines.length = 0
      } else {
        for (const prefixLine of prefixLines) {
          if (isStickyLicenseLabelContextLine(prefixLine)) {
            stickyContextLines.push(prefixLine)
          }
        }
      }
      prefixLines.length = 0
      bodyLines.push(line)
      continue
    }
    if (skipScopedAwayLabelSuffix) {
      if (scopedAwayLicenseLabelSuffixPattern.test(looseLine)) continue
      skipScopedAwayLabelSuffix = false
    }

    let labelLine = looseLine
    let labelValueIndex = index
    const standaloneLabelMatch =
      normalizedStandaloneLicenseLabelPattern.exec(looseLine)
    if (standaloneLabelMatch) {
      const nextValueIndex = nextNonEmptyLooseLineIndex(looseLines, index)
      const nextValueLine =
        nextValueIndex > index ? looseLines[nextValueIndex] || '' : ''
      if (
        nextValueIndex > index &&
        hasRestrictiveLicenseLabelValue(nextValueLine)
      ) {
        labelLine = looseLine + ' ' + nextValueLine
        labelValueIndex = nextValueIndex
      }
    }

    const labelMatch = normalizedInlineLicenseLabelPattern.exec(labelLine)
    if (labelMatch) {
      const context = licenseLabelContextLinesForMatch(
        stickyContextLines,
        prefixLines,
      ).join('\n')
      const hasInactiveContext =
        !hasCurrentLicenseLabelPrefix(labelMatch[0]) &&
        hasInactiveRestrictiveLicenseLabelValueContext(context)
      const hasRestrictiveValue = hasRestrictiveLicenseLabelValue(
        wordsAfterHeaderMatch(labelLine, labelMatch[0].length).join(' '),
      )
      const hasCurrentContext =
        hasCurrentLicenseLabelPrefix(labelMatch[0]) ||
        hasCurrentLicenseLabelSectionContext(licenseLabelContextLines(context))
      const hasScopedAwaySuffix =
        hasRestrictiveValue &&
        !hasInactiveContext &&
        !hasCurrentContext &&
        hasScopedAwaySuffixFromIndex[labelValueIndex + 1]
      if (hasRestrictiveValue && (hasInactiveContext || hasScopedAwaySuffix)) {
        if (!hasInactiveContext) prefixLines.length = 0
        skipScopedAwayLabelSuffix = hasScopedAwaySuffix
        index = labelValueIndex
        continue
      }
      if (!hasInactiveContext) prefixLines.length = 0
      bodyLines.push(line)
      if (labelValueIndex !== index) {
        bodyLines.push(lines[labelValueIndex])
        index = labelValueIndex
      }
      continue
    }

    bodyLines.push(line)
    prefixLines.push(looseLine)
  }

  return bodyLines.join('\n').trim()
}

function nextNonEmptyLineIndex(lines: string[], index: number): number {
  for (
    let candidateIndex = index + 1;
    candidateIndex < lines.length;
    candidateIndex += 1
  ) {
    if (normalizeHeaderLoose(lines[candidateIndex])) return candidateIndex
  }
  return -1
}

function nextNonEmptyLooseLineIndex(
  looseLines: string[],
  index: number,
): number {
  for (
    let candidateIndex = index + 1;
    candidateIndex < looseLines.length;
    candidateIndex += 1
  ) {
    if (looseLines[candidateIndex]) return candidateIndex
  }
  return -1
}

function scopedAwayLicenseLabelSuffixLookup(looseLines: string[]): boolean[] {
  const lookup = new Array<boolean>(looseLines.length + 1)
  lookup[looseLines.length] = false
  for (let index = looseLines.length - 1; index >= 0; index -= 1) {
    lookup[index] =
      lookup[index + 1] ||
      scopedAwayLicenseLabelSuffixPattern.test(looseLines[index] || '')
  }
  return lookup
}

function standaloneLicenseLabelSpdxDetection(
  input: string,
  knownIds: Set<string>,
  aliases: HeaderAlias[],
): LicenseLabelSpdxDetection | undefined {
  const rawLines = input.split(/\r\n?|\n/)
  const lines = stripCommentShellPreservingLineCount(rawLines)
  const labelWithValue =
    /^(?:(?:project|source|package)[-\s]+)?licen[cs]e(?:[-\s]+identifier)?(?::|\s+)\s*(.+)$/i
  const standaloneLabel =
    /^(?:(?:project|source|package)[-\s]+)?licen[cs]e(?:[-\s]+identifier)?\s*:?\s*$/i
  const prefixLines: string[] = []
  const stickyContextLines: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmedLine = line.trim()
    const looseLine = normalizeHeaderLoose(line)
    if (!trimmedLine) {
      if (hasCurrentLicenseLabelSectionContext(prefixLines)) {
        stickyContextLines.length = 0
      } else {
        for (const prefixLine of prefixLines) {
          if (
            isStickyLicenseLabelContextLine(prefixLine) ||
            /\b(?:third party|third-party|dependenc(?:y|ies))\b/.test(
              prefixLine,
            )
          )
            stickyContextLines.push(prefixLine)
        }
      }
      prefixLines.length = 0
      continue
    }

    const context = licenseLabelContextLinesForMatch(
      stickyContextLines,
      prefixLines,
    ).join('\n')
    const isStandaloneLabel = standaloneLabel.test(trimmedLine)
    const inlineMatch = isStandaloneLabel
      ? undefined
      : labelWithValue.exec(trimmedLine)
    let value = inlineMatch?.[1]
    let bodyStartIndex = index + 1
    const gapContextLines: string[] = []
    if (!value && isStandaloneLabel) {
      let inBlockCommentGap = false
      for (
        let candidateIndex = index + 1;
        candidateIndex < lines.length;
        candidateIndex += 1
      ) {
        const rawCandidateLine = rawLines[candidateIndex] || ''
        if (inBlockCommentGap) {
          const closeTail = blockCommentTailAfterClose(rawCandidateLine)
          if (closeTail !== undefined) {
            inBlockCommentGap = false
            if (!closeTail) continue
            const closeTailDetection = detectSpdxIdentifier(
              'SPDX-License-Identifier: ' + closeTail,
              knownIds,
            )
            if (
              closeTailDetection &&
              isStandaloneLicenseLabelSpdxDetection(closeTailDetection)
            ) {
              value = closeTail
              bodyStartIndex = candidateIndex + 1
              break
            }
            if (supportedPunctuatedSpdxIdListIds(closeTail, knownIds)) {
              value = closeTail
              bodyStartIndex = candidateIndex + 1
              break
            }
            const looseCloseTail = normalizeHeaderLoose(closeTail)
            if (looseCloseTail) gapContextLines.push(looseCloseTail)
            break
          }
          const looseGapLine = normalizeHeaderLoose(lines[candidateIndex] || '')
          if (looseGapLine) gapContextLines.push(looseGapLine)
          continue
        }
        const candidateValue = lines[candidateIndex]?.trim()
        if (!candidateValue) {
          if (blockCommentOpenShellPattern.test(rawCandidateLine)) {
            inBlockCommentGap =
              !blockCommentCloseShellPattern.test(rawCandidateLine)
          }
          continue
        }
        const candidateDetection = detectSpdxIdentifier(
          'SPDX-License-Identifier: ' + candidateValue,
          knownIds,
        )
        if (
          candidateDetection &&
          isStandaloneLicenseLabelSpdxDetection(candidateDetection)
        ) {
          value = candidateValue
          bodyStartIndex = candidateIndex + 1
          break
        }
        if (supportedPunctuatedSpdxIdListIds(candidateValue, knownIds)) {
          value = candidateValue
          bodyStartIndex = candidateIndex + 1
          break
        }
        const looseCandidateValue = normalizeHeaderLoose(candidateValue)
        if (lineCommentShellPattern.test(rawCandidateLine)) {
          if (looseCandidateValue) gapContextLines.push(looseCandidateValue)
          continue
        }
        if (blockCommentOpenShellPattern.test(rawCandidateLine)) {
          inBlockCommentGap =
            !blockCommentCloseShellPattern.test(rawCandidateLine)
          if (looseCandidateValue) gapContextLines.push(looseCandidateValue)
          continue
        }
        break
      }
    }
    if (!value) {
      prefixLines.push(looseLine)
      continue
    }
    if (hasKnownHeaderAlias(value, aliases)) {
      prefixLines.push(looseLine)
      continue
    }
    if (
      hasHistoricalLicenseLabelContext(context) ||
      hasThirdPartyLicenseLabelContext(context) ||
      /\b(?:third party|third-party|dependenc(?:y|ies))\b/.test(context) ||
      licenseLabelContextLines(context).some((contextLine) =>
        hasThirdPartyLicenseLabelLineContext(contextLine.trim()),
      ) ||
      hasScopedAwayLicenseLabelContext(context) ||
      hasRestrictiveLicenseLabelSuffix(context)
    ) {
      prefixLines.push(looseLine)
      continue
    }

    const malformedDeclaredIds = supportedPunctuatedSpdxIdListIds(
      value,
      knownIds,
    )
    if (malformedDeclaredIds) {
      const suffix = [
        ...gapContextLines,
        ...licenseLabelSuffixLines(lines.slice(bodyStartIndex)),
      ].join('\n')
      if (
        hasDisqualifiedLicenseLabelSpdxIdsSuffix(
          suffix,
          malformedDeclaredIds,
          aliases,
        )
      ) {
        prefixLines.push(looseLine)
        continue
      }
      return {
        malformedDeclaredIds,
        body: lines.slice(bodyStartIndex).join('\n').trim(),
      }
    }

    const detection = detectSpdxIdentifier(
      'SPDX-License-Identifier: ' + value,
      knownIds,
    )
    if (!detection || !isStandaloneLicenseLabelSpdxDetection(detection)) {
      prefixLines.push(looseLine)
      continue
    }
    const suffix = [
      ...gapContextLines,
      ...licenseLabelSuffixLines(lines.slice(bodyStartIndex)),
    ].join('\n')
    if (hasDisqualifiedLicenseLabelSpdxSuffix(suffix, detection, aliases)) {
      prefixLines.push(looseLine)
      continue
    }
    return {
      detection,
      body: lines.slice(bodyStartIndex).join('\n').trim(),
    }
  }
  return undefined
}

function isStandaloneLicenseLabelSpdxDetection(
  detection: SpdxDetection,
): boolean {
  return (
    detection.hasCompoundExpression ||
    detection.hasWithException ||
    detection.unsupportedIds.some((id) => officialSpdxLicenseIds.has(id))
  )
}

function stripCommentShellPreservingLineCount(lines: string[]): string[] {
  let inBlockComment = false

  return lines.map((line) => {
    if (inBlockComment) {
      const closeIndex = line.indexOf('*/')
      const commentBody =
        closeIndex === -1 ? line : line.slice(0, closeIndex).trimEnd()
      if (closeIndex !== -1) inBlockComment = false
      return commentBody.replace(lineCommentShellPattern, '')
    }

    if (/^\s*#!.*$/.test(line)) return ''

    const blockCommentOpen = blockCommentOpenShellPattern.exec(line)
    if (blockCommentOpen) {
      const closeIndex = line.indexOf('*/', blockCommentOpen[0].length)
      if (closeIndex !== -1) {
        const body = line.slice(blockCommentOpen[0].length, closeIndex).trim()
        const tail = line.slice(closeIndex + 2).trim()
        return tail || body
      }
      inBlockComment = true
      return line.slice(blockCommentOpen[0].length)
    }

    return line.replace(lineCommentShellPattern, '')
  })
}

function blockCommentTailAfterClose(line: string): string | undefined {
  const match = blockCommentCloseTailPattern.exec(line)
  if (!match) return undefined
  return line.slice(match.index + match[0].length).trim()
}

function hasKnownHeaderAlias(value: string, aliases: HeaderAlias[]): boolean {
  const valueWords = aliasWords(value)
  if (valueWords.length === 0) return false
  const licenseAliasWords = aliases.map((alias) => alias.words)
  return (
    licenseIdsForHeaderWords(valueWords, aliases, licenseAliasWords).length > 0
  )
}

function hasDisqualifiedLicenseLabelSpdxSuffix(
  suffix: string,
  detection: SpdxDetection,
  aliases: HeaderAlias[],
): boolean {
  return hasDisqualifiedLicenseLabelSpdxIdsSuffix(
    suffix,
    new Set(detection.ids),
    aliases,
  )
}

function hasDisqualifiedLicenseLabelSpdxIdsSuffix(
  suffix: string,
  licenseIds: Set<string>,
  aliases: HeaderAlias[],
): boolean {
  if (
    hasScopedAwayLicenseLabelSuffix(suffix) ||
    hasRestrictiveLicenseLabelSuffix(suffix) ||
    hasNegatedProjectLicenseLabelSuffix(suffix)
  ) {
    return true
  }

  const licenseAliasWords = aliases.map((alias) => alias.words)
  return aliases
    .filter((alias) => licenseIds.has(alias.licenseId))
    .some((alias) =>
      [alias.words, ...(alias.sameLicenseWords || [])].some((words) =>
        hasNegatedLicenseLabelSuffix(suffix, words, licenseAliasWords),
      ),
    )
}

function unsupportedSpdxExpressionResponse(expression: string): MatchResponse {
  return {
    inputType: 'spdx-expression',
    spdxExpression: expression,
    results: [],
    message:
      'Unknown: compound SPDX expressions, WITH exceptions, and unknown SPDX IDs need a future parser.',
  }
}

function projectBodyForLicenseLabelSpdxExpression(
  body: string,
  licenses: LicenseEntry[],
): string {
  const thirdPartySplit = splitBeforeThirdPartyFullLicenseBody(body, licenses)
  const projectBody = thirdPartySplit?.projectBody.trim()
  if (projectBody) return projectBody
  return hasLeadingThirdPartyLicenseLabelBodyContext(body) ? '' : body
}

function hasCurrentLicenseLabelPrefix(labelPrefix: string): boolean {
  return normalizedPrefixedInlineLicenseLabelPattern.test(labelPrefix)
}

function licenseLabelLineMatch(
  input: string,
  licenseAliasWords: string[][],
  aliases?: HeaderAlias[],
  options: {
    detectConflicts?: boolean
    ignoreDisqualification?: boolean
  } = {},
):
  | {
      context: string
      conflicting?: boolean
      current: boolean
      disqualified?: boolean
      licenseIds?: string[]
      suffix: string
      words: string[]
    }
  | undefined {
  const lines = input.split(/\r\n?|\n/)
  const prefixLines: string[] = []
  const stickyContextLines: string[] = []
  let candidate:
    | {
        context: string
        current: boolean
        disqualified?: boolean
        licenseIds?: string[]
        suffix: string
        words: string[]
      }
    | undefined

  for (let index = 0; index < lines.length; index += 1) {
    const looseLine = normalizeHeaderLoose(lines[index])
    if (!looseLine) {
      if (hasCurrentLicenseLabelSectionContext(prefixLines)) {
        stickyContextLines.length = 0
      } else {
        for (const prefixLine of prefixLines) {
          if (isStickyLicenseLabelContextLine(prefixLine))
            stickyContextLines.push(prefixLine)
        }
      }
      prefixLines.length = 0
      continue
    }

    let labelLine = looseLine
    let labelValueIndex = index
    const standaloneLabelMatch =
      normalizedStandaloneLicenseLabelPattern.exec(looseLine)
    if (standaloneLabelMatch) {
      const nextValueIndex = nextNonEmptyLineIndex(lines, index)
      if (nextValueIndex > index) {
        labelLine =
          looseLine + ' ' + normalizeHeaderLoose(lines[nextValueIndex])
        labelValueIndex = nextValueIndex
      }
    }
    const labelMatch = normalizedInlineLicenseLabelPattern.exec(labelLine)
    if (labelMatch) {
      const hasCurrentLabel = hasCurrentLicenseLabelPrefix(labelMatch[0])
      const contextLines = licenseLabelContextLinesForMatch(
        stickyContextLines,
        prefixLines,
      )
      const context = contextLines.join('\n')
      const suffix = licenseLabelSuffixLines(
        lines.slice(labelValueIndex + 1),
      ).join('\n')
      const labelWords = wordsAfterHeaderMatch(labelLine, labelMatch[0].length)
      const labelLicenseIds = aliases
        ? licenseIdsForHeaderWords(labelWords, aliases, licenseAliasWords)
        : undefined
      const hasLabelAlias =
        (labelLicenseIds && labelLicenseIds.length > 0) ||
        hasPotentialHeaderAlias(labelWords, licenseAliasWords)
      const hasLabelContradiction =
        hasNegatedLicenseLabelSuffix(context, labelWords, licenseAliasWords) ||
        hasNegatedProjectLicenseLabelSuffix(context) ||
        hasNegatedLicenseLabelSuffix(suffix, labelWords, licenseAliasWords) ||
        hasNegatedProjectLicenseLabelSuffix(suffix)
      const hasDisqualifiedLabelMatch = isDisqualifiedLicenseLabelMatch(
        hasCurrentLabel ? '' : context,
        suffix,
      )
      if (labelValueIndex !== index && !hasLabelAlias) {
        prefixLines.push(looseLine)
        continue
      }
      if (
        hasLabelAlias &&
        (options.ignoreDisqualification ||
          (!hasDisqualifiedLabelMatch && !hasLabelContradiction))
      ) {
        if (
          candidate &&
          options.ignoreDisqualification &&
          hasDisqualifiedLabelMatch
        ) {
          prefixLines.length = 0
          index = labelValueIndex
          continue
        }
        if (candidate) {
          if (
            options.ignoreDisqualification &&
            candidate.disqualified &&
            !hasDisqualifiedLabelMatch
          ) {
            candidate = {
              context,
              current: hasCurrentLabel,
              licenseIds: labelLicenseIds,
              suffix,
              words: labelWords,
            }
            prefixLines.length = 0
            index = labelValueIndex
            continue
          }
          if (candidate.licenseIds && labelLicenseIds) {
            const sharedLicenseIds = candidate.licenseIds.filter((licenseId) =>
              labelLicenseIds.includes(licenseId),
            )
            if (sharedLicenseIds.length === 0) {
              if (!options.detectConflicts) return undefined
              return {
                ...candidate,
                conflicting: true,
                current: candidate.current || hasCurrentLabel,
                suffix,
              }
            }
            if (labelLicenseIds.length <= candidate.licenseIds.length) {
              candidate = {
                context,
                current: candidate.current || hasCurrentLabel,
                licenseIds: sharedLicenseIds,
                suffix,
                words: labelWords,
              }
            } else {
              candidate = {
                ...candidate,
                current: candidate.current || hasCurrentLabel,
                licenseIds: sharedLicenseIds,
              }
            }
            prefixLines.length = 0
            index = labelValueIndex
            continue
          }
          if (!sameLicenseLabelWords(candidate.words, labelWords)) {
            return undefined
          }
        }
        candidate = {
          context,
          current: hasCurrentLabel,
          disqualified: hasDisqualifiedLabelMatch,
          licenseIds: labelLicenseIds,
          suffix,
          words: labelWords,
        }
      }
      prefixLines.length = 0
      index = labelValueIndex
      continue
    }

    prefixLines.push(looseLine)
  }

  return candidate
}

function hasCurrentLicenseLabelSectionContext(lines: string[]): boolean {
  return lines.some((line) =>
    /^(?:(?:this|the|our) )?(?:main |primary )?(?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli|source code|source|code|work)(?: (?:metadata|license|licensing|notice|notices|section|details|information))?$/.test(
      line,
    ),
  )
}

function licenseLabelContextLinesForMatch(
  stickyContextLines: string[],
  prefixLines: string[],
): string[] {
  if (!hasCurrentLicenseLabelSectionContext(prefixLines)) {
    return [...stickyContextLines, ...prefixLines]
  }
  return [
    ...stickyProjectLicenseLabelContextLinesForCurrentSection(
      stickyContextLines,
    ),
    ...prefixLines,
  ]
}

function stickyProjectLicenseLabelContextLinesForCurrentSection(
  stickyContextLines: string[],
): string[] {
  const contextLines: string[] = []
  let carriesScopedAwayContext = false
  for (const line of stickyContextLines) {
    if (isScopedAwayStickyLicenseLabelContextLine(line)) {
      carriesScopedAwayContext = true
      continue
    }
    if (
      hasLicenseSpecificProjectNegationLine(line) ||
      hasProjectOwnedRestrictiveLicenseLabelContext(line)
    ) {
      contextLines.push(line)
      carriesScopedAwayContext = false
      continue
    }
    if (!carriesScopedAwayContext && hasRestrictiveLicenseLabelSuffix(line)) {
      contextLines.push(line)
    }
  }
  return contextLines
}

function sameLicenseLabelWords(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((word, index) => word === right[index])
  )
}

function licenseIdsForHeaderWords(
  inputWords: string[],
  aliases: HeaderAlias[],
  licenseAliasWords: string[][],
): string[] {
  const licenseIds = new Set<string>()
  for (const alias of aliases) {
    if (
      matchesHeaderAlias(
        inputWords,
        alias.words,
        licenseAliasWords,
        alias.sameLicenseWords,
      )
    ) {
      licenseIds.add(alias.licenseId)
    }
  }
  return Array.from(licenseIds)
}

function explicitLicenseHeaderCueIds(
  input: string,
  licenses: LicenseEntry[],
): Set<string> {
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const ids = new Set<string>()

  for (const line of input.split(/\r\n?|\n/)) {
    const loose = normalizeHeaderLoose(line)
    if (!loose) continue

    const labelMatch = normalizedInlineLicenseLabelPattern.exec(loose)
    if (labelMatch) {
      for (const id of licenseIdsForHeaderWords(
        wordsAfterHeaderMatch(loose, labelMatch[0].length),
        aliases,
        licenseAliasWords,
      )) {
        ids.add(id)
      }
    }

    const headerPattern = resetLicenseHeaderPattern(
      explicitLicenseHeaderCuePattern,
    )
    let match: RegExpExecArray | null
    while ((match = headerPattern.exec(loose))) {
      for (const id of licenseIdsForHeaderWords(
        wordsAfterHeaderMatch(loose, match.index + match[0].length),
        aliases,
        licenseAliasWords,
      )) {
        ids.add(id)
      }
    }
  }

  return ids
}

function licenseLabelContextLines(context: string): string[] {
  return context.split('\n').filter(Boolean)
}

function hasHistoricalLicenseLabelContext(context: string): boolean {
  return licenseLabelContextLines(context).some((line) =>
    /\b(?:previously|formerly|historically|originally|initially|once)\b|\b(?:previous|former|historical|old|original) licen[cs]e\b/.test(
      line,
    ),
  )
}

function licenseLabelSuffixLines(lines: string[]): string[] {
  const suffixLines: string[] = []
  let inThirdPartySection = false
  for (const line of lines) {
    const looseLine = normalizeHeaderLoose(line)
    if (!looseLine) continue
    if (isThirdPartyLicenseLabelSuffixBoundary(looseLine)) {
      inThirdPartySection = true
      continue
    }
    if (inThirdPartySection && isCurrentLicenseLabelSuffixBoundary(looseLine)) {
      inThirdPartySection = false
      suffixLines.push(looseLine)
      continue
    }
    if (
      inThirdPartySection &&
      hasRestrictiveLicenseLabelLine(looseLine) &&
      !hasProjectOwnedRestrictiveLicenseLabelLine(looseLine)
    )
      continue
    suffixLines.push(looseLine)
  }
  return suffixLines
}

function isThirdPartyLicenseLabelSuffixBoundary(line: string): boolean {
  return hasThirdPartyLicenseLabelLineContext(line)
}

function isCurrentLicenseLabelSuffixBoundary(line: string): boolean {
  return (
    /^(?:(?:main|primary) )?(?:project|source|source code|code|software|package|repository|repo|library|program|application|tool|app|cli|product)(?: license| licensing| notice| notices| terms| details| information| section)?$/.test(
      line,
    ) ||
    /^(?:license|licensing) (?:terms|notice|notices|details|information|section)$/.test(
      line,
    )
  )
}

function isCurrentLicenseSegmentBoundary(
  segment: string,
  licenseAliasWords: string[][],
): boolean {
  const loose = normalizeHeaderLoose(segment)
  if (isCurrentLicenseLabelSuffixBoundary(loose)) return true

  const headerPattern = resetLicenseHeaderPattern(
    currentLicenseSegmentBoundaryPattern,
  )
  let match: RegExpExecArray | null
  while ((match = headerPattern.exec(loose))) {
    const inputWords = wordsAfterHeaderMatch(
      loose,
      match.index + match[0].length,
    )
    if (
      hasPotentialHeaderAlias(inputWords, licenseAliasWords) &&
      hasCurrentLicenseHeaderContext(
        loose,
        match.index,
        licenseAliasWords,
        match[0],
        segment,
      )
    )
      return true
  }

  return false
}

function hasProjectOwnedRestrictiveLicenseLabelLine(line: string): boolean {
  return (
    hasProjectOwnedRestrictiveLicenseLabelContext(line) &&
    !hasThirdPartyHeaderContext(line) &&
    !isThirdPartyOwnedHeaderContext(line) &&
    hasRestrictiveLicenseLabelLine(line)
  )
}

const projectOwnedLicenseLabelSubjectPattern =
  '(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli|product|code|source|work)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application|product|work)|(?:(?:this|the|our) )?(?:main |primary )?project licen[cs]e|(?:main|primary) (?:project )?(?:source code|source|code|software|package|library|program|application|repository|repo|files|tool|app|cli|product)|command line interface|browser build)'
const projectOwnedRestrictiveStatePattern = new RegExp(
  `\\b${projectOwnedLicenseLabelSubjectPattern} (?:is|are|was|were|remains|remain|has been|have been|is still|are still) (?:proprietary|closed source|confidential|nondisclosure|non disclosure)\\b`,
)
const projectOwnedRestrictiveActionPattern = new RegExp(
  `\\bdo not (?:copy|distribute|modify|redistribute|sell|sublicense|use|reverse engineer)\\b.{0,120}\\b${projectOwnedLicenseLabelSubjectPattern}\\b`,
)
const projectOwnedRestrictiveUseLimitPattern = new RegExp(
  `\\b${projectOwnedLicenseLabelSubjectPattern} (?:is|are|was|were|has been|have been) (?:for |only for )?(?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo) (?:use|usage|distribution|redistribution)(?: only)?\\b`,
)
const projectOwnedNoLicensePattern = new RegExp(
  `\\b${projectOwnedLicenseLabelSubjectPattern} (?:is|are|was|were|remains|remain|has been|have been) under no (?:open source |free software |standard )?licen[cs]e\\b`,
)
const dependencyNoteProjectFollowupSubjectPattern = `(?:it|they|${projectOwnedLicenseLabelSubjectPattern})`
const dependencyNoteNegatedLicensePattern = new RegExp(
  `\\b${dependencyNoteProjectFollowupSubjectPattern} (?:is|are|was|were|has been|have been|is still|are still|remains|remain) not (?:currently |presently |actually |explicitly |itself |directly )?(?:licen[cs]ed|released|distributed|made available|available) under\\b`,
)
const dependencyNoteNotOpenSourcePattern = new RegExp(
  `\\b${dependencyNoteProjectFollowupSubjectPattern} (?:is|are|was|were|has been|have been|is still|are still|remains|remain) not (?:open source|free software)\\b`,
)
const dependencyNoteConjunctionNegatedLicensePattern =
  /\b(?:and|but|however|though|although) (?:is|are|was|were|has been|have been|is still|are still|remains|remain) not (?:currently |presently |actually |explicitly |itself |directly )?(?:licen[cs]ed|released|distributed|made available|available) under\b/
const dependencyNoteConjunctionNotOpenSourcePattern =
  /\b(?:and|but|however|though|although) (?:is|are|was|were|has been|have been|is still|are still|remains|remain) not (?:open source|free software)\b/
const dependencyNoteConjunctionNoLicensePattern =
  /\b(?:and|but|however|though|although) (?:is|are|was|were|has been|have been|is still|are still|remains|remain) under no (?:open source |free software |standard )?licen[cs]e\b/
const dependencyNoteConjunctionNoGrantPattern =
  /\b(?:and|but|however|though|although) (?:no (?:licen[cs]e|permission)(?: or (?:other )?permission)? is granted|permission is not granted)(?:,? nor permission is granted)?\b/
const noGrantRestrictiveTailPattern =
  /^(?:no (?:licen[cs]e|permission)(?: or (?:other )?permission)? is granted|permission is not granted)(?:,? nor permission is granted)?$/
const projectOwnedAllRightsReservedAfterPattern = new RegExp(
  `\\ball rights reserved\\b.{0,120}\\b${projectOwnedLicenseLabelSubjectPattern}\\b`,
)
const projectOwnedAllRightsReservedBeforePattern = new RegExp(
  `\\b${projectOwnedLicenseLabelSubjectPattern}\\b.{0,120}\\ball rights reserved\\b`,
)
const strongProjectLicenseSubjectPattern =
  '(?:(?:this|the|our) (?:main |primary )?project|(?:(?:this|the|our) )?(?:main |primary )?project licen[cs]e|(?:main|primary) project)'
const strongProjectRestrictiveStatePattern = new RegExp(
  `\\b${strongProjectLicenseSubjectPattern} (?:is|are|was|were|remains|remain|has been|have been|is still|are still) (?:proprietary|closed source|confidential|nondisclosure|non disclosure)\\b`,
)
const strongProjectRestrictiveActionPattern = new RegExp(
  `\\bdo not (?:copy|distribute|modify|redistribute|sell|sublicense|use|reverse engineer)\\b.{0,120}\\b${strongProjectLicenseSubjectPattern}\\b`,
)
const strongProjectRestrictiveUseLimitPattern = new RegExp(
  `\\b${strongProjectLicenseSubjectPattern} (?:is|are|was|were|has been|have been) (?:for |only for )?(?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo) (?:use|usage|distribution|redistribution)(?: only)?\\b`,
)
const strongProjectNoLicensePattern = new RegExp(
  `\\b${strongProjectLicenseSubjectPattern} (?:is|are|was|were|remains|remain|has been|have been) under no (?:open source |free software |standard )?licen[cs]e\\b`,
)
const strongProjectAllRightsReservedAfterPattern = new RegExp(
  `\\ball rights reserved\\b.{0,120}\\b${strongProjectLicenseSubjectPattern}\\b`,
)
const strongProjectAllRightsReservedBeforePattern = new RegExp(
  `\\b${strongProjectLicenseSubjectPattern}\\b.{0,120}\\ball rights reserved\\b`,
)

function hasProjectOwnedRestrictiveStatement(segment: string): boolean {
  const loose = normalizeHeaderLoose(segment)
  return (
    projectOwnedRestrictiveStatePattern.test(loose) ||
    projectOwnedRestrictiveActionPattern.test(loose) ||
    projectOwnedRestrictiveUseLimitPattern.test(loose) ||
    projectOwnedNoLicensePattern.test(loose) ||
    projectOwnedAllRightsReservedAfterPattern.test(loose) ||
    projectOwnedAllRightsReservedBeforePattern.test(loose)
  )
}

function hasStrongProjectOwnedRestrictiveStatement(segment: string): boolean {
  const loose = normalizeHeaderLoose(segment)
  const labelMatch =
    /^(?:(?:this|the|our) )?(?:main |primary )?project licen[cs]e(?: identifier)? (.+)$/.exec(
      loose,
    )
  return (
    strongProjectRestrictiveStatePattern.test(loose) ||
    strongProjectRestrictiveActionPattern.test(loose) ||
    strongProjectRestrictiveUseLimitPattern.test(loose) ||
    strongProjectNoLicensePattern.test(loose) ||
    strongProjectAllRightsReservedAfterPattern.test(loose) ||
    strongProjectAllRightsReservedBeforePattern.test(loose) ||
    Boolean(
      labelMatch &&
      (hasRestrictiveLicenseLabelLine(labelMatch[1]) ||
        hasStrongProjectRestrictiveContinuation(labelMatch[1])),
    )
  )
}

function hasStrongProjectLicenseContinuationCue(segment: string): boolean {
  return /^(?:(?:this|the|our) )?(?:main |primary )?project licen[cs]e(?: identifier)?$/.test(
    normalizeHeaderLoose(segment),
  )
}

function hasStrongProjectRestrictiveContinuation(segment: string): boolean {
  return /^(?:it|this|that) (?:is|was|were|remains|remain|has been|have been|is still|are still) (?:(?:for |only for )?(?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo) (?:use|usage|distribution|redistribution)(?: only)?|proprietary|closed source|confidential|nondisclosure|non disclosure|under no (?:open source |free software |standard )?licen[cs]e)\b/.test(
    normalizeHeaderLoose(segment),
  )
}

function hasStrongProjectOwnedRestrictiveBodySegments(
  segments: string[],
): boolean {
  return segments.some(
    (segment, index) =>
      hasStrongProjectOwnedRestrictiveStatement(segment) ||
      (index > 0 &&
        hasStrongProjectLicenseContinuationCue(segments[index - 1]) &&
        hasStrongProjectRestrictiveContinuation(segment)),
  )
}

function hasProjectOwnedRestrictiveLicenseLabelContext(line: string): boolean {
  const context = boundedHeaderContext(line)
  return (
    projectOwnedRestrictiveStatePattern.test(context) ||
    projectOwnedRestrictiveActionPattern.test(context) ||
    projectOwnedRestrictiveUseLimitPattern.test(context) ||
    projectOwnedNoLicensePattern.test(context) ||
    projectOwnedAllRightsReservedAfterPattern.test(context) ||
    projectOwnedAllRightsReservedBeforePattern.test(context)
  )
}

function isStickyLicenseLabelContextLine(line: string): boolean {
  return (
    isScopedAwayStickyLicenseLabelContextLine(line) ||
    isStickyProjectLicenseLabelContextLine(line)
  )
}

function isScopedAwayStickyLicenseLabelContextLine(line: string): boolean {
  return (
    hasThirdPartyLicenseLabelLineContext(line) ||
    (!/\bcopyright\b/.test(line) && isScopedAwayLicenseHeaderContext(line))
  )
}

function isStickyProjectLicenseLabelContextLine(line: string): boolean {
  return (
    hasLicenseSpecificProjectNegationLine(line) ||
    hasRestrictiveLicenseLabelSuffix(line)
  )
}

function hasLicenseSpecificProjectNegationLine(line: string): boolean {
  return (
    hasStrongProjectNegationSubject(line) &&
    (/\b(?:licen[cs]ed|released|distributed|made available|available) under\b/.test(
      line,
    ) ||
      /\blicen[cs]ed\b/.test(line))
  )
}

function hasThirdPartyLicenseLabelContext(context: string): boolean {
  return licenseLabelContextLines(context).some((line) => {
    if (/[:：]\s*\S/.test(line)) return false
    const lowerLine = line.toLowerCase()
    return hasThirdPartyLicenseLabelLineContext(
      lowerLine.replace(/[:：]\s*$/, ''),
    )
  })
}

function hasThirdPartyLicenseLabelLineContext(labelContext: string): boolean {
  if (hasOnlyNegatedThirdPartyBodyContext(labelContext)) return false
  return hasAffirmativeThirdPartyLicenseLabelLineContext(labelContext)
}

function hasAffirmativeThirdPartyLicenseLabelLineContext(
  labelContext: string,
): boolean {
  return (
    isThirdPartyOwnedHeaderContext(labelContext) ||
    namedDependencyIntroPattern.test(labelContext) ||
    bundledNamedSubjectIntroPattern.test(labelContext) ||
    /\b(?:dependency|dependencies|component|components|library|libraries|module|modules|plugin|plugins|parser|parsers|tool|tools|helper|helpers) metadata$/.test(
      labelContext,
    ) ||
    /^(?:(?:the|a|an) )?(?:component|components|library|libraries|module|modules|plugin|plugins|parser|parsers|tool|tools|helper|helpers)(?: info| information| details| notices)?$/.test(
      labelContext,
    ) ||
    /\b(?:third party|third-party|vendored(?: code)?|bundled(?: code)?|embedded(?: code)?|included third party(?: code)?)(?: licen[cs]es?| notices?| metadata)?$/.test(
      labelContext,
    ) ||
    /^(?:(?:the|a|an|this|that|these|those) )?(?:(?:optional|dev|development|peer|runtime|transitive) )?dependenc(?:y|ies)(?: [a-z0-9<>]+){0,6}$/.test(
      labelContext,
    ) ||
    /\b(?!project\b|this\b|our\b)[a-z0-9<>]+ package metadata$/.test(
      labelContext,
    )
  )
}

function isDisqualifiedLicenseLabelMatch(
  context: string,
  suffix: string,
): boolean {
  return (
    hasHistoricalLicenseLabelContext(context) ||
    hasThirdPartyLicenseLabelContext(context) ||
    hasScopedAwayLicenseLabelContext(context) ||
    hasScopedAwayLicenseLabelSuffix(suffix) ||
    hasRestrictiveLicenseLabelSuffix(context) ||
    hasRestrictiveLicenseLabelSuffix(suffix)
  )
}

function hasScopedAwayLicenseLabelContext(context: string): boolean {
  return licenseLabelContextLines(context).some(
    (line) =>
      !/\bcopyright\b/.test(line) && isScopedAwayLicenseHeaderContext(line),
  )
}

const scopedAwayLicenseLabelSuffixPattern =
  /^(?:(?:for|only for) (?:docs|documentation|manual|manuals|guide|guides|example|examples|sample|samples|test|tests|fixture|fixtures|asset|assets|image|images|font|fonts|readme|website|site|test code|sample code|example code)(?: (?:only|purposes(?: only)?))?|(?:docs|documentation|manual|manuals|guide|guides|example|examples|sample|samples|test|tests|fixture|fixtures|asset|assets|image|images|font|fonts|readme|website|site|test code|sample code|example code) (?:only|purposes(?: only)?))$/

function hasScopedAwayLicenseLabelSuffix(suffix: string): boolean {
  return licenseLabelContextLines(suffix).some((line) =>
    scopedAwayLicenseLabelSuffixPattern.test(line),
  )
}

function hasRestrictiveLicenseLabelSuffix(suffix: string): boolean {
  const rawLines = licenseLabelContextLines(suffix).filter((line) =>
    normalizeHeaderLoose(line),
  )
  const lines = rawLines.map(normalizeHeaderLoose)
  return lines.some(
    (line, index) =>
      (hasRestrictiveLicenseLabelLine(line) ||
        hasRestrictiveMixedPassiveModalUseSubject(rawLines[index])) &&
      !isThirdPartyAllRightsReservedLabelLine(line) &&
      !isPermissiveCopyrightNoticeSegment(line) &&
      !isPermissiveAllRightsReservedNotice(lines, index),
  )
}

function isThirdPartyAllRightsReservedLabelLine(line: string): boolean {
  if (hasOnlyNegatedThirdPartyBodyContext(line)) return false
  return (
    /\ball rights reserved\b/.test(line) &&
    (hasThirdPartySubjectAllRightsReserved(line) ||
      isThirdPartyOwnedHeaderContext(line) ||
      hasExplicitThirdPartyBodyContextSegment(line)) &&
    !hasDirectProjectAllRightsReserved(line)
  )
}

function hasDirectProjectAllRightsReserved(line: string): boolean {
  if (strictDirectProjectAllRightsReservedPattern.test(line)) return true
  if (
    allRightsReservedByProjectPattern.test(line) &&
    !allRightsReservedByProjectDependencyPattern.test(line)
  )
    return true
  if (hasThirdPartySubjectAllRightsReserved(line)) return false
  return directProjectAllRightsReservedPattern.test(line)
}

function hasThirdPartySubjectAllRightsReserved(line: string): boolean {
  return (
    allRightsReservedByProjectDependencyPattern.test(line) ||
    explicitThirdPartyAllRightsReservedSubjectPattern.test(line) ||
    bareThirdPartyAllRightsReservedSubjectPattern.test(line) ||
    projectDependencyAllRightsReservedSubjectPattern.test(line) ||
    projectDependencyPronounAllRightsReservedSubjectPattern.test(line)
  )
}

function hasOnlyNegatedThirdPartyBodyContext(loose: string): boolean {
  const withoutNegatedContext = loose.replace(
    negatedThirdPartyBodyContextPattern,
    ' ',
  )
  return (
    withoutNegatedContext !== loose &&
    !hasRemainingThirdPartyBodyContext(withoutNegatedContext)
  )
}

function hasRemainingThirdPartyBodyContext(loose: string): boolean {
  return (
    explicitThirdPartyBodyContextPattern.test(loose) ||
    namedDependencyIntroPattern.test(loose) ||
    bundledNamedSubjectIntroPattern.test(loose) ||
    hasAffirmativeThirdPartyLicenseLabelLineContext(loose) ||
    hasThirdPartySubjectAllRightsReserved(loose)
  )
}

function isPermissiveAllRightsReservedNotice(
  lines: string[],
  index: number,
): boolean {
  const previousLine = lines[index - 1] || ''
  const line = lines[index] || ''
  return (
    /^all rights reserved\.?$/.test(line) &&
    index > 0 &&
    isPermissiveCopyrightNoticeSegment(previousLine) &&
    !hasRestrictiveCopyrightNoticeSegment(`${previousLine} ${line}`)
  )
}

function hasRestrictiveLicenseLabelLine(line: string): boolean {
  if (
    /^(?:no (?:licen[cs]e|permission) is granted|permission is not granted)$/.test(
      line,
    )
  )
    return true
  if (/^source(?: code)? available only\.?$/.test(line)) return true
  if (projectOwnedRestrictiveUseLimitPattern.test(line)) return true
  if (
    /\b(?:no permission is granted|permission is not granted) (?:to (?:(?:(?:use|copy|modify|distribute|redistribute),?|and|or) )+|for )(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli|product|code|source|work)\b/.test(
      line,
    )
  )
    return true
  if (/\ball rights reserved\b/.test(line)) return true
  if (hasRestrictiveModalProhibition(line)) return true
  if (hasNoPrefixedRestrictionTail(aliasWords(line), 0)) return true
  if (
    /\bnot for (?:redistribution|distribution|use|copying|modification)\b/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(?:for )?(?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo) (?:use|usage|distribution|redistribution)(?: only)?\.?$/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo)(?: only)?$/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(?:for )?(?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo) only\b/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(?:only|not) for (?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo) (?:use|usage|distribution|redistribution)\b/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^(?:use|usage|distribution|redistribution) (?:is |are |has been |have been )?(?:restricted|limited) (?:to|for|by)\b/.test(
      line,
    )
  ) {
    return true
  }
  if (hasProjectAndDependencyRestrictiveState(line)) return true

  for (const match of line.matchAll(
    /\b(?:proprietary|closed source|confidential|nondisclosure|non disclosure)\b/g,
  )) {
    if (!isNegatedRestrictiveLicenseTerm(line, match.index || 0)) return true
  }

  return false
}

function hasRestrictiveModalProhibition(line: string): boolean {
  if (hasRestrictiveMixedPassiveModalUseSubject(line)) return true
  const words = aliasWords(line)
  return words.some(
    (_, index) =>
      isRestrictiveModalProhibitionAt(words, index) ||
      isRestrictiveCannotProhibitionAt(words, index),
  )
}

function hasRestrictiveMixedPassiveModalUseSubject(line: string): boolean {
  const normalized = line
    .toLowerCase()
    .replace(/[^a-z0-9,\s]+/g, ' ')
    .replace(/\s+/g, ' ')
  return /\b(?:(?:this|the|our|these|those) )?(?:app|application|cli|code|codebase|component|file|files|library|package|product|program|project|repo|repository|service|software|source|tool|work)\s*,\s*(?:(?:(?:project|product|software) )?(?:brand|brands|logo|logos|mark|marks|name|names|trademark|trademarks)\s*,\s*)*(?:(?:and|or) )?(?:(?:project|product|software) )?(?:brand|brands|logo|logos|mark|marks|name|names|trademark|trademarks)\s+(?:may|must|shall) not be used\b/.test(
    normalized,
  )
}

function hasGenericNegatedProjectLicenseLabelLine(line: string): boolean {
  return /\b(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli|product|code|source|work|file|source file)|(?:these|those) files|(?:main|primary) (?:project )?(?:source code|source|code|software|package|library|program|application|repository|repo|files|tool|app|cli|product|file|source file)) (?:is|are|was|were|has been|have been) not (?:currently |presently |actually |explicitly |itself |directly )?(?:licen[cs]ed|released|distributed|made available|available) under (?:any|an?) (?:open source |free software |standard )?licen[cs]e\b/.test(
    line,
  )
}

function hasStrongProjectNegationSubject(segment: string): boolean {
  const loose = normalizeHeaderLoose(segment)
  return (
    /\b(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|source file|source|code|work|file)|(?:these|those) files|(?:main|primary) (?:project )?(?:source code|source|code|software|package|repository|repo|files|file|source file)) (?:is|are|was|were|has been|have been) (?:not|no longer)\b/.test(
      loose,
    ) ||
    /\bno part of (?:this|the|our) (?:project|codebase|software|package|repository|repo|source file|source|code|work|file) (?:is|are|was|were|has been|have been)\b/.test(
      loose,
    )
  )
}

function hasNegatedLicenseLabelSuffix(
  suffix: string,
  labelWords: string[],
  licenseAliasWords: string[][],
): boolean {
  return hasNegatedLicenseWordsInProjectText(
    suffix,
    labelWords,
    licenseAliasWords,
  )
}

function hasNegatedProjectLicenseLabelSuffix(suffix: string): boolean {
  let previousSegmentCarriesThirdParty = false

  return bodyTextSegments(suffix).some((segment) => {
    const segmentCarriesThirdParty = hasThirdPartyBodyContextSegment(segment)
    const carriesThirdParty =
      previousSegmentCarriesThirdParty || segmentCarriesThirdParty
    if (carriesThirdParty && !hasStrongProjectNegationSubject(segment)) {
      previousSegmentCarriesThirdParty = true
      return false
    }
    if (segmentCarriesThirdParty) previousSegmentCarriesThirdParty = true
    return hasGenericNegatedProjectLicenseLabelLine(
      normalizeHeaderLoose(segment),
    )
  })
}

function hasNegatedLicenseListPrefix(
  prefix: string,
  licenseAliasWords: string[][],
): boolean {
  const words = prefix.split(' ').filter(Boolean)
  let end = words.length

  while (end > 0) {
    end = licenseListAliasEnd(words, end)
    let matchedAlias = false
    for (const aliasWords of licenseAliasWords) {
      const aliasStart = end - aliasWords.length
      if (aliasStart < 0) continue
      if (!matchesWordsAt(words, aliasStart, aliasWords)) continue
      if (hasNegatedLicenseHeaderPrefix(words.slice(0, aliasStart).join(' ')))
        return true

      matchedAlias = true
      end = aliasStart
      break
    }
    if (!matchedAlias) return false
  }
  return false
}

function licenseListAliasEnd(words: string[], end: number): number {
  let aliasEnd = end
  if (isLicenseArticle(words[aliasEnd - 1])) aliasEnd -= 1
  if (isLicenseListConnector(words[aliasEnd - 1])) aliasEnd -= 1
  if (isLicenseArticle(words[aliasEnd - 1])) aliasEnd -= 1
  return aliasEnd
}

function isLicenseArticle(word: string | undefined): boolean {
  return word === 'the' || word === 'a' || word === 'an'
}

function isLicenseListConnector(word: string | undefined): boolean {
  return word === 'or' || word === 'and' || word === 'nor'
}

function hasNegatedLicenseAdjective(
  words: string[],
  index: number,
  targetWordsLength: number,
): boolean {
  const nextWordIndex =
    words[index + targetWordsLength] === 'license'
      ? index + targetWordsLength + 1
      : index + targetWordsLength
  const nextWord = words[nextWordIndex]
  if (nextWord !== 'licensed' && nextWord !== 'licenced') return false
  const prefix = words.slice(0, index).join(' ')
  return hasStrongProjectNegationSubject(prefix)
}

function hasNegatedLicenseWordsInText(
  input: string,
  targetWords: string[],
  licenseAliasWords: string[][],
): boolean {
  return licenseLabelContextLines(input).some((line) => {
    const words = aliasWords(line)
    for (let index = 0; index < words.length; index += 1) {
      if (
        !matchesHeaderAlias(words.slice(index), targetWords, licenseAliasWords)
      )
        continue
      const prefix = words.slice(0, index).join(' ')
      if (hasNegatedLicenseHeaderPrefix(prefix)) return true
      if (hasNegatedLicenseListPrefix(prefix, licenseAliasWords)) return true
      if (hasNegatedLicenseAdjective(words, index, targetWords.length))
        return true
    }
    return false
  })
}

function hasNegatedLicenseWordsInProjectText(
  input: string,
  targetWords: string[],
  licenseAliasWords: string[][],
): boolean {
  const segments = bodyTextSegments(input)
  let previousSegmentCarriesThirdParty = false

  for (const segment of segments) {
    const carriesThirdParty =
      previousSegmentCarriesThirdParty ||
      hasThirdPartyBodyContextSegment(segment)
    if (carriesThirdParty && !hasStrongProjectNegationSubject(segment)) {
      previousSegmentCarriesThirdParty = true
      continue
    }

    if (hasNegatedLicenseWordsInText(segment, targetWords, licenseAliasWords)) {
      return true
    }

    if (hasThirdPartyBodyContextSegment(segment)) {
      previousSegmentCarriesThirdParty = true
    } else if (
      !isTransparentLicenseDocumentSegment(segment) &&
      !(
        previousSegmentCarriesThirdParty &&
        isStandaloneLicenseLabelSegment(segment)
      )
    ) {
      previousSegmentCarriesThirdParty = false
    }
  }

  return false
}

function isNegatedRestrictiveLicenseTerm(line: string, index: number): boolean {
  const prefixWords = line
    .slice(Math.max(0, index - 80), index)
    .trim()
    .split(' ')
    .filter(Boolean)

  return (
    hasDirectRestrictiveNegator(prefixWords) ||
    hasCoordinatedRestrictiveNegator(prefixWords) ||
    hasEnumeratedRestrictiveNegator(prefixWords)
  )
}

function hasDirectRestrictiveNegator(words: string[]): boolean {
  const directEnd = skipOptionalArticleBefore(words.length, words)
  const beforeTerm = words.slice(0, directEnd)
  return endsWithRestrictiveNegator(beforeTerm) || endsWithNor(beforeTerm)
}

function hasCoordinatedRestrictiveNegator(words: string[]): boolean {
  const connectorIndex = skipOptionalArticleBefore(words.length, words) - 1
  if (connectorIndex < 1) return false

  const connector = words[connectorIndex]
  if (connector !== 'or' && connector !== 'nor') return false

  const firstTermStart = previousTermStart(connectorIndex, words)
  if (firstTermStart < 0) return false

  return endsWithRestrictiveNegator(words.slice(0, firstTermStart))
}

function hasEnumeratedRestrictiveNegator(words: string[]): boolean {
  const negatorEnd = lastRestrictiveNegatorEnd(words)
  return (
    negatorEnd >= 0 &&
    containsOnlyRestrictiveTermsAndConnectors(words.slice(negatorEnd))
  )
}

function lastRestrictiveNegatorEnd(words: string[]): number {
  for (let endIndex = words.length; endIndex > 0; endIndex -= 1) {
    const beforeTerm = words.slice(0, endIndex)
    if (endsWithRestrictiveNegator(beforeTerm) || endsWithNor(beforeTerm)) {
      return endIndex
    }
  }
  return -1
}

function containsOnlyRestrictiveTermsAndConnectors(words: string[]): boolean {
  let index = 0
  let hasTerm = false
  while (index < words.length) {
    const connector = words[index]
    if (connector === 'and' || connector === 'or' || connector === 'nor') {
      index += 1
      continue
    }

    const termLength = restrictiveTermLengthAt(words, index)
    if (termLength === 0) return false
    hasTerm = true
    index += termLength
  }
  return hasTerm
}

function previousTermStart(endIndex: number, words: string[]): number {
  const lastIndex = skipOptionalArticleBefore(endIndex, words) - 1
  if (lastIndex < 0) return -1
  for (
    let startIndex = Math.max(0, lastIndex - 1);
    startIndex <= lastIndex;
    startIndex += 1
  ) {
    const termLength = restrictiveTermLengthAt(words, startIndex)
    if (termLength > 0 && startIndex + termLength - 1 === lastIndex) {
      return startIndex
    }
  }
  return -1
}

function restrictiveTermLengthAt(words: string[], index: number): number {
  const firstWord = words[index]?.replace(/[,;:]+$/, '')
  const secondWord = words[index + 1]?.replace(/[,;:]+$/, '')
  if (
    firstWord === 'proprietary' ||
    firstWord === 'confidential' ||
    firstWord === 'nondisclosure'
  )
    return 1
  if (firstWord === 'closed' && secondWord === 'source') return 2
  if (firstWord === 'non' && secondWord === 'disclosure') return 2
  return 0
}

function skipOptionalArticleBefore(endIndex: number, words: string[]): number {
  const previous = words[endIndex - 1]
  return previous === 'a' || previous === 'an' || previous === 'the'
    ? endIndex - 1
    : endIndex
}

function endsWithRestrictiveNegator(words: string[]): boolean {
  const last = words[words.length - 1]
  if (
    last === 'not' ||
    last === 'never' ||
    last === 'neither' ||
    last === 'non'
  )
    return true
  return words[words.length - 2] === 'no' && last === 'longer'
}

function endsWithNor(words: string[]): boolean {
  return words[words.length - 1] === 'nor'
}

function hasSkippedUnknownHeaderContext(
  loose: string,
  headerIndex: number,
): boolean {
  const contextPrefix = loose
    .slice(Math.max(0, headerIndex - 240), headerIndex)
    .trim()
  const isRelicenseHeader = isRelicenseHeaderText(loose.slice(headerIndex))
  return (
    /\bnot(?: (?:now|currently|presently|yet|ever|really|actually|explicitly|itself|directly|in|any|sense)){0,6}$/.test(
      contextPrefix,
    ) ||
    /\bno (?:(?:part|portion) of )?(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application|source|code|work)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)|(?:file|files|code|source|software|component|module|project|work)|(?:external )?(?:dependency|dependencies|component|module|library|package|parser|helper|tool|asset|assets|font|fonts|plugin|extension|add on|addon))(?: (?:is|are|was|were|has|have|had|can|will|be|been|being|now|currently|presently|yet|ever|actually|explicitly|itself|directly)){1,8}$/.test(
      contextPrefix,
    ) ||
    noThirdPartyHeaderSubjectNegationPattern.test(contextPrefix) ||
    /\b(?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) (?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|contains|contain)?(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} no (?:external )?(?:(?:parser|helper|plugin|extension|add on|addon) )?(?:dependency|dependencies|component|module|library|package|parser|helper|tool|asset|assets|font|fonts|plugin|extension|add on|addon)(?: (?!and\b|or\b|but\b|the\b|this\b|these\b|those\b|our\b|project\b|codebase\b|software\b|package\b|repository\b|repo\b|library\b|program\b|application\b|code\b|source\b|files\b|is\b|are\b|was\b|were\b|has\b|have\b)[a-z0-9<>]+){0,4}$/.test(
      contextPrefix,
    ) ||
    /\bnone(?: (?:of them|now|currently|presently|yet|ever|actually|explicitly)){0,4} (?:is|are|was|were|has|have|had|can|will|be|been|being)$/.test(
      contextPrefix,
    ) ||
    /\bnor (?:(?:is|are)(?: it| they)?|(?:can|will|should|would|could) (?:it|they) be)$/.test(
      contextPrefix,
    ) ||
    /\bnor (?:(?:is|are)(?: the)? (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)|(?:main|primary) (?:project )?(?:source|code|software|package|library|program|application|repository|repo|files))|(?:has|have) (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) been|(?:can|will) (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application)) be)$/.test(
      contextPrefix,
    ) ||
    /\bnot(?: (?:now|currently|presently|yet|ever|really|actually|explicitly|itself|directly)){0,4} nor(?: ever)?$/.test(
      contextPrefix,
    ) ||
    /\bnot(?: (?:now|currently|presently|yet|ever|really|actually|explicitly|itself|directly|in|any|sense)){0,6} or(?: (?:now|currently|presently|yet|ever|really|actually|explicitly)){0,2}$/.test(
      contextPrefix,
    ) ||
    /\b(?:not going to be|not(?: [a-z0-9]+){0,3} never will be|never will be)$/.test(
      contextPrefix,
    ) ||
    /\bnot(?: (?:now|currently|presently|yet|ever|really|actually|explicitly|itself|directly)){0,4} be$/.test(
      contextPrefix,
    ) ||
    /\bneither (?:(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application))(?: [a-z0-9]+){0,8} nor (?:its [a-z0-9]+|(?:this|the) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files|our (?:project|code|source|software|library|package|repository|repo|files|program|application))(?: [a-z0-9]+){0,8} (?:is|are)$/.test(
      contextPrefix,
    ) ||
    /\b(?:was|were|had been)(?: (?:previously|formerly|originally|initially|first|once|also)){1,4}$/.test(
      contextPrefix,
    ) ||
    /\b(?:was|were|had been)(?: (?:previously|formerly|originally|initially|first|once|also)){1,4} (?:released|distributed|published)(?: [a-z0-9]+){0,4} and$/.test(
      contextPrefix,
    ) ||
    /\b(?:never(?: be| been| being)?|neither|no longer(?: be| been| being)?|without being|by no means(?: now| currently| presently| yet| ever| really| actually| explicitly)?|under no circumstances|previously(?: been)?|formerly(?: been)?|originally(?: been)?|initially(?: been)?|first(?: been)?|once(?: been)?|used to be(?: [a-z0-9]+){0,6})$/.test(
      contextPrefix,
    ) ||
    (!isRelicenseHeader && /\b(?:had been|was|were)$/.test(contextPrefix)) ||
    /\b(?:isn|aren|wasn|weren|hasn|haven|hadn|shouldn|wouldn|couldn|mustn) t(?: (?:now|currently|presently|yet|ever|really|actually|explicitly|itself|directly)){0,4}(?: be| been| being)?$/.test(
      contextPrefix,
    ) ||
    /\b(?:cannot|can not|can t|won t)(?: (?:now|currently|presently|yet|ever|really|actually|explicitly)){0,4} be$/.test(
      contextPrefix,
    )
  )
}

function hasThirdPartyUnknownHeaderContext(
  loose: string,
  headerIndex: number,
  licenseAliasWords: string[][],
): boolean {
  const contextPrefix = loose
    .slice(Math.max(0, headerIndex - 240), headerIndex)
    .trim()
  return (
    isThirdPartyOwnedHeaderContext(
      licenseHeaderContext(loose, headerIndex, licenseAliasWords),
    ) ||
    hasCarriedThirdPartyHeaderContext(loose, headerIndex, licenseAliasWords) ||
    /\b(?:third party|bundled|vendored|external|included|embedded)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,8} (?:helper|dependency|component|module|library|package|parser|tool|asset|assets|font|fonts|plugin|extension|add on|addon)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,10} (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)$/.test(
      contextPrefix,
    ) ||
    /\b(?:the|a|an|this|that|these|those|each|every|any)? ?(?:external )?(?:dependency|dependencies)(?! (?:free|less)\b)(?: (?!and\b|or\b|but\b|is\b|are\b|was\b|were\b|has\b|have\b|had\b|be\b|been\b|being\b)[a-z0-9<>]+){0,10} (?:continues to be|continue to be|is still|are still|has since been|is|are|was|were|has|have|remains|remain)$/.test(
      contextPrefix,
    )
  )
}

function wordsAfterLicenseHeader(
  input: string,
  licenseAliasWords: string[][],
  aliases?: HeaderAlias[],
): string[] | undefined {
  const loose = normalizeHeaderLoose(input)
  const words = loose.split(' ').filter(Boolean).length
  const headerPattern = resetLicenseHeaderPattern(
    wordsAfterLicenseHeaderPattern,
  )
  let fallbackWords: string[] | undefined
  let labelMatch: ReturnType<typeof licenseLabelLineMatch> | undefined
  if (aliases && hasLicenseLabelDeclarationLine(input)) {
    labelMatch = licenseLabelLineMatch(input, licenseAliasWords, aliases)
    if (
      labelMatch &&
      hasThirdPartyLicenseLabelFullBodyContextForAliases(
        labelMatch.suffix,
        aliases,
      )
    ) {
      return labelMatch.words
    }
  }
  let skippedNegatedHeader = false
  let skippedThirdPartyHeader = false
  let match: RegExpExecArray | null

  while ((match = headerPattern.exec(loose))) {
    const inputWords = wordsAfterHeaderMatch(
      loose,
      match.index + match[0].length,
    )
    if (!hasPotentialHeaderAlias(inputWords, licenseAliasWords)) {
      if (isAdjectiveLicenseHeaderPrefix(match[0])) continue
      if (match[0].startsWith('subject to ')) continue
      if (hasSkippedUnknownHeaderContext(loose, match.index)) {
        skippedNegatedHeader = true
        continue
      }
      if (
        hasThirdPartyUnknownHeaderContext(loose, match.index, licenseAliasWords)
      ) {
        skippedThirdPartyHeader = true
        continue
      }
      if (
        hasLaterSupersedingCurrentLicenseHeader(inputWords) ||
        (isGenericUnderLicenseHeaderPrefix(match[0]) &&
          hasLaterCurrentLicenseHeader(inputWords))
      )
        continue
      return undefined
    }

    if (
      hasNegatedLicenseHeaderContext(
        loose,
        match.index,
        licenseAliasWords,
        input,
      )
    ) {
      skippedNegatedHeader = true
      continue
    }
    if (
      hasRestrictiveLicenseHeaderPrefix(loose, match.index) &&
      !hasAffirmativeProjectHeaderContext(loose, match.index, licenseAliasWords)
    ) {
      skippedNegatedHeader = true
      continue
    }
    const headerContext = licenseHeaderContext(
      loose,
      match.index,
      licenseAliasWords,
    )
    if (isScopedAwayLicenseHeaderContext(headerContext)) {
      skippedThirdPartyHeader = true
      continue
    }
    const hasImmediateProjectSubject = hasImmediateProjectHeaderSubject(
      loose,
      match.index,
      match[0],
      input,
    )
    const isThirdPartyOwnedHeader =
      !hasImmediateProjectSubject &&
      isThirdPartyOwnedHeaderContext(headerContext)
    const isLeadingHeader = match.index === 0
    if (
      isThirdPartyOwnedHeader &&
      hasProjectHeaderContext(headerContext) &&
      hasLaterProjectHeaderContext(inputWords)
    )
      continue
    if (!isThirdPartyOwnedHeader && hasLaterCurrentLicenseHeader(inputWords))
      continue
    if (
      hasCurrentLicenseHeaderContext(
        loose,
        match.index,
        licenseAliasWords,
        match[0],
        input,
        headerContext,
      )
    )
      return inputWords
    if (
      skippedNegatedHeader &&
      hasAffirmativeProjectHeaderContext(loose, match.index, licenseAliasWords)
    )
      return inputWords
    if (
      (words <= 24 ||
        isLeadingHeader ||
        hasSourceHeaderPreamble(loose, match.index)) &&
      !skippedNegatedHeader &&
      !skippedThirdPartyHeader &&
      !fallbackWords &&
      !isThirdPartyOwnedHeader &&
      (hasImmediateProjectSubject ||
        !hasCarriedThirdPartyHeaderContext(
          loose,
          match.index,
          licenseAliasWords,
        ))
    )
      fallbackWords = inputWords
  }

  if (labelMatch && !fallbackWords) fallbackWords = labelMatch.words

  return fallbackWords
}

function matchesWordsAt(
  inputWords: string[],
  index: number,
  words: string[],
): boolean {
  return words.every((word, offset) => inputWords[index + offset] === word)
}

function licenseOperandStartIndex(inputWords: string[], index: number): number {
  let operandIndex = index
  if (inputWords[operandIndex] === 'it' || inputWords[operandIndex] === 'they')
    operandIndex += 1
  if (inputWords[operandIndex] === 'also') operandIndex += 1
  if (
    (inputWords[operandIndex] === 'is' ||
      inputWords[operandIndex] === 'are' ||
      inputWords[operandIndex] === 'was' ||
      inputWords[operandIndex] === 'were') &&
    inputWords[operandIndex + 1] === 'also'
  ) {
    operandIndex += 2
  } else if (
    inputWords[operandIndex] === 'is' ||
    inputWords[operandIndex] === 'are' ||
    inputWords[operandIndex] === 'was' ||
    inputWords[operandIndex] === 'were'
  ) {
    operandIndex += 1
  } else if (
    (inputWords[operandIndex] === 'has' ||
      inputWords[operandIndex] === 'have' ||
      inputWords[operandIndex] === 'had') &&
    inputWords[operandIndex + 1] === 'been'
  ) {
    operandIndex += 2
  }
  if (inputWords[operandIndex] === 'also') operandIndex += 1
  if (
    (inputWords[operandIndex] === 'licensed' ||
      inputWords[operandIndex] === 'licenced' ||
      inputWords[operandIndex] === 'relicensed' ||
      inputWords[operandIndex] === 'relicenced' ||
      inputWords[operandIndex] === 'released' ||
      inputWords[operandIndex] === 'distributed') &&
    inputWords[operandIndex + 1] === 'under'
  )
    operandIndex += 2
  else if (inputWords[operandIndex] === 'under') operandIndex += 1
  if (inputWords[operandIndex] === 'the') operandIndex += 1
  if (inputWords[operandIndex] === 'terms') {
    if (inputWords[operandIndex + 1] === 'of') {
      operandIndex += 2
    } else if (
      inputWords[operandIndex + 1] === 'and' &&
      inputWords[operandIndex + 2] === 'conditions' &&
      inputWords[operandIndex + 3] === 'of'
    ) {
      operandIndex += 4
    }
    if (inputWords[operandIndex] === 'the') operandIndex += 1
  }
  return operandIndex
}

function hasLicenseOperandAt(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  const operandIndex = licenseOperandStartIndex(inputWords, index)
  return licenseAliasWords.some((words) =>
    matchesWordsAt(inputWords, operandIndex, words),
  )
}

function hasLicenseOperand(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  const operator = inputWords[index]
  const lookahead = inputWords.slice(index + 1, index + 8)
  if (operator === 'and' && lookahead[0] === 'or') return true
  if (
    operator === 'or' &&
    lookahead.includes('later') &&
    (lookahead.includes('version') || lookahead[0] === 'later')
  )
    return true
  if (
    (operator === 'and' || operator === 'or') &&
    lookahead.includes('compatible') &&
    (lookahead.includes('terms') || lookahead.includes('license'))
  )
    return true

  if (
    (operator === 'and' || operator === 'or') &&
    inputWords[index + 1] === 'is' &&
    inputWords[index + 2] === 'instead'
  )
    return false
  return hasLicenseOperandAt(inputWords, index + 1, licenseAliasWords)
}

function hasAdditionalLicenseHeader(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  const operandIndex = licenseOperandStartIndex(inputWords, index)
  return (
    operandIndex !== index &&
    licenseAliasWords.some((words) =>
      matchesWordsAt(inputWords, operandIndex, words),
    )
  )
}

function hasCompoundLicenseConnector(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  const word = inputWords[index]
  if (word === 'but') {
    let operandIndex = index + 1
    if (
      inputWords[operandIndex] === 'is' ||
      inputWords[operandIndex] === 'are' ||
      inputWords[operandIndex] === 'was' ||
      inputWords[operandIndex] === 'were'
    )
      operandIndex += 1
    if (inputWords[operandIndex] === 'also') operandIndex += 1
    return (
      hasAdditionalLicenseHeader(inputWords, operandIndex, licenseAliasWords) ||
      hasLicenseOperandAt(inputWords, operandIndex, licenseAliasWords)
    )
  }
  if (
    word === 'as' &&
    inputWords[index + 1] === 'well' &&
    inputWords[index + 2] === 'as'
  ) {
    return (
      hasAdditionalLicenseHeader(inputWords, index + 3, licenseAliasWords) ||
      hasLicenseOperandAt(inputWords, index + 3, licenseAliasWords)
    )
  }
  if (word === 'plus') {
    return (
      hasAdditionalLicenseHeader(inputWords, index + 1, licenseAliasWords) ||
      hasLicenseOperandAt(inputWords, index + 1, licenseAliasWords)
    )
  }
  if (
    (word === 'together' || word === 'along') &&
    inputWords[index + 1] === 'with'
  ) {
    return (
      hasAdditionalLicenseHeader(inputWords, index + 2, licenseAliasWords) ||
      hasLicenseOperandAt(inputWords, index + 2, licenseAliasWords)
    )
  }
  return false
}

function isBenignLicenseDocumentReference(words: string[]): boolean {
  if (
    ['text', 'file', 'notice', 'copy', 'document', 'documents'].includes(
      words[0],
    )
  )
    return true
  if (words[0] === 'is' && words[1] === 'included' && words[2] === 'below')
    return true
  if (
    words[0] === 'can' &&
    words[1] === 'be' &&
    words[2] === 'found' &&
    words[3] === 'below'
  )
    return true
  if (words[0] === 'appears' && words[1] === 'below') return true
  return words[0] === 'follows'
}

function hasLicenseLikeOperand(inputWords: string[], index: number): boolean {
  const word = inputWords[index]
  if (word !== 'and' && word !== 'or') return false
  if (inputWords[index + 1] === 'is' && inputWords[index + 2] === 'instead')
    return false

  const lookahead = inputWords.slice(index + 1, index + 8)
  const licenseWordIndex = lookahead.findIndex((word) =>
    ['license', 'licenses', 'licence', 'licences'].includes(word),
  )
  if (lookahead.includes('commercial') && lookahead.includes('terms'))
    return true
  if (licenseWordIndex < 0) return false
  if (
    word === 'and' &&
    isBenignLicenseDocumentReference(lookahead.slice(licenseWordIndex + 1))
  )
    return false
  return true
}

function isBlockedHeaderOperator(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  const word = inputWords[index]
  if (word === 'except' && isBenignComplianceTail(inputWords, index)) {
    return false
  }
  return (
    ((word === 'and' || word === 'or') &&
      (hasLicenseOperand(inputWords, index, licenseAliasWords) ||
        hasLicenseLikeOperand(inputWords, index))) ||
    hasCompoundLicenseConnector(inputWords, index, licenseAliasWords) ||
    word === 'exception' ||
    word === 'exceptions' ||
    word === 'except' ||
    word === 'unless' ||
    word === 'classpath' ||
    word === 'llvm' ||
    word === 'compatible' ||
    word === 'compatibility'
  )
}

function benignWithQualifierTailStart(
  inputWords: string[],
  index: number,
): number | undefined {
  if (inputWords[index] !== 'with') return undefined
  if (
    inputWords[index + 1] === 'no' &&
    (inputWords[index + 2] === 'warranty' ||
      inputWords[index + 2] === 'warranties')
  )
    return index + 3
  if (
    inputWords[index + 1] === 'no' &&
    (inputWords[index + 2] === 'restriction' ||
      inputWords[index + 2] === 'restrictions')
  )
    return index + 3
  if (
    inputWords[index + 1] === 'no' &&
    inputWords[index + 2] === 'restrictive' &&
    (inputWords[index + 3] === 'term' || inputWords[index + 3] === 'terms')
  )
    return index + 4
  if (
    inputWords[index + 1] === 'all' &&
    inputWords[index + 2] === 'source' &&
    inputWords[index + 3] === 'files' &&
    inputWords[index + 4] === 'included'
  )
    return index + 5
  if (
    inputWords[index + 1] === 'the' &&
    inputWords[index + 2] === 'following' &&
    inputWords[index + 3] === 'copyright' &&
    inputWords[index + 4] === 'notice'
  )
    return index + 5
  return undefined
}

function isBenignWithQualifier(inputWords: string[], index: number): boolean {
  return benignWithQualifierTailStart(inputWords, index) !== undefined
}

function isBlockedWithQualifier(inputWords: string[], index: number): boolean {
  return (
    inputWords[index] === 'with' && !isBenignWithQualifier(inputWords, index)
  )
}

function hasBlockedBenignWithTail(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  const tailStart = benignWithQualifierTailStart(inputWords, index)
  if (tailStart === undefined) return false
  if (hasRestrictiveLicenseTail(inputWords, tailStart)) return true
  const tailEnd = Math.min(inputWords.length, tailStart + 8)
  for (let tailIndex = tailStart; tailIndex < tailEnd; tailIndex += 1) {
    if (
      isRestrictiveLicenseTail(inputWords, tailIndex) ||
      hasAdditionalLicenseHeader(inputWords, tailIndex, licenseAliasWords) ||
      hasCompoundLicenseConnector(inputWords, tailIndex, licenseAliasWords) ||
      isBlockedHeaderOperator(inputWords, tailIndex, licenseAliasWords)
    )
      return true
  }
  return false
}

function isBenignLicenseDocumentTail(
  inputWords: string[],
  index: number,
): boolean {
  let licenseIndex = index
  if (inputWords[licenseIndex] === 'the') licenseIndex += 1
  if (
    !['license', 'licenses', 'licence', 'licences'].includes(
      inputWords[licenseIndex],
    )
  )
    return false
  return isBenignLicenseDocumentReference(inputWords.slice(licenseIndex + 1))
}

function isBenignCommercialSupportTail(
  inputWords: string[],
  index: number,
): boolean {
  return (
    inputWords[index] === 'commercial' &&
    ['support', 'services'].includes(inputWords[index + 1])
  )
}

function isBenignForTail(inputWords: string[], index: number): boolean {
  const nextWord = inputWords[index + 1]
  if (nextWord === 'details' || nextWord === 'detail') return true
  if (
    nextWord === 'more' &&
    (inputWords[index + 2] === 'details' ||
      inputWords[index + 2] === 'information')
  )
    return true
  if (
    nextWord === 'the' &&
    inputWords[index + 2] === 'license' &&
    ['text', 'file', 'notice'].includes(inputWords[index + 3])
  )
    return true
  if (isBenignCommercialSupportTail(inputWords, index + 1)) return true
  return (
    nextWord === 'license' &&
    ['text', 'file', 'notice'].includes(inputWords[index + 2])
  )
}

function hasLaterLicenseReference(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  const tailEnd = Math.min(
    inputWords.length,
    index + restrictiveTailWindowWords,
  )
  for (let tailIndex = index; tailIndex < tailEnd; tailIndex += 1) {
    if (
      hasAdditionalLicenseHeader(inputWords, tailIndex, licenseAliasWords) ||
      hasLicenseOperandAt(inputWords, tailIndex, licenseAliasWords)
    )
      return true
  }
  return false
}

function isBenignCopyrightTail(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  return (
    inputWords[index] === 'copyright' &&
    (inputWords[index + 1] === '<year>' || !inputWords[index + 1]) &&
    !hasRestrictiveLicenseTail(inputWords, index + 2) &&
    !hasLaterLicenseReference(inputWords, index + 2, licenseAliasWords)
  )
}

function isBenignProvidedThatTail(
  inputWords: string[],
  index: number,
): boolean {
  if (inputWords[index] !== 'provided' || inputWords[index + 1] !== 'that') {
    return false
  }
  const tail = inputWords.slice(index + 2, index + 16)
  return (
    tail.includes('copyright') &&
    tail.includes('notice') &&
    (tail.includes('permission') ||
      tail.includes('license') ||
      tail.includes('licence')) &&
    (tail.includes('appear') ||
      tail.includes('appears') ||
      tail.includes('include') ||
      tail.includes('included') ||
      tail.includes('retain') ||
      tail.includes('retained') ||
      tail.includes('preserve') ||
      tail.includes('preserved'))
  )
}

function isBenignLicenseDocumentBoundary(
  inputWords: string[],
  index: number,
): boolean {
  let licenseIndex = index
  if (inputWords[licenseIndex] === 'the') licenseIndex += 1
  if (
    !['license', 'licenses', 'licence', 'licences'].includes(
      inputWords[licenseIndex],
    )
  )
    return false
  return (
    isBenignLicenseDocumentReference(inputWords.slice(licenseIndex + 1)) ||
    (inputWords[licenseIndex + 1] === 'for' &&
      isBenignForTail(inputWords, licenseIndex + 1))
  )
}

function isRestrictiveTailScanBoundary(
  inputWords: string[],
  index: number,
): boolean {
  if (inputWords[index] === 'see') {
    return isBenignLicenseDocumentBoundary(inputWords, index + 1)
  }
  return (
    isBenignLicenseDocumentBoundary(inputWords, index) ||
    (inputWords[index] === 'for' && isBenignForTail(inputWords, index))
  )
}

function isBenignComplianceTail(inputWords: string[], index: number): boolean {
  const tail = inputWords.slice(index, index + 8)
  if (
    tail[0] !== 'except' ||
    tail[1] !== 'in' ||
    tail[2] !== 'compliance' ||
    tail[3] !== 'with'
  )
    return false
  const licenseIndex = 4
  if (['the', 'this'].includes(tail[licenseIndex])) {
    return ['license', 'licence'].includes(tail[licenseIndex + 1])
  }
  return ['license', 'licence'].includes(tail[licenseIndex])
}

function hasBenignComplianceTail(inputWords: string[], index: number): boolean {
  const tailEnd = Math.min(
    inputWords.length,
    index + restrictiveTailWindowWords,
  )
  for (let tailIndex = index; tailIndex < tailEnd; tailIndex += 1) {
    if (isBenignComplianceTail(inputWords, tailIndex)) return true
  }
  return false
}

const restrictiveTailWindowWords = 256
const restrictionSubjectConnectorPattern =
  '(?:(?:and|but|however|though|although)\\s+)*'
const restrictionSubjectArticlePattern = '(?:(?:a|an|the|this|that)\\s+)?'
const unqualifiedRestrictionSubjectArticlePattern = '(?:(?:a|an|the|that)\\s+)?'
const restrictionSubjectStatePattern =
  '(?:continues to be|continue to be|is|are|was|were|has|have|had|remains|remain|provided|restricted|limited)\\b'
const thirdPartyRestrictionSubjectNouns = [
  'dependency',
  'dependencies',
  'component',
  'components',
  'module',
  'modules',
  'library',
  'libraries',
  'package',
  'packages',
  'software',
  'parser',
  'parsers',
  'helper',
  'helpers',
  'tool',
  'tools',
  'asset',
  'assets',
  'font',
  'fonts',
  'plugin',
  'plugins',
  'extension',
  'extensions',
  'add on',
  'add ons',
  'addon',
  'addons',
]
const thirdPartyRestrictionSubjectNounPattern =
  '(?:' + thirdPartyRestrictionSubjectNouns.join('|') + ')'
const carriedThisThirdPartyRestrictionSubjectNouns = [
  'component',
  'components',
  'dependency',
  'dependencies',
  'extension',
  'extensions',
  'helper',
  'helpers',
  'module',
  'modules',
  'parser',
  'parsers',
  'plugin',
  'plugins',
]
const thirdPartyRestrictionSubjectNounFamilies: Record<string, string> = {
  dependencies: 'dependency',
  components: 'component',
  modules: 'module',
  libraries: 'library',
  packages: 'package',
  parsers: 'parser',
  helpers: 'helper',
  tools: 'tool',
  assets: 'asset',
  fonts: 'font',
  plugins: 'plugin',
  extensions: 'extension',
  'add on': 'addon',
  'add ons': 'addon',
  addons: 'addon',
}

function canonicalThirdPartyRestrictionSubjectNoun(noun: string): string {
  return thirdPartyRestrictionSubjectNounFamilies[noun] || noun
}

const carriedThisThirdPartyRestrictionSubjectFamilies = new Set(
  carriedThisThirdPartyRestrictionSubjectNouns.map(
    canonicalThirdPartyRestrictionSubjectNoun,
  ),
)
const qualifiedThirdPartyRestrictionSubjectPattern = new RegExp(
  '^' +
    restrictionSubjectConnectorPattern +
    restrictionSubjectArticlePattern +
    '(?:third party|bundled|vendored|external|included|embedded)\\s+(?:(?!and\\b|or\\b|but\\b)[a-z0-9<>]+\\s+){0,3}' +
    thirdPartyRestrictionSubjectNounPattern +
    '(?:\\s+(?:source|code|software|library|component|module|package))?\\s+' +
    restrictionSubjectStatePattern,
)
const unqualifiedThirdPartyRestrictionSubjectPattern = new RegExp(
  '^' +
    restrictionSubjectConnectorPattern +
    unqualifiedRestrictionSubjectArticlePattern +
    '(?:dependency|dependencies|parser|helper)(?:\\s+(?:source|code|software|library|component|module|package))?\\s+' +
    restrictionSubjectStatePattern,
)
const thirdPartyRestrictionObjectPattern = new RegExp(
  '^' +
    restrictionSubjectConnectorPattern +
    '(?:includes|include|uses|use|bundles|bundle|vendors|vendor|ships with|ship with|contains|contain|depends on|depend on|depends upon|depend upon|requires|require)\\s+' +
    '(?:(?:a|an|the)\\s+)?(?:third party|bundled|vendored|external|included|embedded)\\s+(?:(?!and\\b|or\\b|but\\b)[a-z0-9<>]+\\s+){0,3}' +
    thirdPartyRestrictionSubjectNounPattern +
    '(?:\\s+(?:source|code|software|library|component|module|package))?\\s+' +
    '(?:for|only\\s+for|not\\s+for|restricted\\s+to|restricted\\s+for|limited\\s+to|limited\\s+for)\\b',
)
const unrelatedRestrictionSubjectPattern = new RegExp(
  '^' +
    restrictionSubjectConnectorPattern +
    '(?:(?:the|this|that|these|those)\\s+)?(?:test|tests|documentation|docs|example|examples|sample|samples)\\s+' +
    restrictionSubjectStatePattern,
)

function hasThirdPartyRestrictionSubject(
  inputWords: string[],
  index: number,
): boolean {
  const subject = inputWords.slice(index, index + 16).join(' ')
  return (
    qualifiedThirdPartyRestrictionSubjectPattern.test(subject) ||
    unqualifiedThirdPartyRestrictionSubjectPattern.test(subject) ||
    thirdPartyRestrictionObjectPattern.test(subject)
  )
}

function hasNonLicenseRestrictionSubject(
  inputWords: string[],
  index: number,
): boolean {
  return unrelatedRestrictionSubjectPattern.test(
    inputWords.slice(index, index + 12).join(' '),
  )
}

function hasRestrictionSubjectBoundary(
  inputWords: string[],
  index: number,
): boolean {
  return (
    hasThirdPartyRestrictionSubject(inputWords, index) ||
    hasNonLicenseRestrictionSubject(inputWords, index)
  )
}

function thirdPartyRestrictionSubjectNounFamilyAt(
  inputWords: string[],
  index: number,
): string | undefined {
  const noun = thirdPartyRestrictionSubjectNouns.find((candidate) =>
    matchesWordsAt(inputWords, index, candidate.split(' ')),
  )
  return noun ? canonicalThirdPartyRestrictionSubjectNoun(noun) : undefined
}

function hasPreviousThirdPartyRestrictionSubjectNoun(
  segment: string | undefined,
  family: string,
): boolean {
  if (!segment) return false

  const words = aliasWords(segment)
  return words.some(
    (_word, index) =>
      thirdPartyRestrictionSubjectNounFamilyAt(words, index) === family,
  )
}

function canCarryThirdPartyRestrictionSubjectNoun(
  inputWords: string[],
  index: number,
  previousSegment: string | undefined,
): boolean {
  const family = thirdPartyRestrictionSubjectNounFamilyAt(inputWords, index)
  return Boolean(
    family &&
    (carriedThisThirdPartyRestrictionSubjectFamilies.has(family) ||
      hasPreviousThirdPartyRestrictionSubjectNoun(previousSegment, family)),
  )
}

function isBenignLegalLimitationTail(
  inputWords: string[],
  index: number,
): boolean {
  if (!['limited', 'restricted'].includes(inputWords[index])) return false
  if (inputWords[index + 1] !== 'to') return false

  const extentIndex = inputWords[index + 2] === 'the' ? index + 3 : index + 2
  if (inputWords[extentIndex] !== 'extent') return false

  const tail = inputWords.slice(index, index + 12)
  return (
    tail.includes('permitted') ||
    tail.includes('allowed') ||
    tail.includes('applicable') ||
    tail.includes('required') ||
    tail.includes('law') ||
    tail.includes('laws') ||
    tail.includes('statute') ||
    tail.includes('statutes') ||
    tail.includes('regulation') ||
    tail.includes('regulations') ||
    tail.includes('damage') ||
    tail.includes('damages')
  )
}

function hasCommercialOnlyScopeTail(words: string[]): boolean {
  const commercialIndex = words.indexOf('commercial')
  if (commercialIndex < 0) return false

  const scopeWord = words[commercialIndex + 1]
  if (['support', 'services'].includes(scopeWord)) return false
  if (
    scopeWord !== 'only' &&
    ![
      'development',
      'distribution',
      'purpose',
      'purposes',
      'redistribution',
      'use',
      'usage',
    ].includes(scopeWord)
  ) {
    return false
  }

  return words.slice(commercialIndex, commercialIndex + 5).includes('only')
}

const restrictiveScopeLicenseOnlyWords = new Set([
  'academic',
  'commercial',
  'demo',
  'documentation',
  'educational',
  'evaluation',
  'internal',
  'noncommercial',
  'nonprofit',
  'personal',
  'private',
  'research',
  'test',
  'testing',
  'trial',
])

function isBenignForScopeUseCaseTail(words: string[]): boolean {
  return (
    words[0] === 'for' &&
    restrictiveScopeLicenseOnlyWords.has(words[1]) &&
    (words[2] === 'use' || words[2] === 'usage') &&
    ['case', 'cases'].includes(words[3]) &&
    words[4] !== 'only'
  )
}

function hasBenignLicenseOnlyAvailabilityTail(
  words: string[],
  index: number,
): boolean {
  return (
    words[index] === 'available' &&
    ['on', 'upon'].includes(words[index + 1]) &&
    words[index + 2] === 'request' &&
    !hasRestrictiveAvailabilityRequestTail(words, index + 3)
  )
}

function hasRestrictiveAvailabilityRequestTail(
  words: string[],
  index: number,
): boolean {
  return availabilityRequestScopeIndexes(words, index).some((scopeIndex) =>
    hasRestrictiveAvailabilityRequestScopeTail(words, scopeIndex),
  )
}

function availabilityRequestScopeIndexes(
  words: string[],
  index: number,
): number[] {
  const indexes = new Set([index])
  for (
    let relationIndex = index;
    relationIndex < Math.min(words.length, index + 8);
    relationIndex += 1
  ) {
    if (['for', 'to'].includes(words[relationIndex]))
      indexes.add(relationIndex + 1)
  }
  return Array.from(indexes)
}

function hasRestrictiveAvailabilityRequestScopeTail(
  words: string[],
  scopeIndex: number,
): boolean {
  const tail = words.slice(scopeIndex, scopeIndex + 8)

  return (
    hasRestrictiveScopeLicenseOnlyTail(words, scopeIndex, false) ||
    hasCommercialOnlyScopeTail(tail) ||
    words[scopeIndex] === 'noncommercial' ||
    (words[scopeIndex] === 'non' &&
      ['commercial', 'profit'].includes(words[scopeIndex + 1])) ||
    (restrictiveScopeLicenseOnlyWords.has(words[scopeIndex]) &&
      (words[scopeIndex + 1] === 'only' ||
        ['use', 'usage', 'distribution', 'redistribution'].includes(
          words[scopeIndex + 1],
        ) ||
        hasRestrictiveAudienceOnlyTail(words, scopeIndex + 1)))
  )
}

const restrictiveAudienceOnlyWords = new Set([
  'client',
  'clients',
  'customer',
  'customers',
  'employee',
  'employees',
  'member',
  'members',
  'partner',
  'partners',
  'subscriber',
  'subscribers',
  'user',
  'users',
])

function hasRestrictiveAudienceOnlyTail(
  words: string[],
  index: number,
): boolean {
  return (
    restrictiveAudienceOnlyWords.has(words[index]) &&
    words.slice(index + 1, index + 4).includes('only')
  )
}

function hasNegatedLicenseOnlyScopePrefix(
  words: string[],
  index: number,
): boolean {
  const prefixWords = words.slice(Math.max(0, index - 8), index)
  const afterOnlyIndex = scopeLicenseOnlyAfterIndex(words, index)
  return (
    prefixWords
      .slice(-3)
      .some((word) => ['never', 'neither', 'no', 'not'].includes(word)) ||
    hasNegatedLicenseOnlyReferencePrefix(
      prefixWords,
      words[afterOnlyIndex ?? -1],
    )
  )
}

function hasRestrictiveScopeLicenseOnlyTail(
  words: string[],
  index: number,
  allowAvailabilityException = true,
): boolean {
  if (hasNegatedLicenseOnlyScopePrefix(words, index)) return false

  let licenseIndex = index + 1
  if (
    words[index] === 'non' &&
    ['commercial', 'profit'].includes(words[index + 1])
  ) {
    licenseIndex = index + 2
  } else if (!restrictiveScopeLicenseOnlyWords.has(words[index])) {
    return false
  }
  return (
    ['license', 'licence'].includes(words[licenseIndex]) &&
    words[licenseIndex + 1] === 'only' &&
    (!allowAvailabilityException ||
      !hasBenignLicenseOnlyAvailabilityTail(words, licenseIndex + 2))
  )
}

function isRestrictiveModalProhibitionAt(
  inputWords: string[],
  index: number,
): boolean {
  if (
    !['do', 'may', 'must', 'shall'].includes(inputWords[index]) ||
    inputWords[index + 1] !== 'not'
  )
    return false
  const modal = inputWords[index]
  if (
    ['may', 'must', 'shall'].includes(modal) &&
    inputWords[index + 2] === 'be' &&
    ([
      'copied',
      'distributed',
      'modified',
      'reproduced',
      'redistributed',
      'sold',
      'sublicensed',
      'used',
    ].includes(inputWords[index + 3]) ||
      (inputWords[index + 3] === 'reverse' &&
        inputWords[index + 4] === 'engineered'))
  ) {
    if (
      inputWords[index + 3] === 'used' &&
      isBenignModalComplianceTail(inputWords, index, index + 4)
    ) {
      return false
    }
    if (
      inputWords[index + 3] === 'used' &&
      hasRestrictivePassiveModalActionList(inputWords, index + 4)
    ) {
      return true
    }
    if (
      inputWords[index + 3] === 'used' &&
      isPassiveModalBrandingUse(inputWords, index)
    ) {
      return false
    }
    return true
  }
  if (inputWords[index + 2] === 'use') {
    if (isBenignModalComplianceTail(inputWords, index, index + 3)) return false
    if (hasRestrictiveModalActionList(inputWords, index + 3)) return true
    if (hasRestrictiveModalBrandingActionList(inputWords, index + 3))
      return true
    if (hasRestrictiveModalUseObjectActionList(inputWords, index + 3))
      return true
    if (isActiveModalBrandingUse(inputWords, index + 3)) {
      return false
    }
    return (
      hasRestrictiveModalUseObject(inputWords, index + 3) ||
      hasRestrictiveModalUseScopeTail(inputWords, index + 3) ||
      hasRestrictiveBareModalUseTail(inputWords, index + 3) ||
      modal === 'do'
    )
  }
  return (
    modalRestrictionActionWords.has(inputWords[index + 2]) ||
    (inputWords[index + 2] === 'reverse' &&
      inputWords[index + 3] === 'engineer')
  )
}

function isRestrictiveCannotProhibitionAt(
  inputWords: string[],
  index: number,
): boolean {
  const isCannot = inputWords[index] === 'cannot'
  const isCanNot =
    inputWords[index] === 'can' && ['not', 't'].includes(inputWords[index + 1])
  if (!isCannot && !isCanNot) return false

  const verbIndex = index + (isCannot ? 1 : 2)
  if (inputWords[verbIndex] === 'be') {
    const actionIndex = verbIndex + 1
    if (
      [
        'copied',
        'distributed',
        'modified',
        'reproduced',
        'redistributed',
        'sold',
        'sublicensed',
        'used',
      ].includes(inputWords[actionIndex]) ||
      (inputWords[actionIndex] === 'reverse' &&
        inputWords[actionIndex + 1] === 'engineered')
    ) {
      if (
        inputWords[actionIndex] === 'used' &&
        isBenignModalComplianceTail(inputWords, index, actionIndex + 1)
      ) {
        return false
      }
      if (
        inputWords[actionIndex] === 'used' &&
        hasRestrictivePassiveModalActionList(inputWords, actionIndex + 1)
      ) {
        return true
      }
      if (
        inputWords[actionIndex] === 'used' &&
        isPassiveModalBrandingUse(inputWords, index)
      ) {
        return false
      }
      return true
    }
  }

  if (
    modalRestrictionActionWords.has(inputWords[verbIndex]) ||
    (inputWords[verbIndex] === 'reverse' &&
      inputWords[verbIndex + 1] === 'engineer')
  ) {
    return true
  }

  if (inputWords[verbIndex] !== 'use') return false
  if (isBenignModalComplianceTail(inputWords, index, verbIndex + 1))
    return false
  if (hasRestrictiveModalActionList(inputWords, verbIndex + 1)) return true
  if (hasRestrictiveModalBrandingActionList(inputWords, verbIndex + 1))
    return true
  if (hasRestrictiveModalUseObjectActionList(inputWords, verbIndex + 1))
    return true
  if (isActiveModalBrandingUse(inputWords, verbIndex + 1)) return false
  return (
    hasRestrictiveModalUseObject(inputWords, verbIndex + 1) ||
    hasRestrictiveModalUseScopeTail(inputWords, verbIndex + 1) ||
    hasRestrictiveBareModalUseTail(inputWords, verbIndex + 1)
  )
}

function hasRestrictiveModalActionList(
  inputWords: string[],
  startIndex: number,
): boolean {
  const endIndex = Math.min(inputWords.length, startIndex + 10)
  for (let index = startIndex; index < endIndex; index += 1) {
    if (['and', 'or'].includes(inputWords[index])) continue
    if (
      modalRestrictionActionWords.has(inputWords[index]) ||
      (inputWords[index] === 'reverse' && inputWords[index + 1] === 'engineer')
    ) {
      return true
    }
    return false
  }
  return false
}

function hasRestrictivePassiveModalActionList(
  inputWords: string[],
  startIndex: number,
): boolean {
  const endIndex = Math.min(inputWords.length, startIndex + 10)
  for (let index = startIndex; index < endIndex; index += 1) {
    if (['and', 'or'].includes(inputWords[index])) continue
    if (
      modalPassiveRestrictionActionWords.has(inputWords[index]) ||
      (inputWords[index] === 'reverse' &&
        inputWords[index + 1] === 'engineered')
    ) {
      return true
    }
    return false
  }
  return false
}

function modalBrandingUseEndIndex(
  inputWords: string[],
  objectIndex: number,
): number | undefined {
  let endIndex = singleModalBrandingUseEndIndex(inputWords, objectIndex)
  if (endIndex === undefined) return undefined

  while (endIndex < inputWords.length) {
    const directBrandingEnd = singleModalBrandingUseEndIndex(
      inputWords,
      endIndex,
    )
    if (directBrandingEnd !== undefined) {
      endIndex = directBrandingEnd
      continue
    }

    if (!['and', 'or'].includes(inputWords[endIndex])) break
    const connectedBrandingEnd = singleModalBrandingUseEndIndex(
      inputWords,
      endIndex + 1,
    )
    if (connectedBrandingEnd === undefined) break
    endIndex = connectedBrandingEnd
  }

  return endIndex
}

function singleModalBrandingUseEndIndex(
  inputWords: string[],
  objectIndex: number,
): number | undefined {
  const targetIndex = modalObjectDeterminers.has(inputWords[objectIndex])
    ? objectIndex + 1
    : objectIndex
  if (modalBrandingUseWords.has(inputWords[targetIndex])) {
    return targetIndex + 1
  }
  if (inputWords[targetIndex + 1] === 's') {
    return modalBrandingUseWords.has(inputWords[targetIndex + 2])
      ? targetIndex + 3
      : undefined
  }
  return modalBrandingUseWords.has(inputWords[targetIndex + 1])
    ? targetIndex + 2
    : undefined
}

function hasRestrictiveModalBrandingActionList(
  inputWords: string[],
  objectIndex: number,
): boolean {
  const brandingEndIndex = modalBrandingUseEndIndex(inputWords, objectIndex)
  if (brandingEndIndex === undefined) return false
  if (modalRestrictionActionWords.has(inputWords[brandingEndIndex])) return true
  if (hasRestrictiveModalUseObject(inputWords, brandingEndIndex)) return true
  if (!['and', 'or'].includes(inputWords[brandingEndIndex])) return false
  return (
    hasRestrictiveModalActionList(inputWords, brandingEndIndex) ||
    hasRestrictiveModalUseObject(inputWords, brandingEndIndex + 1)
  )
}

function isActiveModalBrandingUse(
  inputWords: string[],
  objectIndex: number,
): boolean {
  return modalBrandingUseEndIndex(inputWords, objectIndex) !== undefined
}

function hasRestrictiveModalUseObject(
  inputWords: string[],
  objectIndex: number,
): boolean {
  if (['it', 'them'].includes(inputWords[objectIndex])) return true
  const targetIndex = modalObjectDeterminers.has(inputWords[objectIndex])
    ? objectIndex + 1
    : objectIndex
  if (isModalBrandingUseTail(inputWords, targetIndex)) return false
  return modalUseObjectWords.has(inputWords[targetIndex])
}

function modalUseObjectEndIndex(
  inputWords: string[],
  objectIndex: number,
): number | undefined {
  if (['it', 'them'].includes(inputWords[objectIndex])) return objectIndex + 1
  const targetIndex = modalObjectDeterminers.has(inputWords[objectIndex])
    ? objectIndex + 1
    : objectIndex
  if (isModalBrandingUseTail(inputWords, targetIndex)) return undefined
  if (modalUseObjectWords.has(inputWords[targetIndex])) return targetIndex + 1
  return undefined
}

function hasRestrictiveModalUseObjectActionList(
  inputWords: string[],
  objectIndex: number,
): boolean {
  const objectEndIndex = modalUseObjectEndIndex(inputWords, objectIndex)
  if (objectEndIndex === undefined) return false
  if (modalRestrictionActionWords.has(inputWords[objectEndIndex])) return true
  if (!['and', 'or'].includes(inputWords[objectEndIndex])) return false
  return hasRestrictiveModalActionList(inputWords, objectEndIndex)
}

function hasRestrictiveModalUseScopeTail(
  inputWords: string[],
  startIndex: number,
): boolean {
  const tail = inputWords.slice(startIndex, startIndex + 5)
  return (
    modalUseScopeAdverbs.has(tail[0]) ||
    hasCommercialOnlyScopeTail(tail) ||
    hasRestrictiveScopeLicenseOnlyTail(inputWords, startIndex) ||
    tail.some((word, index) =>
      [
        'academic',
        'commercial',
        'demo',
        'documentation',
        'educational',
        'internal',
        'evaluation',
        'nonprofit',
        'personal',
        'research',
        'test',
        'testing',
        'trial',
      ].includes(word)
        ? ['purpose', 'purposes', 'use', 'usage', 'only'].includes(
            tail[index + 1],
          ) &&
          !(
            tail[index + 1] === 'use' &&
            ['case', 'cases'].includes(tail[index + 2])
          )
        : false,
    ) ||
    tail.some((word, index) =>
      word === 'non' && tail[index + 1] === 'commercial'
        ? ['purpose', 'purposes', 'use', 'usage', 'only'].includes(
            tail[index + 2],
          )
        : false,
    ) ||
    tail.some((word, index) =>
      word === 'non' && tail[index + 1] === 'profit'
        ? ['purpose', 'purposes', 'use', 'usage', 'only'].includes(
            tail[index + 2],
          )
        : false,
    ) ||
    tail.some((word, index) =>
      word === 'noncommercial'
        ? ['purpose', 'purposes', 'use', 'usage', 'only'].includes(
            tail[index + 1],
          )
        : false,
    )
  )
}

function hasRestrictiveBareModalUseTail(
  inputWords: string[],
  startIndex: number,
): boolean {
  const lead = inputWords[startIndex]
  if (!lead) return true
  return ['except', 'unless', 'under'].includes(lead)
}

function isModalBrandingUseTail(
  inputWords: string[],
  targetIndex: number,
): boolean {
  const nextIndex =
    inputWords[targetIndex + 1] === 's' ? targetIndex + 2 : targetIndex + 1
  return modalBrandingUseWords.has(inputWords[nextIndex])
}

function isModalBrandingUseWord(word: string): boolean {
  return modalBrandingUseWords.has(word)
}

function hasRestrictivePassiveModalSubject(
  inputWords: string[],
  subjectStart: number,
  brandingIndex: number,
): boolean {
  for (let index = subjectStart; index < brandingIndex; index += 1) {
    if (hasRestrictiveModalUseObject(inputWords, index)) return true
  }
  return false
}

function isPassiveModalBrandingUse(
  inputWords: string[],
  modalIndex: number,
): boolean {
  const subjectStart = Math.max(0, modalIndex - 8)
  for (let index = modalIndex - 1; index >= subjectStart; index -= 1) {
    if (!isModalBrandingUseWord(inputWords[index])) continue
    if (hasRestrictivePassiveModalSubject(inputWords, subjectStart, index))
      return false
    if (
      ['and', 'or'].includes(inputWords[index - 1]) &&
      hasRestrictiveModalUseObject(inputWords, index - 2)
    ) {
      return false
    }
    return (
      index === modalIndex - 1 ||
      inputWords[index + 1] === 'of' ||
      inputWords[index + 1] === 's' ||
      (modalIndex - index <= 4 &&
        inputWords
          .slice(index + 1, modalIndex)
          .every((word) => !modalBrandingDescriptorStopWords.has(word)))
    )
  }
  return false
}

function isBenignModalComplianceTail(
  inputWords: string[],
  index: number,
  useTailStart = index + 3,
): boolean {
  const tailEnd = Math.min(inputWords.length, index + 24)
  for (let tailIndex = index + 3; tailIndex + 4 < tailEnd; tailIndex += 1) {
    if (
      inputWords[tailIndex] !== 'except' ||
      inputWords[tailIndex + 1] !== 'in' ||
      inputWords[tailIndex + 2] !== 'compliance' ||
      inputWords[tailIndex + 3] !== 'with'
    ) {
      continue
    }
    if (
      isBenignModalComplianceLicenseReference(inputWords, tailIndex + 4) &&
      !hasRestrictiveModalUseScopeBefore(inputWords, useTailStart, tailIndex)
    ) {
      return true
    }
  }
  return false
}

function hasRestrictiveModalUseScopeBefore(
  inputWords: string[],
  startIndex: number,
  endIndex: number,
): boolean {
  const boundedWords = inputWords.slice(0, endIndex)
  for (let index = startIndex; index < endIndex; index += 1) {
    if (hasRestrictiveModalUseScopeTail(boundedWords, index)) return true
  }
  return false
}

function isBenignModalComplianceLicenseReference(
  inputWords: string[],
  index: number,
): boolean {
  let cursor = index
  if (['the', 'this'].includes(inputWords[cursor])) cursor += 1
  if (['license', 'licence'].includes(inputWords[cursor])) return true
  if (inputWords[cursor] !== 'terms') return false
  cursor += 1
  if (inputWords[cursor] === 'and' && inputWords[cursor + 1] === 'conditions') {
    cursor += 2
  }
  if (inputWords[cursor] !== 'of') return false
  cursor += 1
  if (['the', 'this'].includes(inputWords[cursor])) cursor += 1
  return ['license', 'licence'].includes(inputWords[cursor])
}

function isRestrictiveLicenseTail(
  inputWords: string[],
  index: number,
  afterDocumentBoundary = false,
): boolean {
  if (isRestrictiveTailScanBoundary(inputWords, index)) return false
  const tail = inputWords.slice(index, index + 8)
  if (tail[0] === 'except' && isBenignComplianceTail(inputWords, index)) {
    return false
  }
  if (isBenignCommercialSupportTail(inputWords, index)) return false
  const restrictiveProvidedThat =
    tail[0] === 'provided' &&
    tail[1] === 'that' &&
    !isBenignProvidedThatTail(inputWords, index)
  const restrictiveTailLead = [
    'excluding',
    'except',
    'excepting',
    'unless',
  ].includes(tail[0])
  const restrictiveScopeLead =
    (!isBenignLegalLimitationTail(inputWords, index) &&
      ['restricted', 'limited'].includes(tail[0]) &&
      ['to', 'for', 'by'].includes(tail[1])) ||
    (tail[0] === 'not' && ['for', 'to'].includes(tail[1])) ||
    (tail[0] === 'only' && ['for', 'to'].includes(tail[1])) ||
    hasNoPrefixedRestrictionTail(inputWords, index)
  const restrictiveForScope =
    tail[0] === 'for' &&
    !isBenignForScopeUseCaseTail(tail) &&
    ([
      'academic',
      'demo',
      'documentation',
      'educational',
      'evaluation',
      'internal',
      'private',
      'nonprofit',
      'personal',
      'research',
      'test',
      'testing',
      'trial',
    ].includes(tail[1]) ||
      hasCommercialOnlyScopeTail(tail) ||
      tail[1] === 'noncommercial' ||
      (tail[1] === 'non' && tail[2] === 'commercial') ||
      (tail[1] === 'non' && tail[2] === 'profit') ||
      hasRestrictiveScopeLicenseOnlyTail(inputWords, index + 1))
  const restrictiveModalNot = isRestrictiveModalProhibitionAt(inputWords, index)
  const restrictionIndex = tail.findIndex((word) =>
    ['restriction', 'restrictions', 'restrictive'].includes(word),
  )
  const restrictionWordIndex = index + restrictionIndex
  const hasRestrictiveRestriction =
    restrictionIndex >= 0 &&
    !['no', 'without'].includes(inputWords[restrictionWordIndex - 1]) &&
    !['no', 'without'].includes(inputWords[restrictionWordIndex - 2]) &&
    !['no', 'without'].includes(inputWords[restrictionWordIndex - 3]) &&
    !['no', 'without'].includes(inputWords[restrictionWordIndex - 4]) &&
    (!afterDocumentBoundary ||
      [
        'additional',
        'academic',
        'commercial',
        'custom',
        'demo',
        'documentation',
        'educational',
        'extra',
        'field',
        'internal',
        'private',
        'licence',
        'license',
        'nonprofit',
        'profit',
        'noncommercial',
        'research',
        'test',
        'testing',
        'trial',
        'usage',
        'use',
      ].includes(inputWords[restrictionWordIndex - 1]) ||
      ['applies', 'apply', 'below'].includes(
        inputWords[restrictionWordIndex + 1],
      ))
  return (
    restrictiveProvidedThat ||
    restrictiveTailLead ||
    hasRestrictiveScopeLicenseOnlyTail(inputWords, index) ||
    restrictiveScopeLead ||
    restrictiveForScope ||
    restrictiveModalNot ||
    hasRestrictiveRestriction ||
    (tail[0] === 'but' &&
      (['not', 'excluding', 'except', 'excepting'].includes(tail[1]) ||
        (['restricted', 'limited'].includes(tail[1]) &&
          ['to', 'for', 'by'].includes(tail[2])) ||
        (tail[1] === 'solely' && ['to', 'for'].includes(tail[2])))) ||
    (tail.includes('only') &&
      (hasCommercialOnlyScopeTail(tail) ||
        tail.includes('non') ||
        tail.includes('noncommercial') ||
        tail.includes('academic') ||
        tail.includes('demo') ||
        tail.includes('educational') ||
        tail.includes('documentation') ||
        tail.includes('internal') ||
        tail.includes('private') ||
        tail.includes('nonprofit') ||
        tail.includes('profit') ||
        tail.includes('personal') ||
        tail.includes('research') ||
        tail.includes('test') ||
        tail.includes('testing') ||
        tail.includes('trial')))
  )
}

function hasNoPrefixedRestrictionTail(
  inputWords: string[],
  index: number,
): boolean {
  if (inputWords[index] !== 'no') return false
  if (hasNoPrefixedRestrictionNegationTail(inputWords, index)) return false

  const next = inputWords[index + 1]
  if (!next) return false
  if (noPrefixedRestrictionActionWords.has(next)) {
    return true
  }

  const action = inputWords[index + 2]
  if (
    action &&
    noPrefixedRestrictionScopeWords.has(next) &&
    noPrefixedRestrictionScopedActionWords.has(action)
  ) {
    return true
  }

  const splitScope = inputWords[index + 2]
  const splitAction = inputWords[index + 3]
  return (
    next === 'non' &&
    ['commercial', 'profit'].includes(splitScope) &&
    Boolean(
      splitAction && noPrefixedRestrictionScopedActionWords.has(splitAction),
    )
  )
}

function hasNoPrefixedRestrictionNegationTail(
  inputWords: string[],
  index: number,
): boolean {
  if (inputWords[index] !== 'no') return false

  const next = inputWords[index + 1]
  if (!next) return false
  if (noPrefixedRestrictionActionWords.has(next)) {
    if (
      (next === 'derivative' || next === 'derivatives') &&
      noPrefixedDerivativeWorkWords.has(inputWords[index + 2])
    )
      return hasDerivativeWorkRestrictionNegationTail(inputWords, index + 3)
    return noPrefixedRestrictionNegationWords.has(inputWords[index + 2])
  }

  const action = inputWords[index + 2]
  if (
    action &&
    noPrefixedRestrictionScopeWords.has(next) &&
    noPrefixedRestrictionScopedActionWords.has(action)
  ) {
    return noPrefixedRestrictionNegationWords.has(inputWords[index + 3])
  }

  const splitScope = inputWords[index + 2]
  const splitAction = inputWords[index + 3]
  return (
    next === 'non' &&
    ['commercial', 'profit'].includes(splitScope) &&
    Boolean(
      splitAction && noPrefixedRestrictionScopedActionWords.has(splitAction),
    ) &&
    noPrefixedRestrictionNegationWords.has(inputWords[index + 4])
  )
}

function hasDerivativeWorkRestrictionNegationTail(
  inputWords: string[],
  index: number,
): boolean {
  if (noPrefixedRestrictionNegationWords.has(inputWords[index])) return true
  if (!['and', 'or'].includes(inputWords[index])) return false

  const actionIndex = index + 1
  if (!noPrefixedRestrictionScopedActionWords.has(inputWords[actionIndex]))
    return false
  return noPrefixedRestrictionNegationWords.has(inputWords[actionIndex + 1])
}

function hasRestrictiveLicenseTail(
  inputWords: string[],
  index: number,
): boolean {
  const tailEnd = Math.min(
    inputWords.length,
    index + restrictiveTailWindowWords,
  )
  if (
    hasRestrictiveLicenseLabelSuffix(
      inputWords.slice(index, tailEnd).join(' '),
    ) &&
    !hasRestrictionSubjectBoundary(inputWords, index)
  ) {
    return true
  }
  if (hasRestrictionSubjectBoundary(inputWords, index)) {
    return hasExplicitProjectRestrictiveTail(inputWords, index + 1, tailEnd)
  }

  let afterDocumentBoundary = false
  for (let tailIndex = index; tailIndex < tailEnd; tailIndex += 1) {
    if (hasRestrictionSubjectBoundary(inputWords, tailIndex)) {
      return hasExplicitProjectRestrictiveTail(
        inputWords,
        tailIndex + 1,
        tailEnd,
      )
    }
    if (isRestrictiveTailScanBoundary(inputWords, tailIndex)) {
      afterDocumentBoundary = true
      continue
    }
    if (isBenignLicenseOnlyReferenceTail(inputWords, index, tailIndex)) {
      continue
    }
    if (
      isRestrictiveLicenseTail(inputWords, tailIndex, afterDocumentBoundary)
    ) {
      return true
    }
  }
  return false
}

const licenseOnlyReferenceNouns = new Set([
  'model',
  'models',
  'offering',
  'offerings',
  'product',
  'products',
  'restriction',
  'restrictions',
  'section',
  'sections',
])

function isBenignLicenseOnlyReferenceTail(
  inputWords: string[],
  scanStart: number,
  scopeIndex: number,
): boolean {
  const afterOnlyIndex = scopeLicenseOnlyAfterIndex(inputWords, scopeIndex)
  if (afterOnlyIndex === undefined) return false

  const prefixWords = inputWords.slice(
    Math.max(scanStart, scopeIndex - 8),
    scopeIndex,
  )
  const prefix = prefixWords.join(' ')
  if (
    /(?:^| )(?:no|not|never|neither)(?: a| an| the)?$/.test(prefix) ||
    /(?:^| )not subject to(?: a| an| the)?$/.test(prefix) ||
    /(?:^| )not (?:licensed|released|distributed) (?:under|with)(?: (?:the )?terms of)?(?: a| an| the)?$/.test(
      prefix,
    ) ||
    /(?:^| )without(?: a| an| the)?$/.test(prefix) ||
    hasNegatedLicenseOnlyReferencePrefix(
      prefixWords,
      inputWords[afterOnlyIndex],
    )
  )
    return true

  return (
    licenseOnlyReferenceNouns.has(inputWords[afterOnlyIndex]) &&
    prefixWords.some((word) => ['check', 'read', 'refer', 'see'].includes(word))
  )
}

function hasNegatedLicenseOnlyReferencePrefix(
  prefixWords: string[],
  afterOnlyWord: string | undefined,
): boolean {
  if (!afterOnlyWord || !licenseOnlyReferenceNouns.has(afterOnlyWord))
    return false
  return /(?:^| )(?:(?:not|never) (?:(?:currently|ever|generally|normally|publicly|typically|usually) )?|(?:has|have|had|is|are|was|were) (?:(?:currently|ever|generally|normally|publicly|typically|usually) )?(?:not|never) (?:(?:currently|ever|generally|normally|publicly|typically|usually) )?(?:been|being) |(?:isn|aren|wasn|weren) t (?:(?:currently|ever|generally|normally|publicly|typically|usually) )?(?:being )?|(?:hasn|haven|hadn) t (?:(?:currently|ever|generally|normally|publicly|typically|usually) )?been )(?:advertised|described|distributed|marketed|offered|provided|released|sold) as(?: a| an| the)?$/.test(
    prefixWords.join(' '),
  )
}

function scopeLicenseOnlyAfterIndex(
  words: string[],
  index: number,
): number | undefined {
  let licenseIndex = index + 1
  if (
    words[index] === 'non' &&
    ['commercial', 'profit'].includes(words[index + 1])
  ) {
    licenseIndex = index + 2
  } else if (!restrictiveScopeLicenseOnlyWords.has(words[index])) {
    return undefined
  }

  return ['license', 'licence'].includes(words[licenseIndex]) &&
    words[licenseIndex + 1] === 'only'
    ? licenseIndex + 2
    : undefined
}

function hasExplicitProjectRestrictiveTail(
  inputWords: string[],
  startIndex: number,
  endIndex: number,
): boolean {
  for (let index = startIndex; index < endIndex; index += 1) {
    if (hasRestrictionSubjectBoundary(inputWords, index)) continue
    if (
      (selfReferenceContinuationStateIndex(inputWords, index) !== undefined ||
        projectScopedUseRestrictionStateIndex(inputWords, index) !==
          undefined) &&
      isRestrictiveContinuationAt(inputWords, index)
    ) {
      return true
    }
  }
  return false
}

function isVersionHeaderTail(inputWords: string[], index: number): boolean {
  const word = inputWords[index]
  if (!word) return false
  if (isVersionNumberWord(word)) return true
  return (
    (word === 'v' || word === 'version') &&
    isVersionNumberWord(inputWords[index + 1] || '')
  )
}

function isVersionNumberWord(word: string): boolean {
  const versionWord = word.startsWith('v') ? word.slice(1) : word
  if (versionWord.length === 0) return false
  for (const char of versionWord) {
    if (char < '0' || char > '9') return false
  }
  return true
}

function isBenignLicenseDefinitionTail(
  inputWords: string[],
  index: number,
): boolean {
  return (
    ['the', 'this'].includes(inputWords[index]) &&
    ['license', 'licence'].includes(inputWords[index + 1]) &&
    !inputWords[index + 2]
  )
}

function warrantyDisclaimerTailEnd(
  inputWords: string[],
  index: number,
): number | undefined {
  const skipWarrantyQualifier = (tailIndex: number) => {
    let nextIndex = tailIndex
    if (
      inputWords[nextIndex] === 'of' &&
      inputWords[nextIndex + 1] === 'any' &&
      ['kind', 'kinds'].includes(inputWords[nextIndex + 2])
    ) {
      nextIndex += 3
    }
    if (
      inputWords[nextIndex] === 'express' &&
      inputWords[nextIndex + 1] === 'or' &&
      inputWords[nextIndex + 2] === 'implied'
    ) {
      nextIndex += 3
    }
    if (
      inputWords[nextIndex] === 'including' &&
      inputWords[nextIndex + 1] === 'but' &&
      inputWords[nextIndex + 2] === 'not' &&
      inputWords[nextIndex + 3] === 'limited' &&
      inputWords[nextIndex + 4] === 'to'
    ) {
      nextIndex += 5
      while (
        [
          'a',
          'and',
          'any',
          'fitness',
          'for',
          'merchantability',
          'noninfringement',
          'of',
          'or',
          'particular',
          'purpose',
          'the',
          'warranties',
          'warranty',
        ].includes(inputWords[nextIndex])
      ) {
        nextIndex += 1
      }
    }
    return nextIndex
  }

  if (
    ['provided', 'supplied'].includes(inputWords[index]) &&
    ['without', 'no'].includes(inputWords[index + 1]) &&
    warrantyWords.has(inputWords[index + 2])
  ) {
    return skipWarrantyQualifier(index + 3)
  }

  if (
    inputWords[index] === 'without' &&
    warrantyWords.has(inputWords[index + 1])
  ) {
    return skipWarrantyQualifier(index + 2)
  }

  if (inputWords[index] === 'no' && warrantyWords.has(inputWords[index + 1])) {
    return skipWarrantyQualifier(index + 2)
  }

  let subjectIndex = index
  if (['the', 'this', 'that'].includes(inputWords[subjectIndex])) {
    subjectIndex += 1
  }
  if (
    !['code', 'package', 'project', 'software', 'source', 'work'].includes(
      inputWords[subjectIndex],
    ) ||
    !['is', 'are'].includes(inputWords[subjectIndex + 1]) ||
    !['provided', 'supplied'].includes(inputWords[subjectIndex + 2])
  ) {
    return undefined
  }

  let warrantyIndex = subjectIndex + 3
  if (
    inputWords[warrantyIndex] === 'as' &&
    inputWords[warrantyIndex + 1] === 'is'
  ) {
    warrantyIndex += 2
  }
  if (
    ['without', 'no'].includes(inputWords[warrantyIndex]) &&
    warrantyWords.has(inputWords[warrantyIndex + 1])
  ) {
    return skipWarrantyQualifier(warrantyIndex + 2)
  }
  return undefined
}

function isBenignWarrantyDisclaimerTail(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  const tailEnd = warrantyDisclaimerTailEnd(inputWords, index)
  return (
    tailEnd !== undefined &&
    !hasRestrictiveLicenseTail(inputWords, tailEnd) &&
    !hasLaterLicenseReference(inputWords, tailEnd, licenseAliasWords)
  )
}

function isDuplicateAliasTail(
  inputWords: string[],
  index: number,
  duplicateAliasWords: string[][],
): boolean {
  return duplicateAliasWords.some(
    (candidateWords) =>
      matchesWordsAt(inputWords, index, candidateWords) &&
      !inputWords[index + candidateWords.length],
  )
}

function isBenignTrailingProse(
  inputWords: string[],
  index: number,
  licenseAliasWords: string[][],
): boolean {
  const word = inputWords[index]
  if (isBenignWarrantyDisclaimerTail(inputWords, index, licenseAliasWords))
    return true
  if (hasNoPrefixedRestrictionNegationTail(inputWords, index)) return true
  if (hasRestrictiveLicenseTail(inputWords, index)) return false
  if (hasRestrictionSubjectBoundary(inputWords, index)) return true
  return (
    hasBenignComplianceTail(inputWords, index) ||
    word === 'see' ||
    (word === 'for' && isBenignForTail(inputWords, index)) ||
    word === 'details' ||
    word === 'detail' ||
    isBenignCopyrightTail(inputWords, index, licenseAliasWords) ||
    isBenignLicenseDefinitionTail(inputWords, index) ||
    (word === 'and' &&
      ((inputWords[index + 1] === 'is' &&
        inputWords[index + 2] === 'provided') ||
        (inputWords[index + 1] === 'are' &&
          inputWords[index + 2] === 'provided') ||
        (inputWords[index + 1] === 'compatible' &&
          inputWords[index + 2] === 'with') ||
        isBenignLicenseDocumentTail(inputWords, index + 1)))
  )
}

function isApache20OfficialTitleDateTail(
  inputWords: string[],
  index: number,
): boolean {
  return (
    inputWords[index] === 'january' &&
    inputWords[index + 1] === '2004' &&
    !inputWords[index + 2]
  )
}

function isApache20AliasWords(aliasWords: string[]): boolean {
  return aliasWords[0] === 'apache' && hasWords(aliasWords, ['2', '0'])
}

function matchesHeaderAlias(
  inputWords: string[],
  aliasWords: string[],
  licenseAliasWords: string[][],
  duplicateAliasWords: string[][] = [aliasWords],
): boolean {
  if (aliasWords.length > inputWords.length) return false
  for (const [index, word] of aliasWords.entries()) {
    if (inputWords[index] !== word) return false
  }
  const nextWord = inputWords[aliasWords.length]
  if (!nextWord) return true
  if (
    isApache20AliasWords(aliasWords) &&
    isApache20OfficialTitleDateTail(inputWords, aliasWords.length)
  )
    return true
  if (
    hasAdditionalLicenseHeader(
      inputWords,
      aliasWords.length,
      licenseAliasWords,
    ) ||
    hasCompoundLicenseConnector(
      inputWords,
      aliasWords.length,
      licenseAliasWords,
    )
  )
    return false
  if (
    isBlockedHeaderOperator(inputWords, aliasWords.length, licenseAliasWords) ||
    isBlockedWithQualifier(inputWords, aliasWords.length) ||
    isRestrictiveLicenseTail(inputWords, aliasWords.length)
  )
    return false
  if (nextWord === 'with') {
    return !hasBlockedBenignWithTail(
      inputWords,
      aliasWords.length,
      licenseAliasWords,
    )
  }
  if (nextWord === 'licensed' || nextWord === 'licenced') {
    const afterLicensedIndex = aliasWords.length + 1
    if (!inputWords[afterLicensedIndex]) return true
    if (isRestrictiveLicenseTail(inputWords, afterLicensedIndex)) return false
    return isBenignTrailingProse(
      inputWords,
      afterLicensedIndex,
      licenseAliasWords,
    )
  }
  if (nextWord === 'license' || nextWord === 'licence') {
    const afterLicenseIndex = aliasWords.length + 1
    if (
      isApache20AliasWords(aliasWords) &&
      isApache20OfficialTitleDateTail(inputWords, afterLicenseIndex)
    )
      return true
    if (isVersionHeaderTail(inputWords, afterLicenseIndex)) return false
    if (
      isDuplicateAliasTail(inputWords, afterLicenseIndex, duplicateAliasWords)
    )
      return true
    if (isRestrictiveLicenseTail(inputWords, afterLicenseIndex)) return false
    if (
      inputWords[afterLicenseIndex] === 'copyright' &&
      !isBenignCopyrightTail(inputWords, afterLicenseIndex, licenseAliasWords)
    )
      return false
    if (
      inputWords[afterLicenseIndex] === 'for' &&
      !isBenignForTail(inputWords, afterLicenseIndex)
    )
      return false
    return !(
      hasAdditionalLicenseHeader(
        inputWords,
        afterLicenseIndex,
        licenseAliasWords,
      ) ||
      hasLicenseOperandAt(inputWords, afterLicenseIndex, licenseAliasWords) ||
      hasBlockedBenignWithTail(
        inputWords,
        afterLicenseIndex,
        licenseAliasWords,
      ) ||
      hasRestrictiveLicenseTail(inputWords, afterLicenseIndex) ||
      isBlockedHeaderOperator(
        inputWords,
        afterLicenseIndex,
        licenseAliasWords,
      ) ||
      isBlockedWithQualifier(inputWords, afterLicenseIndex)
    )
  }
  if (isVersionHeaderTail(inputWords, aliasWords.length)) return false
  if (isDuplicateAliasTail(inputWords, aliasWords.length, duplicateAliasWords))
    return true
  return isBenignTrailingProse(inputWords, aliasWords.length, licenseAliasWords)
}

const bareTitleLeadingArticles = new Set(['a', 'an', 'the'])

function exactBareLicenseTitleWordMatch(
  inputWords: string[],
  licenses: LicenseEntry[],
): boolean {
  return licenses.some((entry) => {
    const titleWords = aliasWords(entry.name)
    return (
      titleWords.length === inputWords.length &&
      matchesWordsAt(inputWords, 0, titleWords)
    )
  })
}

function exactBareLicenseTitleWords(
  input: string,
  licenses: LicenseEntry[],
): string[] | undefined {
  const inputWords = aliasWords(input)
  if (inputWords.length < 2 || inputWords.length > 16) return undefined
  return exactBareLicenseTitleWordMatch(inputWords, licenses)
    ? inputWords
    : undefined
}

function bareLicenseAliasWordMatch(
  inputWords: string[],
  aliases: HeaderAlias[],
  licenseAliasWords?: string[][],
): boolean {
  return aliases.some(
    (alias) =>
      alias.allowBareTitle &&
      !alias.legacyAlias &&
      ((alias.words.length === inputWords.length &&
        matchesWordsAt(inputWords, 0, alias.words)) ||
        (licenseAliasWords &&
          matchesHeaderAlias(
            inputWords,
            alias.words,
            licenseAliasWords,
            alias.sameLicenseWords,
          ))),
  )
}

function bareLicenseAliasWords(
  input: string,
  aliases: HeaderAlias[],
  licenseAliasWords?: string[][],
): string[] | undefined {
  const inputWords = aliasWords(input)
  if (inputWords.length < 2 || inputWords.length > 16) return undefined
  return bareLicenseAliasWordMatch(inputWords, aliases, licenseAliasWords)
    ? inputWords
    : undefined
}

function articleStrippedBareLicenseTitleWords(
  input: string,
  aliases: HeaderAlias[],
  licenses: LicenseEntry[],
  licenseAliasWords?: string[][],
): string[] | undefined {
  const inputWords = aliasWords(input)
  if (!bareTitleLeadingArticles.has(inputWords[0] || '')) return undefined
  const candidateWords = inputWords.slice(1)
  if (candidateWords.length < 2 || candidateWords.length > 16) return undefined
  return bareLicenseAliasWordMatch(
    candidateWords,
    aliases,
    licenseAliasWords,
  ) || exactBareLicenseTitleWordMatch(candidateWords, licenses)
    ? candidateWords
    : undefined
}

function articleStrippedHeaderWords(
  inputWords: string[],
  aliases: HeaderAlias[],
  licenses: LicenseEntry[],
  licenseAliasWords: string[][],
): string[] | undefined {
  if (!bareTitleLeadingArticles.has(inputWords[0] || '')) return undefined
  const candidateWords = inputWords.slice(1)
  if (candidateWords.length < 2 || candidateWords.length > 16) return undefined
  if (
    aliases.some((alias) =>
      matchesHeaderAlias(
        candidateWords,
        alias.words,
        licenseAliasWords,
        alias.sameLicenseWords,
      ),
    ) ||
    exactBareLicenseTitleWordMatch(candidateWords, licenses)
  ) {
    return candidateWords
  }
  return undefined
}

function withGnuManualReviewCounterparts(
  results: MatchResult[],
  gnuContext: GnuReviewContext,
  licenseById: Map<string, LicenseEntry>,
): MatchResult[] {
  const seenLicenseIds = new Set(results.map((result) => result.licenseId))
  const expanded = [...results]
  for (const result of results) {
    if (!result.flags.needsManualReview) continue
    if (result.flags.isLegacyId) continue
    const counterpart = gnuCounterparts.get(result.licenseId)
    if (!counterpart || seenLicenseIds.has(counterpart)) continue
    const counterpartEntry = licenseById.get(counterpart)
    if (!counterpartEntry || !gnuManualReview(gnuContext, counterpart)) continue
    expanded.push(resultFromNamedHeader(counterpartEntry, gnuContext))
    seenLicenseIds.add(counterpart)
  }
  return expanded
}

function namedHeaderResults(
  input: string,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
  inputType: MatchResult['inputType'],
  gnuContext: GnuReviewContext,
  options: { allowExactBareTitle?: boolean } = {},
): MatchResult[] {
  if (inputType !== 'license-header' && inputType !== 'unknown') return []

  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const rawInputWords = aliasWords(input)
  const inputWords =
    wordsAfterLicenseHeader(input, licenseAliasWords, aliases) ??
    (inputType === 'license-header'
      ? (articleStrippedHeaderWords(
          rawInputWords,
          aliases,
          licenses,
          licenseAliasWords,
        ) ?? rawInputWords)
      : inputType === 'unknown' && options.allowExactBareTitle
        ? (bareLicenseAliasWords(input, aliases, licenseAliasWords) ??
          exactBareLicenseTitleWords(input, licenses) ??
          articleStrippedBareLicenseTitleWords(
            input,
            aliases,
            licenses,
            licenseAliasWords,
          ))
        : undefined)
  if (!inputWords) return []
  const seenLicenseIds = new Set<string>()
  const results = aliases
    .filter(
      (alias) =>
        matchesHeaderAlias(
          inputWords,
          alias.words,
          licenseAliasWords,
          alias.sameLicenseWords,
        ) && !hasBareAliasTechnicalSubjectTail(inputWords, alias.words.length),
    )
    .filter((alias) => {
      if (seenLicenseIds.has(alias.licenseId)) return false
      seenLicenseIds.add(alias.licenseId)
      return true
    })
    .map((alias) => ({ alias, entry: licenseById.get(alias.licenseId) }))
    .filter((match): match is { alias: HeaderAlias; entry: LicenseEntry } =>
      Boolean(match.entry),
    )
    .map(({ alias, entry }) =>
      resultFromNamedHeader(
        entry,
        disambiguatedGnuHeaderContext(inputWords, alias, gnuContext),
        alias.legacyAlias,
      ),
    )
  return withGnuManualReviewCounterparts(results, gnuContext, licenseById)
}

function namedHeaderConflictResults(
  input: string,
  excludedIds: Set<string>,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
  knownIds?: Set<string>,
): MatchResult[] {
  const trimmed = input.trim()
  if (!trimmed) return []
  if (knownIds && hasSpdxIdToken(trimmed, knownIds)) return []
  const notice = detectGnuNotice(trimmed)
  const context: GnuReviewContext = {
    notice,
    inputOrLater: hasOrLaterWording(notice),
  }
  return namedHeaderResults(
    trimmed,
    licenses,
    licenseById,
    'license-header',
    context,
  ).filter((result) => !excludedIds.has(result.licenseId))
}

function currentProjectNamedHeaderIds(
  input: string,
  aliases: HeaderAlias[],
): Set<string> {
  const ids = new Set<string>()
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const loose = normalizeHeaderLoose(input)
  const headerPattern = resetLicenseHeaderPattern(
    currentProjectNamedHeaderPattern,
  )
  let match: RegExpExecArray | null
  while ((match = headerPattern.exec(loose))) {
    const inputWords = wordsAfterHeaderMatch(
      loose,
      match.index + match[0].length,
    )
    if (!hasPotentialHeaderAlias(inputWords, licenseAliasWords)) continue
    const headerContext = licenseHeaderContext(
      loose,
      match.index,
      licenseAliasWords,
    )
    if (
      hasNegatedLicenseHeaderContext(
        loose,
        match.index,
        licenseAliasWords,
        input,
        headerContext,
      ) ||
      isScopedAwayLicenseHeaderContext(headerContext)
    )
      continue
    if (
      !hasCurrentLicenseHeaderContext(
        loose,
        match.index,
        licenseAliasWords,
        match[0],
        input,
        headerContext,
      )
    )
      continue
    for (const alias of aliases) {
      if (
        matchesHeaderAlias(
          inputWords,
          alias.words,
          licenseAliasWords,
          alias.sameLicenseWords,
        ) &&
        !hasBareAliasTechnicalSubjectTail(inputWords, alias.words.length)
      ) {
        ids.add(alias.licenseId)
      }
    }
  }
  return ids
}

function conflictingLicenseLabelNamedBodyResults(
  input: string,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
): MatchResult[] {
  const labelIds = declaredLicenseLabelIds(input, licenses)
  if (labelIds.size === 0) return []
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const body = bodyWithoutLicenseLabelLines(input, licenseAliasWords, {
    skipPrefixedStandaloneLabelValues: true,
  })
  const bodyHeaderIds = currentProjectNamedHeaderIds(body, aliases)
  if (
    bodyHeaderIds.size > 0 &&
    Array.from(bodyHeaderIds).every((id) => labelIds.has(id))
  )
    return []
  return namedHeaderConflictResults(body, labelIds, licenses, licenseById)
}

function licenseLabelConflictResultsWithDiffDetails(
  input: string,
  results: MatchResult[],
  licenses: LicenseEntry[],
  includeDiffs: boolean,
): MatchResult[] {
  const aliases = getHeaderAliases(licenses)
  const body =
    bodyWithoutLicenseLabelLines(
      input,
      aliases.map((alias) => alias.words),
      { skipPrefixedStandaloneLabelValues: true },
    ) || input
  const resultsWithDiffInput = attachDiffInput(results, body)
  return resultsWithDiffDetails(
    body,
    resultsWithDiffInput,
    licenses,
    includeDiffs,
  )
}

function conflictingNamedHeadersAroundExactFullLicenseBody(
  input: string,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
  knownIds: Set<string>,
): MatchResult[] {
  const bounds = containedSupportedFullLicenseBounds(input, licenses)
  if (!bounds) return []

  const normalizedInput = normalizeStrict(input)
  const excludedIds = new Set([bounds.entry.licenseId])
  const prefixResults = namedHeaderConflictResults(
    normalizedInput.slice(0, bounds.start),
    excludedIds,
    licenses,
    licenseById,
    knownIds,
  )
  if (prefixResults.length > 0) return prefixResults

  return namedHeaderConflictResults(
    normalizedInput.slice(bounds.end),
    excludedIds,
    licenses,
    licenseById,
    knownIds,
  )
}

function disambiguatedGnuHeaderContext(
  inputWords: string[],
  alias: HeaderAlias,
  fallback: GnuReviewContext,
): GnuReviewContext {
  if (alias.legacyAlias) return fallback
  const parsed = parseGnuLicenseId(alias.licenseId)
  if (!parsed) return fallback
  const wordsDisambiguate = alias.licenseId.endsWith('-or-later')
    ? hasWords(inputWords, ['or', 'later'])
    : alias.words.includes('only')
  if (!wordsDisambiguate) return fallback
  return {
    notice: {
      family: parsed.family,
      version: parsed.version,
      wording: inputWords.join(' '),
    },
    inputOrLater: alias.licenseId.endsWith('-or-later'),
  }
}

function hasWords(inputWords: string[], words: string[]): boolean {
  return inputWords.some((_, index) => matchesWordsAt(inputWords, index, words))
}

function spdxDeclarationPrefixEnd(
  expression: string,
  knownIds: Set<string>,
): number {
  let end = 0
  let tokenCount = 0
  for (const match of expression.matchAll(/[A-Za-z0-9.+:-]+|[()]/g)) {
    tokenCount += 1
    if (tokenCount > maxSpdxDeclarationPrefixTokens) break
    const matchEnd = (match.index ?? 0) + match[0].length
    const prefix = expression.slice(0, matchEnd).trim()
    const detected = detectSpdxIdentifier(
      'SPDX-License-Identifier: ' + prefix,
      knownIds,
    )
    if (detected?.expression === prefix) end = matchEnd
  }
  return end
}

function stripSpdxIdentifierFromLine(
  line: string,
  knownIds?: Set<string>,
): string {
  const marker = spdxIdentifierDeclarationLinePattern.exec(line)
  if (!marker) return line
  const expression = line.slice(marker.index + marker[0].length)
  const wrapperTerminator = spdxCommentWrapperTerminator(expression, marker[0])
  if (wrapperTerminator)
    return expression.slice(wrapperTerminator.end).trimStart()
  if (!knownIds) {
    const trimmedExpression = trimSpdxExpressionTail(expression)
    const expressionTail = expression
      .slice(trimmedExpression.length)
      .trimStart()
    let tail = ''
    if (expressionTail.startsWith(';')) {
      tail = expressionTail.slice(1).trimStart()
    } else if (!expressionTail) {
      const strippedTail = stripLeadingSpdxLikeTailTokens(trimmedExpression)
      if (strippedTail !== trimmedExpression) {
        tail = strippedTail
      }
      const semicolonIndex = tail ? -1 : expression.indexOf(';')
      if (semicolonIndex >= 0) {
        tail = stripLeadingSpdxLikeTailTokens(
          expression.slice(semicolonIndex + 1).trimStart(),
        )
      }
    }
    return tail && hasRestrictiveTailSegment(tail) ? tail : ''
  }
  const declarationEnd = spdxDeclarationPrefixEnd(expression, knownIds)
  if (declarationEnd === 0) return expression.trimStart()
  let tail = stripLeadingSpdxLikeTailTokens(
    expression.slice(declarationEnd).trimStart(),
    knownIds,
    { allowBareLeadingToken: false },
  )
  if (/^(?:-->|\*\/)\s*$/.test(tail)) return ''
  const expressionWithoutInlineComment = trimSpdxInlineCommentTail(expression)
  if (expressionWithoutInlineComment.length < expression.trimEnd().length) {
    const inlineDeclarationEnd = spdxDeclarationPrefixEnd(
      expressionWithoutInlineComment,
      knownIds,
    )
    tail = stripLeadingSpdxLikeTailTokens(
      expressionWithoutInlineComment.slice(inlineDeclarationEnd).trimStart(),
      knownIds,
      { allowBareLeadingToken: false },
    )
  }
  if (!tail.startsWith(';')) return tail
  const semicolonTail = tail.slice(1).trimStart()
  const restrictiveTail = stripLeadingSpdxLikeTailTokens(
    semicolonTail,
    knownIds,
  )
  return restrictiveTail && hasRestrictiveTailSegment(restrictiveTail)
    ? restrictiveTail
    : ''
}

function spdxDetectionForExpression(
  expression: string,
  declarationEnd: number,
  knownIds: Set<string>,
): SpdxDetection | undefined {
  const declaration = expression.slice(0, declarationEnd).trim()
  return detectSpdxIdentifier(
    'SPDX-License-Identifier: ' + declaration,
    knownIds,
  )
}

function isSimpleSpdxIdDeclaration(declaration: SpdxDetection): boolean {
  return (
    declaration.ids.length === 1 &&
    declaration.unsupportedIds.length === 0 &&
    !declaration.hasCompoundExpression &&
    !declaration.hasWithException
  )
}

function isBenignSpdxAnnotationTail(
  tail: string,
  declaration: SpdxDetection,
  aliases: HeaderAlias[] = [],
): boolean {
  const trimmed = tail.trim()
  if (!isSimpleSpdxIdDeclaration(declaration)) return false
  if (/^licen[cs]e$/i.test(trimmed)) return true

  const parenthesized = /^\(([^()]*)\)$/.exec(trimmed)
  if (!parenthesized) return false

  const annotation = parenthesized[1].trim()
  if (hasRestrictiveTailSegment(annotation)) return false
  return annotationMatchesDeclaredSpdxId(annotation, declaration.ids, aliases)
}

function trailingBalancedParenthesizedAnnotation(
  value: string,
): { header: string; annotation: string } | undefined {
  const trimmed = value.trim()
  if (!trimmed.endsWith(')')) return undefined
  let depth = 0
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const char = trimmed[index]
    if (char === ')') {
      depth += 1
    } else if (char === '(') {
      depth -= 1
      if (depth === 0) {
        if (index === 0 || !/\s/.test(trimmed[index - 1] || '')) {
          return undefined
        }
        const header = trimmed.slice(0, index).trim()
        const annotation = trimmed.slice(index + 1, -1).trim()
        return header && annotation ? { header, annotation } : undefined
      }
      if (depth < 0) return undefined
    }
  }
  return undefined
}

function annotationMatchesDeclaredSpdxId(
  annotation: string,
  declaredIds: string[],
  aliases: HeaderAlias[],
): boolean {
  const words = aliasWords(annotation)
  if (words.length === 0) return false
  const annotationWordVariants =
    words[0] === 'the' ? [words, words.slice(1)] : [words]

  return declaredIds.some((licenseId) =>
    aliases.some(
      (alias) =>
        alias.licenseId === licenseId &&
        annotationWordVariants.some((annotationWords) =>
          annotationMatchesHeaderAliasWords(annotationWords, alias.words),
        ),
    ),
  )
}

function annotationMatchesHeaderAliasWords(
  annotationWords: string[],
  aliasWords: string[],
): boolean {
  if (
    annotationWords.length === aliasWords.length &&
    matchesWordsAt(annotationWords, 0, aliasWords)
  )
    return true

  if (
    annotationWords.join(' ') === 'public domain' &&
    hasWords(aliasWords, annotationWords)
  )
    return true

  if (!matchesWordsAt(aliasWords, 0, annotationWords)) return false
  if (!annotationWords.includes('license')) return false
  return aliasWords
    .slice(annotationWords.length)
    .every((word) => /^(?:v|version|[0-9]+)$/.test(word))
}

function isBlockCommentSpdxMarker(markerText: string): boolean {
  const trimmed = markerText.trim()
  return /\/\*/.test(trimmed) || /^\*+!?(?:\s|$)/.test(trimmed)
}

function spdxCommentWrapperTerminator(
  expression: string,
  markerText = '',
): { index: number; end: number } | undefined {
  let wrapperTerminator: { index: number; end: number } | undefined
  const terminators = markerText.includes('<!--')
    ? ['-->']
    : isBlockCommentSpdxMarker(markerText)
      ? ['*/']
      : []
  for (const terminator of terminators) {
    const terminatorIndex = expression.indexOf(terminator)
    if (terminatorIndex < 0) continue
    if (!wrapperTerminator || terminatorIndex < wrapperTerminator.index) {
      wrapperTerminator = {
        index: terminatorIndex,
        end: terminatorIndex + terminator.length,
      }
    }
  }
  return wrapperTerminator
}

function trimSpdxAnnotationCommentWrapperTail(
  expression: string,
  markerText = '',
): string {
  const expressionWithoutInlineComment = trimSpdxInlineCommentTail(expression)
  const wrapperTerminator = spdxCommentWrapperTerminator(
    expressionWithoutInlineComment,
    markerText,
  )
  if (!wrapperTerminator) return expressionWithoutInlineComment

  const bodyAfterTerminator = expressionWithoutInlineComment
    .slice(wrapperTerminator.end)
    .trim()
  if (bodyAfterTerminator) return expressionWithoutInlineComment
  return expressionWithoutInlineComment.slice(0, wrapperTerminator.index).trim()
}

function spdxDeclarationLineHasCommentWrapperBody(line: string): boolean {
  const marker = spdxIdentifierDeclarationLinePattern.exec(line)
  if (!marker) return false
  const expression = line.slice(marker.index + marker[0].length)
  const wrapperTerminator = spdxCommentWrapperTerminator(expression, marker[0])
  if (!wrapperTerminator) return false
  return expression.slice(wrapperTerminator.end).trim() !== ''
}

function isBenignMalformedSpdxAnnotationLine(
  line: string,
  knownIds: Set<string>,
  aliases: HeaderAlias[] = [],
): boolean {
  const marker = spdxIdentifierDeclarationLinePattern.exec(line)
  if (!marker) return false
  const expression = line.slice(marker.index + marker[0].length)
  const expressionWithoutInlineComment = trimSpdxAnnotationCommentWrapperTail(
    expression,
    marker[0],
  )
  const declarationEnd = spdxDeclarationPrefixEnd(
    expressionWithoutInlineComment,
    knownIds,
  )
  if (declarationEnd === 0) return false
  const declaration = spdxDetectionForExpression(
    expressionWithoutInlineComment,
    declarationEnd,
    knownIds,
  )
  if (!declaration) return false
  const tail = expressionWithoutInlineComment.slice(declarationEnd).trimStart()
  return isBenignSpdxAnnotationTail(tail, declaration, aliases)
}

function hasRestrictiveTailSegment(tail: string): boolean {
  return (
    hasRestrictiveLicenseLabelSuffix(tail) ||
    hasProjectRestrictiveBodySegment(tail, true)
  )
}

function stripParenthesizedText(text: string): string {
  let depth = 0
  let stripped = ''
  for (const char of text) {
    if (char === '(') {
      depth += 1
      if (depth === 1) stripped += ' '
    } else if (char === ')' && depth > 0) {
      depth -= 1
      if (depth === 0) stripped += ' '
    } else if (depth === 0) {
      stripped += char
    }
  }
  return stripped
}

function hasRestrictiveAnnotationText(text: string): boolean {
  const stripped = stripParenthesizedText(text)
  const candidates = stripped === text ? [text] : [text, stripped]
  return candidates.some((candidate) => {
    const words = aliasWords(candidate)
    return (
      hasRestrictiveTailSegment(candidate) ||
      hasRestrictiveLicenseTail(words, 0)
    )
  })
}

function stripLeadingSpdxLikeTailTokens(
  tail: string,
  knownIds?: Set<string>,
  options: { allowBareLeadingToken?: boolean } = {},
): string {
  const allowBareLeadingToken = options.allowBareLeadingToken ?? true
  if (!allowBareLeadingToken) {
    if (!/^\s*(?:[,;]|\band\b|\bor\b)\s*/i.test(tail)) {
      const strippedTail = stripLeadingSpdxLikeTailTokens(tail, knownIds)
      return strippedTail !== tail.trimStart() &&
        hasRestrictiveTailSegment(strippedTail)
        ? strippedTail
        : tail.trimStart()
    }
  }
  let offset = 0
  let stripped = false
  while (offset < tail.length) {
    const separator = /^\s*(?:(?:[,;]|\band\b|\bor\b)\s*)?/i.exec(
      tail.slice(offset),
    )!
    const tokenStart = offset + separator[0].length
    const token = /^[A-Za-z0-9.+:-]+/.exec(tail.slice(tokenStart))
    if (!token || !isSpdxLikeIdToken(token[0], knownIds)) break
    stripped = true
    offset = tokenStart + token[0].length
  }
  return stripped ? tail.slice(offset).trimStart() : tail.trimStart()
}

function isOnlySpdxLikeLicenseHeaderTail(
  body: string,
  knownIds: Set<string>,
): boolean {
  if (body.includes('\n') || body.includes('\r')) return false
  const strippedTail = stripLeadingSpdxLikeTailTokens(body, knownIds)
  return (
    strippedTail !== body.trimStart() &&
    /^(?:licen[cs]e)?$/i.test(strippedTail.trim())
  )
}

function hasSpdxIdentifierDeclarationLine(input: string): boolean {
  return input
    .split(/\r\n?|\n/)
    .some((line) => spdxIdentifierDeclarationLinePattern.test(line))
}

function isStandaloneSpdxCommentWrapperLine(line: string): boolean {
  return /^(?:\/\*+!?|\*+\/?|\*+!?\s*\/|<!--|-->)$/.test(line.trim())
}

function bodyWithoutSpdxLines(input: string, knownIds?: Set<string>): string {
  const hasSpdxDeclaration = hasSpdxIdentifierDeclarationLine(input)
  return input
    .split(/\r\n?|\n/)
    .map((line) =>
      hasSpdxDeclaration && isStandaloneSpdxCommentWrapperLine(line)
        ? ''
        : stripSpdxIdentifierFromLine(line, knownIds),
    )
    .join('\n')
    .trim()
}

function spdxDeclarationLineValue(line: string): string {
  const marker = spdxIdentifierDeclarationLinePattern.exec(line)
  if (!marker) return ''
  return trimSpdxAnnotationCommentWrapperTail(
    line.slice(marker.index + marker[0].length),
    marker[0],
  ).trim()
}

function spdxDeclarationLineDeclaredValue(line: string): string {
  const marker = spdxIdentifierDeclarationLinePattern.exec(line)
  if (!marker) return ''
  const expression = trimSpdxInlineCommentTail(
    line.slice(marker.index + marker[0].length),
  )
  const wrapperTerminator = spdxCommentWrapperTerminator(expression, marker[0])
  return (
    wrapperTerminator
      ? expression.slice(0, wrapperTerminator.index)
      : expression
  ).trim()
}

function spdxDeclarationLineValues(input: string): string[] {
  return input
    .split(/\r\n?|\n/)
    .filter((line) => !spdxDeclarationLineHasCommentWrapperBody(line))
    .map(spdxDeclarationLineValue)
    .filter(Boolean)
}

function trailingParenthesizedAnnotation(
  value: string,
): { header: string; annotation: string } | undefined {
  const parenthesized = trailingBalancedParenthesizedAnnotation(value)
  if (!parenthesized) return undefined
  const { header, annotation } = parenthesized
  if (!header || !annotation || /[()]/.test(header)) return undefined
  return { header, annotation }
}

function isSafeMalformedSpdxHeaderValue(value: string): boolean {
  if (/;/.test(value) || /\b(?:AND|OR|WITH)\b/.test(value)) return false
  if (!/[()]/.test(value)) return true
  return Boolean(trailingParenthesizedAnnotation(value))
}

function parenthesizedAnnotationMatchesHeader(
  header: string,
  annotation: string,
  aliases: HeaderAlias[],
): boolean {
  const headerWords = aliasWords(header)
  const headerStart = bareTitleLeadingArticles.has(headerWords[0] || '') ? 1 : 0
  const annotationWords = aliasWords(annotation)
  const annotationWordVariants =
    annotationWords[0] === 'the'
      ? [annotationWords, annotationWords.slice(1)]
      : [annotationWords]
  const headerIds = new Set(
    aliases
      .filter((alias) => matchesWordsAt(headerWords, headerStart, alias.words))
      .map((alias) => alias.licenseId),
  )
  return aliases.some(
    (alias) =>
      headerIds.has(alias.licenseId) &&
      annotationWordVariants.some((words) =>
        annotationMatchesHeaderAliasWords(words, alias.words),
      ),
  )
}

function malformedSpdxHeaderValueVariants(
  value: string,
  aliases: HeaderAlias[],
): string[] {
  const variants = [value, value.replace(/,\s*/g, ' ')]
  const parenthesized = trailingParenthesizedAnnotation(value)
  if (
    parenthesized &&
    /\b(?:licen[cs]e|unlicense|public domain|cc0|creative commons zero)\b/.test(
      normalizeHeaderLoose(parenthesized.header),
    ) &&
    parenthesizedAnnotationMatchesHeader(
      parenthesized.header,
      parenthesized.annotation,
      aliases,
    )
  ) {
    variants.push(parenthesized.header)
  }
  for (const variant of [...variants]) {
    variants.push(variant.replace(/^(?:the|a|an)\s+/i, ''))
  }
  return Array.from(new Set(variants))
}

function isMalformedSpdxHeaderFallbackValue(
  value: string,
  aliases: HeaderAlias[],
): boolean {
  if (!isSafeMalformedSpdxHeaderValue(value)) return false
  const parenthesized = trailingParenthesizedAnnotation(value)
  return parenthesized
    ? parenthesizedAnnotationMatchesHeader(
        parenthesized.header,
        parenthesized.annotation,
        aliases,
      )
    : true
}

function isMalformedSpdxNamedHeaderValue(
  value: string,
  knownIds: Set<string>,
): boolean {
  const loose = normalizeHeaderLoose(value)
  if (
    !/\b(?:licen[cs]e|unlicense|public domain|cc0|creative commons zero)\b/.test(
      loose,
    )
  )
    return false
  const spdxLikeTokens = new Set(
    (value.match(/[A-Za-z0-9.+:-]+/g) || [])
      .filter((token) => isSpdxLikeIdToken(token, knownIds))
      .map((token) => token.toLowerCase()),
  )
  return spdxLikeTokens.size <= 1
}

type DeclarationHeaderAliasMatch = {
  licenseId: string
  end: number
}

function declarationHeaderAliasMatches(
  value: string,
  aliases: HeaderAlias[],
): { words: string[]; matches: DeclarationHeaderAliasMatch[] } {
  const words = aliasWords(value)
  const matches: DeclarationHeaderAliasMatch[] = []
  for (let index = 0; index < words.length; index += 1) {
    const remainingWords = words.slice(index)
    const alias = aliases.find((candidate) => {
      if (!matchesWordsAt(words, index, candidate.words)) return false
      const tail = remainingWords.slice(candidate.words.length).join(' ')
      const hasRestrictiveTail =
        hasRestrictiveTailSegment(tail) ||
        hasRestrictiveLicenseTail(remainingWords, candidate.words.length)
      return (
        !hasBareAliasTechnicalSubjectTail(
          remainingWords,
          candidate.words.length,
        ) || hasRestrictiveTail
      )
    })
    if (!alias) continue
    matches.push({
      licenseId: alias.licenseId,
      end: index + alias.words.length,
    })
    index += alias.words.length - 1
  }
  return { words, matches }
}

function spdxLikeDeclarationReferenceKey(
  token: string,
  knownIds: Set<string>,
): string {
  const lowercaseToken = token.toLowerCase()
  for (const knownId of knownIds) {
    if (knownId.toLowerCase() === lowercaseToken) return knownId
  }
  return lowercaseToken
}

function hasMultipleSpdxLikeDeclarationReferences(
  input: string,
  knownIds: Set<string>,
  aliases: HeaderAlias[],
): boolean {
  const referenceKeys = new Set<string>()
  for (const line of input.split(/\r\n?|\n/)) {
    // Accumulate across declaration lines; any mixed references disable fallback.
    const value = spdxDeclarationLineDeclaredValue(line)
    if (!value) continue
    for (const token of value.match(/[A-Za-z0-9.+:-]+/g) || []) {
      if (isSpdxLikeIdToken(token, knownIds)) {
        referenceKeys.add(spdxLikeDeclarationReferenceKey(token, knownIds))
      }
    }
    for (const match of declarationHeaderAliasMatches(value, aliases).matches) {
      referenceKeys.add(match.licenseId)
    }
    if (referenceKeys.size > 1) return true
  }
  return false
}

function restrictiveMalformedSpdxDeclarationTail(
  value: string,
): string | undefined {
  const semicolonIndex = value.indexOf(';')
  if (semicolonIndex < 0) return undefined
  const tail = value.slice(semicolonIndex + 1).trim()
  if (
    /^licenseref (?:proprietary|closed source|confidential)$/.test(
      normalizeHeaderLoose(tail),
    )
  )
    return undefined
  if (tail && hasRestrictiveAnnotationText(tail)) return tail
  return undefined
}

function trailingRestrictiveParenthesizedAnnotation(
  value: string,
  aliases: HeaderAlias[],
  options: { allowShortHeaderAlias?: boolean } = {},
): string | undefined {
  const parenthesized = trailingBalancedParenthesizedAnnotation(value)
  if (!parenthesized) return undefined
  const { header, annotation } = parenthesized
  if (!header || !annotation || !hasRestrictiveAnnotationText(annotation))
    return undefined

  const words = aliasWords(header)
  const aliasStart = bareTitleLeadingArticles.has(words[0] || '') ? 1 : 0
  return aliases.some(
    (alias) =>
      alias.words.some((word) => word === 'license' || word === 'licence') &&
      matchesWordsAt(words, aliasStart, alias.words),
  ) ||
    (options.allowShortHeaderAlias &&
      aliases.some((alias) => matchesWordsAt(words, aliasStart, alias.words)))
    ? annotation
    : undefined
}

function malformedSpdxNamedHeaderRestrictiveTail(
  line: string,
  aliases: HeaderAlias[],
  options: { allowShortHeaderAlias?: boolean } = {},
): string | undefined {
  const marker = spdxIdentifierDeclarationLinePattern.exec(line)
  const hasWrapperBody = spdxDeclarationLineHasCommentWrapperBody(line)
  const hasWrapperDeclaration = Boolean(
    marker &&
    (marker[0].includes('<!--') || isBlockCommentSpdxMarker(marker[0])),
  )
  const value = hasWrapperBody
    ? spdxDeclarationLineDeclaredValue(line)
    : spdxDeclarationLineValue(line)
  if (!value) return undefined
  const semicolonTail = restrictiveMalformedSpdxDeclarationTail(value)
  if (semicolonTail) return semicolonTail
  const parenthesizedTail = trailingRestrictiveParenthesizedAnnotation(
    value,
    aliases,
    {
      allowShortHeaderAlias:
        options.allowShortHeaderAlias || hasWrapperDeclaration,
    },
  )
  if (parenthesizedTail) return parenthesizedTail
  if (!isSafeMalformedSpdxHeaderValue(value)) return undefined

  const parenthesized = trailingParenthesizedAnnotation(value)
  const words = aliasWords(parenthesized?.header ?? value)
  const aliasStart = bareTitleLeadingArticles.has(words[0] || '') ? 1 : 0
  for (const alias of aliases) {
    if (!alias.words.some((word) => word === 'license' || word === 'licence'))
      continue
    if (!matchesWordsAt(words, aliasStart, alias.words)) continue
    const tailStart = aliasStart + alias.words.length
    const tail = parenthesized
      ? parenthesized.annotation
      : words.slice(tailStart).join(' ')
    const tailWords = parenthesized ? aliasWords(tail) : words
    const tailIndex = parenthesized ? 0 : tailStart
    if (
      tail &&
      (hasRestrictiveAnnotationText(tail) ||
        hasRestrictiveLicenseTail(tailWords, tailIndex))
    )
      return tail
  }
  if (hasWrapperBody) {
    const wrapperTail = parenthesized?.annotation ?? value
    if (hasRestrictiveAnnotationText(wrapperTail)) return wrapperTail
  }
  if (!parenthesized && hasRestrictiveTailSegment(value)) return value
  return undefined
}

function hasMalformedSpdxNamedHeaderRestrictiveTail(
  input: string,
  aliases: HeaderAlias[],
): boolean {
  const lines = input.split(/\r\n?|\n/)
  const hasBodyOutsideSpdxDeclarations = lines.some(
    (line) =>
      line.trim() !== '' &&
      !isStandaloneSpdxCommentWrapperLine(line) &&
      !spdxIdentifierDeclarationLinePattern.test(line),
  )
  return lines.some((line) =>
    Boolean(
      malformedSpdxNamedHeaderRestrictiveTail(line, aliases, {
        allowShortHeaderAlias: hasBodyOutsideSpdxDeclarations,
      }),
    ),
  )
}

function isMalformedSpdxNamedHeaderLine(
  line: string,
  knownIds: Set<string>,
): boolean {
  if (spdxDeclarationLineHasCommentWrapperBody(line)) return false
  const value = spdxDeclarationLineValue(line)
  if (!value) return false
  return (
    isSafeMalformedSpdxHeaderValue(value) &&
    isMalformedSpdxNamedHeaderValue(value, knownIds)
  )
}

type MalformedSpdxNamedHeaderInput = {
  text: string
  allowHeaderFallback: boolean
}

function malformedSpdxNamedHeaderInputs(
  input: string,
  knownIds: Set<string>,
  aliases: HeaderAlias[],
): MalformedSpdxNamedHeaderInput[] {
  const safeDeclarationValues = Array.from(
    new Set(
      spdxDeclarationLineValues(input).filter((value) =>
        isMalformedSpdxHeaderFallbackValue(value, aliases),
      ),
    ),
  )
  const safeDeclarationValueInputs =
    safeDeclarationValues.length === 1
      ? malformedSpdxHeaderValueVariants(
          safeDeclarationValues[0] || '',
          aliases,
        )
      : []
  const inputs = new Map<string, boolean>()
  const addInput = (text: string, allowHeaderFallback: boolean): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    inputs.set(trimmed, (inputs.get(trimmed) ?? false) || allowHeaderFallback)
  }
  const strippedBody = bodyWithoutSpdxLines(input, knownIds)
  if (!/^\([^()]*\)$/.test(strippedBody)) addInput(strippedBody, false)
  for (const value of safeDeclarationValueInputs) {
    addInput(value, isMalformedSpdxNamedHeaderValue(value, knownIds))
  }
  return Array.from(inputs, ([text, allowHeaderFallback]) => ({
    text,
    allowHeaderFallback,
  }))
}

function bodyWithoutBenignMalformedSpdxAnnotationLines(
  input: string,
  knownIds: Set<string>,
  aliases: HeaderAlias[],
): string {
  const lines = input.split(/\r\n?|\n/)
  const hasBodyOutsideSpdxDeclarations = lines.some(
    (line) =>
      line.trim() !== '' &&
      !isStandaloneSpdxCommentWrapperLine(line) &&
      !spdxIdentifierDeclarationLinePattern.test(line),
  )
  return lines
    .map((line) => {
      const restrictiveTail = malformedSpdxNamedHeaderRestrictiveTail(
        line,
        aliases,
        { allowShortHeaderAlias: hasBodyOutsideSpdxDeclarations },
      )
      if (restrictiveTail) return restrictiveTail
      if (isStandaloneSpdxCommentWrapperLine(line)) return ''
      return isBenignMalformedSpdxAnnotationLine(line, knownIds, aliases) ||
        isMalformedSpdxNamedHeaderLine(line, knownIds)
        ? ''
        : stripSpdxIdentifierFromLine(line, knownIds)
    })
    .join('\n')
    .trim()
}

function hasNonSpdxBodyLine(input: string): boolean {
  return input
    .split(/\r\n?|\n/)
    .some(
      (line) =>
        line.trim() !== '' &&
        !isStandaloneSpdxCommentWrapperLine(line) &&
        !spdxIdentifierDeclarationLinePattern.test(line),
    )
}

function hasOnlyEmptySpdxDeclarationLines(input: string): boolean {
  const lines = input.split(/\r\n?|\n/)
  let foundSpdxLine = false
  for (const line of lines) {
    const marker = spdxIdentifierDeclarationLinePattern.exec(line)
    if (!marker) continue
    foundSpdxLine = true
    if (spdxDeclarationLineValue(line)) return false
  }
  return foundSpdxLine
}

function hasOnlyBenignMalformedSpdxAnnotationLines(
  input: string,
  knownIds: Set<string>,
  aliases: HeaderAlias[],
): boolean {
  let foundSpdxLine = false
  for (const line of input.split(/\r\n?|\n/)) {
    const marker = spdxIdentifierDeclarationLinePattern.exec(line)
    if (!marker) continue
    foundSpdxLine = true
    if (!isBenignMalformedSpdxAnnotationLine(line, knownIds, aliases))
      return false
  }
  return foundSpdxLine
}

function supportedSpdxLineIds(
  input: string,
  knownIds: Set<string>,
): Set<string> {
  const canonicalIdByLowercase = canonicalKnownIdByLowercaseFor(knownIds)
  const ids = new Set<string>()
  for (const expression of spdxLineExpressions(input, knownIds)) {
    if (/(?:^|\s)(?:-->|\*\/)(?:\s|$)/.test(expression)) continue
    const tokenMatches = Array.from(expression.matchAll(/[A-Za-z0-9.+:-]+/g))
    const punctuatedListIds = supportedPunctuatedSpdxIdListIds(
      expression,
      knownIds,
    )
    const lowercaseOperatorIds = spdxLikeLowercaseOperatorBodyIds(
      expression,
      knownIds,
    )
    const tokens = hasValidSpdxExpressionShape(expression)
      ? tokenMatches.map((match) => match[0])
      : punctuatedListIds
        ? Array.from(punctuatedListIds)
        : lowercaseOperatorIds.length > 0
          ? lowercaseOperatorIds
          : tokenMatches[0]?.index === 0
            ? [tokenMatches[0][0]]
            : []
    for (const token of tokens) {
      if (!isSpdxExpressionIdToken(token)) continue
      const id = canonicalIdByLowercase.get(token.toLowerCase())
      if (id) {
        ids.add(id)
        continue
      }
      const legacyCandidates = legacyAliasCandidatesByLowercase.get(
        token.toLowerCase(),
      )
      if (legacyCandidates) {
        for (const candidate of legacyCandidates) {
          if (knownIds.has(candidate)) ids.add(candidate)
        }
      }
    }
  }
  return ids
}

function hasMalformedSpdxPunctuationIdList(
  input: string,
  knownIds: Set<string>,
): boolean {
  for (const expression of spdxLineExpressions(input, knownIds)) {
    const ids = supportedPunctuatedSpdxIdListIds(expression, knownIds)
    if (ids && ids.size > 1) return true
  }
  return false
}

function supportedPunctuatedSpdxIdListIds(
  expression: string,
  knownIds: Set<string>,
): Set<string> | undefined {
  if (
    !/^[A-Za-z0-9.+:-]+(?:\s*[,;/]\s*[A-Za-z0-9.+:-]+)+$/.test(
      expression.trim(),
    )
  )
    return undefined
  const canonicalIdByLowercase = canonicalKnownIdByLowercaseFor(knownIds)
  const ids = new Set<string>()
  const rawIds = new Set<string>()
  for (const match of expression.matchAll(/[A-Za-z0-9.+:-]+/g)) {
    const token = match[0].toLowerCase()
    const id = canonicalIdByLowercase.get(token)
    if (id) {
      ids.add(id)
      rawIds.add(id.toLowerCase())
      continue
    }
    const legacyCandidates = legacyAliasCandidatesByLowercase.get(token)
    if (legacyCandidates) {
      rawIds.add(token)
      for (const candidate of legacyCandidates) {
        if (knownIds.has(candidate)) ids.add(candidate)
      }
    }
  }
  return rawIds.size > 1 && ids.size > 1 ? ids : undefined
}

function hasThirdPartyRestrictiveScopeBody(input: string): boolean {
  const loose = normalizeHeaderLoose(input)
  for (const match of loose.matchAll(thirdPartyRestrictiveScopeAnchorPattern)) {
    let index = (match.index ?? 0) + match[0].length
    for (
      let skippedTokens = 0;
      skippedTokens <= maxThirdPartyRestrictiveScopeSkippedTokens;
      skippedTokens += 1
    ) {
      if (thirdPartyRestrictiveScopePhraseFollows(loose, index)) return true
      if (skippedTokens === maxThirdPartyRestrictiveScopeSkippedTokens) break
      const nextIndex = thirdPartyScopeTokenEnd(loose, index)
      if (nextIndex === undefined) break
      index = nextIndex
    }
  }
  return false
}

function thirdPartyRestrictiveScopePhraseFollows(
  loose: string,
  index: number,
): boolean {
  if (loose[index] !== ' ') return false
  return thirdPartyRestrictiveScopePhrasePattern.test(
    loose.slice(index + 1, index + 80),
  )
}

function thirdPartyScopeTokenEnd(
  loose: string,
  index: number,
): number | undefined {
  if (loose[index] !== ' ') return undefined
  const start = index + 1
  if (
    thirdPartyScopeTokenStartsWith(loose, start, 'this') ||
    thirdPartyScopeTokenStartsWith(loose, start, 'the') ||
    thirdPartyScopeTokenStartsWith(loose, start, 'our')
  )
    return undefined
  let end = start
  while (
    end < loose.length &&
    isThirdPartyScopeTokenChar(loose.charCodeAt(end))
  )
    end += 1
  return end > start ? end : undefined
}

function thirdPartyScopeTokenStartsWith(
  loose: string,
  start: number,
  token: string,
): boolean {
  return (
    loose.startsWith(token, start) &&
    !isThirdPartyScopeTokenChar(loose.charCodeAt(start + token.length))
  )
}

function isThirdPartyScopeTokenChar(codeUnit: number): boolean {
  return (
    (codeUnit >= 48 && codeUnit <= 57) ||
    (codeUnit >= 97 && codeUnit <= 122) ||
    codeUnit === 60 ||
    codeUnit === 62
  )
}

function conflictingSpdxBodyResults(
  input: string,
  spdxIds: Set<string>,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
  knownIds: Set<string>,
  options: { body?: string } = {},
): MatchResult[] {
  const fullBody = options.body ?? bodyWithoutSpdxLines(input, knownIds)
  if (!fullBody) return []
  const thirdPartySplit = splitBeforeThirdPartyFullLicenseBody(
    fullBody,
    licenses,
  )
  const body = thirdPartySplit ? thirdPartySplit.projectBody : fullBody
  const hasRestrictiveThirdPartyBody = thirdPartySplit
    ? hasRestrictiveThirdPartyFullLicenseBody(
        thirdPartySplit.thirdPartyBody,
        licenses,
      )
    : false
  if (!body && !hasRestrictiveThirdPartyBody) return []

  const bodyGnuNotice = detectGnuNotice(body || fullBody)
  const bodyGnuContext: GnuReviewContext = {
    notice: bodyGnuNotice,
    inputOrLater: hasOrLaterWording(bodyGnuNotice),
  }
  const isDeclaredAmbiguousGnuCounterpart = (result: MatchResult): boolean => {
    const counterpart = gnuCounterparts.get(result.licenseId)
    const parsed = parseGnuLicenseId(result.licenseId)
    const explicitGrantKind = explicitGnuGrantKind(bodyGnuContext)
    if (
      parsed &&
      explicitGrantKind &&
      result.licenseId.endsWith('-' + explicitGrantKind)
    ) {
      return false
    }
    return Boolean(counterpart && spdxIds.has(counterpart) && parsed)
  }
  const conflictsWithDeclaredSpdx = (result: MatchResult): boolean =>
    !spdxIds.has(result.licenseId) && !isDeclaredAmbiguousGnuCounterpart(result)
  const namedConflictingMatches = hasSpdxIdToken(body.trim(), knownIds)
    ? []
    : namedHeaderResults(
        body,
        licenses,
        licenseById,
        'license-header',
        bodyGnuContext,
      ).filter(conflictsWithDeclaredSpdx)
  if (namedConflictingMatches.length > 0) {
    return namedConflictingMatches.slice(0, 5)
  }

  const hasRestrictiveSupportedBody =
    hasRestrictiveThirdPartyBody ||
    hasSupportedBodyTextWithRestrictiveTail(body, licenses) ||
    hasSupportedNormalizedBodyWithRestrictiveTail(body, licenses) ||
    hasThirdPartyRestrictiveScopeBody(body)

  const ranked = sortResults(
    markGnuAmbiguity(
      licenses.map((entry) =>
        resultFromEntry(entry, body, 'mixed-license-text', bodyGnuContext),
      ),
      bodyGnuContext,
    ),
  )

  const conflictingMatches = ranked.filter(
    (result) =>
      result.confidence !== 'Unknown' &&
      (result.score.recall >= 0.98 || result.score.f1 >= 0.9) &&
      conflictsWithDeclaredSpdx(result),
  )

  const rankedConflictResults = (matches: MatchResult[]): MatchResult[] => {
    const conflictingIds = new Set(matches.map((result) => result.licenseId))
    return [
      ...matches,
      ...ranked.filter(
        (result) =>
          !conflictingIds.has(result.licenseId) &&
          result.confidence !== 'Unknown' &&
          !spdxIds.has(result.licenseId) &&
          !isDeclaredAmbiguousGnuCounterpart(result),
      ),
    ].slice(0, 5)
  }

  const exactConflictingMatches = conflictingMatches.filter(
    (result) => result.confidence === 'Exact',
  )
  if (exactConflictingMatches.length > 0) {
    return rankedConflictResults(exactConflictingMatches)
  }

  const carriedSubjectStarts = [
    ['it', 'is'],
    ['it', 'was'],
    ['it', 'has'],
    ['this', 'is'],
    ['this', 'was'],
    ['this', 'has'],
    ['that', 'is'],
    ['that', 'was'],
    ['that', 'has'],
    ['they', 'are'],
    ['they', 'were'],
    ['they', 'have'],
  ]
  const currentProjectSegmentStarts = [
    ['this', 'project'],
    ['the', 'project'],
    ['this', 'software'],
    ['the', 'software'],
    ['this', 'package'],
    ['the', 'package'],
    ['this', 'code'],
    ['the', 'code'],
    ['this', 'repository'],
    ['the', 'repository'],
  ]
  const namedSegmentConflictingMatches = deduplicateBestResultsByLicenseId(
    splitBodySegments(body)
      .flatMap((segment) => {
        const segmentWords = aliasWords(segment)
        if (
          carriedSubjectStarts.some((startWords) =>
            matchesWordsAt(segmentWords, 0, startWords),
          ) ||
          (hasRestrictiveSupportedBody &&
            currentProjectSegmentStarts.some((startWords) =>
              matchesWordsAt(segmentWords, 0, startWords),
            ))
        ) {
          return []
        }
        return namedHeaderResults(
          segment,
          licenses,
          licenseById,
          'unknown',
          bodyGnuContext,
        )
      })
      .filter(conflictsWithDeclaredSpdx),
  )
  if (namedSegmentConflictingMatches.length > 0) {
    return namedSegmentConflictingMatches.slice(0, 5)
  }

  if (hasRestrictiveSupportedBody || conflictingMatches.length === 0) return []

  return rankedConflictResults(conflictingMatches)
}

function spdxConflictDiffBody(
  input: string,
  licenses: LicenseEntry[],
  knownIds: Set<string>,
  options: { body?: string } = {},
): string {
  const fullBody = options.body ?? bodyWithoutSpdxLines(input, knownIds)
  const thirdPartySplit = splitBeforeThirdPartyFullLicenseBody(
    fullBody,
    licenses,
  )
  return thirdPartySplit?.projectBody || fullBody || input
}

function spdxConflictResultsWithDiffDetails(
  input: string,
  results: MatchResult[],
  licenses: LicenseEntry[],
  knownIds: Set<string>,
  includeDiffs: boolean,
  options: { body?: string } = {},
): MatchResult[] {
  const diffInput = spdxConflictDiffBody(input, licenses, knownIds, options)
  const resultsWithDiffInput = attachDiffInput(results, diffInput)
  return resultsWithDiffDetails(
    diffInput,
    resultsWithDiffInput,
    licenses,
    includeDiffs,
  )
}

function leadingBareSpdxDeclaration(
  input: string,
  knownIds: Set<string>,
):
  | {
      body: string
      expression: string
      ids: Set<string>
      legacyAlias?: LegacyAlias
    }
  | undefined {
  const lines = input.split(/\r\n?|\n/)
  const firstContentIndex = lines.findIndex((line) => line.trim())
  if (firstContentIndex < 0) return undefined

  const firstLine = lines[firstContentIndex].trim()
  if (spdxIdentifierDeclarationLinePattern.test(firstLine)) return undefined

  const detection = detectSpdxIdentifier(firstLine, knownIds)
  if (
    !detection ||
    detection.expression !== firstLine ||
    detection.unsupportedIds.length > 0 ||
    detection.hasCompoundExpression ||
    detection.hasWithException
  ) {
    return undefined
  }

  const body = lines
    .slice(firstContentIndex + 1)
    .join('\n')
    .trim()
  if (!body) return undefined

  return {
    body,
    expression: detection.expression,
    ids: new Set(detection.ids),
    legacyAlias: detection.legacyAlias,
  }
}

function bodyWithoutLicenseLabelLines(
  input: string,
  licenseAliasWords?: string[][],
  options: {
    skipPrefixedStandaloneLabelValues?: boolean
  } = {},
): string {
  const bodyLines: string[] = []
  let skipStandaloneLabelValue = false
  const lines = input.split(/\r\n?|\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const loose = normalizeHeaderLoose(line)
    if (skipStandaloneLabelValue) {
      if (loose) skipStandaloneLabelValue = false
      continue
    }
    const standaloneLabelMatch =
      normalizedStandaloneLicenseLabelWithPrefixPattern.exec(loose)
    if (
      standaloneLabelMatch &&
      (!standaloneLabelMatch[1] || options.skipPrefixedStandaloneLabelValues)
    ) {
      const nextValueIndex = nextNonEmptyLineIndex(lines, index)
      const nextValueWords =
        nextValueIndex > index ? aliasWords(lines[nextValueIndex]) : []
      if (
        !licenseAliasWords ||
        hasCleanHeaderAlias(nextValueWords, licenseAliasWords)
      ) {
        skipStandaloneLabelValue = true
        continue
      }
    }
    const inlineLabelMatch = normalizedInlineLicenseLabelPattern.exec(loose)
    if (inlineLabelMatch) {
      const labelWords = wordsAfterHeaderMatch(
        loose,
        inlineLabelMatch[0].length,
      )
      if (
        !licenseAliasWords ||
        hasCleanHeaderAlias(labelWords, licenseAliasWords)
      )
        continue
    }
    bodyLines.push(line)
  }

  return bodyLines.join('\n').trim()
}

function hasCurrentLicenseLabelDeclaration(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const labelMatch = licenseLabelLineMatch(input, licenseAliasWords, aliases, {
    ignoreDisqualification: true,
  })
  return Boolean(
    labelMatch && isActiveLicenseLabelMatch(labelMatch, licenseAliasWords),
  )
}

function isActiveLicenseLabelMatch(
  labelMatch: NonNullable<ReturnType<typeof licenseLabelLineMatch>>,
  licenseAliasWords: string[][],
): boolean {
  return Boolean(
    labelMatch.licenseIds?.length &&
    (labelMatch.current ||
      (!hasHistoricalLicenseLabelContext(labelMatch.context) &&
        !hasThirdPartyLicenseLabelContext(labelMatch.context) &&
        !hasScopedAwayLicenseLabelContext(labelMatch.context))) &&
    !hasScopedAwayLicenseLabelSuffix(labelMatch.suffix) &&
    !hasRestrictiveLicenseLabelSuffix(labelMatch.context) &&
    !hasRestrictiveLicenseLabelSuffix(labelMatch.suffix) &&
    !hasNegatedLicenseLabelSuffix(
      labelMatch.context,
      labelMatch.words,
      licenseAliasWords,
    ) &&
    !hasNegatedProjectLicenseLabelSuffix(labelMatch.context) &&
    !hasNegatedLicenseLabelSuffix(
      labelMatch.suffix,
      labelMatch.words,
      licenseAliasWords,
    ) &&
    !hasNegatedProjectLicenseLabelSuffix(labelMatch.suffix),
  )
}

function declaredLicenseLabelIds(
  input: string,
  licenses: LicenseEntry[],
): Set<string> {
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const labelMatch = licenseLabelLineMatch(input, licenseAliasWords, aliases, {
    ignoreDisqualification: true,
  })
  if (
    !labelMatch ||
    !isActiveLicenseLabelMatch(labelMatch, licenseAliasWords)
  ) {
    return new Set()
  }
  return new Set(labelMatch.licenseIds || [])
}

function hasConflictingLicenseLabelDeclarations(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  return Boolean(
    licenseLabelLineMatch(input, licenseAliasWords, aliases, {
      detectConflicts: true,
      ignoreDisqualification: true,
    })?.conflicting,
  )
}

function hasScopedAwayLicenseLabelDeclaration(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const labelMatch = licenseLabelLineMatch(input, licenseAliasWords, aliases, {
    ignoreDisqualification: true,
  })
  return Boolean(
    labelMatch?.licenseIds?.length &&
    (hasThirdPartyLicenseLabelContext(labelMatch.context) ||
      hasScopedAwayLicenseLabelContext(labelMatch.context) ||
      hasScopedAwayLicenseLabelSuffix(labelMatch.suffix)),
  )
}

function hasNegatedLicenseLabelDeclaration(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const labelMatch = licenseLabelLineMatch(input, licenseAliasWords, aliases, {
    ignoreDisqualification: true,
  })
  return Boolean(
    labelMatch?.licenseIds?.length &&
    (hasNegatedLicenseLabelSuffix(
      labelMatch.context,
      labelMatch.words,
      licenseAliasWords,
    ) ||
      hasNegatedProjectLicenseLabelSuffix(labelMatch.context) ||
      hasNegatedLicenseLabelSuffix(
        labelMatch.suffix,
        labelMatch.words,
        licenseAliasWords,
      ) ||
      hasNegatedProjectLicenseLabelSuffix(labelMatch.suffix)),
  )
}

function hasRestrictiveLicenseLabelDeclaration(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const labelMatch = licenseLabelLineMatch(input, licenseAliasWords, aliases, {
    ignoreDisqualification: true,
  })
  const hasRestrictiveNamedLabel = labelMatch
    ? matchesRestrictiveNamedBody(
        labelMatch.words,
        aliases,
        licenseAliasWords,
        true,
      )
    : false
  return Boolean(
    labelMatch &&
    !hasHistoricalLicenseLabelContext(labelMatch.context) &&
    !hasThirdPartyLicenseLabelContext(labelMatch.context) &&
    !hasScopedAwayLicenseLabelContext(labelMatch.context) &&
    !hasScopedAwayLicenseLabelSuffix(labelMatch.suffix) &&
    (hasRestrictiveNamedLabel ||
      (labelMatch.licenseIds?.length &&
        (hasRestrictiveLicenseLabelSuffix(labelMatch.context) ||
          hasRestrictiveLicenseLabelSuffix(labelMatch.suffix)))),
  )
}

function hasRestrictiveLicenseLabelBodyConflict(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const body = bodyWithoutLicenseLabelLines(
    input,
    getHeaderAliases(licenses).map((alias) => alias.words),
  )
  return Boolean(body && hasContainedSupportedFullLicenseBody(body, licenses))
}

function hasThirdPartyLicenseLabelFullBodyContext(
  body: string,
  licenses: LicenseEntry[],
): boolean {
  return hasThirdPartyLicenseLabelFullBodyContextForAliases(
    body,
    getHeaderAliases(licenses),
  )
}

function hasThirdPartyLicenseLabelFullBodyContextForAliases(
  body: string,
  aliases: HeaderAlias[],
): boolean {
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const aliasesByFirstWord = headerAliasesByFirstWord(aliases)
  const segments = bodyTextSegments(body)
  let hasLeadingThirdPartyContext = false

  for (const segment of segments) {
    const loose = normalizeHeaderLoose(segment)
    const segmentHasThirdPartyContext =
      hasThirdPartyLicenseLabelContext(segment) ||
      hasThirdPartyHeaderContext(loose) ||
      hasThirdPartyBodyContextSegment(segment) ||
      isThirdPartyOwnedHeaderContext(loose)
    const hasLicenseAlias = hasLicenseAliasInWords(
      aliasWords(segment),
      aliasesByFirstWord,
    )
    if (hasLicenseAlias) {
      if (hasProjectLicenseHeaderContext(segment, licenseAliasWords)) {
        return false
      }
      return hasLeadingThirdPartyContext || segmentHasThirdPartyContext
    }

    if (
      !hasLeadingThirdPartyContext &&
      !segmentHasThirdPartyContext &&
      hasProjectHeaderContext(loose)
    )
      return false
    hasLeadingThirdPartyContext =
      hasLeadingThirdPartyContext || segmentHasThirdPartyContext
  }

  return false
}

function hasThirdPartyLicenseLabelSentenceContext(
  body: string,
  aliases: HeaderAlias[],
): boolean {
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const aliasesByFirstWord = headerAliasesByFirstWord(aliases)
  let hasLeadingThirdPartyContext = false

  for (const segment of splitBodySegments(body)) {
    const loose = normalizeHeaderLoose(segment)
    const segmentHasThirdPartyContext =
      hasThirdPartyLicenseLabelContext(segment) ||
      hasThirdPartyHeaderContext(loose) ||
      isThirdPartyOwnedHeaderContext(loose)
    const hasLicenseAlias = hasLicenseAliasInWords(
      aliasWords(segment),
      aliasesByFirstWord,
    )

    if (hasLicenseAlias) {
      const carriesThirdPartyContext =
        segmentHasThirdPartyContext ||
        (hasLeadingThirdPartyContext &&
          (hasExplicitThirdPartyReferenceContext(loose) ||
            /^(?:it|they|this|that|these|those|the (?:dependency|component|module|library|package|parser|tool|helper|plugin|extension|asset|font)) (?:continues to be|continue to be|is still|are still|is|are|was|were|has been|have been|remains|remain)(?: now| currently| presently)? (?:licensed|released|distributed|provided) under\b/.test(
              loose,
            )))
      if (carriesThirdPartyContext) return true
      if (hasProjectLicenseHeaderContext(segment, licenseAliasWords)) {
        return false
      }
      return false
    }

    if (
      !hasLeadingThirdPartyContext &&
      !segmentHasThirdPartyContext &&
      hasProjectHeaderContext(loose)
    )
      return false
    hasLeadingThirdPartyContext =
      hasLeadingThirdPartyContext || segmentHasThirdPartyContext
  }

  return false
}

function hasLeadingThirdPartyLicenseLabelBodyContext(body: string): boolean {
  const loose = normalizeHeaderLoose(body)
  if (
    /^(?:third party|third-party|vendored(?: code)?|bundled(?: code)?|embedded(?: code)?|included third party(?: code)?)(?: licen[cs]es?| notices?| metadata)?(?: |$)/.test(
      loose,
    )
  )
    return true
  const firstSegment = bodyTextSegments(body)[0]
  return firstSegment ? hasThirdPartyLicenseLabelContext(firstSegment) : false
}

function hasThirdPartyFullLicenseBodyAfterContext(
  body: string,
  licenses: LicenseEntry[],
): boolean {
  const segments = bodyTextSegments(body)
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const loose = normalizeHeaderLoose(segment)
    if (
      !hasThirdPartyLicenseLabelContext(loose) &&
      !hasThirdPartyHeaderContext(loose) &&
      !isThirdPartyOwnedHeaderContext(loose)
    )
      continue

    const tail = segments.slice(index + 1).join('\n\n')
    return Boolean(tail) && hasContainedSupportedFullLicenseBody(tail, licenses)
  }
  return false
}

function splitBeforeThirdPartyFullLicenseBody(
  body: string,
  licenses: LicenseEntry[],
): { projectBody: string; thirdPartyBody: string } | undefined {
  const segments = bodyTextSegments(body)
  const licenseAliasWords = getHeaderAliases(licenses).map(
    (alias) => alias.words,
  )
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const loose = normalizeHeaderLoose(segment)
    if (
      !hasThirdPartyLicenseLabelContext(loose) &&
      !hasThirdPartyHeaderContext(loose) &&
      !isThirdPartyOwnedHeaderContext(loose)
    )
      continue

    const nextProjectBoundaryIndex = segments.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        isCurrentLicenseSegmentBoundary(candidate, licenseAliasWords),
    )
    const thirdPartyEndIndex =
      nextProjectBoundaryIndex > index ? nextProjectBoundaryIndex : undefined
    const thirdPartyBody = segments
      .slice(index, thirdPartyEndIndex)
      .join('\n\n')
    if (!hasContainedSupportedFullLicenseBody(thirdPartyBody, licenses))
      continue

    const projectSegments = segments.slice(0, index)
    if (thirdPartyEndIndex !== undefined) {
      projectSegments.push(...segments.slice(thirdPartyEndIndex))
    }

    return {
      projectBody: projectSegments.join('\n\n').trim(),
      thirdPartyBody,
    }
  }
  return undefined
}

function hasRestrictiveThirdPartyFullLicenseBody(
  body: string,
  licenses: LicenseEntry[],
): boolean {
  return (
    hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
      body,
      licenses,
    ) ||
    hasRestrictiveTailAfterContainedSupportedFullLicenseBody(
      body,
      licenses,
      true,
    )
  )
}

function hasContainedSupportedFullLicenseBody(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const inputWordCount = aliasWords(input).length
  if (!mayContainSupportedFullLicenseBody(input, licenses, inputWordCount))
    return false
  if (licenses.some((entry) => input.includes(entry.text))) return true
  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  return licenses.some((entry) =>
    hasSupportedFullLicenseBodyMatch(
      input,
      entry,
      fullLicensePrefixBudget(totalBudget),
      inputWordCount,
    ),
  )
}

function licenseEntryWords(entry: LicenseEntry): string[] {
  let words = licenseWordCache.get(entry)
  if (!words) {
    words = aliasWords(entry.text)
    licenseWordCache.set(entry, words)
  }
  return words
}

function fullLicensePrefixBudget(
  totalBudget?: FullLicensePrefixTotalBudget,
): FullLicensePrefixBudget {
  return { anchorChecks: 0, totalBudget }
}

function licenseLines(entry: LicenseEntry): string[] {
  let lines = licenseLineCache.get(entry)
  if (!lines) {
    lines = entry.text.split(/\r\n?|\n/).filter((line) => line.trim())
    licenseLineCache.set(entry, lines)
  }
  return lines
}

function lineStartIndexes(input: string): number[] {
  const starts = [0]
  for (const match of input.matchAll(/\r\n?|\n/g)) {
    const index = match.index
    if (index !== undefined) starts.push(index + match[0].length)
  }
  return starts
}

function minLicenseWordCount(licenses: LicenseEntry[]): number {
  const cached = minLicenseWordCountCache.get(licenses)
  if (cached !== undefined) return cached

  const minCount = licenses.reduce(
    (min, entry) => Math.min(min, licenseEntryWords(entry).length),
    Number.POSITIVE_INFINITY,
  )
  const count = Number.isFinite(minCount) ? minCount : 0
  minLicenseWordCountCache.set(licenses, count)
  return count
}

function normalizedLicenseTexts(licenses: LicenseEntry[]): string[] {
  let texts = normalizedLicenseTextCache.get(licenses)
  if (!texts) {
    texts = licenses.map((entry) => normalizeStrict(entry.text))
    normalizedLicenseTextCache.set(licenses, texts)
  }
  return texts
}

function mayContainSupportedFullLicenseBody(
  input: string,
  licenses: LicenseEntry[],
  inputWordCount = aliasWords(input).length,
): boolean {
  return inputWordCount >= minLicenseWordCount(licenses)
}

function containedSupportedFullLicenseBounds(
  input: string,
  licenses: LicenseEntry[],
): { end: number; entry: LicenseEntry; start: number } | undefined {
  const normalizedInput = normalizeStrict(input)
  const normalizedLicenses = normalizedLicenseTexts(licenses)
  let earliestBounds:
    | { end: number; entry: LicenseEntry; start: number }
    | undefined

  for (const [index, normalizedLicenseText] of normalizedLicenses.entries()) {
    const start = normalizedInput.indexOf(normalizedLicenseText)
    if (start < 0) continue
    const bounds = {
      start,
      end: start + normalizedLicenseText.length,
      entry: licenses[index],
    }
    if (
      !earliestBounds ||
      start < earliestBounds.start ||
      (start === earliestBounds.start && bounds.end > earliestBounds.end)
    ) {
      earliestBounds = bounds
    }
  }

  return earliestBounds
}

function licenseAnchorWordIndex(
  licenseWords: string[],
  anchorWords: string[],
): number | undefined {
  for (
    let index = 0;
    index <= licenseWords.length - anchorWords.length;
    index += 1
  ) {
    if (matchesWordsAt(licenseWords, index, anchorWords)) return index
  }
  return undefined
}

function containedFullLicenseCandidateStart(
  input: string,
  anchorStart: number,
  lineStarts: number[],
  licenseWords: string[],
  licenseIndex: number,
  budget: FullLicensePrefixBudget,
): number | undefined {
  if (licenseIndex === 0) return anchorStart

  const maxPrefixWords = licenseIndex + 256
  const maxCandidateStarts = 16
  let checkedStarts = 0
  for (let index = lineStarts.length - 1; index >= 0; index -= 1) {
    const start = lineStarts[index]
    if (start > anchorStart) continue
    if (start === anchorStart) continue
    const prefixWords = aliasWords(input.slice(start, anchorStart))
    if (prefixWords.length > maxPrefixWords) break
    const matchedLength = matchFullLicensePrefixWords(
      prefixWords,
      licenseWords,
      0,
      0,
      budget,
      licenseIndex,
    )
    if (matchedLength === prefixWords.length) return start
    checkedStarts += 1
    if (checkedStarts >= maxCandidateStarts) break
  }
  return undefined
}

function containedSupportedFullLicenseAnchor(
  input: string,
  entry: LicenseEntry,
  budget: FullLicensePrefixBudget,
  lineStarts = lineStartIndexes(input),
): { start: number; tailSegments: string[] } | undefined {
  const exactStart = input.indexOf(entry.text)
  if (exactStart >= 0) {
    const exactEnd = exactStart + entry.text.length
    return {
      start: exactStart,
      tailSegments: bodyTextSegments(input.slice(exactEnd)),
    }
  }

  const licenseWords = licenseEntryWords(entry)
  const lines = licenseLines(entry)
  for (const line of lines) {
    const anchorWords = aliasWords(line)
    const licenseIndex = licenseAnchorWordIndex(licenseWords, anchorWords)
    if (licenseIndex === undefined) continue

    let anchorOccurrences = 0
    let anchorStart = input.indexOf(line)
    while (
      anchorStart >= 0 &&
      anchorOccurrences < maxFullLicensePrefixAnchorOccurrences
    ) {
      anchorOccurrences += 1
      const candidateStart = containedFullLicenseCandidateStart(
        input,
        anchorStart,
        lineStarts,
        licenseWords,
        licenseIndex,
        budget,
      )
      if (candidateStart !== undefined) {
        const body = input.slice(anchorStart)
        const bodyForMatch = body.slice(0, maxFullLicensePrefixBodyCharacters)
        const bodyWords = aliasWords(bodyForMatch)
        if (bodyWords.length > maxFullLicensePrefixBodyWords) {
          anchorStart = input.indexOf(line, anchorStart + line.length)
          continue
        }
        const prefixLength = matchFullLicensePrefixWords(
          bodyWords,
          licenseWords,
          0,
          licenseIndex,
          budget,
        )
        if (prefixLength !== undefined) {
          return {
            start: candidateStart,
            tailSegments: bodyTextSegmentsAfterWordPrefix(body, prefixLength),
          }
        }
      }

      anchorStart = input.indexOf(line, anchorStart + line.length)
    }
  }

  return undefined
}

function hasSupportedFullLicenseBodyMatch(
  input: string,
  entry: LicenseEntry,
  budget: FullLicensePrefixBudget,
  inputWordCount = aliasWords(input).length,
): boolean {
  if (input.includes(entry.text)) return true
  if (inputWordCount < licenseEntryWords(entry).length * 0.9) return false

  const score = scoreText(input, entry.text)
  return (
    (score.recall >= 0.98 && score.precision > 0) ||
    Boolean(containedSupportedFullLicenseAnchor(input, entry, budget))
  )
}

function hasHighScoringSupportedFullLicenseRestrictiveContext(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  return licenses.some((entry) => {
    const score = scoreText(input, entry.text)
    if (score.f1 < 0.9 || score.precision < 0.82 || score.recall < 0.9) {
      return false
    }

    const normalizedLicenseText = normalizeStrict(entry.text)
    const contextSegments = bodyTextSegments(input).filter((segment) => {
      const normalizedSegment = normalizeStrict(segment)
      return (
        normalizedSegment !== '' &&
        !normalizedLicenseText.includes(normalizedSegment)
      )
    })
    return hasProjectRestrictiveBodySegments(contextSegments, licenses)
  })
}

function hasRestrictiveTailAfterContainedSupportedFullLicenseBody(
  input: string,
  licenses: LicenseEntry[],
  initialThirdPartyContext = false,
): boolean {
  if (!mayContainSupportedFullLicenseBody(input, licenses)) return false

  const bounds = containedSupportedFullLicenseBounds(input, licenses)
  if (bounds) {
    const tail = normalizeStrict(input).slice(bounds.end).trim()
    const rawTailSegments = tail ? bodyTextSegments(tail) : []
    const tailSegments = tail
      ? (supportedLicenseBodyTailSegments(rawTailSegments, licenses, {
          anchorChecks: 0,
        }) ?? rawTailSegments)
      : []
    if (
      tailSegments.length > 0 &&
      hasProjectRestrictiveBodySegments(
        tailSegments,
        licenses,
        initialThirdPartyContext,
      )
    )
      return true
  }

  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const aliasesByFirstWord = headerAliasesByFirstWord(aliases)
  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  const lineStarts = lineStartIndexes(input)
  for (const entry of licenses) {
    const containedBody = containedSupportedFullLicenseAnchor(
      input,
      entry,
      fullLicensePrefixBudget(totalBudget),
      lineStarts,
    )
    if (!containedBody) continue

    const tailSegments =
      supportedLicenseBodyTailSegments(
        containedBody.tailSegments,
        licenses,
        totalBudget,
      ) ?? containedBody.tailSegments

    if (
      hasProjectRestrictiveBodySegments(
        tailSegments,
        licenses,
        initialThirdPartyContext,
      )
    )
      return true
    if (
      hasRestrictiveFullBodyTailSegments(
        tailSegments,
        aliases,
        aliasesByFirstWord,
        licenseAliasWords,
        true,
        initialThirdPartyContext,
      )
    )
      return true
  }

  return false
}

function isPermissiveCopyrightNoticePrefix(prefix: string): boolean {
  const segments = bodyTextSegments(prefix)
    .map(normalizeHeaderLoose)
    .filter(Boolean)
  let previousCopyrightSegment: string | undefined
  for (const segment of segments) {
    if (isPermissiveCopyrightNoticeSegment(segment)) {
      previousCopyrightSegment = segment
      continue
    }
    if (
      /^all rights reserved\.?$/.test(segment) &&
      previousCopyrightSegment !== undefined &&
      !hasRestrictiveCopyrightNoticeSegment(
        `${previousCopyrightSegment} ${segment}`,
      )
    ) {
      continue
    }
    return false
  }
  return previousCopyrightSegment !== undefined
}

function isPermissiveRightsReservedCopyrightSegment(
  segments: string[],
  index: number,
): boolean {
  const segment = normalizeHeaderLoose(segments[index])
  if (!/^all rights reserved\.?$/.test(segment)) return false

  const previousSegment = segments[index - 1]
  if (previousSegment === undefined) return false

  const previous = normalizeHeaderLoose(previousSegment)
  return (
    isPermissiveCopyrightNoticeSegment(previous) &&
    !hasRestrictiveCopyrightNoticeSegment(previous + ' ' + segment)
  )
}

function hasRestrictiveCopyrightNoticePrefix(prefix: string): boolean {
  const segments = bodyTextSegments(prefix)
    .map(normalizeHeaderLoose)
    .filter(Boolean)
  let previousCopyrightSegment: string | undefined
  for (const [index, segment] of segments.entries()) {
    if (hasThirdPartyRestrictiveCopyrightNoticeContext(segments, index)) {
      previousCopyrightSegment = undefined
      continue
    }
    if (
      /\bcopyright\b/.test(segment) &&
      hasRestrictiveCopyrightNoticeSegment(segment)
    )
      return true
    if (
      /^all rights reserved\.?$/.test(segment) &&
      previousCopyrightSegment !== undefined &&
      hasRestrictiveCopyrightNoticeSegment(
        `${previousCopyrightSegment} ${segment}`,
      )
    ) {
      return true
    }
    previousCopyrightSegment = isPermissiveCopyrightNoticeSegment(segment)
      ? segment
      : undefined
  }
  return false
}

function isPermissiveCopyrightNoticeSegment(segment: string): boolean {
  if (hasRestrictiveCopyrightNoticeSegment(segment)) return false
  const withoutTrailingRights = segment
    .replace(/\ball rights reserved\.?$/, '')
    .trim()
  return /^copyright(?: <year>)?(?: [a-z0-9<>]+){0,128}$/.test(
    withoutTrailingRights,
  )
}

function hasRestrictiveCopyrightNoticeSegment(segment: string): boolean {
  const context = boundedHeaderContext(segment)
  const withoutTrailingRights = context
    .replace(/\ball rights reserved\.?$/, '')
    .trim()
  const restrictiveRightsReserved =
    hasRestrictiveRightsReservedPhrase(context) ||
    /\bnot for (?:redistribution|distribution|use|copying|modification)\b/.test(
      context,
    )
  const restrictiveScope =
    /\b(?:internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|commercial|noncommercial|non commercial|documentation|test|testing|trial|demo) (?:use|usage|distribution|redistribution) only\b/.test(
      context,
    ) ||
    /\b(?:use|usage|distribution|redistribution) (?:is |are |has been |have been )?(?:restricted|limited) (?:to|for|by)\b/.test(
      context,
    ) ||
    /\b(?:only|not) for (?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo) (?:use|usage|distribution|redistribution)\b/.test(
      context,
    )
  return (
    hasProjectOwnedRestrictiveLicenseLabelContext(context) ||
    hasRestrictiveLicenseLabelLine(withoutTrailingRights) ||
    hasProjectRestrictiveBodySegment(withoutTrailingRights, false) ||
    restrictiveRightsReserved ||
    restrictiveScope ||
    /\b(?:do not (?:copy|distribute|modify|redistribute|sell|sublicense|use|reverse engineer)|not permitted|all use prohibited)\b/.test(
      context,
    )
  )
}

function hasThirdPartyRestrictiveCopyrightNoticeContext(
  segments: string[],
  index: number,
): boolean {
  const context = normalizeHeaderLoose(
    segments.slice(Math.max(0, index - 1), index + 2).join(' '),
  )
  return (
    hasThirdPartyBodyContextSegment(context) ||
    /\b(?:bundled|vendored|external|included|third party|third-party)\b/.test(
      context,
    )
  )
}

function hasRestrictiveRightsReservedPhrase(text: string): boolean {
  const matches = text.matchAll(
    /\b(?:redistribution|distribution|use|copying|modification)\b(?: [a-z0-9]+){0,12}? (?:is |are |has been |have been )?(?:prohibited|forbidden|not permitted|not allowed)\b/g,
  )
  for (const match of matches) {
    const phrase = match[0]
    if (/\b(?:not permitted|not allowed)\b$/.test(phrase)) return true
    if (
      /\b(?:not(?: been)?|never) (?:prohibited|forbidden)(?: or (?:prohibited|forbidden))+\b$/.test(
        phrase,
      )
    )
      continue
    if (/\b(?:not(?: been)?|never) (?:prohibited|forbidden)\b$/.test(phrase))
      continue
    return true
  }
  return false
}

function hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const body = bodyWithoutSpdxLines(input)
  if (!mayContainSupportedFullLicenseBody(body, licenses)) return false

  let earliestStart: number | undefined
  let earliestEntry: LicenseEntry | undefined
  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  const lineStarts = lineStartIndexes(body)
  for (const entry of licenses) {
    const containedBody = containedSupportedFullLicenseAnchor(
      body,
      entry,
      fullLicensePrefixBudget(totalBudget),
      lineStarts,
    )
    if (!containedBody) continue
    const { start } = containedBody
    if (earliestStart === undefined || start < earliestStart) {
      earliestStart = start
      earliestEntry = entry
    }
  }
  if (earliestStart !== undefined) {
    const prefix = body.slice(0, earliestStart)
    return (
      (earliestEntry !== undefined &&
        hasNegatedProjectLicensePrefixForEntry(
          prefix,
          earliestEntry,
          licenses,
        )) ||
      hasRestrictiveCopyrightNoticePrefix(prefix) ||
      (!isPermissiveCopyrightNoticePrefix(prefix) &&
        hasProjectRestrictiveBodySegments(bodyTextSegments(prefix), licenses))
    )
  }

  if (hasHighScoringSupportedFullLicenseRestrictiveContext(body, licenses)) {
    return true
  }

  const bounds = containedSupportedFullLicenseBounds(body, licenses)
  if (!bounds) return false

  const prefix = normalizeStrict(body).slice(0, bounds.start).trim()
  return (
    Boolean(prefix) &&
    (hasNegatedProjectLicensePrefixForEntry(prefix, bounds.entry, licenses) ||
      hasRestrictiveCopyrightNoticePrefix(prefix) ||
      (!isPermissiveCopyrightNoticePrefix(prefix) &&
        hasProjectRestrictiveBodySegments(bodyTextSegments(prefix), licenses)))
  )
}

function hasProjectRestrictivePrefixBeforeExactSupportedFullLicenseBody(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const body = hasSpdxIdentifierDeclarationLine(input)
    ? bodyWithoutSpdxLines(input)
    : input.trim()
  if (!mayContainSupportedFullLicenseBody(body, licenses)) return false

  const bounds = containedSupportedFullLicenseBounds(body, licenses)
  if (!bounds || bounds.start === 0) return false

  const prefix = normalizeStrict(body).slice(0, bounds.start).trim()
  return (
    Boolean(prefix) &&
    (hasNegatedProjectLicensePrefixForEntry(prefix, bounds.entry, licenses) ||
      hasRestrictiveCopyrightNoticePrefix(prefix) ||
      (!isPermissiveCopyrightNoticePrefix(prefix) &&
        hasProjectRestrictiveBodySegments(bodyTextSegments(prefix), licenses)))
  )
}

function hasScopedAwayPrefixBeforeContainedSupportedFullLicenseBody(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const body = bodyWithoutSpdxLines(input)
  if (!mayContainSupportedFullLicenseBody(body, licenses)) return false

  const bounds = containedSupportedFullLicenseBounds(body, licenses)
  if (!bounds || bounds.start === 0) return false

  const prefix = normalizeHeaderLoose(
    normalizeStrict(body).slice(0, bounds.start),
  )
  return Boolean(prefix) && isScopedAwayLicenseHeaderContext(prefix)
}

function hasNegatedProjectLicensePrefixForEntry(
  prefix: string,
  entry: LicenseEntry,
  licenses: LicenseEntry[],
): boolean {
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  return aliases.some(
    (alias) =>
      alias.licenseId === entry.licenseId &&
      hasNegatedLicenseWordsInProjectText(
        prefix,
        alias.words,
        licenseAliasWords,
      ),
  )
}

function hasConflictingLicenseLabelFullBody(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const hasConflictingLabels = hasConflictingLicenseLabelDeclarations(
    input,
    licenses,
  )
  const labelIds = declaredLicenseLabelIds(input, licenses)
  if (labelIds.size === 0 && !hasConflictingLabels) return false

  const body = bodyWithoutLicenseLabelLines(
    input,
    getHeaderAliases(licenses).map((alias) => alias.words),
  )
  if (!body) return false
  const thirdPartySplit = splitBeforeThirdPartyFullLicenseBody(body, licenses)
  const projectBody = thirdPartySplit ? thirdPartySplit.projectBody : body
  const hasRestrictiveThirdPartyBody = thirdPartySplit
    ? hasRestrictiveThirdPartyFullLicenseBody(
        thirdPartySplit.thirdPartyBody,
        licenses,
      )
    : false
  const hasLeadingThirdPartyBody =
    hasLeadingThirdPartyLicenseLabelBodyContext(body)
  const hasRestrictiveContainedBody =
    hasRestrictiveThirdPartyBody ||
    hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
      projectBody,
      licenses,
    ) ||
    hasRestrictiveTailAfterContainedSupportedFullLicenseBody(
      projectBody,
      licenses,
      hasLeadingThirdPartyBody,
    )
  const declaredBodyMatchBudget: FullLicensePrefixTotalBudget = {
    anchorChecks: 0,
  }
  const projectBodyWordCount = aliasWords(projectBody).length
  const hasDeclaredBodyMatch = licenses.some(
    (entry) =>
      labelIds.has(entry.licenseId) &&
      hasSupportedFullLicenseBodyMatch(
        projectBody,
        entry,
        fullLicensePrefixBudget(declaredBodyMatchBudget),
        projectBodyWordCount,
      ),
  )
  const conflictingProjectBodyBudget: FullLicensePrefixTotalBudget = {
    anchorChecks: 0,
  }
  const hasConflictingProjectBody = licenses.some(
    (entry) =>
      !labelIds.has(entry.licenseId) &&
      hasSupportedFullLicenseBodyMatch(
        projectBody,
        entry,
        fullLicensePrefixBudget(conflictingProjectBodyBudget),
        projectBodyWordCount,
      ),
  )
  if (
    (hasLeadingThirdPartyBody &&
      hasContainedSupportedFullLicenseBody(body, licenses) &&
      !hasRestrictiveContainedBody &&
      !hasConflictingProjectBody) ||
    (hasThirdPartyLicenseLabelFullBodyContext(body, licenses) &&
      !hasRestrictiveContainedBody &&
      !hasConflictingProjectBody)
  )
    return false
  if (hasRestrictiveContainedBody) return true

  if (
    hasConflictingLabels &&
    hasContainedSupportedFullLicenseBody(body, licenses)
  )
    return true

  if (hasDeclaredBodyMatch) return false

  return hasConflictingProjectBody
}

function currentLicenseLabelResults(
  input: string,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
  gnuContext: GnuReviewContext,
): MatchResult[] {
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const labelMatch = licenseLabelLineMatch(input, licenseAliasWords, aliases, {
    ignoreDisqualification: true,
  })
  if (
    !labelMatch ||
    (!labelMatch.current &&
      (hasHistoricalLicenseLabelContext(labelMatch.context) ||
        hasThirdPartyLicenseLabelContext(labelMatch.context) ||
        hasScopedAwayLicenseLabelContext(labelMatch.context))) ||
    hasScopedAwayLicenseLabelSuffix(labelMatch.suffix) ||
    hasRestrictiveLicenseLabelSuffix(labelMatch.context) ||
    hasRestrictiveLicenseLabelSuffix(labelMatch.suffix) ||
    hasNegatedLicenseLabelSuffix(
      labelMatch.suffix,
      labelMatch.words,
      licenseAliasWords,
    ) ||
    hasNegatedProjectLicenseLabelSuffix(labelMatch.suffix)
  ) {
    return []
  }

  const labelGnuNotice = detectGnuNotice(labelMatch.words.join(' '))
  const labelGnuContext = labelGnuNotice
    ? {
        notice: labelGnuNotice,
        inputOrLater: hasOrLaterWording(labelGnuNotice),
      }
    : gnuContext
  const seenLicenseIds = new Set<string>()
  const results = aliases
    .filter(
      (alias) =>
        matchesHeaderAlias(
          labelMatch.words,
          alias.words,
          licenseAliasWords,
          alias.sameLicenseWords,
        ) &&
        !hasBareAliasTechnicalSubjectTail(labelMatch.words, alias.words.length),
    )
    .filter((alias) => {
      if (seenLicenseIds.has(alias.licenseId)) return false
      seenLicenseIds.add(alias.licenseId)
      return true
    })
    .map((alias) => ({ alias, entry: licenseById.get(alias.licenseId) }))
    .filter((match): match is { alias: HeaderAlias; entry: LicenseEntry } =>
      Boolean(match.entry),
    )
    .map(({ alias, entry }) =>
      resultFromNamedHeader(
        entry,
        disambiguatedGnuHeaderContext(labelMatch.words, alias, labelGnuContext),
        alias.legacyAlias,
      ),
    )
  return withGnuManualReviewCounterparts(results, labelGnuContext, licenseById)
}

function splitBodySegments(body: string): string[] {
  const segments: string[] = []
  // Keep punctuation with the previous sentence without relying on RegExp lookbehind.
  const separators = /[.!?;]\s+|\r\n?|\n/g
  let startIndex = 0
  for (const separator of body.matchAll(separators)) {
    const separatorIndex = separator.index
    if (separatorIndex === undefined) continue
    const separatorText = separator[0]
    const keepsPunctuation = /[.!?;]/.test(separatorText[0] || '')
    const segmentEnd = keepsPunctuation ? separatorIndex + 1 : separatorIndex
    const segment = body.slice(startIndex, segmentEnd).trim()
    if (segment) segments.push(segment)
    startIndex = separatorIndex + separatorText.length
  }
  const tail = body.slice(startIndex).trim()
  if (tail) segments.push(tail)
  return segments
}

function supportedSpdxBodyResults(
  input: string,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
  knownIds: Set<string>,
  aliases?: HeaderAlias[],
): MatchResult[] {
  const body = aliases
    ? bodyWithoutBenignMalformedSpdxAnnotationLines(input, knownIds, aliases)
    : bodyWithoutSpdxLines(input, knownIds)
  if (!body) return []
  if (
    (!aliases || !hasNonSpdxBodyLine(input)) &&
    isOnlySpdxLikeLicenseHeaderTail(body, knownIds)
  )
    return []

  const bodyInputType = classifyInput(body, knownIds)
  const bodyGnuNotice = detectGnuNotice(body)
  const bodyGnuContext: GnuReviewContext = {
    notice: bodyGnuNotice,
    inputOrLater: hasOrLaterWording(bodyGnuNotice),
  }
  const namedMatches = namedHeaderResults(
    body,
    licenses,
    licenseById,
    bodyInputType,
    bodyGnuContext,
  )
  if (namedMatches.length > 0) return namedMatches.slice(0, 5)

  const ranked = sortResults(
    markGnuAmbiguity(
      licenses.map((entry) =>
        resultFromEntry(entry, body, bodyInputType, bodyGnuContext),
      ),
      bodyGnuContext,
    ),
  )
  const exactFullText = ranked.some(
    (result) =>
      result.score.f1 >= 0.98 &&
      result.score.precision >= 0.98 &&
      result.score.recall >= 0.98,
  )
  const hasContainedFullLicense = ranked.some(
    (result) => result.score.recall >= 0.98 && result.score.precision > 0,
  )
  const effectiveInputType = exactFullText
    ? 'full-license-text'
    : hasContainedFullLicense
      ? 'mixed-license-text'
      : bodyInputType
  const effectiveRanked =
    effectiveInputType === bodyInputType
      ? ranked
      : sortResults(
          markGnuAmbiguity(
            licenses.map((entry) =>
              resultFromEntry(entry, body, effectiveInputType, bodyGnuContext),
            ),
            bodyGnuContext,
          ),
        )

  const supportedResults = effectiveRanked
    .filter(
      (result) =>
        result.confidence !== 'Unknown' &&
        (result.score.recall >= 0.98 ||
          result.score.f1 >= 0.9 ||
          (result.score.precision >= 0.82 && result.score.f1 >= 0.55)),
    )
    .slice(0, 5)
  return supportedResults
}

function supportedSpdxBodySegmentHeaderResults(
  body: string,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
  knownIds: Set<string>,
): MatchResult[] {
  if (
    hasThirdPartyLicenseLabelFullBodyContextForAliases(
      body,
      getHeaderAliases(licenses),
    ) ||
    hasThirdPartyLicenseLabelSentenceContext(body, getHeaderAliases(licenses))
  )
    return []

  const namedSegmentMatches = deduplicateBestResultsByLicenseId(
    splitBodySegments(body).flatMap((segment) => {
      const segmentInputType = classifyInput(segment, knownIds)
      const segmentGnuNotice = detectGnuNotice(segment)
      const segmentGnuContext: GnuReviewContext = {
        notice: segmentGnuNotice,
        inputOrLater: hasOrLaterWording(segmentGnuNotice),
      }
      return namedHeaderResults(
        segment,
        licenses,
        licenseById,
        segmentInputType,
        segmentGnuContext,
        { allowExactBareTitle: true },
      )
    }),
  )

  return namedSegmentMatches.slice(0, 5)
}

function declaredSpdxHeaderBodyIds(
  body: string,
  spdxIds: Set<string>,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
  knownIds: Set<string>,
): Set<string> {
  const bodyGnuNotice = detectGnuNotice(body)
  const bodyGnuContext: GnuReviewContext = {
    notice: bodyGnuNotice,
    inputOrLater: hasOrLaterWording(bodyGnuNotice),
  }
  const bodyVariants = [body]
  const bodyWithoutLeadingArticle = body.replace(/^\s*(?:the|a|an)\s+/i, '')
  if (bodyWithoutLeadingArticle !== body) {
    bodyVariants.push(bodyWithoutLeadingArticle)
  }

  const ids = new Set<string>()
  for (const bodyVariant of bodyVariants) {
    const bodyInputType = classifyInput(bodyVariant, knownIds)
    const headerInputType =
      bodyInputType === 'license-header' ? 'license-header' : 'unknown'
    for (const result of namedHeaderResults(
      bodyVariant,
      licenses,
      licenseById,
      headerInputType,
      bodyGnuContext,
      { allowExactBareTitle: true },
    )) {
      if (spdxIds.has(result.licenseId)) ids.add(result.licenseId)
    }
  }
  return ids
}

function markSpdxBodyResultsForReview(
  results: MatchResult[],
  reason: string,
): MatchResult[] {
  return results.map((result) =>
    result.confidence === 'Unknown'
      ? result
      : {
          ...result,
          confidence: 'Possible',
          flags: { ...result.flags, needsManualReview: true },
          explanation: `${reason}; ${result.licenseId} text was detected separately for manual review. ${result.explanation}`,
        },
  )
}

function markUnsupportedSpdxBodyResultsForReview(
  results: MatchResult[],
): MatchResult[] {
  return markSpdxBodyResultsForReview(
    results,
    'SPDX expression contains unsupported IDs',
  )
}

function markAmbiguousSpdxBodyResultsForReview(
  results: MatchResult[],
): MatchResult[] {
  return markSpdxBodyResultsForReview(
    results,
    'SPDX expression is conjunctive or uses WITH exceptions',
  )
}

function hasPartialDeclaredSpdxBodyMatch(
  declaredIds: Set<string>,
  results: MatchResult[],
): boolean {
  if (declaredIds.size <= 1) return false
  const resultIds = new Set(results.map((result) => result.licenseId))
  return Array.from(declaredIds).some((id) => !resultIds.has(id))
}

function hasProjectLicenseHeaderContext(
  segment: string,
  licenseAliasWords: string[][],
): boolean {
  const loose = normalizeHeaderLoose(segment)
  const headerPattern = resetLicenseHeaderPattern(
    projectLicenseHeaderContextPattern,
  )
  let match: RegExpExecArray | null

  while ((match = headerPattern.exec(loose))) {
    const inputWords = wordsAfterHeaderMatch(
      loose,
      match.index + match[0].length,
    )
    if (!hasPotentialHeaderAlias(inputWords, licenseAliasWords)) continue

    const headerContext = licenseHeaderContext(
      loose,
      match.index,
      licenseAliasWords,
    )
    if (
      hasProjectHeaderContext(headerContext) &&
      !isThirdPartyOwnedHeaderContext(headerContext)
    ) {
      return true
    }
  }

  return false
}

function hasRestrictiveProjectLicenseHeaderBody(
  segment: string,
  aliases: HeaderAlias[],
  licenseAliasWords: string[][],
): boolean {
  const loose = normalizeHeaderLoose(segment)
  const headerPattern = resetLicenseHeaderPattern(
    restrictiveProjectLicenseHeaderBodyPattern,
  )
  let match: RegExpExecArray | null

  while ((match = headerPattern.exec(loose))) {
    const inputWords = wordsAfterHeaderMatch(
      loose,
      match.index + match[0].length,
    )
    if (!hasPotentialHeaderAlias(inputWords, licenseAliasWords)) continue

    const headerContext = licenseHeaderContext(
      loose,
      match.index,
      licenseAliasWords,
    )
    if (
      !hasProjectHeaderContext(headerContext) ||
      isThirdPartyOwnedHeaderContext(headerContext)
    ) {
      continue
    }

    if (
      matchesRestrictiveNamedBody(inputWords, aliases, licenseAliasWords, true)
    ) {
      return true
    }
  }

  return false
}

function matchesRestrictiveNamedBody(
  inputWords: string[],
  aliases: HeaderAlias[],
  licenseAliasWords: string[][],
  projectScoped = false,
): boolean {
  return aliases.some(
    (alias) =>
      matchesWordsAt(inputWords, 0, alias.words) &&
      !matchesHeaderAlias(
        inputWords,
        alias.words,
        licenseAliasWords,
        alias.sameLicenseWords,
      ) &&
      (projectScoped ||
        !hasBareLicenseThirdPartyTail(inputWords, alias.words.length)) &&
      !hasBareAliasTechnicalSubjectTail(inputWords, alias.words.length) &&
      hasRestrictiveLicenseTail(inputWords, alias.words.length),
  )
}

function hasThirdPartyBareLicenseSubjectContext(prefix: string): boolean {
  return /\b(?:(?:the|a|an|this|that) )?(?:dependency|dependencies|component|components|module|modules|parser|parsers|helper|helpers|library|libraries|package|packages|tool|tools|asset|assets|font|fonts|plugin|plugins|extension|extensions|add on|add ons|addon|addons) (?:uses|use|is under|are under)(?: |$)/.test(
    prefix,
  )
}

function hasProjectUsedPackageBareLicenseContext(prefix: string): boolean {
  const words = prefix.split(' ').filter(Boolean)
  const finalWord = words[words.length - 1]
  if (!['under', 'with'].includes(finalWord)) return false

  const headerVerbIndex = words.length - 2
  const headerSubject = words.slice(0, headerVerbIndex).join(' ')
  if (
    [
      'licensed',
      'licenced',
      'released',
      'distributed',
      'relicensed',
      'relicenced',
    ].includes(words[headerVerbIndex]) &&
    hasProjectHeaderContext(headerSubject) &&
    !isThirdPartyOwnedHeaderContext(headerSubject)
  ) {
    return false
  }

  const actionIndex = words.findIndex((word) =>
    [
      'bundles',
      'bundle',
      'contains',
      'contain',
      'includes',
      'include',
      'ships',
      'use',
      'uses',
      'vendors',
      'vendor',
    ].includes(word),
  )
  if (actionIndex < 0 || actionIndex >= words.length - 2) return false

  return hasProjectHeaderContext(words.slice(0, actionIndex).join(' '))
}

function hasBareLicenseProjectContext(prefix: string): boolean {
  if (!prefix || prefix === 'the') return true
  if (
    hasThirdPartyBareLicenseSubjectContext(prefix) ||
    hasProjectUsedPackageBareLicenseContext(prefix)
  )
    return false
  if (
    hasThirdPartyHeaderContext(prefix) ||
    isThirdPartyOwnedHeaderContext(prefix)
  ) {
    return false
  }
  return (
    hasProjectHeaderContext(prefix) &&
    /\b(?:is|are|has|have|had|uses|use|under|licensed|released|distributed)\b/.test(
      prefix,
    )
  )
}

const thirdPartyTailCoreNounPattern =
  '(?:dependency|dependencies|component|components|parser|parsers|helper|helpers)'
const thirdPartyTailQualifiedNounPattern =
  '(?:dependency|dependencies|component|components|module|modules|parser|parsers|helper|helpers|library|libraries|package|packages|tool|tools|asset|assets|font|fonts|plugin|plugins|extension|extensions|add on|add ons|addon|addons)'
const bareLicensePrefixWindowWords = 32
const bareLicenseTailWindowWords = 24
const thirdPartyTailQualifierPattern =
  '(?:third party|bundled|vendored|external|included|embedded)'
const thirdPartyTailBoundaryPattern =
  '(?!\\s+(?:is|are|was|were|has|have|listed|documented|separate|separately)\\b)'
const selfReferenceTailPattern = '(?:this|our|current|project|main|primary)'
const thirdPartyTailObjectPattern =
  '(?!' +
  selfReferenceTailPattern +
  '\\b)(?:' +
  '(?:' +
  thirdPartyTailQualifierPattern +
  '\\s+)(?:(?!' +
  selfReferenceTailPattern +
  '\\b)[a-z0-9<>]+\\s+){0,2}' +
  thirdPartyTailQualifiedNounPattern +
  '|(?:(?!' +
  selfReferenceTailPattern +
  '\\b)[a-z0-9<>]+\\s+){0,2}' +
  thirdPartyTailCoreNounPattern +
  ')' +
  thirdPartyTailBoundaryPattern
const thirdPartyTailPattern = new RegExp(
  '\\b(?:(?:as|for)\\s+|license\\s+for\\s+|only\\s+)(?:(?:a|an|the)\\s+)?' +
    thirdPartyTailObjectPattern +
    '\\b',
)

const thirdPartyPurposeTailPattern =
  /\b(?:as|for) (?:a |an |the )?(?:parser|parsers|helper|helpers|component|components|module|modules|plugin|plugins|extension|extensions|add on|add ons|addon|addons) (?:dependency|dependencies|component|components|module|modules|plugin|plugins|extension|extensions|add on|add ons|addon|addons)\b/

function hasBareLicenseThirdPartyTail(
  inputWords: string[],
  aliasLength: number,
): boolean {
  const tail = inputWords
    .slice(aliasLength, aliasLength + bareLicenseTailWindowWords)
    .join(' ')
  return (
    thirdPartyTailPattern.test(tail) || thirdPartyPurposeTailPattern.test(tail)
  )
}

const technicalSubjectTailPattern =
  /^(?:(?:(?:version|v)\s+)?[0-9]+(?:\s+[0-9]+)?\s+)?(?:compression(?: (?:code|library|module))?|networking(?: (?:code|library|module))?)\b/

function hasBareAliasTechnicalSubjectTail(
  inputWords: string[],
  aliasLength: number,
): boolean {
  const nextWord = inputWords[aliasLength]
  if (
    !nextWord ||
    [
      'but',
      'except',
      'excepting',
      'excluding',
      'are',
      'be',
      'been',
      'being',
      'continues',
      'continue',
      'distributed',
      'academic',
      'commercial',
      'educational',
      'evaluation',
      'for',
      'however',
      'internal',
      'private',
      'grant',
      'grants',
      'had',
      'has',
      'have',
      'is',
      'licence',
      'licences',
      'license',
      'licensed',
      'licenses',
      'limited',
      'non',
      'nonprofit',
      'noncommercial',
      'not',
      'only',
      'permissions',
      'provided',
      'restricted',
      'released',
      'remain',
      'remains',
      'relicensed',
      'rights',
      'terms',
      'research',
      'although',
      'though',
      'unless',
      'was',
      'were',
      'with',
    ].includes(nextWord)
  ) {
    return false
  }
  return (
    technicalSubjectTailPattern.test(
      inputWords.slice(aliasLength, aliasLength + 6).join(' '),
    ) && hasRestrictiveLicenseTail(inputWords, aliasLength)
  )
}

function headerAliasesByFirstWord(
  aliases: HeaderAlias[],
): Map<string, HeaderAlias[]> {
  const byFirstWord = new Map<string, HeaderAlias[]>()
  for (const alias of aliases) {
    const firstWord = alias.words[0]
    if (!firstWord) continue
    const matches = byFirstWord.get(firstWord) || []
    matches.push(alias)
    byFirstWord.set(firstWord, matches)
  }
  return byFirstWord
}

function hasRestrictiveBareLicenseBody(
  body: string,
  aliasesByFirstWord: Map<string, HeaderAlias[]>,
  licenseAliasWords: string[][],
): boolean {
  const words = aliasWords(body)
  if (words.length === 0) return false

  for (let startIndex = 0; startIndex < words.length; startIndex += 1) {
    const aliases = aliasesByFirstWord.get(words[startIndex])
    if (!aliases) continue

    const prefix = words
      .slice(Math.max(0, startIndex - bareLicensePrefixWindowWords), startIndex)
      .join(' ')
    const directProjectContext = hasDirectProjectBareLicensePrefix(prefix)
    if (!hasBareLicenseProjectContext(prefix) && !directProjectContext) {
      continue
    }

    const inputWords = words.slice(startIndex)
    for (const alias of aliases) {
      if (!matchesWordsAt(inputWords, 0, alias.words)) continue
      if (
        !directProjectContext &&
        hasBareLicenseThirdPartyTail(inputWords, alias.words.length)
      ) {
        continue
      }
      if (hasBareAliasTechnicalSubjectTail(inputWords, alias.words.length)) {
        continue
      }
      if (
        !matchesHeaderAlias(
          inputWords,
          alias.words,
          licenseAliasWords,
          alias.sameLicenseWords,
        ) &&
        hasRestrictiveLicenseTail(inputWords, alias.words.length)
      ) {
        return true
      }
    }
  }

  return false
}

function declaredSpdxBodyEntries(
  spdxIds: Set<string>,
  licenseById: Map<string, LicenseEntry>,
): LicenseEntry[] {
  const entries: LicenseEntry[] = []
  const seenIds = new Set<string>()

  for (const id of spdxIds) {
    for (const candidateId of [id, gnuCounterparts.get(id)]) {
      if (!candidateId || seenIds.has(candidateId)) continue
      const entry = licenseById.get(candidateId)
      if (!entry) continue
      seenIds.add(candidateId)
      entries.push(entry)
    }
  }

  return entries
}

function hasDeclaredSpdxBodyPrefix(
  input: string,
  spdxIds: Set<string>,
  licenseById: Map<string, LicenseEntry>,
): boolean {
  const body = bodyWithoutSpdxLines(input)
  if (!body) return false

  const bodyWords = aliasWords(body)
  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  for (const entry of declaredSpdxBodyEntries(spdxIds, licenseById)) {
    if (
      fullLicensePrefixWordLength(
        bodyWords,
        licenseEntryWords(entry),
        fullLicensePrefixBudget(totalBudget),
      ) !== undefined
    ) {
      return true
    }
  }
  return false
}

function bodyTextSegments(text: string): string[] {
  const normalizedText = text.replaceAll(
    String.fromCharCode(13),
    String.fromCharCode(10),
  )
  const segments: string[] = []
  let startIndex = 0

  const pushSegment = (endIndex: number): void => {
    const segment = normalizedText.slice(startIndex, endIndex).trim()
    if (segment) segments.push(segment)
    startIndex = endIndex + 1
  }

  for (let index = 0; index < normalizedText.length; index += 1) {
    const character = normalizedText[index]
    if (character === String.fromCharCode(10)) {
      pushSegment(index)
      continue
    }
    if (
      character !== '.' &&
      character !== '!' &&
      character !== '?' &&
      character !== ';'
    )
      continue
    if (
      character === '.' &&
      /[0-9]/.test(normalizedText[index - 1] || '') &&
      /[0-9]/.test(normalizedText[index + 1] || '')
    ) {
      continue
    }
    if (
      index === normalizedText.length - 1 ||
      /\s/.test(normalizedText[index + 1] || '')
    ) {
      pushSegment(index)
    }
  }

  const finalSegment = normalizedText.slice(startIndex).trim()
  if (finalSegment) segments.push(finalSegment)
  return segments
}

function cleanSpdxLikeBodyDeclarationComment(segment: string): string {
  return segment
    .trim()
    .replace(/^(?:<!--|\/\/[/!]?|\/\*+!?|\*+|#|;|--|[-*])\s*/, '')
    .replace(/\*\/$/, '')
    .replace(/-->$/, '')
}

function hasSpdxLikeBodyDeclarationLabel(segment: string): boolean {
  return rawSpdxLikeBodyDeclarationLabelPattern.test(
    cleanSpdxLikeBodyDeclarationComment(segment),
  )
}

function cleanSpdxLikeBodyDeclarationSegment(segment: string): string {
  return cleanSpdxLikeBodyDeclarationComment(segment)
    .replace(rawSpdxLikeBodyDeclarationLabelPattern, '')
    .trim()
}

function legacyAnnotatedLicenseNameLeadingId(
  expression: string,
): string | undefined {
  const firstTokenMatch = /[A-Za-z0-9.+:-]+/.exec(expression)
  const firstToken = firstTokenMatch?.[0]
  if (!firstToken || !lowercaseLegacyIds.has(firstToken.toLowerCase())) {
    return undefined
  }

  const annotation = expression
    .slice((firstTokenMatch.index ?? 0) + firstToken.length)
    .trim()
  return /^\([^()]*\b(?:licen[cs]e|public domain)\b[^()]*\)$/i.test(annotation)
    ? firstToken
    : undefined
}

function isSpdxLikeBodyDeclarationId(
  id: string,
  knownIds: Set<string>,
): boolean {
  return (
    !isSpdxExceptionIdToken(id) &&
    (isSpdxLikeIdToken(id, knownIds) ||
      lowercaseLegacyIds.has(id.toLowerCase()))
  )
}

function knownIdsHas(knownIds: Set<string>, id: string): boolean {
  if (knownIds.has(id)) return true
  return cachedLowercaseSetFor(knownIds).has(id.toLowerCase())
}

function isBareUnsupportedWordSpdxLikeBodyDeclaration(
  rawTokens: string[],
  hasDeclarationLabel: boolean,
  knownIds: Set<string>,
): boolean {
  if (hasDeclarationLabel || rawTokens.length !== 1) return false
  const [id] = rawTokens
  return (
    /^[A-Za-z]+$/.test(id) &&
    !knownIdsHas(knownIds, id) &&
    isSpdxLikeBodyDeclarationId(id, knownIds)
  )
}

function spdxLikeBodyCommaListIds(
  expression: string,
  knownIds: Set<string>,
): string[] {
  const firstTokenMatch = /[A-Za-z0-9.+:-]+/.exec(expression)
  const firstToken = firstTokenMatch?.[0]
  if (!firstToken) return []
  if (
    !expression
      .slice((firstTokenMatch.index ?? 0) + firstToken.length)
      .trimStart()
      .startsWith(',')
  ) {
    return []
  }

  const ids = Array.from(
    expression.matchAll(/[A-Za-z0-9.+:-]+/g),
    (match) => match[0],
  ).filter(isSpdxExpressionIdToken)
  const spdxLikeIds = ids.filter((id) =>
    isSpdxLikeBodyDeclarationId(id, knownIds),
  )
  return spdxLikeIds.length === ids.length ? spdxLikeIds : []
}

function spdxLikeLowercaseOperatorBodyIds(
  expression: string,
  knownIds: Set<string>,
): string[] {
  const rawTokens = Array.from(
    expression.matchAll(/[A-Za-z0-9.+:-]+/g),
    (match) => match[0],
  )
  if (!rawTokens.some((token) => ['and', 'or', 'with'].includes(token))) {
    return []
  }

  const normalizedTokens = rawTokens.map((token) =>
    ['and', 'or', 'with'].includes(token) ? token.toUpperCase() : token,
  )
  const ids = normalizedTokens.filter(isSpdxExpressionIdToken)
  const spdxLikeIds = ids.filter((id) =>
    isSpdxLikeBodyDeclarationId(id, knownIds),
  )
  if (
    !ids.every(
      (id) =>
        isSpdxExceptionIdToken(id) || isSpdxLikeBodyDeclarationId(id, knownIds),
    )
  )
    return []
  return spdxLikeIds
}

function spdxLikeBodyDeclarationIds(
  segment: string,
  knownIds: Set<string>,
): string[] {
  const hasDeclarationLabel = hasSpdxLikeBodyDeclarationLabel(segment)
  const expression = cleanSpdxLikeBodyDeclarationSegment(segment)
  if (!expression) return []
  // Keep prose-shaped shortcuts ahead of the stricter SPDX grammar fallback.
  const annotatedLeadingId =
    spdxLikeAnnotatedLicenseNameLeadingId(expression, knownIds) ||
    legacyAnnotatedLicenseNameLeadingId(expression)
  if (annotatedLeadingId) return [annotatedLeadingId]
  const rawTokens = Array.from(
    expression.matchAll(/[A-Za-z0-9.+:-]+/g),
    (match) => match[0],
  )
  const malformedCustomReferenceIds = rawTokens.filter(
    (token) =>
      isMalformedCustomSpdxReferenceToken(token) &&
      (hasDeclarationLabel || !isStandaloneDocumentRefToken(token)),
  )
  if (malformedCustomReferenceIds.length > 0) return malformedCustomReferenceIds
  if (
    isBareUnsupportedWordSpdxLikeBodyDeclaration(
      rawTokens,
      hasDeclarationLabel,
      knownIds,
    )
  )
    return []
  const lowercaseOperatorIds = spdxLikeLowercaseOperatorBodyIds(
    expression,
    knownIds,
  )
  if (lowercaseOperatorIds.length > 0) return lowercaseOperatorIds
  if (/\b(?:and|or|with)\b/.test(expression)) return []
  const commaListIds = spdxLikeBodyCommaListIds(expression, knownIds)
  if (commaListIds.length > 0) return commaListIds
  if (rawTokens.some((token) => ['AND', 'OR', 'WITH'].includes(token))) {
    const ids = rawTokens.filter(isSpdxExpressionIdToken)
    const spdxLikeIds = ids.filter((id) =>
      isSpdxLikeBodyDeclarationId(id, knownIds),
    )
    if (spdxLikeIds.length === ids.length) return spdxLikeIds
  }
  if (!hasValidSpdxExpressionShape(expression)) return []

  const ids = rawTokens.filter(isSpdxExpressionIdToken)
  const spdxLikeIds = ids.filter((id) =>
    isSpdxLikeBodyDeclarationId(id, knownIds),
  )
  if (spdxLikeIds.length === 0) return []

  return spdxLikeIds
}

function hasUndeclaredSpdxLikeBodyDeclaration(
  body: string,
  declaredIds: Set<string>,
  knownIds: Set<string>,
): boolean {
  const declaredLowercaseIds = new Set(
    Array.from(declaredIds, (id) => id.toLowerCase()),
  )
  let previousSegmentCarriesThirdParty = false

  for (const segment of bodyTextSegments(body)) {
    const declarationIds = spdxLikeBodyDeclarationIds(segment, knownIds)
    const segmentLoose = normalizeHeaderLoose(segment)
    const segmentHasThirdPartyContext = hasThirdPartyBodyContextSegment(segment)
    const segmentHasProjectContext = hasProjectHeaderContext(segmentLoose)
    const scopedToThirdParty =
      !segmentHasProjectContext &&
      (previousSegmentCarriesThirdParty || segmentHasThirdPartyContext)

    const hasUndeclaredId = declarationIds.some(
      (id) => !isDeclaredSpdxLikeBodyId(id, declaredLowercaseIds),
    )
    if (hasUndeclaredId && !scopedToThirdParty) return true

    if (scopedToThirdParty) {
      previousSegmentCarriesThirdParty = true
      continue
    }
    previousSegmentCarriesThirdParty =
      !segmentHasProjectContext && segmentHasThirdPartyContext
  }

  return false
}

function isDeclaredSpdxLikeBodyId(
  id: string,
  declaredLowercaseIds: Set<string>,
): boolean {
  const lowercaseId = id.toLowerCase()
  if (declaredLowercaseIds.has(lowercaseId)) return true
  const legacyCandidates = legacyAliasCandidatesByLowercase.get(lowercaseId)
  return (
    legacyCandidates?.some((candidate) =>
      declaredLowercaseIds.has(candidate.toLowerCase()),
    ) || false
  )
}

function hasCarriedNamedDependencyBodySubject(segment: string): boolean {
  const headerMatch =
    /(?:(?:re)?licen[cs]ed|released|distributed) under(?: |$)/.exec(segment)
  if (!headerMatch || headerMatch.index === undefined) return false

  const prefixWords = aliasWords(segment.slice(0, headerMatch.index))
  const verbStart = namedDependencyStateVerbStart(prefixWords)
  const subjectEnd = verbStart ?? prefixWords.length
  let effectiveSubjectEnd = subjectEnd
  while (
    effectiveSubjectEnd > 0 &&
    ['code', 'file', 'files', 'source', 'sources'].includes(
      prefixWords[effectiveSubjectEnd - 1],
    )
  ) {
    effectiveSubjectEnd -= 1
  }

  for (let wordCount = 1; wordCount <= 3; wordCount += 1) {
    const subjectStart = effectiveSubjectEnd - wordCount
    if (subjectStart < 0) break
    if (
      isNamedDependencyCarrySubject(
        prefixWords.slice(subjectStart, effectiveSubjectEnd),
      )
    ) {
      return true
    }
  }

  return false
}

function hasCarriedOmittedThirdPartyLicenseSubject(
  segment: string,
  aliasesByFirstWord: Map<string, HeaderAlias[]>,
): boolean {
  const words = aliasWords(segment)
  const operandIndex = licenseOperandStartIndex(words, 0)
  const matchingAliases = (
    aliasesByFirstWord.get(words[operandIndex]) || []
  ).filter((alias) => matchesWordsAt(words, operandIndex, alias.words))
  return matchingAliases.length > 0
}

function carriedLicenseHeaderIndex(inputWords: string[]): number | undefined {
  for (let index = 0; index < inputWords.length - 1; index += 1) {
    if (
      [
        'distributed',
        'licensed',
        'licenced',
        'released',
        'relicensed',
        'relicenced',
      ].includes(inputWords[index]) &&
      inputWords[index + 1] === 'under'
    ) {
      return index
    }
  }
  return undefined
}

function hasCarriedThirdPartyLicenseSubject(
  segment: string,
  previousSegment: string | undefined,
): boolean {
  const words = aliasWords(segment)
  const headerIndex = carriedLicenseHeaderIndex(words)
  if (headerIndex === undefined) return false

  const prefixWords = words.slice(0, headerIndex)
  const verbStart = namedDependencyStateVerbStart(prefixWords)
  const subjectWords = prefixWords.slice(0, verbStart ?? prefixWords.length)
  if (subjectWords.length === 1 && ['it', 'they'].includes(subjectWords[0])) {
    return true
  }
  if (!['the', 'this', 'that'].includes(subjectWords[0])) return false

  const nounFamily = thirdPartyRestrictionSubjectNounFamilyAt(subjectWords, 1)
  if (!nounFamily) return false
  return (
    carriedThisThirdPartyRestrictionSubjectFamilies.has(nounFamily) ||
    hasPreviousThirdPartyRestrictionSubjectNoun(previousSegment, nounFamily)
  )
}

function hasCarriedThirdPartyBodyContext(
  segment: string,
  previousSegment: string | undefined,
  aliasesByFirstWord: Map<string, HeaderAlias[]>,
): boolean {
  if (!previousSegment) return false
  const previousLoose = normalizeHeaderLoose(previousSegment)
  if (
    !hasThirdPartyHeaderContext(previousLoose) &&
    !isThirdPartyOwnedHeaderContext(previousLoose) &&
    !hasThirdPartyLicenseBodySegment(previousSegment, aliasesByFirstWord)
  ) {
    return false
  }

  const segmentLoose = normalizeHeaderLoose(segment)
  return (
    hasCarriedNamedDependencyBodySubject(segmentLoose) ||
    hasCarriedOmittedThirdPartyLicenseSubject(
      segmentLoose,
      aliasesByFirstWord,
    ) ||
    hasCarriedThirdPartyLicenseSubject(segmentLoose, previousSegment)
  )
}

function hasLicenseAliasInWords(
  inputWords: string[],
  aliasesByFirstWord: Map<string, HeaderAlias[]>,
): boolean {
  for (let startIndex = 0; startIndex < inputWords.length; startIndex += 1) {
    const aliases = aliasesByFirstWord.get(inputWords[startIndex])
    if (
      aliases?.some((alias) =>
        matchesWordsAt(inputWords, startIndex, alias.words),
      )
    ) {
      return true
    }
  }
  return false
}

function hasProjectUsedPackageLicenseBodySegment(
  inputWords: string[],
  aliasesByFirstWord: Map<string, HeaderAlias[]>,
): boolean {
  for (let startIndex = 0; startIndex < inputWords.length; startIndex += 1) {
    const aliases = aliasesByFirstWord.get(inputWords[startIndex])
    if (
      !aliases?.some((alias) =>
        matchesWordsAt(inputWords, startIndex, alias.words),
      )
    ) {
      continue
    }

    if (
      hasProjectUsedPackageBareLicenseContext(
        inputWords.slice(0, startIndex).join(' '),
      )
    ) {
      return true
    }
  }
  return false
}

function hasThirdPartyBodyContextSegment(segment: string): boolean {
  const loose = normalizeHeaderLoose(segment)
  if (hasOnlyNegatedThirdPartyBodyContext(loose)) return false
  if (
    hasGenericRestrictiveBodySubject(loose) &&
    !hasExplicitThirdPartyBodyContextSegment(loose)
  )
    return false
  return /\b(?:third party|bundled|vendored|external|included|embedded|dependency|dependencies|component|components|module|modules|parser|parsers|helper|helpers|library|libraries|package|packages|tool|tools|asset|assets|font|fonts|plugin|plugins|extension|extensions|add on|add ons|addon|addons)\b/.test(
    loose,
  )
}

function hasRestrictiveDependencyNote(segment: string): boolean {
  const looseText = normalizeHeaderLoose(segment)
  if (
    hasProjectAndDependencyRestrictiveState(looseText) ||
    hasRestrictiveProjectStateAfterDependencyNote(looseText)
  ) {
    return false
  }

  let foundDependencyNote = false
  for (const bodySegment of bodyTextSegments(segment)) {
    const looseSegment = normalizeHeaderLoose(bodySegment)
    if (!looseSegment) continue
    if (isRestrictiveDependencyNoteSegment(looseSegment)) {
      foundDependencyNote = true
      continue
    }
    if (
      hasRestrictiveLicenseLabelLine(looseSegment) ||
      hasProjectRestrictiveBodySegment(bodySegment, true)
    ) {
      return false
    }
  }
  return foundDependencyNote
}

function hasRestrictiveDependencyNoteConflict(segment: string): boolean {
  let foundDependencyNote = false
  for (const bodySegment of bodyTextSegments(segment)) {
    const looseSegment = normalizeHeaderLoose(bodySegment)
    if (!looseSegment) continue
    if (isRestrictiveDependencyNoteSegment(looseSegment)) {
      if (
        hasProjectAndDependencyRestrictiveState(looseSegment) ||
        hasRestrictiveProjectStateAfterDependencyNote(looseSegment)
      ) {
        return true
      }
      foundDependencyNote = true
      continue
    }
    if (
      foundDependencyNote &&
      (hasRestrictiveLicenseLabelLine(looseSegment) ||
        hasProjectRestrictiveBodySegment(bodySegment, true))
    ) {
      return true
    }
  }
  return false
}

function isRestrictiveDependencyNoteSegment(loose: string): boolean {
  return (
    /\bdependenc(?:y|ies)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:is|are|was|were|has been|have been|remains|remain) (?:proprietary|closed source|confidential|private|all rights reserved)\b/.test(
      loose,
    ) ||
    /\b(?:has|have|uses|use|includes|include|bundles|bundle|vendors|vendor|contains|contain|ships with|ship with|depends on|depend on|depends upon|depend upon|requires|require)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,6} (?:proprietary|closed source|confidential|private|all rights reserved)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} dependenc(?:y|ies)\b/.test(
      loose,
    ) ||
    /\bdependenc(?:y|ies)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:may|might|can|could) (?:be |include |have |use )?(?:proprietary|closed source|confidential|private|all rights reserved)\b/.test(
      loose,
    ) ||
    /\bdependenc(?:y|ies)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:use|uses|are under|are covered by|have|include)(?: (?!and\b|or\b|but\b)[a-z0-9<>]+){0,4} (?:proprietary|closed source|confidential|private) licen[cs]es?\b/.test(
      loose,
    )
  )
}

function hasProjectAndDependencyRestrictiveState(loose: string): boolean {
  return /\b(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files) (?:and|or) (?:(?:its|their|the|our) )?dependenc(?:y|ies) (?:is|are|was|were|has been|have been|is still|are still|remains|remain) (?:proprietary|closed source|confidential|private|all rights reserved)\b/.test(
    loose,
  )
}

function hasRestrictiveProjectStateAfterDependencyNote(loose: string): boolean {
  return (
    /\b(?:and|but|however|though|although) (?:(?:it|they|this|that|these|those|(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files) )?(?:is|are|was|were|has been|have been|is still|are still|remains|remain) (?:proprietary|closed source|confidential|private|all rights reserved)\b/.test(
      loose,
    ) ||
    /\b(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application)|(?:these|those) files)\b.{0,160}\b(?:it|they|this|that|these|those) (?:is|are|was|were|has been|have been|is still|are still|remains|remain) (?:proprietary|closed source|confidential|private|all rights reserved)\b/.test(
      loose,
    ) ||
    dependencyNoteNegatedLicensePattern.test(loose) ||
    dependencyNoteNotOpenSourcePattern.test(loose) ||
    dependencyNoteConjunctionNegatedLicensePattern.test(loose) ||
    dependencyNoteConjunctionNotOpenSourcePattern.test(loose) ||
    dependencyNoteConjunctionNoLicensePattern.test(loose) ||
    dependencyNoteConjunctionNoGrantPattern.test(loose)
  )
}

function hasGenericRestrictiveBodySubject(loose: string): boolean {
  return /\b(?:(?:this|the|our) (?:asset|assets|component|components|extension|extensions|font|fonts|helper|helpers|library|libraries|module|modules|package|packages|parser|parsers|plugin|plugins|software|tool|tools)|(?:asset|component|extension|font|helper|library|module|package|parser|plugin|software|tool)) (?:is|are|was|were|has been|have been|remains|remain) (?:(?:for |only for )?(?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo) (?:use|usage|distribution|redistribution)(?: only)?|(?:restricted|limited) (?:to|for|by)|proprietary|closed source|confidential|nondisclosure|non disclosure)\b/.test(
    loose,
  )
}

function hasExplicitThirdPartyBodyContextSegment(segment: string): boolean {
  const loose = normalizeHeaderLoose(segment)
  if (!explicitThirdPartyBodyContextPattern.test(loose)) return false
  return !hasOnlyNegatedThirdPartyBodyContext(loose)
}

function hasThirdPartyLicenseBodySegment(
  segment: string,
  aliasesByFirstWord: Map<string, HeaderAlias[]>,
): boolean {
  const segmentLoose = normalizeHeaderLoose(segment)
  const segmentWords = aliasWords(segment)
  if (!hasLicenseAliasInWords(segmentWords, aliasesByFirstWord)) {
    return false
  }
  if (
    hasThirdPartyBareLicenseSubjectContext(segmentLoose) ||
    hasProjectUsedPackageLicenseBodySegment(segmentWords, aliasesByFirstWord)
  )
    return true
  if (
    !/\b(?:third party|bundled|vendored|external|included|embedded|dependency|dependencies)\b/.test(
      segmentLoose,
    )
  ) {
    return false
  }

  const headerPattern = resetLicenseHeaderPattern(
    thirdPartyLicenseBodySegmentPattern,
  )
  let headerMatch: RegExpExecArray | null
  while ((headerMatch = headerPattern.exec(segmentLoose))) {
    if (headerMatch.index === undefined) continue
    const prefix = segmentLoose.slice(0, headerMatch.index).trim()
    if (isThirdPartyOwnedHeaderContext(prefix)) return true
    if (hasProjectHeaderContext(prefix)) return false
  }

  if (hasProjectHeaderContext(segmentLoose)) return false
  if (isThirdPartyOwnedHeaderContext(segmentLoose)) return true
  return true
}

function hasDirectProjectBareLicensePrefix(prefix: string): boolean {
  return /\b(?:(?:this|the) (?:project|package|software|code|source|library)|our (?:project|package|software|code|source|library)|(?:main|primary) (?:code|source|package|software|library)) (?:uses|use|is under|are under)$/.test(
    prefix,
  )
}

function hasCleanBareLicenseSegment(
  segment: string,
  aliasesByFirstWord: Map<string, HeaderAlias[]>,
  licenseAliasWords: string[][],
): boolean {
  const words = aliasWords(segment)
  for (let startIndex = 0; startIndex < words.length; startIndex += 1) {
    const aliases = aliasesByFirstWord.get(words[startIndex])
    if (!aliases) continue

    const prefix = words
      .slice(Math.max(0, startIndex - bareLicensePrefixWindowWords), startIndex)
      .join(' ')
    const directProjectContext = hasDirectProjectBareLicensePrefix(prefix)
    if (!hasBareLicenseProjectContext(prefix) && !directProjectContext) {
      continue
    }

    const inputWords = words.slice(startIndex)
    for (const alias of aliases) {
      if (
        matchesHeaderAlias(
          inputWords,
          alias.words,
          licenseAliasWords,
          alias.sameLicenseWords,
        ) &&
        (directProjectContext ||
          !hasBareLicenseThirdPartyTail(inputWords, alias.words.length)) &&
        !hasBareAliasTechnicalSubjectTail(inputWords, alias.words.length)
      ) {
        return true
      }
    }
  }
  return false
}

function hasCleanNamedLicenseSegment(
  segment: string,
  aliases: HeaderAlias[],
  aliasesByFirstWord: Map<string, HeaderAlias[]>,
  licenseAliasWords: string[][],
): boolean {
  const headerWords = wordsAfterLicenseHeader(segment, licenseAliasWords)
  if (!headerWords) {
    return hasCleanBareLicenseSegment(
      segment,
      aliasesByFirstWord,
      licenseAliasWords,
    )
  }

  const segmentLoose = normalizeHeaderLoose(segment)
  if (
    hasThirdPartyHeaderContext(segmentLoose) ||
    isThirdPartyOwnedHeaderContext(segmentLoose)
  ) {
    return false
  }

  return aliases.some((alias) =>
    matchesHeaderAlias(
      headerWords,
      alias.words,
      licenseAliasWords,
      alias.sameLicenseWords,
    ),
  )
}

function isTransparentLicenseDocumentSegment(segment: string): boolean {
  const words = aliasWords(segment)
  if (words.length === 0) return false
  if (words[0] === 'see') {
    return isBenignLicenseDocumentBoundary(words, 1)
  }
  return isBenignLicenseDocumentBoundary(words, 0)
}

function isTransparentLicenseBodySegment(segment: string): boolean {
  const words = aliasWords(segment)
  return (
    isTransparentLicenseDocumentSegment(segment) ||
    (words[0] === 'copyright' &&
      words[1] === '<year>' &&
      !words.includes('reserved') &&
      !hasRestrictiveLicenseTail(words, 0))
  )
}

function restrictiveContinuationStart(words: string[]): number | undefined {
  let index = 0
  while (['but', 'however', 'though', 'although'].includes(words[index])) {
    index += 1
  }
  return index < words.length ? index : undefined
}

function selfReferenceContinuationStateIndex(
  words: string[],
  index: number,
): number | undefined {
  let nounIndex = index
  if (['this', 'that', 'the', 'our'].includes(words[index])) {
    nounIndex = index + 1
  }

  let stateStart: number | undefined
  if (
    words[nounIndex] === 'source' &&
    ['code', 'file', 'files'].includes(words[nounIndex + 1])
  ) {
    stateStart = nounIndex + 2
  } else if (
    [
      'project',
      'package',
      'software',
      'code',
      'source',
      'library',
      'component',
      'module',
      'plugin',
      'extension',
      'parser',
      'helper',
    ].includes(words[nounIndex])
  ) {
    stateStart = nounIndex + 1
  } else if (
    ['main', 'primary'].includes(words[nounIndex]) &&
    [
      'project',
      'package',
      'software',
      'code',
      'source',
      'library',
      'component',
      'module',
      'plugin',
      'extension',
      'parser',
      'helper',
    ].includes(words[nounIndex + 1])
  ) {
    stateStart = nounIndex + 2
  }

  if (stateStart === undefined) return undefined
  if (
    ['has', 'have', 'had'].includes(words[stateStart]) &&
    words[stateStart + 1] === 'been'
  ) {
    return stateStart + 2
  }
  if (['is', 'are', 'was', 'were', 'has', 'have'].includes(words[stateStart])) {
    return stateStart + 1
  }
  return stateStart
}

function projectScopedUseRestrictionStateIndex(
  words: string[],
  index: number,
): number | undefined {
  const useIndex =
    words[index] === 'non' &&
    ['commercial', 'profit'].includes(words[index + 1])
      ? index + 2
      : index + 1
  if (
    ![
      'commercial',
      'noncommercial',
      'non',
      'internal',
      'private',
      'demo',
      'documentation',
      'evaluation',
      'academic',
      'educational',
      'nonprofit',
      'personal',
      'research',
      'test',
      'testing',
      'trial',
    ].includes(words[index]) ||
    !['use', 'usage', 'distribution', 'redistribution'].includes(
      words[useIndex],
    ) ||
    words[useIndex + 1] !== 'of'
  ) {
    return undefined
  }

  let nounIndex = useIndex + 2
  if (['this', 'that', 'the', 'our'].includes(words[nounIndex])) {
    nounIndex += 1
  }

  let stateStart: number | undefined
  if (
    words[nounIndex] === 'source' &&
    ['code', 'file', 'files'].includes(words[nounIndex + 1])
  ) {
    stateStart = nounIndex + 2
  } else if (
    ['project', 'package', 'software', 'code', 'source', 'library'].includes(
      words[nounIndex],
    )
  ) {
    stateStart = nounIndex + 1
  } else if (
    ['main', 'primary'].includes(words[nounIndex]) &&
    ['project', 'package', 'software', 'code', 'source', 'library'].includes(
      words[nounIndex + 1],
    )
  ) {
    stateStart = nounIndex + 2
  }

  if (stateStart === undefined) return undefined
  if (
    ['has', 'have', 'had'].includes(words[stateStart]) &&
    words[stateStart + 1] === 'been'
  ) {
    return stateStart + 2
  }
  if (['is', 'are', 'was', 'were', 'has', 'have'].includes(words[stateStart])) {
    return stateStart + 1
  }
  return stateStart
}

function isRestrictiveStateAt(words: string[], index: number): boolean {
  return (
    !isBenignLegalLimitationTail(words, index) &&
    ['restricted', 'limited'].includes(words[index]) &&
    ['to', 'for', 'by'].includes(words[index + 1])
  )
}

function isRestrictiveContinuationAt(words: string[], index: number): boolean {
  const lead = words[index]
  if (hasPermissionRequiredRestrictionAt(words, index)) return true
  if (hasSourceDisclosureRequirementAt(words, index)) return true
  const selfReferenceStateIndex = selfReferenceContinuationStateIndex(
    words,
    index,
  )
  if (selfReferenceStateIndex !== undefined) {
    return isRestrictiveStateAt(words, selfReferenceStateIndex)
  }
  if (['except', 'excepting', 'excluding', 'unless'].includes(lead)) {
    return !isBenignComplianceTail(words, index)
  }
  if (['it', 'they', 'this', 'that', 'these', 'those'].includes(lead)) {
    const stateIndex =
      ['has', 'have', 'had'].includes(words[index + 1]) &&
      words[index + 2] === 'been'
        ? index + 3
        : ['is', 'are', 'was', 'were', 'has', 'have'].includes(words[index + 1])
          ? index + 2
          : index + 1
    return isRestrictiveStateAt(words, stateIndex)
  }
  if (['limited', 'restricted'].includes(lead)) {
    return isRestrictiveStateAt(words, index)
  }
  if (lead === 'provided' && words[index + 1] === 'that') {
    return !isBenignProvidedThatTail(words, index)
  }
  if (lead === 'not') return ['for', 'to'].includes(words[index + 1])
  if (lead === 'only') return ['for', 'to'].includes(words[index + 1])
  if (hasNoPrefixedRestrictionTail(words, index)) return true
  if (lead === 'for') {
    const tail = words.slice(index, index + 8)
    return (
      (!isBenignForScopeUseCaseTail(tail) &&
        [
          'academic',
          'demo',
          'documentation',
          'educational',
          'evaluation',
          'internal',
          'private',
          'nonprofit',
          'personal',
          'research',
          'test',
          'testing',
          'trial',
        ].includes(words[index + 1]) &&
        (words[index + 2] === 'only' ||
          ['use', 'usage'].includes(words[index + 2]))) ||
      hasRestrictiveScopeLicenseOnlyTail(words, index + 1) ||
      hasCommercialOnlyScopeTail(tail) ||
      words[index + 1] === 'noncommercial' ||
      (words[index + 1] === 'non' &&
        ['commercial', 'profit'].includes(words[index + 2]))
    )
  }
  if (hasRestrictiveScopeLicenseOnlyTail(words, index)) return true
  if (
    [
      'commercial',
      'noncommercial',
      'internal',
      'private',
      'demo',
      'documentation',
      'evaluation',
      'academic',
      'educational',
      'nonprofit',
      'personal',
      'research',
      'test',
      'testing',
      'trial',
    ].includes(lead) &&
    ['use', 'usage', 'distribution', 'redistribution'].includes(
      words[index + 1],
    )
  ) {
    if (words[index + 2] === 'only') return true

    const projectScopedStateIndex = projectScopedUseRestrictionStateIndex(
      words,
      index,
    )
    const stateIndex =
      projectScopedStateIndex ??
      (['has', 'have', 'had'].includes(words[index + 2]) &&
      words[index + 3] === 'been'
        ? index + 4
        : ['is', 'are', 'was', 'were', 'has', 'have'].includes(words[index + 2])
          ? index + 3
          : index + 2)
    return isRestrictiveStateAt(words, stateIndex)
  }
  if (
    ([
      'academic',
      'demo',
      'educational',
      'evaluation',
      'internal',
      'private',
      'nonprofit',
      'personal',
      'research',
      'test',
      'testing',
      'trial',
    ].includes(lead) &&
      ['use', 'usage'].includes(words[index + 1]) &&
      !['case', 'cases'].includes(words[index + 2])) ||
    lead === 'noncommercial' ||
    (lead === 'non' && ['commercial', 'profit'].includes(words[index + 1]))
  ) {
    return hasRestrictiveLicenseTail(words, index)
  }
  const usageSubjectIndex = ['the', 'this', 'that'].includes(lead)
    ? index + 1
    : index
  if (
    ['use', 'usage', 'distribution', 'redistribution'].includes(
      words[usageSubjectIndex],
    )
  ) {
    const stateIndex =
      ['has', 'have', 'had'].includes(words[usageSubjectIndex + 1]) &&
      words[usageSubjectIndex + 2] === 'been'
        ? usageSubjectIndex + 3
        : ['is', 'are', 'was', 'were', 'has', 'have'].includes(
              words[usageSubjectIndex + 1],
            )
          ? usageSubjectIndex + 2
          : usageSubjectIndex + 1
    return isRestrictiveStateAt(words, stateIndex)
  }
  if (lead !== 'use') return false
  if (['restricted', 'limited'].includes(words[index + 1])) {
    return ['to', 'for', 'by'].includes(words[index + 2])
  }
  return (
    (['has', 'have', 'had'].includes(words[index + 1]) &&
      words[index + 2] === 'been' &&
      ['restricted', 'limited'].includes(words[index + 3]) &&
      ['to', 'for', 'by'].includes(words[index + 4])) ||
    (['is', 'are', 'was', 'were'].includes(words[index + 1]) &&
      ['restricted', 'limited'].includes(words[index + 2]) &&
      ['to', 'for', 'by'].includes(words[index + 3]))
  )
}

function hasCarriedThirdPartyRestrictiveContinuationSegment(
  segment: string,
  previousSegment: string | undefined,
): boolean {
  const words = aliasWords(segment)
  const start = restrictiveContinuationStart(words)
  if (start === undefined) return false

  const nounIndex = ['that', 'the', 'this'].includes(words[start])
    ? start + 1
    : start
  if (
    !canCarryThirdPartyRestrictionSubjectNoun(words, nounIndex, previousSegment)
  ) {
    return false
  }
  return isRestrictiveContinuationAt(words, start)
}

function hasRestrictiveContinuationSegment(segment: string): boolean {
  const words = aliasWords(segment)
  const start = restrictiveContinuationStart(words)
  return start !== undefined && isRestrictiveContinuationAt(words, start)
}

function hasRestrictiveContinuationTail(
  inputWords: string[],
  index: number,
): boolean {
  const tailEnd = Math.min(
    inputWords.length,
    index + restrictiveTailWindowWords,
  )
  for (let tailIndex = index; tailIndex < tailEnd; tailIndex += 1) {
    if (hasRestrictionSubjectBoundary(inputWords, tailIndex)) {
      return hasExplicitProjectRestrictiveTail(
        inputWords,
        tailIndex + 1,
        tailEnd,
      )
    }
    if (isBenignLicenseOnlyReferenceTail(inputWords, index, tailIndex)) {
      continue
    }
    if (isRestrictiveContinuationAt(inputWords, tailIndex)) return true
  }
  return false
}

function hasPermissionRequiredRestrictionAt(
  words: string[],
  index: number,
): boolean {
  const subjectIndex = restrictiveTailSubjectDeterminers.has(words[index])
    ? index + 1
    : index
  const subjectEnd =
    words[subjectIndex] === 'derivative' &&
    noPrefixedDerivativeWorkWords.has(words[subjectIndex + 1])
      ? subjectIndex + 2
      : permissionRequiredRightWords.has(words[subjectIndex])
        ? subjectIndex + 1
        : undefined
  if (subjectEnd === undefined) return false
  if (
    !['need', 'needs', 'require', 'requires', 'requiring'].includes(
      words[subjectEnd],
    )
  )
    return false

  const objectEnd = Math.min(words.length, subjectEnd + 6)
  for (
    let objectIndex = subjectEnd + 1;
    objectIndex < objectEnd;
    objectIndex += 1
  ) {
    if (isPermissionRequirementNegationAt(words, objectIndex)) return false
    if (
      ['permission', 'permissions'].includes(words[objectIndex]) &&
      isPermissionNoticeReferenceAt(words, objectIndex)
    )
      continue
    if (permissionRequirementWords.has(words[objectIndex])) return true
  }
  return false
}

function isPermissionRequirementNegationAt(
  words: string[],
  index: number,
): boolean {
  return (
    permissionRequirementNegationWords.has(words[index]) &&
    !(words[index] === 'not' && words[index + 1] === 'only')
  )
}

function isPermissionNoticeReferenceAt(
  words: string[],
  index: number,
): boolean {
  if (permissionNoticeWords.has(words[index + 1])) return true
  if (
    words[index + 1] === 'and' &&
    noticeDescriptorWords.has(words[index + 2]) &&
    permissionNoticeWords.has(words[index + 3])
  )
    return true
  return (
    noticeDescriptorWords.has(words[index + 1]) &&
    permissionNoticeWords.has(words[index + 2])
  )
}

function hasSourceDisclosureRequirementAt(
  words: string[],
  index: number,
): boolean {
  const subjectIndex = restrictiveTailSubjectDeterminers.has(words[index])
    ? index + 1
    : index
  const subjectEnd =
    words[subjectIndex] === 'source' && words[subjectIndex + 1] === 'code'
      ? subjectIndex + 2
      : words[subjectIndex] === 'derivative' &&
          noPrefixedDerivativeWorkWords.has(words[subjectIndex + 1])
        ? subjectIndex + 2
        : sourceDisclosureSubjectWords.has(words[subjectIndex])
          ? subjectIndex + 1
          : undefined
  if (subjectEnd === undefined) return false
  if (!['must', 'shall'].includes(words[subjectEnd])) return false

  let predicateIndex = subjectEnd + 1
  if (words[predicateIndex] === 'be') predicateIndex += 1
  if (
    ['disclosed', 'published', 'released', 'shared'].includes(
      words[predicateIndex],
    )
  )
    return true
  if (
    words[predicateIndex] === 'made' &&
    words[predicateIndex + 1] === 'available'
  )
    return true
  return (
    words[predicateIndex] === 'open' && words[predicateIndex + 1] === 'source'
  )
}

function hasRestrictiveSegmentContinuationTail(segment: string): boolean {
  const words = aliasWords(segment)
  if (!hasThirdPartyBodyContextSegment(segment)) {
    return hasRestrictiveContinuationTail(words, 0)
  }
  return hasExplicitProjectRestrictiveTail(
    words,
    0,
    Math.min(words.length, restrictiveTailWindowWords),
  )
}

function hasExplicitProjectRestrictiveContinuationSegment(
  segment: string,
): boolean {
  const words = aliasWords(segment)
  const start = restrictiveContinuationStart(words)
  return (
    start !== undefined &&
    !hasRestrictionSubjectBoundary(words, start) &&
    (selfReferenceContinuationStateIndex(words, start) !== undefined ||
      projectScopedUseRestrictionStateIndex(words, start) !== undefined) &&
    isRestrictiveContinuationAt(words, start)
  )
}

function hasStandaloneRestrictiveScopeSegment(segment: string): boolean {
  const words = aliasWords(segment)
  const start = restrictiveContinuationStart(words)
  if (start === undefined) return false
  return (
    [
      'except',
      'excepting',
      'excluding',
      'for',
      'academic',
      'commercial',
      'demo',
      'documentation',
      'educational',
      'limited',
      'no',
      'not',
      'non',
      'noncommercial',
      'internal',
      'private',
      'evaluation',
      'nonprofit',
      'only',
      'personal',
      'provided',
      'restricted',
      'research',
      'test',
      'testing',
      'trial',
      'unless',
      'use',
    ].includes(words[start]) && isRestrictiveContinuationAt(words, start)
  )
}

function hasStandaloneRestrictiveLicenseOnlySegment(
  segment: string,
  allowAvailabilityException = true,
): boolean {
  const words = aliasWords(segment)
  const start = restrictiveContinuationStart(words)
  if (start === undefined) return false
  if (hasProjectBundledThirdPartyLicenseOnlySegment(words)) return false
  const scopedToThirdParty =
    hasThirdPartyBodyContextSegment(segment) &&
    !hasProjectHeaderContext(normalizeHeaderLoose(segment))
  if (scopedToThirdParty) return false

  for (let index = start; index < words.length; index += 1) {
    const scopeIndex = words[index] === 'for' ? index + 1 : index
    if (
      !isStandaloneRestrictiveLicenseOnlyStart(words, start, index, scopeIndex)
    )
      continue
    const allowTailAvailabilityException =
      allowAvailabilityException &&
      !hasLicenseOnlyLabelPrefix(words, scopeIndex)
    if (
      hasRestrictiveScopeLicenseOnlyTail(
        words,
        scopeIndex,
        allowTailAvailabilityException,
      )
    )
      return true
  }
  return false
}

function isStandaloneRestrictiveLicenseOnlyStart(
  words: string[],
  start: number,
  index: number,
  scopeIndex: number,
): boolean {
  return (
    scopeIndex === start ||
    (index === start && words[index] === 'for') ||
    hasLicenseOnlyLabelPrefix(words, scopeIndex)
  )
}

function projectThirdPartyObjectVerbEnd(
  words: string[],
  index: number,
): number | undefined {
  if (
    [
      'bundle',
      'bundles',
      'contain',
      'contains',
      'include',
      'includes',
      'require',
      'requires',
      'use',
      'uses',
      'vendor',
      'vendors',
    ].includes(words[index])
  )
    return index + 1
  if (words[index] === 'ship' && words[index + 1] === 'with') return index + 2
  if (words[index] === 'ships' && words[index + 1] === 'with') return index + 2
  if (
    ['depend', 'depends'].includes(words[index]) &&
    ['on', 'upon'].includes(words[index + 1])
  )
    return index + 2
  return undefined
}

function hasLicenseOnlyLabelPrefix(
  words: string[],
  scopeIndex: number,
): boolean {
  const prefixWords = words.slice(0, scopeIndex)
  if (prefixWords.length === 1) {
    return [
      'licence',
      'license',
      'note',
      'notes',
      'notice',
      'notices',
    ].includes(prefixWords[0])
  }
  if (prefixWords.length !== 2) return false
  return (
    (prefixWords[0] === 'project' &&
      ['licence', 'license', 'note', 'notes', 'notice', 'notices'].includes(
        prefixWords[1],
      )) ||
    (['package', 'source'].includes(prefixWords[0]) &&
      ['licence', 'license'].includes(prefixWords[1]))
  )
}

function hasProjectBundledThirdPartyObjectBefore(
  words: string[],
  objectEndIndex: number,
): boolean {
  for (let index = 0; index < objectEndIndex; index += 1) {
    const objectStartIndex = projectThirdPartyObjectVerbEnd(words, index)
    if (objectStartIndex === undefined) continue
    if (!hasProjectHeaderContext(words.slice(0, index).join(' '))) continue

    const objectWords = words.slice(objectStartIndex, objectEndIndex)
    const subjectNounIndex = objectWords.findIndex(
      (_word, offset) =>
        thirdPartyRestrictionSubjectNounFamilyAt(objectWords, offset) !==
        undefined,
    )
    if (subjectNounIndex < 0) continue

    const objectPrefixWords = objectWords.slice(0, subjectNounIndex)
    if (
      objectPrefixWords.some((word) =>
        ['main', 'our', 'primary', 'project', 'that', 'this'].includes(word),
      )
    )
      continue

    return true
  }
  return false
}

function hasProjectBundledThirdPartyLicenseOnlySegment(
  words: string[],
): boolean {
  for (let index = 0; index < words.length; index += 1) {
    const underWithScopeStart = licenseOnlyScopeStartAfterUnderWith(
      words,
      index,
    )
    if (underWithScopeStart !== undefined) {
      if (
        hasRestrictiveScopeLicenseOnlyTail(words, underWithScopeStart) &&
        hasProjectBundledThirdPartyObjectBefore(words, index)
      )
        return true
    }

    if (!['that', 'which'].includes(words[index])) continue

    const scopeStart =
      ['has', 'have', 'had'].includes(words[index + 1]) &&
      words[index + 2] === 'been'
        ? index + 3
        : ['is', 'are', 'was', 'were', 'has', 'have'].includes(words[index + 1])
          ? index + 2
          : undefined
    if (scopeStart === undefined) continue

    const effectiveScopeStart = ['a', 'an', 'the'].includes(words[scopeStart])
      ? scopeStart + 1
      : scopeStart
    if (
      hasRestrictiveScopeLicenseOnlyTail(words, effectiveScopeStart) &&
      hasProjectBundledThirdPartyObjectBefore(words, index)
    )
      return true
  }
  return false
}

function licenseOnlyScopeStartAfterUnderWith(
  words: string[],
  index: number,
): number | undefined {
  const relationIndex =
    ['licensed', 'released', 'distributed'].includes(words[index]) &&
    ['under', 'with'].includes(words[index + 1])
      ? index + 1
      : ['under', 'with'].includes(words[index])
        ? index
        : undefined
  if (relationIndex === undefined) return undefined

  let scopeStart = relationIndex + 1
  if (
    words[scopeStart] === 'the' &&
    words[scopeStart + 1] === 'terms' &&
    words[scopeStart + 2] === 'of'
  ) {
    scopeStart += 3
  } else if (words[scopeStart] === 'terms' && words[scopeStart + 1] === 'of') {
    scopeStart += 2
  }
  return ['a', 'an', 'the'].includes(words[scopeStart])
    ? scopeStart + 1
    : scopeStart
}

function hasProjectScopedRestrictiveLicenseOnlySegment(
  segment: string,
): boolean {
  const words = aliasWords(segment)
  for (let index = 0; index < words.length; index += 1) {
    const stateIndex = projectScopedUseRestrictionStateIndex(words, index)
    const scopeIndex =
      stateIndex !== undefined && ['a', 'an', 'the'].includes(words[stateIndex])
        ? stateIndex + 1
        : stateIndex
    if (
      scopeIndex !== undefined &&
      hasRestrictiveScopeLicenseOnlyTail(words, scopeIndex, false)
    )
      return true

    const subjectIndex = ['the', 'this', 'our'].includes(words[index])
      ? index + 1
      : index
    if (
      ![
        'project',
        'codebase',
        'software',
        'package',
        'repository',
        'repo',
        'library',
        'program',
        'application',
        'component',
        'product',
        'service',
        'code',
        'source',
        'work',
      ].includes(words[subjectIndex])
    ) {
      continue
    }

    const subjectStateStart =
      ['has', 'have', 'had'].includes(words[subjectIndex + 1]) &&
      words[subjectIndex + 2] === 'been'
        ? subjectIndex + 3
        : ['is', 'are', 'was', 'were', 'has', 'have'].includes(
              words[subjectIndex + 1],
            )
          ? subjectIndex + 2
          : undefined
    if (subjectStateStart !== undefined) {
      const underWithScopeStart = licenseOnlyScopeStartAfterUnderWith(
        words,
        subjectStateStart,
      )
      if (
        underWithScopeStart !== undefined &&
        hasRestrictiveScopeLicenseOnlyTail(words, underWithScopeStart, false)
      )
        return true

      const scopeStart = ['a', 'an', 'the'].includes(words[subjectStateStart])
        ? subjectStateStart + 1
        : subjectStateStart
      if (hasRestrictiveScopeLicenseOnlyTail(words, scopeStart, false))
        return true
    }

    let licenseIndex = subjectIndex + 1
    if (words[licenseIndex] === 's') licenseIndex += 1
    if (!['license', 'licence'].includes(words[licenseIndex])) continue
    const stateStart =
      ['has', 'have', 'had'].includes(words[licenseIndex + 1]) &&
      words[licenseIndex + 2] === 'been'
        ? licenseIndex + 3
        : ['is', 'are', 'was', 'were', 'has', 'have'].includes(
              words[licenseIndex + 1],
            )
          ? licenseIndex + 2
          : licenseIndex + 1
    const scopeStart = ['a', 'an', 'the'].includes(words[stateStart])
      ? stateStart + 1
      : stateStart
    if (hasRestrictiveScopeLicenseOnlyTail(words, scopeStart, false))
      return true
  }
  return false
}

function hasCarriedThirdPartyRestrictiveLicenseOnlySegment(
  segment: string,
): boolean {
  const words = aliasWords(segment)
  const start = restrictiveContinuationStart(words)
  if (start === undefined) return false

  for (let stateIndex = start + 1; stateIndex < words.length; stateIndex += 1) {
    const scopeStart =
      ['has', 'have', 'had'].includes(words[stateIndex]) &&
      words[stateIndex + 1] === 'been'
        ? stateIndex + 2
        : ['is', 'are', 'was', 'were', 'has', 'have'].includes(
              words[stateIndex],
            )
          ? stateIndex + 1
          : undefined
    if (scopeStart === undefined) continue

    const hasThirdPartySubject = words
      .slice(start, stateIndex)
      .some(
        (_word, offset) =>
          thirdPartyRestrictionSubjectNounFamilyAt(words, start + offset) !==
          undefined,
      )
    if (!hasThirdPartySubject) continue

    const effectiveScopeStart = ['a', 'an', 'the'].includes(words[scopeStart])
      ? scopeStart + 1
      : scopeStart
    if (hasRestrictiveScopeLicenseOnlyTail(words, effectiveScopeStart))
      return true
  }

  return false
}

function hasNamedThirdPartyRestrictiveLicenseOnlySegment(
  segment: string,
): boolean {
  const words = aliasWords(segment)
  const start = restrictiveContinuationStart(words)
  if (start === undefined) return false

  for (let stateIndex = start + 1; stateIndex < words.length; stateIndex += 1) {
    const scopeStart =
      ['has', 'have', 'had'].includes(words[stateIndex]) &&
      words[stateIndex + 1] === 'been'
        ? stateIndex + 2
        : ['is', 'are', 'was', 'were', 'has', 'have'].includes(
              words[stateIndex],
            )
          ? stateIndex + 1
          : undefined
    if (scopeStart === undefined) continue

    const subjectWords = words.slice(start, stateIndex)
    const subjectNounIndex = subjectWords.findIndex(
      (_word, offset) =>
        thirdPartyRestrictionSubjectNounFamilyAt(words, start + offset) !==
        undefined,
    )
    if (subjectNounIndex <= 0) continue
    const subjectNameWords = subjectWords.slice(0, subjectNounIndex)
    while (['a', 'an', 'the'].includes(subjectNameWords[0] || '')) {
      subjectNameWords.shift()
    }
    if (subjectNameWords.length === 0) continue
    if (
      subjectNameWords.some((word) =>
        ['main', 'our', 'primary', 'project', 'that', 'this'].includes(word),
      )
    )
      continue

    const effectiveScopeStart = ['a', 'an', 'the'].includes(words[scopeStart])
      ? scopeStart + 1
      : scopeStart
    if (hasRestrictiveScopeLicenseOnlyTail(words, effectiveScopeStart))
      return true
  }

  return false
}

function hasRestrictiveLicenseOnlyBodySegments(
  segments: string[],
  licenses: LicenseEntry[],
): boolean {
  const aliasesByFirstWord = headerAliasesByFirstWord(
    getHeaderAliases(licenses),
  )
  let previousSegmentCarriesThirdParty = false

  for (const [index, segment] of segments.entries()) {
    const previousSegment = segments[index - 1]
    const hasNamedThirdPartyLicenseOnly =
      hasNamedThirdPartyRestrictiveLicenseOnlySegment(segment)
    if (hasExplicitProjectRestrictiveCarryBoundary(segment)) return true

    const hasProjectScopedLicenseOnly =
      hasProjectScopedRestrictiveLicenseOnlySegment(segment)

    const carriesThirdParty =
      hasInheritedThirdPartyContextSegment(
        segment,
        previousSegment,
        previousSegmentCarriesThirdParty,
        isTransparentLicenseDocumentSegment,
      ) ||
      (previousSegmentCarriesThirdParty &&
        hasCarriedThirdPartyLicenseSubject(segment, previousSegment)) ||
      hasCarriedThirdPartyBodyContext(
        segment,
        previousSegment,
        aliasesByFirstWord,
      ) ||
      hasNamedThirdPartyLicenseOnly ||
      (previousSegmentCarriesThirdParty &&
        hasCarriedThirdPartyRestrictiveLicenseOnlySegment(segment)) ||
      (previousSegmentCarriesThirdParty &&
        hasStandaloneRestrictiveLicenseOnlySegment(segment))

    if (carriesThirdParty) {
      previousSegmentCarriesThirdParty = true
      continue
    }

    if (
      hasProjectScopedLicenseOnly ||
      hasStandaloneRestrictiveLicenseOnlySegment(segment)
    )
      return true

    if (hasThirdPartyBodyContextSegment(segment)) {
      previousSegmentCarriesThirdParty = true
    } else if (
      !isTransparentLicenseDocumentSegment(segment) &&
      !(
        previousSegmentCarriesThirdParty &&
        isStandaloneLicenseLabelSegment(segment)
      )
    ) {
      previousSegmentCarriesThirdParty = false
    }
  }

  return false
}

function hasBareNoLicenseMarkerSegment(segment: string): boolean {
  return /^(?:unlicensed|no license|no open source license|not open source|not licensed)$/.test(
    normalizeHeaderLoose(segment),
  )
}

function isThirdPartyNoLicenseMarkerBridgeSegment(segment: string): boolean {
  const words = aliasWords(segment)
  if (
    words.length >= 2 &&
    words.length <= 8 &&
    /^(?:author|authors|component|dependency|homepage|id|library|module|name|package|title|url|version|website)\s*[:：]\s*\S/i.test(
      segment.trim(),
    )
  ) {
    return true
  }
  if (words[0] !== 'see') return false
  if (words.length === 2) {
    return ['below', 'following'].includes(words[1])
  }
  if (words.length === 3) {
    return (
      (['license', 'licenses', 'licence', 'licences'].includes(words[1]) &&
        ['below', 'following'].includes(words[2])) ||
      (words[1] === 'following' &&
        ['license', 'licenses', 'licence', 'licences'].includes(words[2]))
    )
  }
  if (words.length === 4) {
    return (
      words[1] === 'the' &&
      ((['license', 'licenses', 'licence', 'licences'].includes(words[2]) &&
        ['below', 'following'].includes(words[3])) ||
        (words[2] === 'following' &&
          ['license', 'licenses', 'licence', 'licences'].includes(words[3])))
    )
  }
  return false
}

function hasBareNoLicenseMarkerThirdPartyContextSegment(
  segment: string,
): boolean {
  const loose = normalizeHeaderLoose(segment)
  return (
    hasExplicitThirdPartyBodyContextSegment(loose) ||
    /^(?:dependenc(?:y|ies)|components?|modules?|libraries|tools?|assets?|fonts?|plugins?|extensions?|add ons?|addons?)(?: (?:licen[cs]es?|notices?|terms))?$/.test(
      loose,
    )
  )
}

function hasBareNoLicenseMarkerBodySegments(
  segments: string[],
  licenses: LicenseEntry[],
): boolean {
  const aliasesByFirstWord = headerAliasesByFirstWord(
    getHeaderAliases(licenses),
  )
  let previousSegmentCarriesThirdParty = false

  for (const [index, segment] of segments.entries()) {
    const previousSegment = segments[index - 1]
    const hasBareNoLicenseMarker = hasBareNoLicenseMarkerSegment(segment)
    const carriesThirdParty =
      hasInheritedThirdPartyContextSegment(
        segment,
        previousSegment,
        previousSegmentCarriesThirdParty,
        isTransparentLicenseDocumentSegment,
      ) ||
      (previousSegmentCarriesThirdParty &&
        (hasCarriedThirdPartyLicenseSubject(segment, previousSegment) ||
          hasBareNoLicenseMarker ||
          isThirdPartyNoLicenseMarkerBridgeSegment(segment))) ||
      hasCarriedThirdPartyBodyContext(
        segment,
        previousSegment,
        aliasesByFirstWord,
      )

    if (carriesThirdParty) {
      previousSegmentCarriesThirdParty = true
      continue
    }

    if (!previousSegmentCarriesThirdParty && hasBareNoLicenseMarker) {
      return true
    }

    if (hasBareNoLicenseMarkerThirdPartyContextSegment(segment)) {
      previousSegmentCarriesThirdParty = true
    } else if (
      !isTransparentLicenseDocumentSegment(segment) &&
      !(
        previousSegmentCarriesThirdParty &&
        isStandaloneLicenseLabelSegment(segment)
      )
    ) {
      previousSegmentCarriesThirdParty = false
    }
  }

  return false
}

function isStandaloneLicenseLabelSegment(segment: string): boolean {
  const words = aliasWords(segment)
  return words.length === 1 && ['license', 'licence'].includes(words[0])
}

function hasExplicitProjectRestrictiveCarryBoundary(segment: string): boolean {
  const loose = normalizeHeaderLoose(segment)
  const hasProjectSubject =
    /\b(?:(?:this|the|our) (?:project|codebase|repository|repo|file|source file)|(?:these|those) files|(?:main|primary) (?:project )?(?:source|code|repository|repo|files|file|source file))\b/.test(
      loose,
    )
  if (hasProjectSubject) return hasProjectRestrictiveBodySegment(segment)

  const projectNoticeIndex = loose.search(/\bproject notice\b/)
  return (
    projectNoticeIndex >= 0 &&
    hasStandaloneRestrictiveLicenseOnlySegment(
      loose.slice(projectNoticeIndex),
      false,
    )
  )
}

function hasInheritedThirdPartyContextSegment(
  segment: string,
  previousSegment: string | undefined,
  previousSegmentCarriesThirdParty: boolean,
  isTransparentSegment: (segment: string) => boolean,
): boolean {
  return (
    previousSegmentCarriesThirdParty &&
    !hasExplicitProjectRestrictiveCarryBoundary(segment) &&
    (!previousSegment || isTransparentSegment(previousSegment))
  )
}

function hasProjectRestrictiveBodySegments(
  segments: string[],
  licenses: LicenseEntry[],
  initialThirdPartyContext = false,
): boolean {
  const aliasesByFirstWord = headerAliasesByFirstWord(
    getHeaderAliases(licenses),
  )
  let previousSegmentCarriesThirdParty = initialThirdPartyContext

  for (const [index, segment] of segments.entries()) {
    const previousSegment = segments[index - 1]
    if (hasExplicitProjectRestrictiveCarryBoundary(segment)) return true

    const carriesThirdParty =
      hasInheritedThirdPartyContextSegment(
        segment,
        previousSegment,
        previousSegmentCarriesThirdParty,
        isTransparentLicenseDocumentSegment,
      ) ||
      (previousSegmentCarriesThirdParty &&
        hasCarriedThirdPartyLicenseSubject(segment, previousSegment)) ||
      hasCarriedThirdPartyBodyContext(
        segment,
        previousSegment,
        aliasesByFirstWord,
      )
    if (carriesThirdParty) {
      previousSegmentCarriesThirdParty = true
      continue
    }

    if (isPermissiveRightsReservedCopyrightSegment(segments, index)) {
      previousSegmentCarriesThirdParty = false
      continue
    }

    if (
      !previousSegmentCarriesThirdParty &&
      (hasProjectRestrictiveBodySegment(segment, true) ||
        hasRightsReservedRestrictionTail(segments, index))
    )
      return true

    if (hasProjectRestrictiveBodySegment(segment)) return true

    if (hasThirdPartyBodyContextSegment(segment)) {
      previousSegmentCarriesThirdParty = true
    } else if (
      !isTransparentLicenseDocumentSegment(segment) &&
      !(
        previousSegmentCarriesThirdParty &&
        isStandaloneLicenseLabelSegment(segment)
      )
    ) {
      previousSegmentCarriesThirdParty = false
    }
  }

  return false
}

function bodyTextSegmentsAfterWordPrefix(
  text: string,
  prefixLength: number,
): string[] {
  const segments = bodyTextSegments(text)
  const tailSegments: string[] = []
  let seenWords = 0

  for (const segment of segments) {
    const words = aliasWords(segment)
    if (words.length === 0) continue

    const nextSeenWords = seenWords + words.length
    if (nextSeenWords <= prefixLength) {
      seenWords = nextSeenWords
      continue
    }

    if (seenWords >= prefixLength) {
      tailSegments.push(segment)
    } else {
      const tailWords = words.slice(prefixLength - seenWords)
      if (tailWords.length > 0) tailSegments.push(tailWords.join(' '))
    }
    seenWords = nextSeenWords
  }

  return tailSegments
}

function hasRightsReservedRestrictionTail(
  segments: string[],
  index: number,
): boolean {
  const loose = normalizeHeaderLoose(segments.slice(index, index + 2).join(' '))
  const context = normalizeHeaderLoose(
    segments.slice(Math.max(0, index - 1), index + 2).join(' '),
  )
  if (
    hasThirdPartyBodyContextSegment(context) ||
    /\b(?:bundled|vendored|external|included|third party|third-party)\b/.test(
      context,
    )
  )
    return false

  return hasRestrictiveRightsReservedPhrase(loose)
}

function supportedLicenseBodyTailSegments(
  segments: string[],
  licenses: LicenseEntry[],
  totalBudget: FullLicensePrefixTotalBudget,
): string[] | undefined {
  const text = segments.join(String.fromCharCode(10))
  const words = aliasWords(text)
  let longestPrefixLength: number | undefined

  for (const entry of licenses) {
    const licenseWords = licenseEntryWords(entry)
    const prefixLength = fullLicensePrefixWordLength(
      words,
      licenseWords,
      fullLicensePrefixBudget(totalBudget),
    )
    if (prefixLength === undefined) continue
    if (
      longestPrefixLength === undefined ||
      prefixLength > longestPrefixLength
    ) {
      longestPrefixLength = prefixLength
    }
  }

  if (longestPrefixLength === undefined) return undefined
  if (longestPrefixLength >= words.length) return []
  return bodyTextSegmentsAfterWordPrefix(text, longestPrefixLength)
}

function projectTailSegmentsAfterThirdPartyFullLicenseBody(
  segments: string[],
  licenses: LicenseEntry[],
):
  | {
      hasProjectRestrictiveThirdPartyBody: boolean
      segments: string[]
    }
  | undefined {
  const thirdPartySplit = splitBeforeThirdPartyFullLicenseBody(
    segments.join(String.fromCharCode(10, 10)),
    licenses,
  )
  if (!thirdPartySplit) return undefined

  return {
    hasProjectRestrictiveThirdPartyBody:
      hasStrongProjectOwnedRestrictiveBodySegments(
        bodyTextSegments(thirdPartySplit.thirdPartyBody),
      ),
    segments: bodyTextSegments(thirdPartySplit.projectBody),
  }
}

function hasRestrictiveFullBodyTailSegments(
  segments: string[],
  aliases: HeaderAlias[],
  aliasesByFirstWord: Map<string, HeaderAlias[]>,
  licenseAliasWords: string[][],
  allowBareRestrictiveTail = false,
  initialThirdPartyContext = false,
): boolean {
  let previousSegmentEnablesContinuation = true
  let previousSegmentCarriesThirdParty = initialThirdPartyContext

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const previousSegment = segments[index - 1]
    if (hasExplicitProjectRestrictiveCarryBoundary(segment)) return true

    const carriesThirdParty =
      hasInheritedThirdPartyContextSegment(
        segment,
        previousSegment,
        previousSegmentCarriesThirdParty,
        isTransparentLicenseBodySegment,
      ) ||
      (previousSegmentCarriesThirdParty &&
        hasCarriedThirdPartyLicenseSubject(segment, previousSegment)) ||
      hasCarriedThirdPartyBodyContext(
        segment,
        previousSegment,
        aliasesByFirstWord,
      )
    if (carriesThirdParty) {
      previousSegmentEnablesContinuation = false
      previousSegmentCarriesThirdParty = true
      continue
    }
    if (hasThirdPartyLicenseBodySegment(segment, aliasesByFirstWord)) {
      if (
        hasRestrictiveProjectLicenseHeaderBody(
          segment,
          aliases,
          licenseAliasWords,
        ) ||
        hasRestrictiveBareLicenseBody(
          segment,
          aliasesByFirstWord,
          licenseAliasWords,
        )
      ) {
        return true
      }
      previousSegmentEnablesContinuation = false
      previousSegmentCarriesThirdParty = true
      continue
    }

    if (isPermissiveRightsReservedCopyrightSegment(segments, index)) {
      previousSegmentEnablesContinuation = false
      previousSegmentCarriesThirdParty = false
      continue
    }

    if (
      !previousSegmentCarriesThirdParty &&
      (hasProjectRestrictiveBodySegment(segment, allowBareRestrictiveTail) ||
        hasRightsReservedRestrictionTail(segments, index))
    )
      return true

    const restrictiveContinuation = hasRestrictiveContinuationSegment(segment)
    const explicitProjectRestriction =
      hasExplicitProjectRestrictiveContinuationSegment(segment)
    const carriedThirdPartyRestriction =
      previousSegmentCarriesThirdParty &&
      hasCarriedThirdPartyRestrictiveContinuationSegment(
        segment,
        previousSegment,
      )
    if (
      restrictiveContinuation &&
      previousSegmentCarriesThirdParty &&
      (!explicitProjectRestriction || carriedThirdPartyRestriction)
    ) {
      previousSegmentCarriesThirdParty = true
      continue
    }
    if (
      (previousSegmentEnablesContinuation &&
        hasRestrictiveSegmentContinuationTail(segment)) ||
      (restrictiveContinuation &&
        (explicitProjectRestriction ||
          hasStandaloneRestrictiveScopeSegment(segment)))
    ) {
      return true
    }

    const cleanLicenseSegment = hasCleanNamedLicenseSegment(
      segment,
      aliases,
      aliasesByFirstWord,
      licenseAliasWords,
    )
    const headerWords = wordsAfterLicenseHeader(segment, licenseAliasWords)
    const projectScopedHeader =
      headerWords !== undefined &&
      hasProjectLicenseHeaderContext(segment, licenseAliasWords)
    const hasRestrictiveBody = headerWords
      ? matchesRestrictiveNamedBody(
          headerWords,
          aliases,
          licenseAliasWords,
          projectScopedHeader,
        )
      : hasRestrictiveBareLicenseBody(
          segment,
          aliasesByFirstWord,
          licenseAliasWords,
        )
    if (hasRestrictiveBody) return true

    if (cleanLicenseSegment) {
      previousSegmentEnablesContinuation = true
      previousSegmentCarriesThirdParty = false
    } else if (hasThirdPartyBodyContextSegment(segment)) {
      previousSegmentEnablesContinuation = false
      previousSegmentCarriesThirdParty = true
    } else if (
      !isTransparentLicenseBodySegment(segment) &&
      !(
        previousSegmentCarriesThirdParty &&
        isStandaloneLicenseLabelSegment(segment)
      )
    ) {
      previousSegmentEnablesContinuation = false
      previousSegmentCarriesThirdParty = false
    }
  }

  return false
}

function isTemplatePlaceholderWord(word: string): boolean {
  return word.startsWith('<') || word.endsWith('>')
}

function templatePlaceholderEnd(words: string[], index: number): number {
  let endIndex = index + 1
  while (endIndex < words.length && !words[endIndex - 1].endsWith('>')) {
    endIndex += 1
  }
  return endIndex
}

function matchFullLicensePrefixWords(
  bodyWords: string[],
  licenseWords: string[],
  bodyIndex: number,
  licenseIndex: number,
  budget: FullLicensePrefixBudget,
  stopLicenseIndex = licenseWords.length,
): number | undefined {
  while (licenseIndex < stopLicenseIndex) {
    if (bodyWords[bodyIndex] === licenseWords[licenseIndex]) {
      bodyIndex += 1
      licenseIndex += 1
      continue
    }

    if (
      licenseIndex > 0 &&
      licenseWords[licenseIndex] === 'c' &&
      licenseWords[licenseIndex - 1] === 'copyright' &&
      isTemplatePlaceholderWord(licenseWords[licenseIndex + 1] || '')
    ) {
      licenseIndex += 1
      continue
    }

    if (!isTemplatePlaceholderWord(licenseWords[licenseIndex])) {
      return undefined
    }

    let nextLicenseIndex = templatePlaceholderEnd(licenseWords, licenseIndex)
    while (isTemplatePlaceholderWord(licenseWords[nextLicenseIndex] || '')) {
      nextLicenseIndex = templatePlaceholderEnd(licenseWords, nextLicenseIndex)
    }
    if (nextLicenseIndex >= stopLicenseIndex) return bodyWords.length

    const nextLicenseWord = licenseWords[nextLicenseIndex]
    for (
      let nextBodyIndex = bodyIndex;
      nextBodyIndex < bodyWords.length;
      nextBodyIndex += 1
    ) {
      budget.anchorChecks += 1
      if (budget.totalBudget) budget.totalBudget.anchorChecks += 1
      if (budget.anchorChecks > maxFullLicensePrefixAnchorChecks)
        return undefined
      if (
        budget.totalBudget &&
        budget.totalBudget.anchorChecks > maxTotalFullLicensePrefixAnchorChecks
      )
        return undefined
      if (bodyWords[nextBodyIndex] !== nextLicenseWord) continue
      const matchedLength = matchFullLicensePrefixWords(
        bodyWords,
        licenseWords,
        nextBodyIndex,
        nextLicenseIndex,
        budget,
        stopLicenseIndex,
      )
      if (matchedLength !== undefined) return matchedLength
    }
    return undefined
  }

  return bodyIndex
}

function fullLicensePrefixWordLength(
  bodyWords: string[],
  licenseWords: string[],
  budget: FullLicensePrefixBudget,
): number | undefined {
  if (bodyWords.length > maxFullLicensePrefixBodyWords) return undefined
  return matchFullLicensePrefixWords(bodyWords, licenseWords, 0, 0, budget)
}

function hasDeclaredSpdxBodyTextWithRestrictiveTail(
  input: string,
  spdxIds: Set<string>,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
): boolean {
  const body = bodyWithoutSpdxLines(input)
  if (!body) return false

  const bodyWords = aliasWords(body)
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const aliasesByFirstWord = headerAliasesByFirstWord(aliases)
  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  for (const entry of declaredSpdxBodyEntries(spdxIds, licenseById)) {
    const licenseWords = licenseEntryWords(entry)
    const prefixLength = fullLicensePrefixWordLength(
      bodyWords,
      licenseWords,
      fullLicensePrefixBudget(totalBudget),
    )
    if (prefixLength === undefined || prefixLength >= bodyWords.length) continue

    let tailSegments = bodyTextSegmentsAfterWordPrefix(body, prefixLength)
    const thirdPartyTail = projectTailSegmentsAfterThirdPartyFullLicenseBody(
      tailSegments,
      licenses,
    )
    if (thirdPartyTail) {
      if (thirdPartyTail.hasProjectRestrictiveThirdPartyBody) return true
      if (thirdPartyTail.segments.length === 0) continue
      tailSegments = thirdPartyTail.segments
    }
    const supportedBodyTailSegments = supportedLicenseBodyTailSegments(
      tailSegments,
      licenses,
      totalBudget,
    )
    if (supportedBodyTailSegments) {
      if (supportedBodyTailSegments.length === 0) continue
      tailSegments = supportedBodyTailSegments
    }

    if (
      hasRestrictiveFullBodyTailSegments(
        tailSegments,
        aliases,
        aliasesByFirstWord,
        licenseAliasWords,
        true,
      )
    )
      return true
  }
  return false
}

function hasContainedDeclaredSpdxBodyWithRestrictiveTail(
  input: string,
  spdxIds: Set<string>,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
): boolean {
  const body = bodyWithoutSpdxLines(input)
  if (!body) return false

  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const aliasesByFirstWord = headerAliasesByFirstWord(aliases)
  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  const lineStarts = lineStartIndexes(body)
  for (const entry of declaredSpdxBodyEntries(spdxIds, licenseById)) {
    const match = containedSupportedFullLicenseAnchor(
      body,
      entry,
      fullLicensePrefixBudget(totalBudget),
      lineStarts,
    )
    if (!match) continue

    const prefixSegments = bodyTextSegments(body.slice(0, match.start)).filter(
      Boolean,
    )
    const hasProjectHeading = prefixSegments.some((segment) =>
      isNonrestrictiveLicenseHeadingPrefix(segment),
    )
    const initialThirdPartyContext =
      !hasProjectHeading &&
      prefixSegments.some((segment) => hasThirdPartyBodyContextSegment(segment))

    let tailSegments = match.tailSegments
    const thirdPartyTail = projectTailSegmentsAfterThirdPartyFullLicenseBody(
      tailSegments,
      licenses,
    )
    if (thirdPartyTail) {
      if (thirdPartyTail.hasProjectRestrictiveThirdPartyBody) return true
      if (thirdPartyTail.segments.length === 0) continue
      tailSegments = thirdPartyTail.segments
    }
    const supportedBodyTailSegments = supportedLicenseBodyTailSegments(
      tailSegments,
      licenses,
      totalBudget,
    )
    if (supportedBodyTailSegments) {
      if (supportedBodyTailSegments.length === 0) continue
      tailSegments = supportedBodyTailSegments
    }

    if (
      hasProjectRestrictiveBodySegments(
        tailSegments,
        licenses,
        initialThirdPartyContext,
      ) ||
      hasRestrictiveFullBodyTailSegments(
        tailSegments,
        aliases,
        aliasesByFirstWord,
        licenseAliasWords,
        true,
        initialThirdPartyContext,
      )
    )
      return true
  }
  return false
}

function hasSupportedBodyTextWithRestrictiveTail(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const body = bodyWithoutSpdxLines(input)
  if (!body) return false

  const bodyWords = aliasWords(body)
  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const aliasesByFirstWord = headerAliasesByFirstWord(aliases)
  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  for (const entry of licenses) {
    const licenseWords = licenseEntryWords(entry)
    const prefixLength = fullLicensePrefixWordLength(
      bodyWords,
      licenseWords,
      fullLicensePrefixBudget(totalBudget),
    )
    if (prefixLength === undefined || prefixLength >= bodyWords.length) continue

    let tailSegments = bodyTextSegmentsAfterWordPrefix(body, prefixLength)
    const supportedBodyTailSegments = supportedLicenseBodyTailSegments(
      tailSegments,
      licenses,
      totalBudget,
    )
    if (supportedBodyTailSegments) {
      if (supportedBodyTailSegments.length === 0) continue
      tailSegments = supportedBodyTailSegments
    }

    if (
      hasRestrictiveFullBodyTailSegments(
        tailSegments,
        aliases,
        aliasesByFirstWord,
        licenseAliasWords,
        true,
      )
    )
      return true
  }
  return false
}

function hasSupportedBodyTextWithSpdxLikeTail(
  input: string,
  licenses: LicenseEntry[],
  knownIds: Set<string>,
): boolean {
  const body = bodyWithoutInactiveRestrictiveLicenseLabelValueDeclarations(
    bodyWithoutSpdxLines(input, knownIds),
  )
  if (!body) return false

  const bodyWords = aliasWords(body)
  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  for (const entry of licenses) {
    const prefixLength = fullLicensePrefixWordLength(
      bodyWords,
      licenseEntryWords(entry),
      fullLicensePrefixBudget(totalBudget),
    )
    if (prefixLength === undefined || prefixLength >= bodyWords.length) continue

    let tailSegments = bodyTextSegmentsAfterWordPrefix(body, prefixLength)
    const supportedBodyTailSegments = supportedLicenseBodyTailSegments(
      tailSegments,
      licenses,
      totalBudget,
    )
    if (supportedBodyTailSegments) {
      if (supportedBodyTailSegments.length === 0) continue
      tailSegments = supportedBodyTailSegments
    }

    if (
      hasUndeclaredSpdxLikeBodyDeclaration(
        tailSegments.join(String.fromCharCode(10)),
        new Set([entry.licenseId]),
        knownIds,
      )
    )
      return true
  }
  return false
}

function hasSupportedNormalizedBodyWithRestrictiveTail(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const normalizedInput = normalizeStrict(input.trim())
  const normalizedLicenses = normalizedLicenseTexts(licenses)
  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  return normalizedLicenses.some((normalizedLicenseText) => {
    if (
      normalizedInput === normalizedLicenseText ||
      !normalizedInput.startsWith(normalizedLicenseText)
    ) {
      return false
    }

    const tail = normalizedInput.slice(normalizedLicenseText.length).trim()
    if (!tail) return false
    const supportedBodyTailSegments = supportedLicenseBodyTailSegments(
      bodyTextSegments(tail),
      licenses,
      totalBudget,
    )
    if (supportedBodyTailSegments) {
      if (supportedBodyTailSegments.length === 0) return false
      const supportedBodyTail = supportedBodyTailSegments.join(
        String.fromCharCode(10),
      )
      return (
        hasProjectRestrictiveBodySegment(supportedBodyTail, true) ||
        hasRestrictiveSegmentContinuationTail(supportedBodyTail)
      )
    }
    return (
      hasProjectRestrictiveBodySegment(tail, true) ||
      hasRestrictiveSegmentContinuationTail(tail)
    )
  })
}

function hasRestrictiveNamedSpdxBody(
  input: string,
  licenses: LicenseEntry[],
): boolean {
  const body = bodyWithoutSpdxLines(input)
  if (!body) return false

  const aliases = getHeaderAliases(licenses)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const aliasesByFirstWord = headerAliasesByFirstWord(aliases)
  const segments = bodyTextSegments(body)
  let previousSegmentEnablesContinuation = false
  let previousSegmentCarriesThirdParty = false

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const carriesThirdParty =
      (previousSegmentCarriesThirdParty &&
        hasCarriedThirdPartyLicenseSubject(segment, segments[index - 1])) ||
      hasCarriedThirdPartyBodyContext(
        segment,
        segments[index - 1],
        aliasesByFirstWord,
      )
    if (carriesThirdParty) {
      previousSegmentEnablesContinuation = false
      previousSegmentCarriesThirdParty = true
      continue
    }
    if (hasThirdPartyLicenseBodySegment(segment, aliasesByFirstWord)) {
      if (
        hasRestrictiveProjectLicenseHeaderBody(
          segment,
          aliases,
          licenseAliasWords,
        ) ||
        hasRestrictiveBareLicenseBody(
          segment,
          aliasesByFirstWord,
          licenseAliasWords,
        )
      ) {
        return true
      }
      previousSegmentEnablesContinuation = false
      previousSegmentCarriesThirdParty = true
      continue
    }

    const restrictiveContinuation = hasRestrictiveContinuationSegment(segment)
    const explicitProjectRestriction =
      hasExplicitProjectRestrictiveContinuationSegment(segment)
    const carriedThirdPartyRestriction =
      previousSegmentCarriesThirdParty &&
      hasCarriedThirdPartyRestrictiveContinuationSegment(
        segment,
        segments[index - 1],
      )
    if (
      restrictiveContinuation &&
      previousSegmentCarriesThirdParty &&
      (!explicitProjectRestriction || carriedThirdPartyRestriction)
    ) {
      previousSegmentCarriesThirdParty = true
      continue
    }
    if (
      (previousSegmentEnablesContinuation &&
        hasRestrictiveSegmentContinuationTail(segment)) ||
      (restrictiveContinuation &&
        ((previousSegmentEnablesContinuation &&
          !hasThirdPartyBodyContextSegment(segment)) ||
          explicitProjectRestriction ||
          hasStandaloneRestrictiveScopeSegment(segment)))
    ) {
      return true
    }

    const cleanLicenseSegment = hasCleanNamedLicenseSegment(
      segment,
      aliases,
      aliasesByFirstWord,
      licenseAliasWords,
    )
    const headerWords = wordsAfterLicenseHeader(segment, licenseAliasWords)
    const projectScopedHeader =
      headerWords !== undefined &&
      hasProjectLicenseHeaderContext(segment, licenseAliasWords)
    const hasRestrictiveBody = headerWords
      ? matchesRestrictiveNamedBody(
          headerWords,
          aliases,
          licenseAliasWords,
          projectScopedHeader,
        )
      : hasRestrictiveBareLicenseBody(
          segment,
          aliasesByFirstWord,
          licenseAliasWords,
        )
    if (hasRestrictiveBody) return true

    if (cleanLicenseSegment) {
      previousSegmentEnablesContinuation = true
      previousSegmentCarriesThirdParty = false
    } else if (hasThirdPartyBodyContextSegment(segment)) {
      previousSegmentEnablesContinuation = false
      previousSegmentCarriesThirdParty = true
    } else if (
      !isTransparentLicenseBodySegment(segment) &&
      !(
        previousSegmentCarriesThirdParty &&
        isStandaloneLicenseLabelSegment(segment)
      )
    ) {
      previousSegmentEnablesContinuation = false
      previousSegmentCarriesThirdParty = false
    }
  }

  return false
}

function hasProjectRestrictiveBodySegment(
  segment: string,
  allowBareRestrictiveTail = false,
): boolean {
  const loose = normalizeHeaderLoose(segment)
  const projectScopePattern =
    /\b(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|component|product|service|code|source|work|file|source file)|(?:these|those) files|(?:main|primary) (?:project )?(?:source|code|software|package|library|program|application|repository|repo|files|file|source file))\b/

  if (/\ball rights reserved\b/.test(loose)) {
    if (hasDirectProjectAllRightsReserved(loose)) return true
    if (
      projectOwnedRestrictiveStatePattern.test(loose) ||
      projectOwnedRestrictiveActionPattern.test(loose) ||
      projectOwnedRestrictiveUseLimitPattern.test(loose)
    )
      return true
    // Project-owned guards above must run before this third-party exclusion.
    if (
      hasThirdPartySubjectAllRightsReserved(loose) ||
      isThirdPartyOwnedHeaderContext(loose) ||
      hasExplicitThirdPartyBodyContextSegment(segment)
    )
      return false
    if (projectScopePattern.test(loose)) return true
    const withoutTrailingRights = loose
      .replace(/\ball rights reserved\.?$/, '')
      .trim()
    if (
      withoutTrailingRights !== loose &&
      /^copyright(?: <year>)?(?: [a-z0-9<>]+){0,128}$/.test(
        withoutTrailingRights,
      )
    )
      return false
    return allowBareRestrictiveTail
  }
  if (
    /\bcommons clause\b/.test(loose) &&
    (allowBareRestrictiveTail || projectScopePattern.test(loose))
  )
    return true
  if (
    /\blicenseref (?:proprietary|closed source|confidential)\b/.test(loose) &&
    (allowBareRestrictiveTail || projectScopePattern.test(loose))
  )
    return true
  if (
    /^(?:proprietary|closed source|source available only|source code available only|confidential|nondisclosure|non disclosure)(?: (?:and|or) (?:proprietary|closed source|source available only|source code available only|confidential|nondisclosure|non disclosure))*$/.test(
      loose,
    )
  ) {
    return allowBareRestrictiveTail
  }
  if (
    /^(?:unlicensed|no license|no open source license|not open source|not licensed)$/.test(
      loose,
    )
  ) {
    return allowBareRestrictiveTail
  }
  if (hasGenericNegatedProjectLicenseLabelLine(loose)) {
    if (hasNegatedProjectScopeLicenseOnlyLine(loose)) return false
    if (
      hasThirdPartyBodyContextSegment(segment) &&
      !hasStrongProjectNegationSubject(segment)
    )
      return false
    return true
  }
  // Named third-party components can look project-scoped through the noun.
  if (hasNamedThirdPartyRestrictiveLicenseOnlySegment(segment)) return false
  if (allowBareRestrictiveTail && hasStandaloneRestrictiveScopeSegment(segment))
    return true
  if (
    allowBareRestrictiveTail &&
    hasStandaloneRestrictiveLicenseOnlySegment(segment)
  )
    return true
  if (
    hasRestrictiveModalProhibition(segment) &&
    (allowBareRestrictiveTail || projectScopePattern.test(loose))
  )
    return true
  if (
    (hasPermissionRequiredRestrictionAt(aliasWords(segment), 0) ||
      hasSourceDisclosureRequirementAt(aliasWords(segment), 0)) &&
    (allowBareRestrictiveTail || projectScopePattern.test(loose))
  )
    return true
  if (
    /\b(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|component|product|service|code|source|work|file|source file)|(?:these|those) files|(?:main|primary) (?:project )?(?:source|code|software|package|library|program|application|repository|repo|files|file|source file)) (?:is|are|was|were|remains|remain|has been|have been) (?:proprietary|closed source|confidential|nondisclosure|non disclosure)\b/.test(
      loose,
    )
  )
    return true
  if (projectOwnedNoLicensePattern.test(loose)) return true
  if (hasProjectScopedRestrictiveLicenseOnlySegment(segment)) return true
  if (
    /\b(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|component|product|service|code|source|work|file|source file)|(?:these|those) files|(?:main|primary) (?:project )?(?:source|code|software|package|library|program|application|repository|repo|files|file|source file)) (?:is|are|was|were|has been|have been) for (?:commercial|noncommercial|non commercial|internal|private|evaluation|academic|educational|nonprofit|non profit|personal|research|test|testing|trial|demo) (?:use|usage|distribution|redistribution) only\b/.test(
      loose,
    )
  )
    return true
  if (hasProjectAndDependencyRestrictiveState(loose)) return true
  if (allowBareRestrictiveTail && noGrantRestrictiveTailPattern.test(loose))
    return true
  return /\b(?:no permission is granted|permission is not granted) (?:to (?:(?:(?:use|copy|modify|distribute|redistribute),?|and|or) )+|for )(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|component|product|service|code|source|work)\b/.test(
    loose,
  )
}

function hasNegatedProjectScopeLicenseOnlyLine(line: string): boolean {
  return /\b(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|component|product|service|code|source|work|file|source file) (?:is|are|was|were|has been|have been) not (?:(?:licensed|released|distributed) )?(?:under|with) (?:(?:the )?terms of )?(?:a |an |the )?(?:(?:non commercial|non profit)|commercial|noncommercial|nonprofit|internal|private|demo|documentation|evaluation|academic|educational|personal|research|test|testing|trial) licen[cs]e only\b/.test(
    line,
  )
}

function hasProjectRestrictiveSpdxBody(
  input: string,
  licenses: LicenseEntry[],
  options: {
    allowBareRestrictiveTail?: boolean
    knownIds?: Set<string>
  } = {},
): boolean {
  const body = bodyWithoutSpdxLines(input, options.knownIds)
  if (!body) return false
  const allowBareRestrictiveTail = options.allowBareRestrictiveTail ?? true

  const aliases = getHeaderAliases(licenses)
  const aliasesByFirstWord = headerAliasesByFirstWord(aliases)
  const segments = bodyTextSegments(body)
  let previousSegmentCarriesThirdParty = false

  for (const [index, segment] of segments.entries()) {
    if (hasExplicitProjectRestrictiveCarryBoundary(segment)) return true

    const carriesThirdParty =
      (previousSegmentCarriesThirdParty &&
        hasCarriedThirdPartyLicenseSubject(segment, segments[index - 1])) ||
      hasCarriedThirdPartyBodyContext(
        segment,
        segments[index - 1],
        aliasesByFirstWord,
      )
    if (carriesThirdParty) {
      previousSegmentCarriesThirdParty = true
      continue
    }

    if (isPermissiveRightsReservedCopyrightSegment(segments, index)) {
      previousSegmentCarriesThirdParty = false
      continue
    }

    const loose = normalizeHeaderLoose(segment)
    if (
      !previousSegmentCarriesThirdParty &&
      (hasProjectRestrictiveBodySegment(segment, allowBareRestrictiveTail) ||
        hasRightsReservedRestrictionTail(segments, index))
    )
      return true

    const hasProjectScope =
      /\b(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|component|product|service|code|source|work)|(?:these|those) files|(?:main|primary) (?:project )?(?:source|code|software|package|library|program|application|repository|repo|files))\b/.test(
        loose,
      )
    if (!hasProjectScope) {
      if (hasThirdPartyBodyContextSegment(segment)) {
        previousSegmentCarriesThirdParty = true
      } else if (
        !isTransparentLicenseDocumentSegment(segment) &&
        !(
          previousSegmentCarriesThirdParty &&
          isStandaloneLicenseLabelSegment(segment)
        )
      ) {
        previousSegmentCarriesThirdParty = false
      }
      continue
    }

    if (
      /\b(?:(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|component|product|service|code|source|work)|(?:these|those) files|(?:main|primary) (?:project )?(?:source|code|software|package|library|program|application|repository|repo|files)) (?:is|are|was|were|remains|remain|has been|have been) (?:proprietary|closed source)\b/.test(
        loose,
      )
    )
      return true
    if (
      /\b(?:no permission is granted|permission is not granted) (?:to (?:(?:(?:use|copy|modify|distribute|redistribute),?|and|or) )+|for )(?:this|the|our) (?:project|codebase|software|package|repository|repo|library|program|application|component|product|service|code|source|work)\b/.test(
        loose,
      )
    ) {
      return true
    }

    previousSegmentCarriesThirdParty =
      isThirdPartyOwnedHeaderContext(loose) ||
      hasExplicitThirdPartyBodyContextSegment(segment)
  }

  return false
}

function hasDeclaredGnuCounterpartExactBody(
  input: string,
  spdxIds: Set<string>,
  licenseById: Map<string, LicenseEntry>,
): boolean {
  const body = bodyWithoutSpdxLines(input)
  if (!body) return false

  for (const entry of declaredSpdxBodyEntries(spdxIds, licenseById)) {
    const score = scoreText(body, entry.text)
    if (score.f1 >= 0.98 && score.precision >= 0.98 && score.recall >= 0.98) {
      return true
    }
  }

  return false
}

function negatedDeclaredSpdxIds(
  input: string,
  spdxIds: Set<string>,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
): Set<string> {
  const body = bodyWithoutSpdxLines(input)
  if (!body) return new Set()

  const aliases = getHeaderAliases(licenses)
  const aliasesByFirstWord = headerAliasesByFirstWord(aliases)
  const licenseAliasWords = aliases.map((alias) => alias.words)
  const declaredIds = new Set(
    declaredSpdxBodyEntries(spdxIds, licenseById).map(
      (entry) => entry.licenseId,
    ),
  )
  const declaredAliases = aliases.filter((alias) =>
    declaredIds.has(alias.licenseId),
  )
  const negatedIds = new Set<string>()
  const segments = bodyTextSegments(body)
  let previousSegmentCarriesThirdParty = false

  for (const [index, segment] of segments.entries()) {
    const carriesThirdParty =
      previousSegmentCarriesThirdParty ||
      hasCarriedThirdPartyBodyContext(
        segment,
        segments[index - 1],
        aliasesByFirstWord,
      ) ||
      hasThirdPartyBodyContextSegment(segment)
    const projectScopedNegation = hasStrongProjectNegationSubject(segment)
    if (carriesThirdParty && !projectScopedNegation) {
      previousSegmentCarriesThirdParty = true
      continue
    }

    const looseSegment = normalizeHeaderLoose(segment)
    if (
      hasGenericNegatedProjectLicenseLabelLine(looseSegment) &&
      !hasNegatedProjectScopeLicenseOnlyLine(looseSegment)
    )
      return declaredIds
    for (const alias of declaredAliases) {
      if (hasNegatedLicenseWordsInText(segment, alias.words, licenseAliasWords))
        negatedIds.add(alias.licenseId)
    }

    if (hasThirdPartyBodyContextSegment(segment)) {
      previousSegmentCarriesThirdParty = true
    } else if (
      !isTransparentLicenseDocumentSegment(segment) &&
      !(
        previousSegmentCarriesThirdParty &&
        isStandaloneLicenseLabelSegment(segment)
      )
    ) {
      previousSegmentCarriesThirdParty = false
    }
  }

  return negatedIds
}

function hasPureOrSpdxExpression(expression: string | undefined): boolean {
  const upper = expression?.toUpperCase() || ''
  return (
    /\s+OR\s+/.test(upper) &&
    !/\s+AND\s+/.test(upper) &&
    !/\s+WITH\s+/.test(upper)
  )
}

function isNonrestrictiveLicenseHeadingPrefix(prefix: string): boolean {
  const segments = bodyTextSegments(prefix)
    .map((segment) => normalizeHeaderLoose(segment))
    .filter(Boolean)
  if (segments.length === 0) return true

  return segments.every((segment) =>
    /^(?:(?:main|primary) project |project |source |repository |repo |package )?licen[cs]e(?: text| terms| notice)?$/.test(
      segment,
    ),
  )
}

function hasDeclaredSpdxBodyAfterNonrestrictiveContextPrefix(
  input: string,
  spdxIds: Set<string>,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
): boolean {
  const body = bodyWithoutSpdxLines(input)
  if (!body) return false

  const totalBudget: FullLicensePrefixTotalBudget = { anchorChecks: 0 }
  const lineStarts = lineStartIndexes(body)
  for (const entry of declaredSpdxBodyEntries(spdxIds, licenseById)) {
    const match = containedSupportedFullLicenseAnchor(
      body,
      entry,
      fullLicensePrefixBudget(totalBudget),
      lineStarts,
    )
    if (!match) continue

    const prefixSegments = bodyTextSegments(body.slice(0, match.start)).filter(
      Boolean,
    )
    if (
      prefixSegments.some((segment) =>
        hasProjectOwnedRestrictiveStatement(segment),
      ) ||
      hasProjectRestrictiveBodySegments(prefixSegments, licenses)
    )
      continue

    if (
      prefixSegments.length > 0 &&
      prefixSegments.every(
        (segment) =>
          hasThirdPartyBodyContextSegment(segment) ||
          isTransparentLicenseDocumentSegment(segment) ||
          isNonrestrictiveLicenseHeadingPrefix(segment),
      )
    ) {
      return true
    }
  }
  return false
}

function cleanDeclaredProjectBodyBeforeThirdPartyFullLicense(
  thirdPartySplit: { projectBody: string; thirdPartyBody: string },
  declaredEntries: LicenseEntry[],
  spdxIds: Set<string>,
  licenses: LicenseEntry[],
): {
  hasConflictingProjectBody: boolean
  hasDeclaredProjectBody: boolean
  hasProjectRestrictiveThirdPartyBody: boolean
  hasRestrictiveProjectBody: boolean
} {
  const hasProjectRestrictiveThirdPartyBody =
    hasStrongProjectOwnedRestrictiveBodySegments(
      bodyTextSegments(thirdPartySplit.thirdPartyBody),
    )

  const projectBodySegments = bodyTextSegments(thirdPartySplit.projectBody)
  const declaredProjectBodyBudget: FullLicensePrefixTotalBudget = {
    anchorChecks: 0,
  }
  let hasDeclaredProjectBody = false
  let hasDeclaredProjectBodyAfterHeading = false
  for (const entry of declaredEntries) {
    const match = containedSupportedFullLicenseAnchor(
      thirdPartySplit.projectBody,
      entry,
      fullLicensePrefixBudget(declaredProjectBodyBudget),
    )
    if (!match) continue
    hasDeclaredProjectBody = true
    if (
      isNonrestrictiveLicenseHeadingPrefix(
        thirdPartySplit.projectBody.slice(0, match.start),
      )
    ) {
      hasDeclaredProjectBodyAfterHeading = true
    }
  }

  const hasRestrictiveProjectPrefix =
    hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
      thirdPartySplit.projectBody,
      licenses,
    ) && !hasDeclaredProjectBodyAfterHeading
  const hasRestrictiveProjectTail =
    hasRestrictiveTailAfterContainedSupportedFullLicenseBody(
      thirdPartySplit.projectBody,
      licenses,
    )
  const hasRestrictiveProjectSpdxBody =
    !hasDeclaredProjectBodyAfterHeading &&
    hasProjectRestrictiveSpdxBody(thirdPartySplit.projectBody, licenses, {
      allowBareRestrictiveTail: false,
    })
  const hasRestrictiveProjectBody =
    hasStrongProjectOwnedRestrictiveBodySegments(projectBodySegments) ||
    hasRestrictiveProjectPrefix ||
    hasRestrictiveProjectTail ||
    hasRestrictiveProjectSpdxBody
  const conflictingProjectBodyBudget: FullLicensePrefixTotalBudget = {
    anchorChecks: 0,
  }
  const projectBodyWordCount = aliasWords(thirdPartySplit.projectBody).length
  const hasConflictingProjectBody = licenses.some(
    (entry) =>
      !spdxIds.has(entry.licenseId) &&
      hasSupportedFullLicenseBodyMatch(
        thirdPartySplit.projectBody,
        entry,
        fullLicensePrefixBudget(conflictingProjectBodyBudget),
        projectBodyWordCount,
      ),
  )

  return {
    hasConflictingProjectBody,
    hasDeclaredProjectBody,
    hasProjectRestrictiveThirdPartyBody,
    hasRestrictiveProjectBody,
  }
}

function hasRestrictiveSpdxBodyConflict(
  input: string,
  spdxIds: Set<string>,
  licenses: LicenseEntry[],
  licenseById: Map<string, LicenseEntry>,
  knownIds: Set<string>,
  spdxExpression?: string,
): boolean {
  const body = bodyWithoutInactiveRestrictiveLicenseLabelValueDeclarations(
    bodyWithoutSpdxLines(input, knownIds),
  )
  const declaredEntries = declaredSpdxBodyEntries(spdxIds, licenseById)
  const hasDeclaredEntries = declaredEntries.length > 0
  const thirdPartySplit = body
    ? splitBeforeThirdPartyFullLicenseBody(body, licenses)
    : undefined
  let cachedCleanDeclaredThirdPartyBody:
    | ReturnType<typeof cleanDeclaredProjectBodyBeforeThirdPartyFullLicense>
    | undefined
  const getCleanDeclaredThirdPartyBody = ():
    | ReturnType<typeof cleanDeclaredProjectBodyBeforeThirdPartyFullLicense>
    | undefined => {
    if (!thirdPartySplit) return undefined
    cachedCleanDeclaredThirdPartyBody ??=
      cleanDeclaredProjectBodyBeforeThirdPartyFullLicense(
        thirdPartySplit,
        declaredEntries,
        spdxIds,
        licenses,
      )
    return cachedCleanDeclaredThirdPartyBody
  }
  let cachedSupportedSpdxBodyResults: MatchResult[] | undefined
  const getSupportedSpdxBodyResults = (): MatchResult[] => {
    cachedSupportedSpdxBodyResults ??= supportedSpdxBodyResults(
      input,
      licenses,
      licenseById,
      knownIds,
    )
    return cachedSupportedSpdxBodyResults
  }
  const cleanDeclaredThirdPartyBody = hasDeclaredEntries
    ? getCleanDeclaredThirdPartyBody()
    : undefined
  const hasCleanDeclaredProjectBodyBeforeThirdParty =
    hasDeclaredEntries &&
    cleanDeclaredThirdPartyBody?.hasDeclaredProjectBody &&
    !cleanDeclaredThirdPartyBody.hasProjectRestrictiveThirdPartyBody &&
    !cleanDeclaredThirdPartyBody.hasRestrictiveProjectBody &&
    !cleanDeclaredThirdPartyBody.hasConflictingProjectBody
  if (
    body &&
    !/\r|\n/.test(body) &&
    !mayContainSupportedFullLicenseBody(body, licenses) &&
    hasRestrictiveLicenseLabelSuffix(body) &&
    !hasRestrictiveDependencyNote(body)
  )
    return true
  if (
    body &&
    /\r|\n/.test(body) &&
    !mayContainSupportedFullLicenseBody(body, licenses) &&
    hasRestrictiveDependencyNoteConflict(body)
  )
    return true
  if (body && hasRestrictiveLicenseLabelValueDeclaration(body)) return true
  if (
    body &&
    hasRestrictiveLicenseLabelDeclaration(body, licenses) &&
    !hasCleanDeclaredProjectBodyBeforeThirdParty
  )
    return true
  if (body && hasUndeclaredSpdxLikeBodyDeclaration(body, spdxIds, knownIds)) {
    return true
  }

  const hasPureOrDeclaredBody =
    hasPureOrSpdxExpression(spdxExpression) &&
    getSupportedSpdxBodyResults().some((result) =>
      spdxIds.has(result.licenseId),
    )
  const hasDeclaredBodyRestrictiveTail =
    hasDeclaredSpdxBodyTextWithRestrictiveTail(
      body,
      spdxIds,
      licenses,
      licenseById,
    ) ||
    hasContainedDeclaredSpdxBodyWithRestrictiveTail(
      body,
      spdxIds,
      licenses,
      licenseById,
    )
  const hasDeclaredBodyAfterNonrestrictivePrefix =
    hasDeclaredSpdxBodyAfterNonrestrictiveContextPrefix(
      body,
      spdxIds,
      licenses,
      licenseById,
    )
  if (
    !thirdPartySplit &&
    hasPureOrDeclaredBody &&
    !hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
      body,
      licenses,
    ) &&
    !hasDeclaredBodyRestrictiveTail &&
    !hasProjectRestrictiveSpdxBody(body, licenses, {
      allowBareRestrictiveTail: false,
      knownIds,
    })
  )
    return false
  if (hasDeclaredEntries) {
    const negatedIds = negatedDeclaredSpdxIds(
      input,
      spdxIds,
      licenses,
      licenseById,
    )
    if (negatedIds.size > 0) {
      const hasUnnegatedAlternativeBody =
        hasPureOrSpdxExpression(spdxExpression) &&
        getSupportedSpdxBodyResults().some(
          (result) =>
            spdxIds.has(result.licenseId) && !negatedIds.has(result.licenseId),
        )
      if (hasUnnegatedAlternativeBody) return false
      return true
    }
  }
  if (hasCleanDeclaredProjectBodyBeforeThirdParty) return false
  if (
    !thirdPartySplit &&
    hasDeclaredBodyAfterNonrestrictivePrefix &&
    !hasDeclaredBodyRestrictiveTail
  )
    return false

  if (thirdPartySplit) {
    const thirdPartyBody = getCleanDeclaredThirdPartyBody()
    const hasProjectRestrictiveThirdPartyBody =
      thirdPartyBody?.hasProjectRestrictiveThirdPartyBody ?? false
    const hasRestrictiveThirdPartyBody =
      hasProjectRestrictiveThirdPartyBody ||
      hasRestrictiveThirdPartyFullLicenseBody(
        thirdPartySplit.thirdPartyBody,
        licenses,
      )
    const hasDeclaredProjectBody =
      thirdPartyBody?.hasDeclaredProjectBody ?? false
    const hasRestrictiveProjectBody =
      thirdPartyBody?.hasRestrictiveProjectBody ?? false
    const hasConflictingProjectBody =
      thirdPartyBody?.hasConflictingProjectBody ?? false
    if (
      !hasProjectRestrictiveThirdPartyBody &&
      !hasRestrictiveProjectBody &&
      hasDeclaredProjectBody &&
      !hasConflictingProjectBody
    )
      return false
    if (
      !hasRestrictiveProjectBody &&
      hasPureOrSpdxExpression(spdxExpression) &&
      getSupportedSpdxBodyResults().some((result) =>
        spdxIds.has(result.licenseId),
      )
    )
      return false
    if (
      !hasRestrictiveThirdPartyBody &&
      !hasRestrictiveProjectBody &&
      (hasDeclaredProjectBody || !hasConflictingProjectBody)
    )
      return false
  }

  if (!hasDeclaredEntries) {
    if (
      hasSupportedBodyTextWithRestrictiveTail(input, licenses) ||
      hasSupportedNormalizedBodyWithRestrictiveTail(input, licenses)
    )
      return true
    if (
      hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
        input,
        licenses,
      )
    )
      return true
    if (getSupportedSpdxBodyResults().length > 0) return false
    if (hasProjectRestrictiveSpdxBody(input, licenses)) return true
    return false
  }

  if (hasDeclaredBodyRestrictiveTail) return true
  if (
    hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
      body,
      licenses,
    )
  )
    return true
  if (
    hasDeclaredGnuCounterpartExactBody(body, spdxIds, licenseById) ||
    hasDeclaredSpdxBodyPrefix(body, spdxIds, licenseById)
  )
    return false
  if (body && isPermissiveCopyrightNoticePrefix(body)) return false
  if (hasProjectRestrictiveSpdxBody(body, licenses)) return true

  return hasRestrictiveNamedSpdxBody(body, licenses)
}

export interface RankOptions {
  includeDiffs?: boolean
}

const diffInputSymbol = Symbol('diffInput')

type MatchResultWithDiffInput = MatchResult & {
  [diffInputSymbol]?: string
}

function attachDiffInput(
  results: MatchResult[],
  diffInput: string,
): MatchResult[] {
  return results.map((result) => {
    const resultWithDiffInput = { ...result } as MatchResultWithDiffInput
    Object.defineProperty(resultWithDiffInput, diffInputSymbol, {
      value: diffInput,
      enumerable: true,
    })
    return resultWithDiffInput
  })
}

function diffDetailsForResult(
  input: string,
  result: MatchResult,
  licenses: LicenseEntry[],
): Pick<MatchResult, 'diff' | 'diffSegments'> | undefined {
  const entry = licenses.find(
    (license) => license.licenseId === result.licenseId,
  )
  if (!entry) return undefined

  const resultDiffInput = (result as MatchResultWithDiffInput)[diffInputSymbol]
  const trimmedInput = (resultDiffInput || input).trim()
  let diffInput = trimmedInput
  if (
    result.inputType !== 'spdx-expression' &&
    hasSpdxIdentifierDeclarationLine(trimmedInput)
  ) {
    const knownIds = knownIdsFor(licenses)
    diffInput = bodyWithoutSpdxLines(trimmedInput, knownIds)
    if (!detectSpdxIdentifier(trimmedInput, knownIds)) {
      diffInput =
        bodyWithoutBenignMalformedSpdxAnnotationLines(
          trimmedInput,
          knownIds,
          getHeaderAliases(licenses),
        ) || diffInput
    }
    if (!diffInput) return undefined
  }
  const normalizedInput = normalizeStrict(diffInput)
  const normalizedLicenseText = normalizeStrict(entry.text)
  if (normalizedInput === normalizedLicenseText) {
    const diffSegments: MatchResult['diffSegments'] = [
      {
        type: 'equal',
        text: 'No material differences after normalization.',
      },
    ]
    return {
      diff: formatDiffSegments(diffSegments),
      diffSegments,
    }
  }

  const diffSegments = explainNormalizedDiffSegments(
    normalizedInput,
    normalizedLicenseText,
  )
  return {
    diff: formatDiffSegments(diffSegments),
    diffSegments,
  }
}

function resultsWithDiffDetails(
  input: string,
  results: MatchResult[],
  licenses: LicenseEntry[],
  includeDiffs = true,
): MatchResult[] {
  if (!includeDiffs) return results
  return results.map((result, index) => {
    if (index >= maxDiffResults) return result

    const diffDetails = diffDetailsForResult(input, result, licenses)
    return diffDetails ? { ...result, ...diffDetails } : result
  })
}

export function diffForResult(
  input: string,
  result: MatchResult,
  licenses: LicenseEntry[],
): string | undefined {
  return diffDetailsForResult(input, result, licenses)?.diff
}

export function diffSegmentsForResult(
  input: string,
  result: MatchResult,
  licenses: LicenseEntry[],
): MatchResult['diffSegments'] {
  return diffDetailsForResult(input, result, licenses)?.diffSegments
}

export function rankLicenses(
  input: string,
  licenses: LicenseEntry[],
  options: RankOptions = {},
): MatchResponse {
  if (input.length > maxInputSize || new Blob([input]).size > maxInputSize) {
    resetInputShingleCache()
    return {
      inputType: 'unknown',
      results: [],
      message: inputTooLargeMessage,
    }
  }

  const trimmed = input.trim()
  const knownIds = knownIdsFor(licenses)

  let licenseById = licenseByIdCache.get(licenses)
  if (!licenseById) {
    licenseById = new Map(
      licenses.map((license) => [license.licenseId, license]),
    )
    licenseByIdCache.set(licenses, licenseById)
  }
  const headerAliases = getHeaderAliases(licenses)
  const spdx = detectSpdxIdentifier(trimmed, knownIds)
  const hasSpdxDeclarationLine = hasSpdxIdentifierDeclarationLine(trimmed)
  const hasMalformedSpdxLine = !spdx && hasSpdxDeclarationLine
  const inputType = spdx
    ? 'spdx-expression'
    : hasMalformedSpdxLine
      ? 'unknown'
      : classifyInput(trimmed, knownIds)

  if (!trimmed) {
    resetInputShingleCache()
    return {
      inputType: 'unknown',
      results: [],
      message: 'Paste license text to identify it.',
    }
  }

  const leadingBareSpdx = leadingBareSpdxDeclaration(trimmed, knownIds)

  const malformedSpdxBody = hasMalformedSpdxLine
    ? bodyWithoutBenignMalformedSpdxAnnotationLines(
        trimmed,
        knownIds,
        headerAliases,
      )
    : ''
  const malformedSpdxBodyResults = hasMalformedSpdxLine
    ? supportedSpdxBodyResults(
        trimmed,
        licenses,
        licenseById,
        knownIds,
        headerAliases,
      )
    : []
  const malformedSpdxDeclaredIds = hasMalformedSpdxLine
    ? supportedSpdxLineIds(trimmed, knownIds)
    : new Set<string>()
  const hasOnlyMalformedSpdxNamedHeaderFallback =
    hasMalformedSpdxLine &&
    !hasNonSpdxBodyLine(trimmed) &&
    malformedSpdxNamedHeaderInputs(trimmed, knownIds, headerAliases).some(
      (input) => input.allowHeaderFallback,
    )
  const hasMultipleMalformedSpdxDeclarationReferences =
    hasMalformedSpdxLine &&
    hasMultipleSpdxLikeDeclarationReferences(trimmed, knownIds, headerAliases)
  const hasOnlyMalformedSpdxHeaderBodyResults =
    hasMultipleMalformedSpdxDeclarationReferences &&
    malformedSpdxBodyResults.length > 0 &&
    malformedSpdxBodyResults.every(
      (result) => result.inputType === 'license-header',
    )
  const hasMalformedSpdxRestrictiveNamedHeaderTail =
    hasMalformedSpdxLine &&
    hasMalformedSpdxNamedHeaderRestrictiveTail(trimmed, headerAliases)
  const hasThirdPartyMalformedSpdxBodyLicenseContext =
    hasMalformedSpdxLine &&
    malformedSpdxBody &&
    (hasThirdPartyLicenseLabelFullBodyContextForAliases(
      malformedSpdxBody,
      headerAliases,
    ) ||
      hasThirdPartyLicenseLabelSentenceContext(
        malformedSpdxBody,
        headerAliases,
      ))
  if (
    hasMalformedSpdxLine &&
    !malformedSpdxBody &&
    hasOnlyBenignMalformedSpdxAnnotationLines(trimmed, knownIds, headerAliases)
  ) {
    const exactResults = exactSpdxResults(
      Array.from(malformedSpdxDeclaredIds),
      'spdx-expression',
      licenseById,
    )
    if (exactResults.length === 1) {
      return {
        inputType: 'spdx-expression',
        spdxExpression: exactResults[0].licenseId,
        results: exactResults,
        message: 'SPDX license identifier detected.',
      }
    }
  }
  if (
    hasMalformedSpdxLine &&
    malformedSpdxBody &&
    hasOnlyBenignMalformedSpdxAnnotationLines(trimmed, knownIds, headerAliases)
  ) {
    const exactResults = exactSpdxResults(
      Array.from(
        declaredSpdxHeaderBodyIds(
          malformedSpdxBody,
          malformedSpdxDeclaredIds,
          licenses,
          licenseById,
          knownIds,
        ),
      ),
      'spdx-expression',
      licenseById,
    )
    if (exactResults.length === 1) {
      return {
        inputType: 'spdx-expression',
        spdxExpression: exactResults[0].licenseId,
        results: exactResults,
        message: 'SPDX license identifier detected.',
      }
    }
  }
  if (
    hasMalformedSpdxLine &&
    hasOnlyEmptySpdxDeclarationLines(trimmed) &&
    malformedSpdxBody
  ) {
    const headerResponse = rankLicenses(malformedSpdxBody, licenses, {
      ...options,
      includeDiffs: false,
    })
    if (
      headerResponse.inputType === 'license-header' &&
      headerResponse.results.length > 0 &&
      explicitLicenseHeaderCueIds(malformedSpdxBody, licenses).size <= 1 &&
      !hasThirdPartyMalformedSpdxBodyLicenseContext &&
      !hasRestrictiveModalProhibition(malformedSpdxBody)
    ) {
      return {
        ...headerResponse,
        results: resultsWithDiffDetails(
          malformedSpdxBody,
          headerResponse.results,
          licenses,
          options.includeDiffs ?? true,
        ),
      }
    }
  }
  if (
    hasMalformedSpdxLine &&
    malformedSpdxBodyResults.length > 0 &&
    !hasThirdPartyMalformedSpdxBodyLicenseContext &&
    !hasOnlyMalformedSpdxHeaderBodyResults &&
    !hasOnlyMalformedSpdxNamedHeaderFallback
  ) {
    const conflictingResults =
      malformedSpdxDeclaredIds.size > 0
        ? conflictingSpdxBodyResults(
            trimmed,
            malformedSpdxDeclaredIds,
            licenses,
            licenseById,
            knownIds,
            { body: malformedSpdxBody },
          )
        : []
    if (conflictingResults.length > 0) {
      return {
        inputType: 'mixed-license-text',
        results: spdxConflictResultsWithDiffDetails(
          trimmed,
          conflictingResults,
          licenses,
          knownIds,
          options.includeDiffs ?? true,
          { body: malformedSpdxBody },
        ),
        message: 'SPDX identifier conflicts with the detected license text.',
      }
    }
    if (
      hasRestrictiveSpdxBodyConflict(
        trimmed,
        malformedSpdxDeclaredIds,
        licenses,
        licenseById,
        knownIds,
      ) ||
      hasMalformedSpdxRestrictiveNamedHeaderTail
    ) {
      return {
        inputType: 'mixed-license-text',
        results: [],
        message:
          malformedSpdxDeclaredIds.size > 0
            ? 'SPDX identifier conflicts with restrictive license text.'
            : 'Malformed SPDX identifier conflicts with restrictive license text.',
      }
    }
    if (
      hasMalformedSpdxPunctuationIdList(trimmed, knownIds) &&
      hasPartialDeclaredSpdxBodyMatch(
        malformedSpdxDeclaredIds,
        malformedSpdxBodyResults,
      )
    ) {
      return {
        inputType: 'mixed-license-text',
        results: [],
        message:
          'Malformed SPDX identifier lists multiple licenses without AND/OR.',
      }
    }
    const results = resultsWithDiffDetails(
      malformedSpdxBody,
      malformedSpdxBodyResults,
      licenses,
      options.includeDiffs ?? true,
    )
    return {
      inputType: 'mixed-license-text',
      results,
      message:
        'Malformed SPDX identifier ignored; detected license text separately.',
    }
  }
  if (
    hasMalformedSpdxLine &&
    malformedSpdxBodyResults.length === 0 &&
    (hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
      trimmed,
      licenses,
    ) ||
      hasMalformedSpdxRestrictiveNamedHeaderTail ||
      hasProjectRestrictiveBodySegments(
        bodyTextSegments(malformedSpdxBody),
        licenses,
      ) ||
      hasProjectRestrictiveSpdxBody(trimmed, licenses, { knownIds }))
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'SPDX identifier conflicts with restrictive license text.',
    }
  }
  if (
    hasMalformedSpdxLine &&
    malformedSpdxBodyResults.length === 0 &&
    malformedSpdxBody &&
    !hasMultipleMalformedSpdxDeclarationReferences &&
    !hasThirdPartyMalformedSpdxBodyLicenseContext &&
    !hasOnlyMalformedSpdxNamedHeaderFallback
  ) {
    const segmentBodyResults = supportedSpdxBodySegmentHeaderResults(
      malformedSpdxBody,
      licenses,
      licenseById,
      knownIds,
    )
    if (segmentBodyResults.length > 0) {
      return {
        inputType: 'mixed-license-text',
        results: resultsWithDiffDetails(
          malformedSpdxBody,
          segmentBodyResults,
          licenses,
          options.includeDiffs ?? true,
        ),
        message:
          'Malformed SPDX identifier ignored; detected license text separately.',
      }
    }
  }

  if (
    inputType === 'spdx-expression' &&
    spdx &&
    (spdx.unsupportedIds.length > 0 ||
      spdx.hasCompoundExpression ||
      spdx.hasWithException)
  ) {
    const expressionIds = new Set(spdx.ids)
    if (spdx.ids.some((id) => knownIds.has(id))) {
      const conflictingResults = conflictingSpdxBodyResults(
        trimmed,
        expressionIds,
        licenses,
        licenseById,
        knownIds,
      )
      if (conflictingResults.length > 0) {
        return {
          inputType: 'mixed-license-text',
          spdxExpression: spdx.expression || trimmed,
          results: spdxConflictResultsWithDiffDetails(
            trimmed,
            conflictingResults,
            licenses,
            knownIds,
            options.includeDiffs ?? true,
          ),
          message: 'SPDX identifier conflicts with the detected license text.',
        }
      }
    }

    if (
      hasRestrictiveSpdxBodyConflict(
        trimmed,
        expressionIds,
        licenses,
        licenseById,
        knownIds,
        spdx.expression,
      )
    ) {
      return {
        inputType: 'mixed-license-text',
        spdxExpression: spdx.expression || trimmed,
        results: [],
        message: 'SPDX identifier conflicts with restrictive license text.',
      }
    }

    const bodyResults = supportedSpdxBodyResults(
      trimmed,
      licenses,
      licenseById,
      knownIds,
    )
    if (bodyResults.length > 0) {
      const body = bodyWithoutSpdxLines(trimmed, knownIds)
      const results =
        spdx.unsupportedIds.length > 0
          ? markUnsupportedSpdxBodyResultsForReview(bodyResults)
          : spdx.hasConjunctiveExpression || spdx.hasWithException
            ? markAmbiguousSpdxBodyResultsForReview(bodyResults)
            : bodyResults
      return {
        inputType: 'mixed-license-text',
        spdxExpression: spdx.expression || trimmed,
        results: resultsWithDiffDetails(
          body,
          results,
          licenses,
          options.includeDiffs ?? true,
        ),
        message:
          'SPDX expression needs review; detected license text separately.',
      }
    }

    return {
      inputType,
      spdxExpression: spdx?.expression || trimmed,
      results: [],
      message:
        'Unknown: compound SPDX expressions, WITH exceptions, and unknown SPDX IDs need a future parser.',
    }
  }

  const gnuNotice = detectGnuNotice(trimmed)
  const gnuContext: GnuReviewContext = {
    notice: gnuNotice,
    inputOrLater: hasOrLaterWording(gnuNotice),
  }

  if (spdx?.legacyAlias) {
    const candidates = legacySpdxCandidateResults(
      spdx.legacyAlias,
      inputType,
      licenseById,
    )
    const candidateIds = new Set(candidates.map((result) => result.licenseId))
    const conflictingResults = conflictingSpdxBodyResults(
      trimmed,
      candidateIds,
      licenses,
      licenseById,
      knownIds,
    )
    if (conflictingResults.length > 0) {
      return {
        inputType: 'mixed-license-text',
        spdxExpression: spdx.expression,
        legacyAlias: spdx.legacyAlias,
        results: spdxConflictResultsWithDiffDetails(
          trimmed,
          conflictingResults,
          licenses,
          knownIds,
          options.includeDiffs ?? true,
        ),
        message: 'SPDX identifier conflicts with the detected license text.',
      }
    }
    if (
      hasRestrictiveSpdxBodyConflict(
        trimmed,
        candidateIds,
        licenses,
        licenseById,
        knownIds,
        spdx.expression,
      )
    ) {
      return {
        inputType: 'mixed-license-text',
        spdxExpression: spdx.expression,
        legacyAlias: spdx.legacyAlias,
        results: [],
        message: 'SPDX identifier conflicts with restrictive license text.',
      }
    }

    return {
      inputType,
      spdxExpression: spdx.expression,
      legacyAlias: spdx.legacyAlias,
      results: candidates,
      message:
        'Legacy SPDX identifier detected. Confirm the correct only/or-later ID.',
    }
  }

  if (spdx) {
    const exactResults = exactSpdxResults(spdx.ids, inputType, licenseById)
    if (exactResults.length > 0) {
      const exactIds = new Set(exactResults.map((result) => result.licenseId))
      const conflictingResults = conflictingSpdxBodyResults(
        trimmed,
        exactIds,
        licenses,
        licenseById,
        knownIds,
      )
      if (conflictingResults.length > 0) {
        return {
          inputType: 'mixed-license-text',
          spdxExpression: spdx.expression,
          results: spdxConflictResultsWithDiffDetails(
            trimmed,
            conflictingResults,
            licenses,
            knownIds,
            options.includeDiffs ?? true,
          ),
          message: 'SPDX identifier conflicts with the detected license text.',
        }
      }
      if (
        hasRestrictiveSpdxBodyConflict(
          trimmed,
          exactIds,
          licenses,
          licenseById,
          knownIds,
          spdx.expression,
        )
      ) {
        return {
          inputType: 'mixed-license-text',
          spdxExpression: spdx.expression,
          results: [],
          message: 'SPDX identifier conflicts with restrictive license text.',
        }
      }

      return {
        inputType,
        spdxExpression: spdx.expression,
        results: exactResults,
        message: 'SPDX license identifier detected.',
      }
    }
  }

  if (leadingBareSpdx) {
    const legacyCandidates = leadingBareSpdx.legacyAlias
      ? legacySpdxCandidateResults(
          leadingBareSpdx.legacyAlias,
          'spdx-expression',
          licenseById,
        )
      : []
    const leadingBareSpdxIds = leadingBareSpdx.legacyAlias
      ? new Set(legacyCandidates.map((result) => result.licenseId))
      : leadingBareSpdx.ids
    const conflictingResults = conflictingSpdxBodyResults(
      leadingBareSpdx.body,
      leadingBareSpdxIds,
      licenses,
      licenseById,
      knownIds,
    )
    if (conflictingResults.length > 0) {
      return {
        inputType: 'mixed-license-text',
        spdxExpression: leadingBareSpdx.expression,
        legacyAlias: leadingBareSpdx.legacyAlias,
        results: spdxConflictResultsWithDiffDetails(
          leadingBareSpdx.body,
          conflictingResults,
          licenses,
          knownIds,
          options.includeDiffs ?? true,
          { body: leadingBareSpdx.body },
        ),
        message: 'SPDX identifier conflicts with the detected license text.',
      }
    }
    if (
      hasRestrictiveSpdxBodyConflict(
        leadingBareSpdx.body,
        leadingBareSpdxIds,
        licenses,
        licenseById,
        knownIds,
        leadingBareSpdx.expression,
      )
    ) {
      return {
        inputType: 'mixed-license-text',
        spdxExpression: leadingBareSpdx.expression,
        legacyAlias: leadingBareSpdx.legacyAlias,
        results: [],
        message: 'SPDX identifier conflicts with restrictive license text.',
      }
    }
    if (leadingBareSpdx.legacyAlias) {
      return {
        inputType: 'spdx-expression',
        spdxExpression: leadingBareSpdx.expression,
        legacyAlias: leadingBareSpdx.legacyAlias,
        results: legacyCandidates,
        message:
          'Legacy SPDX identifier detected. Confirm the correct only/or-later ID.',
      }
    }

    const exactResults = exactSpdxResults(
      Array.from(leadingBareSpdx.ids),
      'spdx-expression',
      licenseById,
    )
    if (exactResults.length > 0) {
      return {
        inputType: 'spdx-expression',
        spdxExpression: leadingBareSpdx.expression,
        results: exactResults,
        message: 'SPDX license identifier detected.',
      }
    }
  }

  let exactSupportedFullLicenseBodyRestrictivePrefix: boolean | undefined
  const hasExactSupportedFullLicenseBodyRestrictivePrefix = () =>
    (exactSupportedFullLicenseBodyRestrictivePrefix ??=
      hasProjectRestrictivePrefixBeforeExactSupportedFullLicenseBody(
        trimmed,
        licenses,
      ))

  const licenseLabelInput = hasMalformedSpdxLine
    ? bodyWithoutSpdxLines(trimmed, knownIds)
    : trimmed
  const labelSpdx = standaloneLicenseLabelSpdxDetection(
    licenseLabelInput,
    knownIds,
    headerAliases,
  )
  if (labelSpdx) {
    if (labelSpdx.malformedDeclaredIds) {
      const bodyResults = supportedSpdxBodyResults(
        labelSpdx.body,
        licenses,
        licenseById,
        knownIds,
        headerAliases,
      )
      if (bodyResults.length > 0) {
        return {
          inputType: 'mixed-license-text',
          results: resultsWithDiffDetails(
            labelSpdx.body,
            bodyResults,
            licenses,
            options.includeDiffs ?? true,
          ),
          message:
            'License label lists multiple licenses without AND/OR; detected license text separately.',
        }
      }
      return {
        inputType: 'mixed-license-text',
        results: [],
        message: 'License label lists multiple licenses without AND/OR.',
      }
    }
    if (labelSpdx.body) {
      const bodyForRanking = projectBodyForLicenseLabelSpdxExpression(
        labelSpdx.body,
        licenses,
      )
      if (!bodyForRanking)
        return unsupportedSpdxExpressionResponse(labelSpdx.detection.expression)
      // Re-enter through the regular SPDX branch so the label expression is
      // handled once, then the remaining body follows the normal ranking flow.
      const labelSpdxResponse = rankLicenses(
        'SPDX-License-Identifier: ' +
          labelSpdx.detection.expression +
          '\n\n' +
          bodyForRanking,
        licenses,
        options,
      )
      return {
        ...labelSpdxResponse,
        spdxExpression: labelSpdx.detection.expression,
        results: attachDiffInput(labelSpdxResponse.results, bodyForRanking),
      }
    }
    return unsupportedSpdxExpressionResponse(labelSpdx.detection.expression)
  }
  const hasLicenseLabelDeclaration =
    hasLicenseLabelDeclarationLine(licenseLabelInput)
  const hasCurrentLicenseLabel = hasCurrentLicenseLabelDeclaration(
    licenseLabelInput,
    licenses,
  )

  if (
    hasLicenseLabelDeclaration &&
    hasNegatedLicenseLabelDeclaration(licenseLabelInput, licenses)
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'License label conflicts with restrictive license text.',
    }
  }
  if (
    hasCurrentLicenseLabel &&
    hasRestrictiveLicenseLabelValueDeclaration(licenseLabelInput)
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'License label conflicts with restrictive license text.',
    }
  }
  if (
    hasLicenseLabelDeclaration &&
    hasRestrictiveLicenseLabelDeclaration(licenseLabelInput, licenses) &&
    hasRestrictiveLicenseLabelBodyConflict(licenseLabelInput, licenses)
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'License label conflicts with restrictive license text.',
    }
  }
  if (
    hasLicenseLabelDeclaration &&
    hasRestrictiveLicenseLabelValueDeclaration(licenseLabelInput) &&
    hasContainedSupportedFullLicenseBody(licenseLabelInput, licenses)
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'License label conflicts with restrictive license text.',
    }
  }
  if (
    hasLicenseLabelDeclaration &&
    hasConflictingLicenseLabelFullBody(licenseLabelInput, licenses)
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'License label conflicts with the detected license text.',
    }
  }
  const conflictingLabelNamedBodyResults =
    hasLicenseLabelDeclaration && hasCurrentLicenseLabel
      ? conflictingLicenseLabelNamedBodyResults(
          licenseLabelInput,
          licenses,
          licenseById,
        )
      : []
  if (conflictingLabelNamedBodyResults.length > 0) {
    return {
      inputType: 'mixed-license-text',
      results: licenseLabelConflictResultsWithDiffDetails(
        licenseLabelInput,
        conflictingLabelNamedBodyResults,
        licenses,
        options.includeDiffs ?? true,
      ),
      message: 'License label conflicts with the detected license text.',
    }
  }

  const bodyWithoutLabel = hasLicenseLabelDeclaration
    ? bodyWithoutLicenseLabelLines(
        licenseLabelInput,
        getHeaderAliases(licenses).map((alias) => alias.words),
        { skipPrefixedStandaloneLabelValues: true },
      )
    : ''
  const thirdPartyFullBodySplit = bodyWithoutLabel
    ? splitBeforeThirdPartyFullLicenseBody(bodyWithoutLabel, licenses)
    : undefined
  const unlabeledThirdPartyFullBodySplit = !hasLicenseLabelDeclaration
    ? splitBeforeThirdPartyFullLicenseBody(trimmed, licenses)
    : undefined
  const hasRestrictiveSplitFullBody = thirdPartyFullBodySplit
    ? hasRestrictiveThirdPartyFullLicenseBody(
        thirdPartyFullBodySplit.thirdPartyBody,
        licenses,
      ) ||
      hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
        thirdPartyFullBodySplit.projectBody,
        licenses,
      ) ||
      hasRestrictiveTailAfterContainedSupportedFullLicenseBody(
        thirdPartyFullBodySplit.projectBody,
        licenses,
      )
    : false
  const hasProjectFullBodyAfterThirdParty = Boolean(
    thirdPartyFullBodySplit?.projectBody &&
    hasContainedSupportedFullLicenseBody(
      thirdPartyFullBodySplit.projectBody,
      licenses,
    ),
  )
  const hasUnlabeledProjectFullBodyAfterThirdParty = Boolean(
    unlabeledThirdPartyFullBodySplit?.projectBody &&
    hasContainedSupportedFullLicenseBody(
      unlabeledThirdPartyFullBodySplit.projectBody,
      licenses,
    ),
  )
  const hasLeadingThirdPartyLabelBody = Boolean(
    bodyWithoutLabel &&
    hasLeadingThirdPartyLicenseLabelBodyContext(bodyWithoutLabel),
  )
  const bodyWithoutLabelSegments = bodyWithoutLabel
    ? bodyTextSegments(bodyWithoutLabel)
    : []
  const hasThirdPartyContainedBody =
    hasLeadingThirdPartyLabelBody &&
    hasContainedSupportedFullLicenseBody(bodyWithoutLabel, licenses)
  const hasRestrictiveLicenseValueBodyWithoutLabel =
    bodyWithoutLabel &&
    hasBareNoLicenseMarkerBodySegments(bodyWithoutLabelSegments, licenses)
  const hasExplicitProjectRestrictiveBodyWithoutLabel =
    bodyWithoutLabel &&
    bodyWithoutLabelSegments.some((segment) =>
      hasProjectRestrictiveBodySegment(segment),
    )
  const hasStandaloneRestrictiveScopeBodyWithoutLabel =
    bodyWithoutLabel &&
    hasRestrictiveLicenseOnlyBodySegments(bodyWithoutLabelSegments, licenses)
  if (
    hasCurrentLicenseLabel &&
    (hasRestrictiveLicenseValueBodyWithoutLabel ||
      hasStandaloneRestrictiveScopeBodyWithoutLabel)
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'License label conflicts with restrictive license text.',
    }
  }
  if (
    hasThirdPartyContainedBody &&
    (hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
      bodyWithoutLabel,
      licenses,
    ) ||
      hasRestrictiveTailAfterContainedSupportedFullLicenseBody(
        bodyWithoutLabel,
        licenses,
        true,
      ))
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'License label conflicts with restrictive license text.',
    }
  }
  if (
    bodyWithoutLabel &&
    !hasThirdPartyContainedBody &&
    !hasProjectFullBodyAfterThirdParty &&
    !hasExplicitProjectRestrictiveBodyWithoutLabel &&
    hasScopedAwayLicenseLabelDeclaration(licenseLabelInput, licenses) &&
    (hasThirdPartyLicenseLabelFullBodyContext(bodyWithoutLabel, licenses) ||
      hasThirdPartyFullLicenseBodyAfterContext(bodyWithoutLabel, licenses)) &&
    hasContainedSupportedFullLicenseBody(bodyWithoutLabel, licenses)
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'License label applies outside the detected third-party text.',
    }
  }
  if (
    !spdx &&
    !hasCurrentLicenseLabel &&
    hasExactSupportedFullLicenseBodyRestrictivePrefix()
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'Detected license text conflicts with restrictive license text.',
    }
  }
  if (
    unlabeledThirdPartyFullBodySplit &&
    !hasUnlabeledProjectFullBodyAfterThirdParty &&
    !hasRestrictiveThirdPartyFullLicenseBody(
      unlabeledThirdPartyFullBodySplit.thirdPartyBody,
      licenses,
    )
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'Detected license text applies to third-party text.',
    }
  }
  if (
    bodyWithoutLabel &&
    thirdPartyFullBodySplit &&
    hasProjectFullBodyAfterThirdParty &&
    hasScopedAwayLicenseLabelDeclaration(licenseLabelInput, licenses)
  ) {
    const projectBody = thirdPartyFullBodySplit.projectBody
    const projectGnuNotice = detectGnuNotice(projectBody)
    const projectGnuContext: GnuReviewContext = {
      notice: projectGnuNotice,
      inputOrLater: hasOrLaterWording(projectGnuNotice),
    }
    const projectResults = sortResults(
      markGnuAmbiguity(
        licenses.map((entry) =>
          resultFromEntry(
            entry,
            projectBody,
            'mixed-license-text',
            projectGnuContext,
          ),
        ),
        projectGnuContext,
      ),
    )
      .filter((result) => result.confidence !== 'Unknown')
      .slice(0, 5)
    if (projectResults.length > 0) {
      const resultsWithDiffInput = attachDiffInput(projectResults, projectBody)
      return {
        inputType: 'mixed-license-text',
        results: resultsWithDiffDetails(
          projectBody,
          resultsWithDiffInput,
          licenses,
          options.includeDiffs ?? true,
        ),
        message: 'License candidates ranked by shingle F1 score.',
      }
    }
  }
  if (
    bodyWithoutLabel &&
    thirdPartyFullBodySplit &&
    !hasRestrictiveSplitFullBody &&
    hasCurrentLicenseLabel
  ) {
    const labelResults = currentLicenseLabelResults(
      licenseLabelInput,
      licenses,
      licenseById,
      gnuContext,
    )
    if (labelResults.length > 0) {
      return {
        inputType: 'license-header',
        results: labelResults,
        message: 'License candidates ranked by explicit header wording.',
      }
    }
  }
  if (
    bodyWithoutLabel &&
    hasThirdPartyContainedBody &&
    hasCurrentLicenseLabel
  ) {
    const labelResults = currentLicenseLabelResults(
      licenseLabelInput,
      licenses,
      licenseById,
      gnuContext,
    )
    if (labelResults.length > 0) {
      return {
        inputType: 'license-header',
        results: labelResults,
        message: 'License candidates ranked by explicit header wording.',
      }
    }
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'License label conflicts with restrictive license text.',
    }
  }

  const namedHeaderInputType =
    bodyWithoutLabel &&
    (hasThirdPartyContainedBody ||
      hasThirdPartyLicenseLabelFullBodyContext(bodyWithoutLabel, licenses))
      ? 'license-header'
      : inputType
  const namedHeaderInputs = hasMalformedSpdxLine
    ? hasMultipleMalformedSpdxDeclarationReferences ||
      hasThirdPartyMalformedSpdxBodyLicenseContext
      ? []
      : malformedSpdxNamedHeaderInputs(trimmed, knownIds, headerAliases)
    : [{ text: trimmed, allowHeaderFallback: false }]
  let namedResults: MatchResult[] = []
  for (const namedHeaderInput of namedHeaderInputs) {
    namedResults = namedHeaderResults(
      namedHeaderInput.text,
      licenses,
      licenseById,
      namedHeaderInputType,
      gnuContext,
      { allowExactBareTitle: true },
    )
    if (
      namedResults.length === 0 &&
      hasMalformedSpdxLine &&
      namedHeaderInput.allowHeaderFallback
    ) {
      namedResults = namedHeaderResults(
        namedHeaderInput.text,
        licenses,
        licenseById,
        'license-header',
        gnuContext,
        { allowExactBareTitle: true },
      )
    }
    if (namedResults.length > 0) break
  }
  const conflictingFullBodyHeaderResults =
    conflictingNamedHeadersAroundExactFullLicenseBody(
      trimmed,
      licenses,
      licenseById,
      knownIds,
    )
  if (namedResults.length > 0) {
    if (conflictingFullBodyHeaderResults.length > 0) {
      return {
        inputType: 'mixed-license-text',
        results: conflictingFullBodyHeaderResults,
        message: 'Detected license text conflicts with another license header.',
      }
    }
    return {
      inputType: 'license-header',
      results: namedResults,
      message: 'License candidates ranked by explicit header wording.',
    }
  }

  if (conflictingFullBodyHeaderResults.length > 0) {
    return {
      inputType: 'mixed-license-text',
      results: conflictingFullBodyHeaderResults,
      message: 'Detected license text conflicts with another license header.',
    }
  }

  const ranked = sortResults(
    markGnuAmbiguity(
      licenses.map((entry) =>
        resultFromEntry(entry, trimmed, inputType, gnuContext),
      ),
      gnuContext,
    ),
  )
  const exactFullText = ranked.some(
    (result) =>
      result.score.f1 >= 0.98 &&
      result.score.precision >= 0.98 &&
      result.score.recall >= 0.98,
  )
  // F1 sorting can put a broader but lower-precision license first.
  const hasHighScoringUnknownCandidate =
    inputType === 'unknown' &&
    ranked.some(
      (result) => result.score.precision >= 0.82 && result.score.f1 >= 0.55,
    )
  const hasContainedFullLicense = ranked.some(
    (result) => result.score.recall >= 0.98 && result.score.precision > 0,
  )
  const hasOpeningHighPrecisionFullCandidate =
    inputType === 'full-license-text' &&
    !hasContainedFullLicense &&
    (hasOpeningLicenseTitle(trimmed) || hasFullLicenseTermsMarker(trimmed)) &&
    ranked.some(
      (result) =>
        result.score.precision >= 0.9 &&
        result.score.recall >= 0.9 &&
        result.score.f1 >= 0.9,
    )
  const hasHighScoringImperfectFullCandidate =
    inputType === 'full-license-text' &&
    !exactFullText &&
    !hasContainedFullLicense &&
    !hasOpeningLicenseTitle(trimmed) &&
    !hasFullLicenseTermsMarker(trimmed) &&
    ranked.some(
      (result) => result.score.precision >= 0.82 && result.score.f1 >= 0.55,
    )
  const effectiveInputType =
    exactFullText || hasOpeningHighPrecisionFullCandidate
      ? 'full-license-text'
      : hasHighScoringUnknownCandidate ||
          hasHighScoringImperfectFullCandidate ||
          hasContainedFullLicense
        ? 'mixed-license-text'
        : inputType
  const effectiveRanked =
    effectiveInputType === inputType
      ? ranked
      : sortResults(
          markGnuAmbiguity(
            licenses.map((entry) =>
              resultFromEntry(entry, trimmed, effectiveInputType, gnuContext),
            ),
            gnuContext,
          ),
        )
  const useful = effectiveRanked
    .filter((result, index) =>
      effectiveInputType === 'mixed-license-text'
        ? index === 0 || result.confidence !== 'Unknown'
        : result.confidence !== 'Unknown',
    )
    .slice(0, 5)
  const hasHighRecallFullLicenseWithExtraContext = useful.some(
    (result) =>
      result.score.recall >= 0.95 &&
      result.score.f1 >= 0.9 &&
      result.score.recall - result.score.precision >= 0.015,
  )
  const hasHighRecallFullLicenseRestrictiveContext =
    hasHighRecallFullLicenseWithExtraContext &&
    ((!hasCurrentLicenseLabel &&
      hasProjectRestrictivePrefixBeforeContainedSupportedFullLicenseBody(
        trimmed,
        licenses,
      )) ||
      hasRestrictiveTailAfterContainedSupportedFullLicenseBody(
        trimmed,
        licenses,
      ))
  if (
    !hasCurrentLicenseLabel &&
    (exactFullText ||
      hasContainedFullLicense ||
      effectiveInputType === 'full-license-text' ||
      effectiveInputType === 'mixed-license-text') &&
    hasScopedAwayPrefixBeforeContainedSupportedFullLicenseBody(
      trimmed,
      licenses,
    )
  ) {
    return {
      inputType: effectiveInputType,
      results: [],
      message:
        'Unknown: the input is not a reliable match for a standard open-source license.',
    }
  }
  if (
    ((exactFullText ||
      hasContainedFullLicense ||
      effectiveInputType === 'full-license-text' ||
      effectiveInputType === 'mixed-license-text') &&
      ((!hasCurrentLicenseLabel &&
        hasExactSupportedFullLicenseBodyRestrictivePrefix()) ||
        hasSupportedBodyTextWithRestrictiveTail(trimmed, licenses) ||
        hasSupportedBodyTextWithSpdxLikeTail(trimmed, licenses, knownIds) ||
        hasHighRecallFullLicenseRestrictiveContext)) ||
    hasSupportedNormalizedBodyWithRestrictiveTail(trimmed, licenses)
  ) {
    return {
      inputType: 'mixed-license-text',
      results: [],
      message: 'Detected license text conflicts with restrictive license text.',
    }
  }
  if (useful.length === 0 || effectiveInputType === 'unknown') {
    return {
      inputType: effectiveInputType,
      results: [],
      message:
        'Unknown: the input is not a reliable match for a standard open-source license.',
    }
  }

  const withDiffs = resultsWithDiffDetails(
    trimmed,
    useful,
    licenses,
    options.includeDiffs ?? true,
  )

  return {
    inputType: effectiveInputType,
    results: withDiffs,
    message: 'License candidates ranked by shingle F1 score.',
  }
}
