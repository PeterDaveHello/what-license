import { spdxLicenseIds } from '../data/spdx-license-ids.generated'
import { spdxExceptionIds } from '../data/spdx-exceptions.generated'
import { cachedLowercaseSetFor, cachedSetSnapshotMatches } from './set-cache'

const spdxExpressionOperatorTokens = new Set(['AND', 'OR', 'WITH'])
const spdxExpressionCompoundOperatorTokens = new Set(['AND', 'OR'])
const lowercaseSpdxExpressionOperatorTokens = new Set(
  Array.from(spdxExpressionOperatorTokens, (token) => token.toLowerCase()),
)
const validSpdxExpressionCharacterPattern = /^[A-Za-z0-9.+:\-\s()]+$/
const spdxExpressionIdTokenPattern = /^[A-Za-z0-9.+:-]+$/
const spdxExpressionTokenPattern = /[A-Za-z0-9.+:-]+|[()]/g
const semicolonCommentFallbackTokenPattern =
  /^(?:AG|APPL(?:Y|IES)|AUTHORS?|BV|COPYRIGHT|CORP|GMBH|HOLDERS?|INC|LICEN[CS]ES?|LLC|LTD|NOTE|NOTICES?|NV|PLC|SAS|TERMS?|TODO|FIXME)(?:[-_].*)?$/i
const namedLicenseTitlePattern =
  /\b[a-z0-9]+(?: [a-z0-9]+){0,8} licen[cs]e(?: [a-z0-9]+){0,4}\b/g
const nonLicenseTitleAnnotationPattern =
  /\b(?:(?:see|read|check|consult|view|review|open|inspect) (?:also )?(?:the )?|refer(?:red)? to (?:the )?)(?:licen[cs]e|licen[cs]es|copying|notice|notices)(?: file| files| text| terms| information| info| details| notes?)?\b|\blicen[cs]e (?:file|files|information|info|notice|notices|metadata|terms|text|copy|copies|details|section|sections|url|link|reference|references|notes?)\b/
const cc0TitlePattern =
  /\b(?:cc0(?: 1 0)?(?: universal)?|creative commons zero(?: v?1 0)?(?: universal)?)\b/
const unlicenseTitlePattern = /\b(?:the )?unlicense\b/
const dependencyScopePhrasePattern =
  /\b(?:for|with)(?: [a-z0-9]+){0,4} dependenc(?:y|ies)\b/
const dependencyScopePhraseGlobalPattern = new RegExp(
  dependencyScopePhrasePattern.source,
  'g',
)
// Bound the detailed pass; fallback scans use cheaper checks for long tails.
const maxSecondaryLicenseTailScanSegments = 100
const projectScopeNounPattern =
  '(?:project|codebase|software|package|repository|repo|library|program|application|tool|app|cli|product|component|source code|source|code|work|source files?|files?)'
const projectScopeReferencePattern = new RegExp(
  `\\b(?:for|with|under)(?: (?:this|the|our|main|primary))? ${projectScopeNounPattern}\\b(?! dependenc)`,
)
const projectScopeAfterDependencyPattern = new RegExp(
  `\\bdependenc(?:y|ies) (?:and|or|plus|along with|as well as) (?:this |the |our |main |primary )?${projectScopeNounPattern}\\b(?! dependenc)`,
)
const projectScopeBeforeDependencyPattern = new RegExp(
  `\\b(?:for|with|under)(?: (?:this|the|our|main|primary))? ${projectScopeNounPattern} (?:and|or|plus|along with|as well as)(?: [a-z0-9]+){0,4} dependenc(?:y|ies)\\b`,
)
const shortSpdxLikeIdTokens = new Set([
  '0bsd',
  'afl-3.0',
  'artistic-2.0',
  'blueoak-1.0.0',
  'bsl-1.0',
  'isc',
  'mit',
  'ms-pl',
  'ncsa',
  'postgresql',
  'unlicense',
  'wtfpl',
  'zlib',
])
// Treat short standard/year references as prose, not unknown license IDs.
const nonLicenseVersionedTokenPattern =
  /^(?:(?:ASCII|ECMA|HTTP|ISO|RFC|UTF)-\d+(?:[.-]\d+)*|[A-Z]{2,}-\d{4}|(?:BUILD|CHANGELOG|MILESTONE|RELEASE|RELEASE-NOTES?|REVISION|VERSION)-\d+(?:[.-]\d+)*)$/i
