import { describe, expect, it } from 'vitest'
import { licenses, spdxSourceVersion } from '../src/data/licenses.generated'
import {
  spdxExceptionIds,
  spdxExceptionSourceVersion,
} from '../src/data/spdx-exceptions.generated'
import {
  spdxLicenseIds,
  spdxLicenseIdSourceVersion,
} from '../src/data/spdx-license-ids.generated'
import { legacyAliases } from '../src/data/legacy-aliases'

describe('generated SPDX data', () => {
  it('contains the phase-one SPDX snapshot', () => {
    expect(spdxSourceVersion).toBe('v3.28.0')
    expect(spdxLicenseIdSourceVersion).toBe('v3.28.0')
    expect(spdxExceptionSourceVersion).toBe('v3.28.0')
    expect(licenses).toHaveLength(36)
  })

  it('has complete unique primary entries', () => {
    const ids = new Set<string>()
    for (const license of licenses) {
      expect(license.licenseId).toBeTruthy()
      expect(license.name).toBeTruthy()
      expect(license.text.length).toBeGreaterThan(100)
      expect(Array.isArray(license.seeAlso)).toBe(true)
      expect(license.seeAlso.every((value) => typeof value === 'string')).toBe(
        true,
      )
      expect(typeof license.isOsiApproved).toBe('boolean')
      if (license.isFsfLibre !== undefined)
        expect(typeof license.isFsfLibre).toBe('boolean')
      expect(license.isDeprecated).toBe(false)
      expect(ids.has(license.licenseId)).toBe(false)
      ids.add(license.licenseId)
    }
  })

  it('has complete unique SPDX exception IDs', () => {
    const ids = new Set<string>()
    expect(spdxExceptionIds).toHaveLength(84)
    for (const id of spdxExceptionIds) {
      expect(id).toMatch(/^[A-Za-z0-9.+-]+$/)
      expect(ids.has(id), id).toBe(false)
      ids.add(id)
    }
  })

  it('has complete unique SPDX license IDs', () => {
    const ids = new Set<string>()
    expect(spdxLicenseIds.length).toBeGreaterThan(600)
    for (const id of spdxLicenseIds) {
      expect(id).toMatch(/^[A-Za-z0-9.+-]+$/)
      expect(ids.has(id), id).toBe(false)
      ids.add(id)
    }
    for (const license of licenses) {
      expect(ids.has(license.licenseId), license.licenseId).toBe(true)
    }
    expect(ids.has('OFL-1.1')).toBe(true)
    expect(ids.has('OSL-3.0')).toBe(true)
    expect(ids.has('ZPL-2.1')).toBe(true)
  })

  it('uses GNU only/or-later IDs and keeps legacy IDs as aliases', () => {
    const ids = new Set(licenses.map((license) => license.licenseId))
    expect(ids.has('GPL-2.0')).toBe(false)
    expect(ids.has('GPL-2.0-only')).toBe(true)
    expect(ids.has('GPL-2.0-or-later')).toBe(true)
    expect(
      legacyAliases.find((alias) => alias.legacyId === 'GPL-2.0')?.candidates,
    ).toEqual(['GPL-2.0-only', 'GPL-2.0-or-later'])
  })
})
