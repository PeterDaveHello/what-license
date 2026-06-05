import { tokenizeWords } from './normalize'
import type { Confidence, ScoreBreakdown } from './types'

const maxLicenseShingleCacheEntries = 128
const licenseShingleCache = new Map<string, Set<string>>()
let cachedInputText: string | undefined
let cachedInputShingles: Set<string> | undefined

export function resetInputShingleCache(): void {
  cachedInputText = undefined
  cachedInputShingles = undefined
}

export function createShingles(tokens: string[], size = 5): Set<string> {
  if (tokens.length < size)
    return new Set(tokens.length ? [tokens.join(' ')] : [])
  const shingles = new Set<string>()
  for (let index = 0; index <= tokens.length - size; index += 1) {
    let shingle = tokens[index] || ''
    for (let offset = 1; offset < size; offset += 1) {
      shingle += ' ' + tokens[index + offset]
    }
    shingles.add(shingle)
  }
  return shingles
}

function shinglesForInput(text: string): Set<string> {
  if (text === cachedInputText && cachedInputShingles) {
    return cachedInputShingles
  }
  cachedInputText = text
  cachedInputShingles = createShingles(tokenizeWords(text))
  return cachedInputShingles
}

function shinglesForLicenseText(text: string): Set<string> {
  const cached = licenseShingleCache.get(text)
  if (cached) {
    licenseShingleCache.delete(text)
    licenseShingleCache.set(text, cached)
    return cached
  }
  const shingles = createShingles(tokenizeWords(text))
  licenseShingleCache.set(text, shingles)
  while (licenseShingleCache.size > maxLicenseShingleCacheEntries) {
    const oldestKey = licenseShingleCache.keys().next().value
    if (oldestKey !== undefined) licenseShingleCache.delete(oldestKey)
  }
  return shingles
}

export function scoreText(input: string, licenseText: string): ScoreBreakdown {
  const inputShingles = shinglesForInput(input)
  const licenseShingles = shinglesForLicenseText(licenseText)
  if (inputShingles.size === 0 || licenseShingles.size === 0) {
    return { precision: 0, recall: 0, f1: 0 }
  }

  let overlap = 0
  const smallerSet =
    inputShingles.size <= licenseShingles.size ? inputShingles : licenseShingles
  const largerSet =
    inputShingles.size <= licenseShingles.size ? licenseShingles : inputShingles
  for (const shingle of smallerSet) {
    if (largerSet.has(shingle)) overlap += 1
  }

  const precision = overlap / inputShingles.size
  const recall = overlap / licenseShingles.size
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1 }
}

export function confidenceFromScore(
  score: ScoreBreakdown | number,
): Confidence {
  const f1 = typeof score === 'number' ? score : score.f1
  if (f1 >= 0.98) {
    if (
      typeof score !== 'number' &&
      (score.precision < 0.98 || score.recall < 0.98)
    )
      return 'Likely'
    return 'Exact'
  }
  if (f1 >= 0.9) return 'Likely'
  if (f1 >= 0.7) return 'Possible'
  return 'Unknown'
}