const legacyGnuSpdxIdPattern =
  /^(?:AGPL-3\.0|GPL-[23]\.0|LGPL-(?:2\.1|3\.0))\+?$/i
const customSpdxReferenceTokenPattern =
  /^(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+$/
const spdxLicenseIdSet = new Set(spdxLicenseIds)
const lowercaseSpdxLicenseIds = new Set(
  spdxLicenseIds.map((id) => id.toLowerCase()),
)
const lowercaseSpdxExceptionIds = new Set(
  spdxExceptionIds.map((id) => id.toLowerCase()),
)
const knownLicenseIdWordsCache = new WeakMap<
  Set<string>,
  { sourceIds: string[]; words: string[] }
>()

interface KnownIdLookup {
  knownIds: Set<string>
  lowercaseIds?: Set<string>
  licenseIdWords?: string[]
}

interface SecondaryLicenseTailScan {
  hasSecondaryLicense: boolean
  reachedTailEnd: boolean
  offset: number
  sawSecondaryLicenseCue: boolean
}

interface SemicolonTailSegment {
  index: number
  segment: string
  segmentEnd: number
  reachedTailEnd: boolean
  nextOffset: number
}

interface SemicolonTailScanBounds {
  reachedTailEnd: boolean
  offset: number
}

function knownLicenseIdWordsFor(knownIds: Set<string>): string[] {
  const cached = knownLicenseIdWordsCache.get(knownIds)
  if (cached && cachedSetSnapshotMatches(knownIds, cached.sourceIds)) {
    return cached.words
  }

  const sourceIds = Array.from(knownIds)
  const words = sourceIds
    .map((id) =>
      id
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim(),
    )
    .filter((idWords) => idWords.includes(' '))
  knownLicenseIdWordsCache.set(knownIds, { sourceIds, words })
  return words
}

function knownIdLookupFor(knownIds?: Set<string>): KnownIdLookup | undefined {
  if (!knownIds) return undefined
  return { knownIds }
}

function lookupLowercaseIds(
  knownIds: Set<string>,
  lookup?: KnownIdLookup,
): Set<string> {
  if (lookup?.knownIds === knownIds) {
    return (lookup.lowercaseIds ??= cachedLowercaseSetFor(knownIds))
  }
  return cachedLowercaseSetFor(knownIds)
}

function lookupLicenseIdWords(
  knownIds: Set<string>,
  lookup?: KnownIdLookup,
): string[] {
  if (lookup?.knownIds === knownIds) {
    return (lookup.licenseIdWords ??= knownLicenseIdWordsFor(knownIds))
  }
  return knownLicenseIdWordsFor(knownIds)
}

export function isSpdxExpressionOperator(token: string): boolean {
  return spdxExpressionOperatorTokens.has(token.toUpperCase())
}

export function isSpdxExpressionIdToken(token: string): boolean {
  return (
    /[A-Za-z0-9]/.test(token) &&
    spdxExpressionIdTokenPattern.test(token) &&
    !lowercaseSpdxExpressionOperatorTokens.has(token.toLowerCase()) &&
    (!token.includes(':') || isCustomSpdxReferenceToken(token))
  )
}

export function isSpdxExceptionIdToken(token: string): boolean {
  return (
    isSpdxExpressionIdToken(token) &&
    lowercaseSpdxExceptionIds.has(token.toLowerCase())
  )
}

export function isSpdxExceptionLikeToken(token: string): boolean {
  if (lowercaseSpdxLicenseIds.has(token.toLowerCase())) return false
  return (
    isSpdxExceptionIdToken(token) ||
    /^[A-Za-z0-9.-]*[A-Za-z0-9]-exception(?:-[A-Za-z0-9.]+)?$/i.test(token)
  )
}

export function isSpdxExpressionCompoundOperator(token: string): boolean {
  return spdxExpressionCompoundOperatorTokens.has(token.toUpperCase())
}

function hasValidSpdxExpressionGrammar(expression: string): boolean {
  const tokens = Array.from(
    expression.matchAll(spdxExpressionTokenPattern),
    (match) => match[0],
  )
  if (tokens.length === 0) return false

  let depth = 0
  let expectsOperand = true
  let expectsWithExceptionId = false
  let previousOperandWasException = false
  let previousOperandCanUseWith = false
  for (const token of tokens) {
    if (token === '(') {
      if (expectsWithExceptionId) return false
      if (!expectsOperand) return false
      depth += 1
      previousOperandCanUseWith = false
    } else if (token === ')') {
      if (expectsWithExceptionId) return false
      if (expectsOperand) return false
      depth -= 1
      if (depth < 0) return false
      expectsOperand = false
      previousOperandCanUseWith = false
    } else if (isSpdxExpressionOperator(token)) {
      const operator = token.toUpperCase()
      if (expectsOperand) return false
      if (
        operator === 'WITH' &&
        (!previousOperandCanUseWith || previousOperandWasException)
      )
        return false
      expectsOperand = true
      expectsWithExceptionId = operator === 'WITH'
      previousOperandWasException = false
      previousOperandCanUseWith = false
    } else {
      if (!expectsOperand) return false
      if (!isSpdxExpressionIdToken(token)) return false
      if (isMalformedCustomSpdxReferenceToken(token)) return false
      if (expectsWithExceptionId && !isSpdxExceptionLikeToken(token))
        return false
      if (!expectsWithExceptionId && isSpdxExceptionIdToken(token)) return false
      const operandIsException = expectsWithExceptionId
      expectsOperand = false
      expectsWithExceptionId = false
      previousOperandWasException = operandIsException
      previousOperandCanUseWith = !operandIsException
    }
  }
  return !expectsOperand && !expectsWithExceptionId && depth === 0
}

export function hasValidSpdxExpressionShape(expression: string): boolean {
  return (
    validSpdxExpressionCharacterPattern.test(expression) &&
    hasValidSpdxExpressionGrammar(expression)
  )
}

function knownIdSetHas(
  knownIds: Set<string>,
  token: string,
  lookup?: KnownIdLookup,
): boolean {
  if (knownIds.has(token)) return true
  return lookupLowercaseIds(knownIds, lookup).has(token.toLowerCase())
}

function isCustomSpdxReferenceToken(token: string): boolean {
  return customSpdxReferenceTokenPattern.test(token)
}

export function isStandaloneDocumentRefToken(token: string): boolean {
  return /^DocumentRef-[A-Za-z0-9.-]+$/i.test(token)
}

function hasCustomLicenseReferenceMarker(token: string): boolean {
  return /^LicenseRef-/i.test(token) || /:LicenseRef-/i.test(token)
}

export function isMalformedCustomSpdxReferenceToken(token: string): boolean {
  if (isCustomSpdxReferenceToken(token)) return false
  // A DocumentRef can only qualify a LicenseRef; it is not an operand by itself.
  return (
    isStandaloneDocumentRefToken(token) ||
    hasCustomLicenseReferenceMarker(token)
  )
}

function hasSpdxLikeSemicolonToken(
  token: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  if (!isSpdxExpressionIdToken(token)) return false
  if (semicolonCommentFallbackTokenPattern.test(token)) return false
  if (isSpdxLikeIdToken(token, knownIds, lookup)) return true
  if (!knownIds) {
    if (/^[A-Z0-9][A-Za-z0-9.+:-]*[.+][A-Za-z0-9.+:-]*$/.test(token))
      return true
  }
  return false
}

function hasSpdxLikeAnnotatedLicenseNameLeadingToken(
  expression: string,
  firstTokenMatch: RegExpMatchArray | undefined,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  const firstToken = firstTokenMatch?.[0]
  if (!firstToken) return false
  if (!hasSpdxLikeSemicolonToken(firstToken, knownIds, lookup)) return false

  const annotation = expression
    .slice((firstTokenMatch.index ?? 0) + firstToken.length)
    .trim()
  return /^\([^()]*\b(?:licen[cs]e|public domain)\b[^()]*\)$/i.test(annotation)
}

function hasLeadingLowercaseOperatorSpdxLikeTail(
  rawTokens: string[],
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  if (!['and', 'or', 'with'].includes(rawTokens[0] || '')) return false

  const idTokens = rawTokens.slice(1).filter(isSpdxExpressionIdToken)
  return (
    idTokens.length > 0 &&
    idTokens.every((token) =>
      hasSpdxLikeSemicolonToken(token, knownIds, lookup),
    )
  )
}

export function isSpdxLikeIdToken(
  token: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  if (!isSpdxExpressionIdToken(token)) return false
  if (knownIds && knownIdSetHas(knownIds, token, lookup)) return true
  if (!knownIds && shortSpdxLikeIdTokens.has(token.toLowerCase())) return true
  if (isCustomSpdxReferenceToken(token)) return true
  if (legacyGnuSpdxIdPattern.test(token)) return true
  if (isSpdxExceptionIdToken(token)) return true
  if (
    spdxLicenseIdSet.has(token) ||
    ((!knownIds ||
      token.includes('-') ||
      token.includes('.') ||
      token.includes('+')) &&
      lowercaseSpdxLicenseIds.has(token.toLowerCase()))
  )
    return true
  if (nonLicenseVersionedTokenPattern.test(token)) return false
  return /^[A-Z][A-Za-z0-9]*(?:-[A-Z][A-Za-z0-9]*){2,}$/.test(token)
}

function isPotentialSpdxListToken(
  token: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  if (hasSpdxLikeSemicolonToken(token, knownIds, lookup)) return true
  return (
    isSpdxExpressionIdToken(token) &&
    /[-+.:]/.test(token) &&
    /^[A-Z][A-Za-z0-9.+:-]*$/.test(token) &&
    !semicolonCommentFallbackTokenPattern.test(token)
  )
}

function hasSpdxLikeSemicolonSegment(
  segment: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  const expression = segment.trim()
  const rawTokenMatches = Array.from(
    expression.matchAll(spdxExpressionTokenPattern),
  )
  const rawTokens = rawTokenMatches.map((match) => match[0])
  const firstToken = rawTokens[0]
  const idTokens = rawTokens.filter(isSpdxExpressionIdToken)
  const hasSpdxLikeToken = idTokens.some((token) =>
    hasSpdxLikeSemicolonToken(token, knownIds, lookup),
  )
  const hasFallbackCommentToken = idTokens.some((token) =>
    semicolonCommentFallbackTokenPattern.test(token),
  )
  if (rawTokens.some(hasCustomLicenseReferenceMarker)) return true
  if (
    firstToken &&
    expression
      .slice((rawTokenMatches[0]?.index ?? 0) + firstToken.length)
      .trimStart()
      .startsWith(',') &&
    idTokens.length > 0
  ) {
    return (
      !hasFallbackCommentToken &&
      (hasSpdxLikeToken ||
        idTokens.every((token) =>
          isPotentialSpdxListToken(token, knownIds, lookup),
        ))
    )
  }
  if (
    hasSpdxLikeToken &&
    // Keep this case-sensitive: lowercase operators in semicolon tails are prose.
    rawTokens.some((token) => spdxExpressionOperatorTokens.has(token))
  )
    return true
  if (
    hasSpdxLikeAnnotatedLicenseNameLeadingToken(
      expression,
      rawTokenMatches[0],
      knownIds,
      lookup,
    )
  )
    return true
  if (/^(?:and|or|with)\b/.test(expression)) {
    return hasLeadingLowercaseOperatorSpdxLikeTail(rawTokens, knownIds, lookup)
  }
  if (/\b(?:and|or|with)\b/.test(expression)) {
    const spdxLikeIds = idTokens.filter((token) =>
      hasSpdxLikeSemicolonToken(token, knownIds, lookup),
    )
    return spdxLikeIds.length > 0 && spdxLikeIds.length === idTokens.length
  }
  const spdxLikeIds = idTokens.filter((token) =>
    hasSpdxLikeSemicolonToken(token, knownIds, lookup),
  )
  if (spdxLikeIds.length > 0 && spdxLikeIds.length === idTokens.length) {
    return true
  }
  if (!expression || !hasValidSpdxExpressionShape(expression)) return false
  return hasSpdxLikeToken
}

function consecutiveSpdxLikeSemicolonTailEnd(
  tail: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): number | undefined {
  let offset = 0
  let end: number | undefined
  while (offset <= tail.length) {
    const nextSemicolon = tail.indexOf(';', offset)
    const segmentEnd = nextSemicolon >= 0 ? nextSemicolon : tail.length
    const segment = tail.slice(offset, segmentEnd)
    if (!hasSpdxLikeSemicolonSegment(segment, knownIds, lookup)) break

    end = segmentEnd
    if (nextSemicolon < 0) break
    offset = nextSemicolon + 1
  }
  return end
}

function hasSecondaryLicenseCue(segment: string): boolean {
  const loose = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return (
    loose === 'also' ||
    /\b(?:(?:additional|dual|multiple|multi|alternative|alternate|other|second) licen[cs](?:e|es|ed|ing)|alternatively licen[cs](?:ed|ing))\b/.test(
      loose,
    ) ||
    /\balso (?:available|offered|licen[cs]ed|released|distributed|under)\b/.test(
      loose,
    )
  )
}

function hasKnownLicenseIdWordReference(
  loose: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  if (!knownIds) return false
  const paddedLoose = ' ' + loose + ' '
  for (const idWords of lookupLicenseIdWords(knownIds, lookup)) {
    if (paddedLoose.includes(' ' + idWords + ' ')) {
      return true
    }
  }
  return false
}

function hasNamedLicenseTitleReference(
  segment: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  const loose = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (unlicenseTitlePattern.test(loose) || cc0TitlePattern.test(loose)) {
    return true
  }
  if (hasKnownLicenseIdWordReference(loose, knownIds, lookup)) return true
  for (const match of loose.matchAll(namedLicenseTitlePattern)) {
    if (!nonLicenseTitleAnnotationPattern.test(match[0])) return true
  }
  return false
}

function hasDependencyScopedReference(segment: string): boolean {
  const loose = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return (
    dependencyScopePhrasePattern.test(loose) ||
    /\b(?:runtime|optional|dev|development|peer|transitive|third party|bundled|vendored|external) dependenc(?:y|ies)\b/.test(
      loose,
    )
  )
}

function hasProjectScopedReference(segment: string): boolean {
  const loose = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const withoutDependencyScope = loose
    .replace(dependencyScopePhraseGlobalPattern, ' ')
    .trim()
  return (
    projectScopeReferencePattern.test(withoutDependencyScope) ||
    projectScopeAfterDependencyPattern.test(loose) ||
    projectScopeBeforeDependencyPattern.test(loose)
  )
}

function hasSpdxLikeReferenceToken(
  segment: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  for (const match of segment.matchAll(spdxExpressionTokenPattern)) {
    if (hasSpdxLikeSemicolonToken(match[0], knownIds, lookup)) return true
  }
  return false
}

function forEachSemicolonTailSegment(
  tail: string,
  maxSegments: number,
  visit: (segment: SemicolonTailSegment) => boolean | void,
): SemicolonTailScanBounds {
  let offset = 0
  for (
    let index = 0;
    index < maxSegments && offset <= tail.length;
    index += 1
  ) {
    const nextSemicolon = tail.indexOf(';', offset)
    const segmentEnd = nextSemicolon >= 0 ? nextSemicolon : tail.length
    const reachedTailEnd = nextSemicolon < 0
    const nextOffset = reachedTailEnd ? tail.length : nextSemicolon + 1
    const shouldStop = visit({
      index,
      segment: tail.slice(offset, segmentEnd),
      segmentEnd,
      reachedTailEnd,
      nextOffset,
    })
    if (shouldStop) return { reachedTailEnd, offset: nextOffset }
    if (reachedTailEnd) return { reachedTailEnd: true, offset: tail.length }
    offset = nextOffset
  }
  return { reachedTailEnd: false, offset }
}

function hasUnscannedSecondaryLicenseTail(
  tail: string,
  sawSecondaryLicenseCue: boolean,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  const scan = scanSecondaryLicenseSemicolonTail(
    tail,
    knownIds,
    lookup,
    sawSecondaryLicenseCue,
    false,
  )
  if (scan.hasSecondaryLicense) return true
  if (scan.reachedTailEnd) return false

  const trimmed = tail.slice(scan.offset).trim()
  if (!trimmed) return false
  const hasLicenseReference =
    hasSpdxLikeReferenceToken(trimmed, knownIds, lookup) ||
    hasNamedLicenseTitleReference(trimmed, knownIds, lookup)
  if (!hasLicenseReference) return false
  const hasSecondaryCue =
    scan.sawSecondaryLicenseCue ||
    hasUnscannedSecondaryLicenseCue(trimmed, knownIds, lookup)
  const hasProjectScope = hasProjectScopedReference(trimmed)
  if (!hasSecondaryCue && !hasProjectScope) return false
  if (
    hasOnlyDependencyScopedLicenseReferenceSegments(trimmed, knownIds, lookup)
  ) {
    return false
  }
  return true
}

function hasUnscannedSecondaryLicenseCue(
  tail: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  let foundCue = false
  forEachSemicolonTailSegment(tail, Number.POSITIVE_INFINITY, ({ segment }) => {
    if (hasSecondaryLicenseCue(segment)) {
      foundCue = true
      return true
    }
    if (
      /^\s*also\b/i.test(segment) &&
      (hasSpdxLikeReferenceToken(segment, knownIds, lookup) ||
        hasNamedLicenseTitleReference(segment, knownIds, lookup))
    ) {
      foundCue = true
      return true
    }
  })
  return foundCue
}

function hasOnlyDependencyScopedLicenseReferenceSegments(
  tail: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  let sawDependencyScopedLicenseReference = false
  let carriesDependencyScope = false
  let sawSecondaryLicenseCue = false
  let hasOnlyDependencyScopedReferences = true
  forEachSemicolonTailSegment(tail, Number.POSITIVE_INFINITY, ({ segment }) => {
    const hasLicenseReference =
      hasSpdxLikeReferenceToken(segment, knownIds, lookup) ||
      hasNamedLicenseTitleReference(segment, knownIds, lookup)
    const hasExplicitSecondaryLicenseCue = hasSecondaryLicenseCue(segment)
    const hasAlsoReferenceCue =
      !hasExplicitSecondaryLicenseCue &&
      /^\s*also\b/i.test(segment) &&
      hasLicenseReference
    const hasSameSegmentSecondaryLicenseCue =
      hasExplicitSecondaryLicenseCue || hasAlsoReferenceCue
    if (hasLicenseReference) {
      if (hasProjectScopedReference(segment)) {
        hasOnlyDependencyScopedReferences = false
        return true
      }
      if (hasDependencyScopedReference(segment)) {
        carriesDependencyScope = true
        sawSecondaryLicenseCue = false
      } else if (sawSecondaryLicenseCue || hasSameSegmentSecondaryLicenseCue) {
        hasOnlyDependencyScopedReferences = false
        return true
      } else if (!carriesDependencyScope) {
        hasOnlyDependencyScopedReferences = false
        return true
      }
      sawDependencyScopedLicenseReference = true
    } else if (hasSameSegmentSecondaryLicenseCue) {
      sawSecondaryLicenseCue = true
    }
  })
  return (
    hasOnlyDependencyScopedReferences && sawDependencyScopedLicenseReference
  )
}

function scanSecondaryLicenseSemicolonTail(
  tail: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
  initialSawSecondaryLicenseCue = false,
  allowFirstSegmentBareLicenseReference = true,
): SecondaryLicenseTailScan {
  let sawSecondaryLicenseCue = initialSawSecondaryLicenseCue
  let scanResult: SecondaryLicenseTailScan | undefined
  const bounds = forEachSemicolonTailSegment(
    tail,
    maxSecondaryLicenseTailScanSegments,
    ({ index, segment, segmentEnd, reachedTailEnd }) => {
      let hasNamedLicenseTitle: boolean | undefined
      const getHasNamedLicenseTitle = () =>
        (hasNamedLicenseTitle ??= hasNamedLicenseTitleReference(
          segment,
          knownIds,
          lookup,
        ))
      let hasLicenseReference: boolean | undefined
      const getHasLicenseReference = () =>
        (hasLicenseReference ??=
          hasSpdxLikeReferenceToken(segment, knownIds, lookup) ||
          getHasNamedLicenseTitle())
      const hasExplicitSecondaryLicenseCue = hasSecondaryLicenseCue(segment)
      const hasAlsoReferenceCue =
        !hasExplicitSecondaryLicenseCue &&
        /^\s*also\b/i.test(segment) &&
        getHasLicenseReference()
      const hasSameSegmentSecondaryLicenseCue =
        hasExplicitSecondaryLicenseCue || hasAlsoReferenceCue

      if (
        hasDependencyScopedReference(segment) &&
        !hasProjectScopedReference(segment)
      ) {
        sawSecondaryLicenseCue = false
        if (reachedTailEnd) {
          scanResult = {
            hasSecondaryLicense: false,
            reachedTailEnd: true,
            offset: tail.length,
            sawSecondaryLicenseCue,
          }
          return true
        }
        return
      }
      if (isCorporateAttributionSemicolonComment(segment, knownIds, lookup)) {
        if (reachedTailEnd) {
          scanResult = {
            hasSecondaryLicense: false,
            reachedTailEnd: true,
            offset: tail.length,
            sawSecondaryLicenseCue,
          }
          return true
        }
        return
      }

      if (
        sawSecondaryLicenseCue &&
        (hasSpdxLikeSemicolonSegment(segment, knownIds, lookup) ||
          getHasNamedLicenseTitle())
      ) {
        scanResult = {
          hasSecondaryLicense: true,
          reachedTailEnd,
          offset: segmentEnd,
          sawSecondaryLicenseCue,
        }
        return true
      }

      // A bare license reference is only a secondary license when it is the
      // first tail segment or appears in the same segment as a cue. Later
      // cue-following references use the broader semicolon segment check above.
      if (
        getHasLicenseReference() &&
        (hasProjectScopedReference(segment) ||
          (allowFirstSegmentBareLicenseReference && index === 0) ||
          hasSameSegmentSecondaryLicenseCue)
      ) {
        scanResult = {
          hasSecondaryLicense: true,
          reachedTailEnd,
          offset: segmentEnd,
          sawSecondaryLicenseCue,
        }
        return true
      }
      if (hasSameSegmentSecondaryLicenseCue) sawSecondaryLicenseCue = true

      if (reachedTailEnd) {
        scanResult = {
          hasSecondaryLicense: false,
          reachedTailEnd: true,
          offset: tail.length,
          sawSecondaryLicenseCue,
        }
        return true
      }
    },
  )
  if (scanResult) return scanResult
  return {
    hasSecondaryLicense: false,
    reachedTailEnd: bounds.reachedTailEnd,
    offset: bounds.offset,
    sawSecondaryLicenseCue,
  }
}

function isCorporateAttributionSemicolonComment(
  segment: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  const tokens = Array.from(
    segment.matchAll(spdxExpressionTokenPattern),
    (match) => match[0],
  )
  const spdxLikeTokens = tokens.filter((token) =>
    hasSpdxLikeSemicolonToken(token, knownIds, lookup),
  )
  return (
    spdxLikeTokens.length === 1 &&
    /^[\sA-Za-z0-9.+:-]+,\s*(?:BV|Corp|Corporation|GmbH|Inc|LLC|Ltd|NV|PLC|SAS)\.?$/i.test(
      segment.trim(),
    )
  )
}

function hasSecondaryLicenseSemicolonTail(
  tail: string,
  knownIds?: Set<string>,
  lookup?: KnownIdLookup,
): boolean {
  const scan = scanSecondaryLicenseSemicolonTail(tail, knownIds, lookup)
  if (scan.hasSecondaryLicense) return true
  if (scan.reachedTailEnd) return false
  return hasUnscannedSecondaryLicenseTail(
    tail.slice(scan.offset),
    scan.sawSecondaryLicenseCue,
    knownIds,
    lookup,
  )
}

export function spdxLikeAnnotatedLicenseNameLeadingId(
  expression: string,
  knownIds?: Set<string>,
): string | undefined {
  const lookup = knownIdLookupFor(knownIds)
  const firstTokenMatch = /[A-Za-z0-9.+:-]+/.exec(expression)
  return hasSpdxLikeAnnotatedLicenseNameLeadingToken(
    expression,
    firstTokenMatch || undefined,
    knownIds,
    lookup,
  )
    ? firstTokenMatch?.[0]
    : undefined
}

function spdxInlineCommentTailEndIndex(expression: string): number | undefined {
  const inlineComment = /(^|\s|[A-Za-z0-9.+:)-])(#|\/\/|--(?=\s|$)).*$/u.exec(
    expression,
  )
  return inlineComment?.index === undefined
    ? undefined
    : inlineComment.index + (inlineComment[1]?.length || 0)
}

