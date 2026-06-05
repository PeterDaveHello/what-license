const shebangPattern = /^#!.*$/m
const blockCommentOpenLinePattern = /^[ \t]*\/\*+!?[ \t]?(.*)$/
const standaloneBlockCommentCloseLinePattern = /^[ \t]*\*+\/[ \t]*$/
export const lineCommentShellPattern = /^\s*(?:\*|\/\/|#|--|;)+\s?/
// Mid-line */ alone does not trigger stripping without a matching /* opener.
const commentShellCandidatePattern =
  /\/\*|(?:^|[\r\n])\s*(?:\*|\/\/|#|--|;)+\s?/
const shortLicenseMarkerPattern =
  /^(?:0bsd|afl(?:[- ]?3(?:\.0)?)?|agpl(?:[- ]?[0-9].*)?|apache(?:[- ]?(?:2(?:\.0)?|license))?|artistic(?:[- ]?2(?:\.0)?)?|blue[- ]?oak(?:[- ]?1(?:\.0){2})?|bsd(?:[- ]?[23][ -]?clause)?|bsl(?:[- ]?1(?:\.0)?)?|cddl(?:[- ]?1(?:\.[01])?)?|cc0(?:[- ]?1(?:\.0)?)?|epl(?:[- ]?[12](?:\.0)?)?|eupl(?:[- ]?1(?:\.2)?)?|gpl(?:[- ]?[23](?:\.0)?(?:[- ](?:only|or[- ]later))?)?|isc|lgpl(?:[- ]?[23](?:\.[01])?(?:[- ](?:only|or[- ]later))?)?|mit(?:[- ]?0)?|mpl(?:[- ]?v?[12](?:\.[01])?)?|ms[- ]?pl|ncsa|postgresql|wtfpl|zlib|unlicense)$/
const copyrightYearTailPatternSource = String.raw`(?:[ \t]*(?:[-‐‑‒–—,][ \t]*)+\d{4}|[ \t]+(?:and|or)[ \t]+\d{4}|[ \t]+\d{4})*`
const copyrightYearPattern = new RegExp(
  String.raw`(?:copyright\s*)?(?:\(c\)|©)\s*\d{4}${copyrightYearTailPatternSource}|copyright\s*\d{4}${copyrightYearTailPatternSource}`,
  'gi',
)
const licenseRelevantBlockCommentTrailingPattern =
  /\b(?:all rights reserved|copying|copyright|licen[cs]e|licensed|permission|spdx-license-identifier)\b|(?:\(c\)|©)\s*\d{4}/i

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function singleLineBlockCommentShellContent(line: string): string | undefined {
  const trimmed = line.trim()
  if (
    trimmed.length < 4 ||
    trimmed[0] !== '/' ||
    trimmed[1] !== '*' ||
    trimmed[trimmed.length - 1] !== '/' ||
    trimmed[trimmed.length - 2] !== '*'
  ) {
    return undefined
  }

  let start = 2
  while (start < trimmed.length - 1 && trimmed[start] === '*') start += 1
  if (trimmed[start] === '!') start += 1
  if (start === trimmed.length - 1) start -= 1
  if (/\s/.test(trimmed[start] || '')) start += 1

  let end = trimmed.length - 2
  while (end > start && trimmed[end - 1] === '*') end -= 1
  if (end > start && /\s/.test(trimmed[end - 1] || '')) end -= 1

  return trimmed.slice(start, end)
}

function blockCommentCloseLineContent(line: string): string | undefined {
  const closeIndex = line.indexOf('*/')
  if (closeIndex === -1) return undefined

  let contentEnd = closeIndex
  while (contentEnd > 0 && line[contentEnd - 1] === '*') contentEnd -= 1
  while (contentEnd > 0 && /[ \t]/.test(line[contentEnd - 1] || '')) {
    contentEnd -= 1
  }

  let trailingStart = closeIndex + 2
  while (
    trailingStart < line.length &&
    /[ \t]/.test(line[trailingStart] || '')
  ) {
    trailingStart += 1
  }

  const beforeClose = line.slice(0, contentEnd)
  const afterClose = line.slice(trailingStart)
  if (!licenseRelevantBlockCommentTrailingPattern.test(afterClose)) {
    return beforeClose
  }
  if (!beforeClose) return afterClose
  return beforeClose + ' ' + afterClose
}

export function stripCommentShell(text: string): string {
  const normalized = normalizeNewlines(text)
  if (!commentShellCandidatePattern.test(normalized)) return normalized

  const lines = normalized.split('\n')
  const strippedLines: string[] = []
  const nextBlockCloseIndex: Array<number | undefined> = []
  const lineCommentShellPrefixCounts = [0]
  let inBlockComment = false
  let followingBlockCloseIndex: number | undefined

  for (let index = 0; index < lines.length; index += 1) {
    lineCommentShellPrefixCounts[index + 1] =
      lineCommentShellPrefixCounts[index] +
      (lineCommentShellPattern.test(lines[index]) ? 1 : 0)
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    nextBlockCloseIndex[index] = followingBlockCloseIndex
    if (
      blockCommentCloseLineContent(lines[index]) !== undefined &&
      singleLineBlockCommentShellContent(lines[index]) === undefined
    ) {
      followingBlockCloseIndex = index
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (shebangPattern.test(line)) continue

    const singleLineBlockComment = singleLineBlockCommentShellContent(line)
    if (singleLineBlockComment !== undefined) {
      strippedLines.push(singleLineBlockComment)
      continue
    }

    if (inBlockComment) {
      if (standaloneBlockCommentCloseLinePattern.test(line)) {
        inBlockComment = false
        continue
      }
      const blockCommentCloseLine = blockCommentCloseLineContent(line)
      if (blockCommentCloseLine !== undefined) {
        inBlockComment = false
        if (blockCommentCloseLine)
          strippedLines.push(
            blockCommentCloseLine.replace(lineCommentShellPattern, ''),
          )
        continue
      }
      strippedLines.push(line.replace(lineCommentShellPattern, ''))
      continue
    }

    const blockCommentOpenLine = blockCommentOpenLinePattern.exec(line)
    const blockCommentCloseIndex = nextBlockCloseIndex[index]
    if (
      blockCommentOpenLine &&
      blockCommentCloseIndex !== undefined &&
      hasWrappedBlockCommentShell(
        lines,
        index,
        blockCommentCloseIndex,
        blockCommentOpenLine[1],
        lineCommentShellPrefixCounts,
      )
    ) {
      inBlockComment = true
      if (blockCommentOpenLine[1]) strippedLines.push(blockCommentOpenLine[1])
      continue
    }

    strippedLines.push(line.replace(lineCommentShellPattern, ''))
  }

  return strippedLines.join('\n')
}

function hasWrappedBlockCommentShell(
  lines: string[],
  openIndex: number,
  closeIndex: number,
  openerContent: string,
  lineCommentShellPrefixCounts: number[],
): boolean {
  if (!openerContent.trim()) return true
  if (standaloneBlockCommentCloseLinePattern.test(lines[closeIndex]))
    return true
  const closeLineContent =
    blockCommentCloseLineContent(lines[closeIndex])?.trim() || ''

  if (
    lineCommentShellPrefixCounts[closeIndex + 1] >
    lineCommentShellPrefixCounts[openIndex + 1]
  )
    return true
  if (closeLineContent) {
    if (
      isLiteralBlockMarker(openerContent) &&
      isLiteralBlockMarker(closeLineContent)
    )
      return false
    return true
  }
  return false
}

function isLiteralBlockMarker(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return false
  if (/[^\w .-]/.test(normalized)) return false
  if (normalized.split(/\s+/).length > 3) return false
  if (shortLicenseMarkerPattern.test(normalized)) return false
  return !/\b(?:conditions|copyright|grant|granted|license|permission|software|terms|warranty)\b/.test(
    normalized,
  )
}

export function normalizeStrict(text: string): string {
  return stripCommentShell(text.replace(/^\uFEFF/, ''))
    .normalize('NFKC')
    .replace(copyrightYearPattern, 'copyright <year>')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .toLowerCase()
}

export function normalizeLoose(text: string): string {
  return normalizeStrict(text)
    .replace(/<year>(?:\s*[-,]\s*<year>)*/g, '<year>')
    .replace(/[^a-z0-9<>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenizeWords(text: string): string[] {
  return normalizeLoose(text).match(/[a-z0-9<>]+/g) || []
}
