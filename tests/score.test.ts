import { beforeEach, describe, expect, it } from 'vitest'
import {
  confidenceFromScore,
  createShingles,
  resetInputShingleCache,
  scoreText,
} from '../src/core/score'
import { licenses } from '../src/data/licenses.generated'

const byId = new Map(
  licenses.map((license) => [license.licenseId, license.text]),
)

function licenseText(licenseId: string): string {
  const text = byId.get(licenseId)
  if (!text) throw new Error(licenseId + ' not found in test data')
  return text
}

describe('shingle F1 scoring', () => {
  beforeEach(() => {
    resetInputShingleCache()
  })

  it('creates fixed-size word shingles', () => {
    expect(createShingles(['one', 'two', 'three', 'four'], 3)).toEqual(
      new Set(['one two three', 'two three four']),
    )
  })

  it('scores identical license text as exact', () => {
    const mit = licenseText('MIT')
    expect(scoreText(mit, mit).f1).toBe(1)
  })

  it('separates BSD two-clause and three-clause text', () => {
    const bsd2 = licenseText('BSD-2-Clause')
    const bsd3 = licenseText('BSD-3-Clause')
    expect(scoreText(bsd2, bsd2).f1).toBeGreaterThan(scoreText(bsd2, bsd3).f1)
    expect(scoreText(bsd3, bsd3).f1).toBeGreaterThan(scoreText(bsd3, bsd2).f1)
  })

  it('requires every score component for exact confidence', () => {
    expect(confidenceFromScore({ precision: 0.97, recall: 1, f1: 0.98 })).toBe(
      'Likely',
    )
    expect(confidenceFromScore({ precision: 1, recall: 0.97, f1: 0.98 })).toBe(
      'Likely',
    )
    expect(
      confidenceFromScore({ precision: 0.98, recall: 0.98, f1: 0.98 }),
    ).toBe('Exact')
  })

  it('maps lower F1 scores to likely, possible, or unknown confidence', () => {
    expect(confidenceFromScore(0.95)).toBe('Likely')
    expect(confidenceFromScore(0.8)).toBe('Possible')
    expect(confidenceFromScore(0.5)).toBe('Unknown')
  })
})