export function trimSpdxInlineCommentTail(expression: string): string {
  const endIndex = spdxInlineCommentTailEndIndex(expression)
  return endIndex === undefined
    ? expression.trim()
    : expression.slice(0, endIndex).trim()
}

function isBlockCommentMarker(markerText: string): boolean {
  const trimmed = markerText.trim()
  return /\/\*/.test(trimmed) || /^\*+!?$/.test(trimmed)
}

export function trimSpdxExpressionTail(
  expression: string,
  knownIds?: Set<string>,
  markerText = '',
  allowBareClosingMarkers = true,
  lookup = knownIdLookupFor(knownIds),
): string {
  let endIndex = expression.length
  const tailMarkers = ['/*']
  if (allowBareClosingMarkers || markerText.includes('<!--')) {
    tailMarkers.push('-->')
  }
  if (allowBareClosingMarkers || isBlockCommentMarker(markerText)) {
    tailMarkers.push('*/')
  }
  for (const marker of tailMarkers) {
    const markerIndex = expression.indexOf(marker)
    if (markerIndex >= 0 && markerIndex < endIndex) endIndex = markerIndex
  }
  const inlineCommentEndIndex = spdxInlineCommentTailEndIndex(expression)
  if (inlineCommentEndIndex !== undefined && inlineCommentEndIndex < endIndex) {
    endIndex = inlineCommentEndIndex
  }
  const semicolonComment = /(^|\s|[A-Za-z0-9.+:)-]);(.*)$/u.exec(expression)
  if (semicolonComment?.index !== undefined) {
    const semicolonIndex =
      semicolonComment.index + (semicolonComment[1]?.length || 0)
    if (semicolonIndex < endIndex) {
      const tail = semicolonComment[2] || ''
      const spdxLikeTailEnd = consecutiveSpdxLikeSemicolonTailEnd(
        tail,
        knownIds,
        lookup,
      )
      if (spdxLikeTailEnd !== undefined) {
        const trimmedTailEnd = semicolonIndex + 1 + spdxLikeTailEnd
        if (trimmedTailEnd < endIndex) endIndex = trimmedTailEnd
      } else if (!hasSecondaryLicenseSemicolonTail(tail, knownIds, lookup)) {
        endIndex = semicolonIndex
      }
    }
  }
  return expression.slice(0, endIndex).trim()
}

