import { describe, expect, it } from 'vitest'
import {
  cachedLowercaseSetFor,
  cachedSetSnapshotMatches,
} from '../src/core/set-cache'

describe('cached set snapshot matching', () => {
  it('matches empty sets and snapshots', () => {
    expect(cachedSetSnapshotMatches(new Set(), [])).toBe(true)
  })

  it('matches sets with the same values in insertion order', () => {
    expect(
      cachedSetSnapshotMatches(new Set(['MIT', 'Apache-2.0']), [
        'MIT',
        'Apache-2.0',
      ]),
    ).toBe(true)
  })

  it('rejects sets with the same values in a different insertion order', () => {
    expect(
      cachedSetSnapshotMatches(new Set(['Apache-2.0', 'MIT']), [
        'MIT',
        'Apache-2.0',
      ]),
    ).toBe(false)
  })

  it('rejects sets with the same length and different values', () => {
    expect(
      cachedSetSnapshotMatches(new Set(['MIT', 'ISC']), ['MIT', 'Apache-2.0']),
    ).toBe(false)
  })

  it('rejects snapshots with a different length', () => {
    expect(cachedSetSnapshotMatches(new Set(['MIT']), ['MIT', 'ISC'])).toBe(
      false,
    )
  })

  it('rejects snapshots after the set is mutated', () => {
    const ids = new Set(['MIT', 'Apache-2.0'])
    const snapshot = Array.from(ids)

    expect(cachedSetSnapshotMatches(ids, snapshot)).toBe(true)
    ids.delete('MIT')
    ids.add('ISC')
    expect(cachedSetSnapshotMatches(ids, snapshot)).toBe(false)
  })
})

describe('cached lowercase sets', () => {
  it('returns lowercase values and reuses matching snapshots', () => {
    const ids = new Set(['MIT', 'Apache-2.0'])
    const lowercaseIds = cachedLowercaseSetFor(ids)

    expect(Array.from(lowercaseIds)).toEqual(['mit', 'apache-2.0'])
    expect(cachedLowercaseSetFor(ids)).toBe(lowercaseIds)
  })

  it('rebuilds lowercase values after the source set is mutated', () => {
    const ids = new Set(['MIT'])
    const lowercaseIds = cachedLowercaseSetFor(ids)

    ids.delete('MIT')
    ids.add('ISC')

    const updatedLowercaseIds = cachedLowercaseSetFor(ids)
    expect(updatedLowercaseIds).not.toBe(lowercaseIds)
    expect(Array.from(updatedLowercaseIds)).toEqual(['isc'])
  })
})
