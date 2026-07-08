import { legacyAliasById } from '../data/legacy-aliases'
import { spdxLicenseIds } from '../data/spdx-license-ids.generated'
import { spdxExceptionIds } from '../data/spdx-exceptions.generated'
import {
  hasValidSpdxExpressionShape,
  isSpdxExceptionLikeToken,
  isSpdxExpressionCompoundOperator,
  isSpdxExpressionIdToken,
  spdxLineExpressions,
  trimSpdxExpressionTail,
} from './spdx-expression'
import { cachedSetSnapshotMatches } from './set-cache'
import type { LegacyAlias } from './types'

export interface SpdxDetection {
  expression: string
  ids: string[]
  unsupportedIds: string[]
  hasCompoundExpression: boolean
  hasConjunctiveExpression: boolean
  hasWithException: boolean
  legacyAlias?: LegacyAlias
}

const spdxLicenseIdByLowercase = new Map(
  spdxLicenseIds.map((id) => [id.toLowerCase(), id]),
)
const canonicalSpdxTokenByLowercase = new Map([
  ...spdxLicenseIds.map((id) => [id.toLowerCase(), id]),
  ...spdxExceptionIds.map((id) => [id.toLowerCase(), id]),
  ...Array.from(legacyAliasById.values(), (alias) => [
    alias.legacyId.toLowerCase(),
    alias.legacyId,
  ]),
] as [string, string][])
const knownIdByLowercaseCache = new WeakMap<
  Set<string>,
  { ids: string[]; map: Map<string, string> }
>()

function knownIdByLowercaseFor(knownIds: Set<string>): Map<string, string> {
  const cached = knownIdByLowercaseCache.get(knownIds)
  if (cached && cachedSetSnapshotMatches(knownIds, cached.ids)) {
    return cached.map
  }

  const ids = Array.from(knownIds)
  const map = new Map(ids.map((id) => [id.toLowerCase(), id]))
  knownIdByLowercaseCache.set(knownIds, { ids, map })
  return map
}