export function hasSpdxIdToken(
  expression: string,
  knownIds?: Set<string>,
): boolean {
  const lookup = knownIdLookupFor(knownIds)
  const trimmedExpression = trimSpdxExpressionTail(
    expression,
    knownIds,
    '',
    true,
    lookup,
  )
  const tokens = trimmedExpression.match(/[A-Za-z0-9.+:-]+/g) || []
  return (
    hasValidSpdxExpressionShape(trimmedExpression) &&
    tokens.some((token) => isSpdxLikeIdToken(token, knownIds, lookup)) &&
    tokens.every(
      (token) =>
        isSpdxExpressionOperator(token) ||
        isSpdxLikeIdToken(token, knownIds, lookup),
    )
  )
}

export function spdxLineExpressions(
  input: string,
  knownIds?: Set<string>,
): string[] {
  const lookup = knownIdLookupFor(knownIds)
  const spdxLinePattern =
    /(?:^|[\r\n])\s*(?:(<!--|\/\/[/!]*|\/\*+!?|\*+|#|;|--|-)\s*)?SPDX-License-Identifier:[ \t]*([^\r\n]*)/gi
  return Array.from(input.matchAll(spdxLinePattern), (match) =>
    trimSpdxExpressionTail(
      match[2]?.trim() || '',
      knownIds,
      match[1] || '',
      false,
      lookup,
    ),
  )
}
