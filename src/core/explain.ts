import {
  diff_match_patch,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
} from 'diff-match-patch'
import { normalizeStrict } from './normalize'
import type { DiffSegment, InputType } from './types'

const maxDiffCharacters = 120_000
const maxDiffSummaryCharacters = 2000
const largeDiffMessage = 'Diff summary disabled for large inputs.'

function codePointLength(text: string): number {
  const iterator = text[Symbol.iterator]()
  let length = 0
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    length += 1
  }
  return length
}

function exceedsCodePointLimit(text: string, limit: number): boolean {
  const iterator = text[Symbol.iterator]()
  let length = 0
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    length += 1
    if (length > limit) return true
  }
  return false
}

function sliceCodePoints(text: string, limit: number): string {
  if (limit <= 0) return ''
  const codePoints: string[] = []
  let count = 0
  for (const codePoint of text) {
    if (count >= limit) break
    codePoints.push(codePoint)
    count += 1
  }
  return codePoints.join('')
}

function lastCodePoints(text: string, limit: number): string {
  if (limit <= 0) return ''
  const codePoints = new Array<string>(limit)
  let start = 0
  let length = 0
  for (const codePoint of text) {
    const index = (start + length) % limit
    codePoints[index] = codePoint
    if (length === limit) {
      start = (start + 1) % limit
    } else {
      length += 1
    }
  }
  const result: string[] = []
  for (let offset = 0; offset < length; offset += 1) {
    result.push(codePoints[(start + offset) % limit])
  }
  return result.join('')
}

function summarizeEqualText(text: string): string {
  if (!exceedsCodePointLimit(text, 160)) return text
  return sliceCodePoints(text, 80) + ' ... ' + lastCodePoints(text, 80)
}

function diffSegmentPrefixLength(segment: DiffSegment): number {
  return segment.type === 'equal' ? 0 : 2
}

function limitDiffSegments(segments: DiffSegment[]): DiffSegment[] {
  let remaining = maxDiffSummaryCharacters
  const limited: DiffSegment[] = []

  for (const segment of segments) {
    const separatorLength = limited.length > 0 ? 1 : 0
    const segmentPrefixLength = diffSegmentPrefixLength(segment)
    const textLimit = remaining - separatorLength - segmentPrefixLength
    if (textLimit <= 0) break

    const segmentTextLength = codePointLength(segment.text)
    const text = sliceCodePoints(segment.text, textLimit)
    limited.push({ ...segment, text })
    remaining -= separatorLength + segmentPrefixLength + codePointLength(text)
    if (segmentTextLength > textLimit) break
  }

  return limited
}

export function explainNormalizedDiffSegments(
  normalizedInput: string,
  normalizedLicenseText: string,
): DiffSegment[] {
  if (
    exceedsCodePointLimit(normalizedInput, maxDiffCharacters) ||
    exceedsCodePointLimit(normalizedLicenseText, maxDiffCharacters)
  )
    return [{ type: 'equal', text: largeDiffMessage }]

  const dmp = new diff_match_patch()
  const diffs = dmp.diff_main(normalizedInput, normalizedLicenseText)
  dmp.diff_cleanupSemantic(diffs)
  return limitDiffSegments(
    diffs
      .map(([type, value]): DiffSegment | undefined => {
        const text = value.replace(/\s+/g, ' ').trim()
        if (!text) return undefined
        if (type === DIFF_EQUAL) {
          return { type: 'equal', text: summarizeEqualText(text) }
        }
        if (type === DIFF_INSERT) return { type: 'insert', text }
        if (type === DIFF_DELETE) return { type: 'delete', text }
        return { type: 'equal', text }
      })
      .filter((segment): segment is DiffSegment => Boolean(segment)),
  )
}

export function formatDiffSegments(segments: DiffSegment[]): string {
  return sliceCodePoints(
    segments
      .map((segment) => {
        if (segment.type === 'insert') return '+ ' + segment.text
        if (segment.type === 'delete') return '- ' + segment.text
        return segment.text
      })
      .join(' '),
    maxDiffSummaryCharacters,
  )
}

export function explainNormalizedDiff(
  normalizedInput: string,
  normalizedLicenseText: string,
): string {
  return formatDiffSegments(
    explainNormalizedDiffSegments(normalizedInput, normalizedLicenseText),
  )
}

export function explainDiff(input: string, licenseText: string): string {
  return explainNormalizedDiff(
    normalizeStrict(input),
    normalizeStrict(licenseText),
  )
}

export function explainDiffSegments(
  input: string,
  licenseText: string,
): DiffSegment[] {
  return explainNormalizedDiffSegments(
    normalizeStrict(input),
    normalizeStrict(licenseText),
  )
}

export function buildExplanation(
  licenseId: string,
  inputType: InputType,
  f1: number,
  needsManualReview: boolean,
): string {
  if (needsManualReview) {
    return (
      licenseId +
      ' is close, but GNU only/or-later wording needs manual confirmation.'
    )
  }
  if (inputType === 'spdx-expression')
    return 'The input contains a matching SPDX license identifier.'
  if (inputType === 'license-notice' || inputType === 'license-header') {
    return 'The wording matches a license notice or header, not a complete license text.'
  }
  if (f1 >= 0.98) return 'The normalized text is an almost exact match.'
  if (f1 >= 0.9) return 'Most distinctive license shingles match this license.'
  if (f1 >= 0.7)
    return 'Some license shingles match, but confidence is limited.'
  return 'The input does not reliably match this license.'
}