export function detectSpdxIdentifier(
  input: string,
  knownIds: Set<string>,
): SpdxDetection | undefined {
  const trimmed = input.trim()
  const lineExpressions = spdxLineExpressions(trimmed, knownIds)
  const bareExpression = lineExpressions.length
    ? undefined
    : trimSpdxExpressionTail(trimmed, knownIds)
  const expressions = lineExpressions.length
    ? lineExpressions
    : bareExpression
      ? [bareExpression]
      : []
  if (expressions.length === 0) return undefined

  let knownIdByLowercase: Map<string, string> | undefined
  const canonicalKnownToken = (token: string): string | undefined => {
    const lowercaseToken = token.toLowerCase()
    return (
      canonicalSpdxTokenByLowercase.get(lowercaseToken) ||
      (knownIdByLowercase ??= knownIdByLowercaseFor(knownIds)).get(
        lowercaseToken,
      )
    )
  }
  const canonicalSupportedToken = (token: string): string =>
    canonicalKnownToken(token) || token

  const trimOuterParentheses = (tokens: string[]): string[] => {
    while (tokens[0] === '(' && tokens[tokens.length - 1] === ')') {
      let depth = 0
      let wrapsEntireExpression = true
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]
        if (token === '(') depth += 1
        if (token === ')') depth -= 1
        if (depth === 0 && index < tokens.length - 1) {
          wrapsEntireExpression = false
          break
        }
      }
      if (!wrapsEntireExpression) break
      tokens = tokens.slice(1, -1)
    }
    return tokens
  }
  const isCanonicalOperatorToken = (token: string): boolean =>
    token === 'and' || token === 'or' || token === 'with'
  const trimParenthesizedOperands = (tokens: string[]): string[] => {
    let changed = true
    while (changed) {
      changed = false
      const nextTokens: string[] = []
      for (let index = 0; index < tokens.length; index += 1) {
        const operand = tokens[index + 1]
        if (
          tokens[index] === '(' &&
          operand &&
          operand !== '(' &&
          operand !== ')' &&
          !isCanonicalOperatorToken(operand) &&
          tokens[index + 2] === ')'
        ) {
          nextTokens.push(operand)
          index += 2
          changed = true
          continue
        }
        nextTokens.push(tokens[index])
      }
      tokens = nextTokens
    }
    return tokens
  }
  const canonicalUnknownToken = (token: string): string =>
    /^(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+$/.test(token)
      ? token
      : token.toLowerCase()
  const canonicalExpressionKey = (expression: string): string =>
    trimOuterParentheses(
      trimParenthesizedOperands(
        trimOuterParentheses(
          Array.from(expression.matchAll(/[A-Za-z0-9.+:-]+|[()]/g), (match) => {
            return (
              canonicalKnownToken(match[0]) || canonicalUnknownToken(match[0])
            )
          }),
        ),
      ),
    ).join(' ')

  const parseExpression = (
    expression: string,
    explicitLine: boolean,
  ): SpdxDetection | undefined => {
    if (!hasValidSpdxExpressionShape(expression)) return undefined

    const rawTokens = Array.from(expression.matchAll(/[A-Za-z0-9.+:-]+/g)).map(
      (match) => match[0],
    )
    const idEntries = rawTokens
      .map((token, index) => ({ index, token }))
      .filter(({ token }) => isSpdxExpressionIdToken(token))
      .map(({ index, token }) => ({
        id: canonicalSupportedToken(token),
        index,
      }))
    const isWithException = (entry: { id: string; index: number }): boolean =>
      rawTokens[entry.index - 1]?.toLowerCase() === 'with' &&
      isSpdxExceptionLikeToken(entry.id)
    const hasWithException = idEntries.some(isWithException)
    const licenseEntries = idEntries.filter((entry) => !isWithException(entry))
    const hasCompoundExpression =
      licenseEntries.length > 1 ||
      rawTokens.some(isSpdxExpressionCompoundOperator)
    const hasConjunctiveExpression = rawTokens.some(
      (token) => token.toUpperCase() === 'AND',
    )
    const ids = idEntries.map((entry) => entry.id)

    if (ids.length === 0) return undefined

    const unsupportedIds = idEntries
      .filter(
        (entry) =>
          !knownIds.has(entry.id) &&
          !legacyAliasById.has(entry.id.toLowerCase()) &&
          !isWithException(entry),
      )
      .map((entry) => entry.id)
    const hasKnownOrLegacyId = ids.some(
      (id) => knownIds.has(id) || legacyAliasById.has(id.toLowerCase()),
    )
    const hasOnlyOfficialSpdxLicenseIds =
      licenseEntries.length > 0 &&
      licenseEntries.every((entry) =>
        spdxLicenseIdByLowercase.has(entry.id.toLowerCase()),
      )
    if (!hasKnownOrLegacyId && !explicitLine && !hasOnlyOfficialSpdxLicenseIds)
      return undefined
    if (
      unsupportedIds.length > 0 &&
      !explicitLine &&
      !hasOnlyOfficialSpdxLicenseIds
    ) {
      return undefined
    }

    const legacyAlias = ids
      .map((id) => legacyAliasById.get(id.toLowerCase()))
      .find((alias): alias is LegacyAlias => Boolean(alias))

    return {
      expression,
      ids,
      unsupportedIds,
      hasCompoundExpression,
      hasConjunctiveExpression,
      hasWithException,
      legacyAlias,
    }
  }

  const explicitLine = lineExpressions.length > 0
  const detections: SpdxDetection[] = []
  for (const expression of expressions) {
    const detection = parseExpression(expression, explicitLine)
    if (!detection) return undefined
    detections.push(detection)
  }
  if (detections.length === 0) return undefined
  if (detections.length === 1) return detections[0]

  const uniqueDetections: SpdxDetection[] = []
  const seenExpressionKeys = new Set<string>()
  for (const detection of detections) {
    const key = canonicalExpressionKey(detection.expression)
    if (seenExpressionKeys.has(key)) continue
    seenExpressionKeys.add(key)
    uniqueDetections.push(detection)
  }
  if (uniqueDetections.length === 1) return uniqueDetections[0]

  return {
    expression: uniqueDetections
      .map((detection) =>
        detection.hasCompoundExpression
          ? '(' + detection.expression + ')'
          : detection.expression,
      )
      .join(' AND '),
    ids: Array.from(
      new Set(uniqueDetections.flatMap((detection) => detection.ids)),
    ),
    unsupportedIds: Array.from(
      new Set(
        uniqueDetections.flatMap((detection) => detection.unsupportedIds),
      ),
    ),
    hasCompoundExpression: true,
    hasConjunctiveExpression: true,
    hasWithException: uniqueDetections.some(
      (detection) => detection.hasWithException,
    ),
    legacyAlias: uniqueDetections.find((detection) => detection.legacyAlias)
      ?.legacyAlias,
  }
}
