import { describe, expect, it } from 'vitest'
import { licenses } from '../src/data/licenses.generated'
import randomText from './fixtures/random-text.txt?raw'
import {
  explainNormalizedDiffSegments,
  formatDiffSegments,
} from '../src/core/explain'
import { inputTooLargeMessage, maxInputSize } from '../src/core/constants'
import {
  diffForResult,
  diffSegmentsForResult,
  rankLicenses,
} from '../src/core/rank'
import { classifyInput } from '../src/core/classify-input'

const byId = new Map(
  licenses.map((license) => [license.licenseId, license.text]),
)
const knownIds = new Set(licenses.map((license) => license.licenseId))

function isGnuFamilyLicenseId(licenseId: string): boolean {
  return /^(?:AGPL|GPL|LGPL)-/.test(licenseId)
}

function first(input: string) {
  return rankLicenses(input, licenses).results[0]
}

function expectNoExactOrLikelyLicense(input: string, licenseId: string) {
  const response = rankLicenses(input, licenses, { includeDiffs: false })
  expect(
    response.results.some(
      (result) =>
        result.licenseId === licenseId &&
        (result.confidence === 'Exact' || result.confidence === 'Likely'),
    ),
    input,
  ).toBe(false)
}

function expectNoLicensePrefixes(
  response: ReturnType<typeof rankLicenses>,
  prefixes: string[],
) {
  expect(
    response.results.filter((result) =>
      prefixes.some((prefix) => result.licenseId.startsWith(prefix)),
    ),
  ).toHaveLength(0)
}

function hasUnpairedSurrogate(text: string): boolean {
  return Array.from(text).some((char) => {
    const codeUnit = char.charCodeAt(0)
    return char.length === 1 && codeUnit >= 0xd800 && codeUnit <= 0xdfff
  })
}

describe('license ranking', () => {
  it(
    'matches every supported complete license text',
    { timeout: 60000 },
    () => {
      for (const license of licenses) {
        const response = rankLicenses(license.text, licenses, {
          includeDiffs: false,
        })
        expect(response.results.length, license.licenseId).toBeGreaterThan(0)
        expect(response.inputType, license.licenseId).toBe('full-license-text')
        if (isGnuFamilyLicenseId(license.licenseId)) {
          expect(
            response.results.some(
              (result) => result.licenseId === license.licenseId,
            ),
            license.licenseId,
          ).toBe(true)
        } else {
          expect(response.results[0], license.licenseId).toMatchObject({
            licenseId: license.licenseId,
          })
        }
      }
    },
  )

  it('matches complete common license texts', { timeout: 10_000 }, () => {
    expect(first(byId.get('MIT') || '')?.licenseId).toBe('MIT')
    expect(first(byId.get('Apache-2.0') || '')?.licenseId).toBe('Apache-2.0')
    expect(first(byId.get('BSD-2-Clause') || '')?.licenseId).toBe(
      'BSD-2-Clause',
    )
    expect(first(byId.get('BSD-3-Clause') || '')?.licenseId).toBe(
      'BSD-3-Clause',
    )
    expect(first(byId.get('MPL-1.0') || '')?.licenseId).toBe('MPL-1.0')
    expect(first(byId.get('MPL-1.1') || '')?.licenseId).toBe('MPL-1.1')
    expect(first(byId.get('MPL-2.0') || '')?.licenseId).toBe('MPL-2.0')
  })

  it('classifies filled BSD full texts as full license text', () => {
    const bsd2 = (byId.get('BSD-2-Clause') || '').replace(
      '<year> <owner>',
      '2026 Example Corp',
    )
    const response = rankLicenses(bsd2, licenses, { includeDiffs: false })

    expect(response.inputType).toBe('full-license-text')
    expect(response.results[0]).toMatchObject({
      licenseId: 'BSD-2-Clause',
    })
    expect(response.results[0]?.confidence).not.toBe('Unknown')
  })

  it('flags ambiguous GNU full texts instead of hard-guessing only/or-later', () => {
    const gpl2Response = rankLicenses(byId.get('GPL-2.0-only') || '', licenses)
    const gpl3Response = rankLicenses(byId.get('GPL-3.0-only') || '', licenses)
    const agpl3Response = rankLicenses(
      byId.get('AGPL-3.0-only') || '',
      licenses,
    )
    const gpl2 = gpl2Response.results[0]
    const gpl3 = gpl3Response.results[0]
    const agpl3 = agpl3Response.results[0]

    expect(gpl2?.licenseId).toMatch(/^GPL-2\.0-/)
    expect(gpl2?.flags.needsManualReview).toBe(true)
    expect(gpl2?.confidence).toBe('Possible')
    expectNoLicensePrefixes(gpl2Response, ['GPL-3.', 'LGPL-', 'AGPL-'])
    expect(gpl3?.licenseId).toMatch(/^GPL-3\.0-/)
    expect(gpl3?.flags.needsManualReview).toBe(true)
    expect(gpl3?.confidence).toBe('Possible')
    expectNoLicensePrefixes(gpl3Response, ['GPL-2.', 'LGPL-', 'AGPL-'])
    expect(agpl3?.licenseId).toMatch(/^AGPL-3\.0-/)
    expect(agpl3?.flags.needsManualReview).toBe(true)
    expect(agpl3?.confidence).toBe('Possible')
    expectNoLicensePrefixes(agpl3Response, ['GPL-', 'LGPL-'])

    const lgpl21Response = rankLicenses(
      byId.get('LGPL-2.1-only') || '',
      licenses,
    )
    const lgpl30Response = rankLicenses(
      byId.get('LGPL-3.0-only') || '',
      licenses,
    )
    const lgpl21 = lgpl21Response.results[0]
    const lgpl30 = lgpl30Response.results[0]

    expect(lgpl21?.licenseId).toMatch(/^LGPL-2\.1-/)
    expect(lgpl21?.flags.needsManualReview).toBe(true)
    expect(lgpl21?.confidence).toBe('Possible')
    expectNoLicensePrefixes(lgpl21Response, ['LGPL-3.', 'GPL-', 'AGPL-'])
    expect(lgpl30?.licenseId).toMatch(/^LGPL-3\.0-/)
    expect(lgpl30?.flags.needsManualReview).toBe(true)
    expect(lgpl30?.confidence).toBe('Possible')
    expectNoLicensePrefixes(lgpl30Response, ['LGPL-2.', 'GPL-', 'AGPL-'])
  })

  it('keeps AGPL body matches when earlier prose mentions GPL', () => {
    const response = rankLicenses(
      'See also the GNU General Public License for background.' +
        String.fromCharCode(10, 10) +
        (byId.get('AGPL-3.0-only') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('full-license-text')
    expect(response.results[0]?.licenseId).toMatch(/^AGPL-3\.0-/)
    expect(response.results[0]?.confidence).toBe('Possible')
    expectNoLicensePrefixes(response, ['GPL-', 'LGPL-'])
  })

  it('keeps high-recall AGPL body matches after opening AGPL wording is removed', () => {
    const agpl3 = byId.get('AGPL-3.0-only') || ''
    const strippedAgpl3 = agpl3
      .replace(
        /^GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n\n/,
        '',
      )
      .replace(
        'The GNU Affero General Public License is a free, copyleft license for software and other kinds of works, specifically designed to ensure cooperation with the community in the case of network server software.\n\n',
        '',
      )
    const response = rankLicenses(strippedAgpl3, licenses, {
      includeDiffs: false,
    })

    expect(response.inputType).toBe('full-license-text')
    expect(response.results[0]?.licenseId).toMatch(/^AGPL-3\.0-/)
    expect(response.results[0]?.confidence).toBe('Possible')
    expectNoLicensePrefixes(response, ['GPL-', 'LGPL-'])
  })

  it('keeps modified full-license matches with large non-word tails', () => {
    const mit = byId.get('MIT') || ''
    const modifiedMit = mit.replace(
      'Permission is hereby granted',
      'Permission is granted',
    )
    const response = rankLicenses(
      modifiedMit + String.fromCharCode(10, 10) + '.'.repeat(220_000),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('full-license-text')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
    })
    expect(response.results[0]?.confidence).not.toBe('Unknown')
  })

  it('rejects oversized inputs before ranking licenses', () => {
    const response = rankLicenses('x'.repeat(maxInputSize + 1), licenses)

    expect(response).toMatchObject({
      inputType: 'unknown',
      results: [],
      message: inputTooLargeMessage,
    })
  })

  it('keeps short GPL headers from surfacing AGPL candidates', () => {
    const response = rankLicenses(
      'Licensed under GNU General Public License version 3 only',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]?.licenseId).toMatch(/^GPL-3\.0-/)
    expectNoLicensePrefixes(response, ['AGPL-', 'LGPL-'])
  })

  it('detects SPDX identifiers exactly', () => {
    const response = rankLicenses('SPDX-License-Identifier: MIT', licenses)
    expect(response.inputType).toBe('spdx-expression')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
      flags: { isLegacyId: false },
    })

    for (const input of ['MIT -->', 'MIT */']) {
      const bareCommentResponse = rankLicenses(input, licenses)
      expect(bareCommentResponse.inputType, input).toBe('spdx-expression')
      expect(bareCommentResponse.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }

    const markdownBulletResponse = rankLicenses(
      '- SPDX-License-Identifier: MIT',
      licenses,
    )
    expect(markdownBulletResponse.inputType).toBe('spdx-expression')
    expect(markdownBulletResponse.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })

    const bareCompoundResponse = rankLicenses('( MIT OR Apache-2.0 )', licenses)
    expect(bareCompoundResponse.inputType).toBe('spdx-expression')
    expect(bareCompoundResponse.message).toContain('future parser')
    expect(bareCompoundResponse.results).toHaveLength(0)

    const bareUnsupportedResponse = rankLicenses('BSD-4-Clause', licenses)
    expect(bareUnsupportedResponse.inputType).toBe('spdx-expression')
    expect(bareUnsupportedResponse.spdxExpression).toBe('BSD-4-Clause')
    expect(bareUnsupportedResponse.message).toContain('future parser')
    expect(bareUnsupportedResponse.results).toHaveLength(0)

    const repeatedLineResponse = rankLicenses(
      'SPDX-License-Identifier: MIT\nSPDX-License-Identifier: mit',
      licenses,
    )
    expect(repeatedLineResponse.inputType).toBe('spdx-expression')
    expect(repeatedLineResponse.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })

    for (const input of [
      '<!-- SPDX-License-Identifier: MIT --> Copyright 2026',
      '/* SPDX-License-Identifier: MIT */ Copyright 2026',
      '/*\n * SPDX-License-Identifier: MIT */ Copyright 2026',
    ]) {
      const commentResponse = rankLicenses(input, licenses)
      expect(commentResponse.inputType, input).toBe('spdx-expression')
      expect(commentResponse.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }

    for (const input of [
      'SPDX-License-Identifier: MIT # internal note',
      'SPDX-License-Identifier: MIT // internal note',
      'SPDX-License-Identifier: MIT ; internal note',
      'SPDX-License-Identifier: MIT -- internal note',
      'SPDX-License-Identifier: MIT; internal note',
      'SPDX-License-Identifier: MIT-- internal note',
      'SPDX-License-Identifier: MIT// internal note',
      'SPDX-License-Identifier: MIT# internal note',
      'SPDX-License-Identifier: MIT /* internal note */',
      'SPDX-License-Identifier: MIT/* internal note */',
      'SPDX-License-Identifier: MIT; Acme, Corp',
      'SPDX-License-Identifier: MIT; Copyright, Holder',
      'SPDX-License-Identifier: MIT; additional license information',
      'SPDX-License-Identifier: MIT; also see LICENSE',
      'SPDX-License-Identifier: MIT; also see license file',
      'SPDX-License-Identifier: MIT; INTERNAL, TESTING',
      'SPDX-License-Identifier: MIT; ACME-2024',
      'SPDX-License-Identifier: MIT; Apache-2.0 with runtime dependencies',
      'SPDX-License-Identifier: MIT; Apache-2.0 (runtime dependency)',
      'SPDX-License-Identifier: MIT; Apache-2.0 and ISC for dependencies',
      'SPDX-License-Identifier: MIT; Apache-2.0 for dependencies; ISC',
      'SPDX-License-Identifier: MIT; Apache-2.0 for package dependencies',
      'SPDX-License-Identifier: MIT; Apache License 2.0 for source code dependencies',
      'SPDX-License-Identifier: MIT; also Apache-2.0 for dependencies',
      'SPDX-License-Identifier: MIT; also; Apache-2.0 for dependencies',
      'SPDX-License-Identifier: MIT; also under Apache-2.0 for dependencies',
      'SPDX-License-Identifier: MIT; also licensed under Apache-2.0 for runtime dependencies',
      'SPDX-License-Identifier: MIT; also licensed under Apache License 2.0 for dependencies',
      'SPDX-License-Identifier: MIT; UTF-8',
      'SPDX-License-Identifier: MIT; RFC-2119',
      'SPDX-License-Identifier: MIT; ISO-639-1',
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10) +
        'Release-Notes-2026',
      'SPDX-License-Identifier: MIT' + String.fromCharCode(10) + 'Version-1.0',
    ]) {
      const inlineCommentResponse = rankLicenses(input, licenses)
      expect(inlineCommentResponse.inputType, input).toBe('spdx-expression')
      expect(inlineCommentResponse.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }

    const inlineCommentHeaderResponse = rankLicenses(
      'SPDX-License-Identifier: MIT // Licensed under Apache-2.0',
      licenses,
      { includeDiffs: false },
    )
    expect(inlineCommentHeaderResponse.inputType).toBe('spdx-expression')
    expect(inlineCommentHeaderResponse.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })

    const semicolonResponse = rankLicenses(
      'SPDX-License-Identifier: MIT; Apache-2.0',
      licenses,
    )
    expect(semicolonResponse.inputType).toBe('unknown')
    expect(semicolonResponse.message).toContain('Unknown')
    expect(semicolonResponse.results).toHaveLength(0)

    for (const input of [
      'SPDX-License-Identifier: MIT; and Apache-2.0',
      'SPDX-License-Identifier: MIT; or Apache-2.0',
      'SPDX-License-Identifier: MIT; with Classpath-exception-2.0',
    ]) {
      const malformedLowercaseTailResponse = rankLicenses(input, licenses)
      expect(malformedLowercaseTailResponse.inputType, input).toBe('unknown')
      expect(malformedLowercaseTailResponse.message, input).toContain('Unknown')
      expect(malformedLowercaseTailResponse.results, input).toHaveLength(0)
    }

    const commaListResponse = rankLicenses(
      'SPDX-License-Identifier: MIT, BSD-3-Clause',
      licenses,
    )
    expect(commaListResponse.inputType).toBe('unknown')
    expect(commaListResponse.message).toContain('Unknown')
    expect(commaListResponse.results).toHaveLength(0)

    const annotatedSemicolonResponse = rankLicenses(
      'SPDX-License-Identifier: MIT; Apache-2.0 (Apache License)',
      licenses,
    )
    expect(annotatedSemicolonResponse.inputType).toBe('unknown')
    expect(annotatedSemicolonResponse.message).toContain('Unknown')
    expect(annotatedSemicolonResponse.results).toHaveLength(0)

    const lowercaseOperatorSemicolonResponse = rankLicenses(
      'SPDX-License-Identifier: MIT; Apache-2.0 and ISC',
      licenses,
    )
    expect(lowercaseOperatorSemicolonResponse.inputType).toBe('unknown')
    expect(lowercaseOperatorSemicolonResponse.message).toContain('Unknown')
    expect(lowercaseOperatorSemicolonResponse.results).toHaveLength(0)

    for (const input of [
      'SPDX-License-Identifier: MIT; dual license; Apache-2.0',
      'SPDX-License-Identifier: MIT; dual licensed; Apache-2.0',
      'SPDX-License-Identifier: MIT; dual-licensed; Apache-2.0',
      'SPDX-License-Identifier: MIT; dual licensing; Apache-2.0',
      'SPDX-License-Identifier: MIT; internal note; also Apache-2.0',
      'SPDX-License-Identifier: MIT; additional license; Apache-2.0',
      'SPDX-License-Identifier: MIT; additional licenses; Apache-2.0',
      'SPDX-License-Identifier: MIT; additional licensing; Apache-2.0',
      'SPDX-License-Identifier: MIT; multiple licenses; Apache-2.0',
      'SPDX-License-Identifier: MIT; alternative licensing; Apache-2.0',
      'SPDX-License-Identifier: MIT; other licences; Apache-2.0',
      'SPDX-License-Identifier: MIT; alternatively licensed; Apache-2.0',
      'SPDX-License-Identifier: MIT; also available; ISC',
      'SPDX-License-Identifier: MIT; also Apache-2.0',
      'SPDX-License-Identifier: MIT; also; ISC',
      'SPDX-License-Identifier: MIT; also under Apache-2.0',
      'SPDX-License-Identifier: MIT; also under Apache 2.0',
      'SPDX-License-Identifier: MIT; also under BSD 3-Clause',
      'SPDX-License-Identifier: MIT; also licensed under Apache License 2.0',
      'SPDX-License-Identifier: MIT; also under; Apache License 2.0',
      'SPDX-License-Identifier: MIT; also licensed under Apache-2.0',
      'SPDX-License-Identifier: MIT; also released under Apache-2.0',
      'SPDX-License-Identifier: MIT; additional licenses Apache License 2.0',
      'SPDX-License-Identifier: MIT; additional licenses Creative Commons Zero v1.0 Universal',
      'SPDX-License-Identifier: MIT; dual license; Common Development and Distribution License 1.0',
      'SPDX-License-Identifier: MIT; alternatively licensed under Do What The F*ck You Want To Public License',
      'SPDX-License-Identifier: MIT; Apache-2.0 or later',
      'SPDX-License-Identifier: MIT; Apache-2.0 for dependencies and source code',
      'SPDX-License-Identifier: MIT; Apache-2.0 for dependencies and this project',
      'SPDX-License-Identifier: MIT; Apache-2.0 for dependencies and BSD-3-Clause for this project',
      'SPDX-License-Identifier: MIT; Apache License 2.0 for dependencies and BSD 3-Clause for source code',
    ]) {
      const secondaryLicenseCueResponse = rankLicenses(input, licenses)
      expect(secondaryLicenseCueResponse.inputType, input).toBe('unknown')
      expect(secondaryLicenseCueResponse.message, input).toContain('Unknown')
      expect(secondaryLicenseCueResponse.results, input).toHaveLength(0)
    }

    for (const input of [
      'SPDX-License-Identifier: MIT; internal note; Apache-2.0',
      'SPDX-License-Identifier: MIT; also internal note; Apache-2.0',
      'SPDX-License-Identifier: MIT; note; Apache License 2.0',
      'SPDX-License-Identifier: MIT; note; BSD 3-Clause',
      'SPDX-License-Identifier: MIT; see also; ISC',
    ]) {
      const semicolonNoteResponse = rankLicenses(input, licenses)
      expect(semicolonNoteResponse.inputType, input).toBe('spdx-expression')
      expect(semicolonNoteResponse.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }

    const malformedWithSemicolonResponse = rankLicenses(
      'SPDX-License-Identifier: MIT; Apache-2.0 WITH GPL-2.0-only',
      licenses,
    )
    expect(malformedWithSemicolonResponse.inputType).toBe('unknown')
    expect(malformedWithSemicolonResponse.message).toContain('Unknown')
    expect(malformedWithSemicolonResponse.results).toHaveLength(0)

    const uppercaseProseOperatorResponse = rankLicenses(
      'SPDX-License-Identifier: MIT; Apache-2.0 AND ISC for dependencies',
      licenses,
    )
    expect(uppercaseProseOperatorResponse.inputType).toBe('unknown')
    expect(uppercaseProseOperatorResponse.message).toContain('Unknown')
    expect(uppercaseProseOperatorResponse.results).toHaveLength(0)

    const unsupportedSemicolonResponse = rankLicenses(
      'SPDX-License-Identifier: MIT; LicenseRef-Proprietary',
      licenses,
    )
    expect(unsupportedSemicolonResponse.inputType).toBe('unknown')
    expect(unsupportedSemicolonResponse.message).toContain('Unknown')
    expect(unsupportedSemicolonResponse.results).toHaveLength(0)

    for (const tail of ['LicenseRef-', 'DocumentRef-doc:LicenseRef-']) {
      const malformedTailResponse = rankLicenses(
        `SPDX-License-Identifier: MIT; ${tail}`,
        licenses,
      )
      expect(malformedTailResponse.inputType, tail).toBe('unknown')
      expect(malformedTailResponse.message, tail).toContain('Unknown')
      expect(malformedTailResponse.results, tail).toHaveLength(0)
    }

    for (const tail of [
      'SSPL-1.0',
      'SSPL-1.0 (Server Side Public License)',
      'BUSL-1.1',
      'Elastic-2.0',
      'PolyForm-Noncommercial-1.0.0',
      'GPL-2.0+',
      'gpl-2.0+',
      'gpl-2.0+ (GNU General Public License)',
    ]) {
      const unsupportedTailResponse = rankLicenses(
        `SPDX-License-Identifier: MIT; ${tail}`,
        licenses,
      )
      expect(unsupportedTailResponse.inputType, tail).toBe('unknown')
      expect(unsupportedTailResponse.message, tail).toContain('Unknown')
      expect(unsupportedTailResponse.results, tail).toHaveLength(0)
    }

    const licenseRefBodyResponse = rankLicenses(
      'SPDX-License-Identifier: MIT\nLicenseRef-Proprietary',
      licenses,
    )
    expect(licenseRefBodyResponse.inputType).toBe('mixed-license-text')
    expect(licenseRefBodyResponse.message).toContain('conflicts')
    expect(licenseRefBodyResponse.results).toHaveLength(0)

    const lowercaseWithBodyResponse = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10) +
        'GPL-2.0-only with Classpath-exception-2.0',
      licenses,
    )
    expect(lowercaseWithBodyResponse.inputType).toBe('mixed-license-text')
    expect(lowercaseWithBodyResponse.message).toContain('conflicts')
    expect(lowercaseWithBodyResponse.results).toHaveLength(0)

    for (const bodyId of [
      'SSPL-1.0',
      'BUSL-1.1',
      'Elastic-2.0',
      'PolyForm-Noncommercial-1.0.0',
      'Not-A-License',
      'LicenseRef-',
      'DocumentRef-doc:LicenseRef-',
      'GPL-2.0+',
      'gpl-2.0+',
    ]) {
      const unsupportedBodyResponse = rankLicenses(
        `SPDX-License-Identifier: MIT\n${bodyId}`,
        licenses,
      )
      expect(unsupportedBodyResponse.inputType, bodyId).toBe(
        'mixed-license-text',
      )
      expect(unsupportedBodyResponse.message, bodyId).toContain('conflicts')
      expect(unsupportedBodyResponse.results, bodyId).toHaveLength(0)
    }

    for (const bodyLine of [
      'License: SSPL-1.0',
      'License: SSPL-1.0 (Server Side Public License)',
      'License: Apache-2.0 (Apache License)',
      'License: Apache-2.0, ISC',
      'License: CECILL-2.1',
      'License: MIT and Apache-2.0',
      'License: MIT WITH GPL-2.0-only',
      'License: MIT WITH LicenseRef-Custom',
      'License: MIT with GPL-2.0-only',
      'License: MIT with LicenseRef-Custom',
      'License: OFL-1.1',
      'License: OSL-3.0',
      'License: LicenseRef- or Apache-2.0',
      'License: W3C-20150513',
      'License: ZPL-2.1',
      'License: gpl-2.0+ (GNU General Public License)',
      'License-Identifier: BUSL-1.1',
      'License-Identifier: DocumentRef-guide',
      'Project License' + String.fromCharCode(10) + 'SSPL-1.0',
      'Project License: SSPL-1.0',
      'Source License: BUSL-1.1',
      '# License: Elastic-2.0',
      '<!-- License: SSPL-1.0 -->',
    ]) {
      const unsupportedBodyLabelResponse = rankLicenses(
        `SPDX-License-Identifier: MIT\n${bodyLine}`,
        licenses,
      )
      expect(unsupportedBodyLabelResponse.inputType, bodyLine).toBe(
        'mixed-license-text',
      )
      expect(unsupportedBodyLabelResponse.message, bodyLine).toContain(
        'conflicts',
      )
      expect(unsupportedBodyLabelResponse.results, bodyLine).toHaveLength(0)
    }

    for (const bodyLine of [
      'License: Product-1.0',
      'Project License: Product-1.0',
      'Source License: Widget-2026.1',
      'License: 3D-1.0',
      'License: AI-2.0',
      'Project License: US-1.0',
    ]) {
      const productVersionBodyLabelResponse = rankLicenses(
        `SPDX-License-Identifier: MIT\n${bodyLine}`,
        licenses,
      )
      expect(productVersionBodyLabelResponse.inputType, bodyLine).toBe(
        'spdx-expression',
      )
      expect(productVersionBodyLabelResponse.message, bodyLine).not.toContain(
        'conflicts',
      )
      expect(
        productVersionBodyLabelResponse.results[0],
        bodyLine,
      ).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }

    for (const bodyLine of ['JSON', 'Intel', 'Ruby', 'curl']) {
      const wordBodyResponse = rankLicenses(
        `SPDX-License-Identifier: MIT\n${bodyLine}`,
        licenses,
      )
      expect(wordBodyResponse.inputType, bodyLine).toBe('spdx-expression')
      expect(wordBodyResponse.message, bodyLine).not.toContain('conflicts')
      expect(wordBodyResponse.results[0], bodyLine).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }

    for (const bodyLine of [
      'License: JSON',
      'License: Intel',
      'License: Ruby',
      'License: curl',
    ]) {
      const labeledWordBodyResponse = rankLicenses(
        `SPDX-License-Identifier: MIT\n${bodyLine}`,
        licenses,
      )
      expect(labeledWordBodyResponse.inputType, bodyLine).toBe(
        'mixed-license-text',
      )
      expect(labeledWordBodyResponse.message, bodyLine).toContain('conflicts')
      expect(labeledWordBodyResponse.results, bodyLine).toHaveLength(0)
    }

    const lowercaseOperatorBodyLabelResponse = rankLicenses(
      'SPDX-License-Identifier: GPL-2.0-or-later' +
        String.fromCharCode(10) +
        'License: GPL-2.0 or later',
      licenses,
      { includeDiffs: false },
    )
    expect(lowercaseOperatorBodyLabelResponse.inputType).toBe('spdx-expression')
    expect(lowercaseOperatorBodyLabelResponse.spdxExpression).toBe(
      'GPL-2.0-or-later',
    )
    expect(lowercaseOperatorBodyLabelResponse.results[0]).toMatchObject({
      licenseId: 'GPL-2.0-or-later',
      confidence: 'Exact',
    })

    const proseTokenBodyLabelResponse = rankLicenses(
      'SPDX-License-Identifier: Apache-2.0' +
        String.fromCharCode(10) +
        'License: Apache-2.0 AND dependencies',
      licenses,
      { includeDiffs: false },
    )
    expect(proseTokenBodyLabelResponse.inputType).toBe('spdx-expression')
    expect(proseTokenBodyLabelResponse.spdxExpression).toBe('Apache-2.0')
    expect(proseTokenBodyLabelResponse.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Exact',
    })

    const lowercaseProseTokenBodyLabelResponse = rankLicenses(
      'SPDX-License-Identifier: Apache-2.0' +
        String.fromCharCode(10) +
        'License: Apache-2.0 with runtime dependencies',
      licenses,
      { includeDiffs: false },
    )
    expect(lowercaseProseTokenBodyLabelResponse.inputType).toBe(
      'spdx-expression',
    )
    expect(lowercaseProseTokenBodyLabelResponse.spdxExpression).toBe(
      'Apache-2.0',
    )
    expect(lowercaseProseTokenBodyLabelResponse.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Exact',
    })

    const dependencyListResponse = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party dependencies:' +
        String.fromCharCode(10) +
        'Apache-2.0' +
        String.fromCharCode(10) +
        'Elastic-2.0',
      licenses,
      { includeDiffs: false },
    )
    expect(dependencyListResponse.inputType).toBe('spdx-expression')
    expect(dependencyListResponse.spdxExpression).toBe('MIT')
    expect(dependencyListResponse.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })

    const dependencyLabelListResponse = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party dependencies:' +
        String.fromCharCode(10) +
        'License: Elastic-2.0',
      licenses,
      { includeDiffs: false },
    )
    expect(dependencyLabelListResponse.inputType).toBe('spdx-expression')
    expect(dependencyLabelListResponse.spdxExpression).toBe('MIT')
    expect(dependencyLabelListResponse.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })

    const dependencyParagraphResponse = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices:' +
        String.fromCharCode(10) +
        'Thank you for reading.' +
        String.fromCharCode(10) +
        'License: Elastic-2.0',
      licenses,
      { includeDiffs: false },
    )
    expect(dependencyParagraphResponse.inputType).toBe('spdx-expression')
    expect(dependencyParagraphResponse.spdxExpression).toBe('MIT')
    expect(dependencyParagraphResponse.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })

    const dependencyDeclaredFirstResponse = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party dependencies:' +
        String.fromCharCode(10) +
        'MIT' +
        String.fromCharCode(10) +
        'Elastic-2.0',
      licenses,
      { includeDiffs: false },
    )
    expect(dependencyDeclaredFirstResponse.inputType).toBe('spdx-expression')
    expect(dependencyDeclaredFirstResponse.spdxExpression).toBe('MIT')
    expect(dependencyDeclaredFirstResponse.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })

    const projectResetResponse = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party dependencies:' +
        String.fromCharCode(10) +
        'Apache-2.0' +
        String.fromCharCode(10) +
        'Project License: MIT' +
        String.fromCharCode(10) +
        'Elastic-2.0',
      licenses,
      { includeDiffs: false },
    )
    expect(projectResetResponse.inputType).toBe('mixed-license-text')
    expect(projectResetResponse.message).toContain('conflicts')
    expect(projectResetResponse.results).toHaveLength(0)
  })

  it('falls back to complete license text after malformed SPDX lines', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: see LICENSE file' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('Malformed SPDX identifier ignored')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })
    expect(response.results[0]?.diffSegments).toBeDefined()
  })

  it('keeps stronger malformed SPDX body header matches when deduplicating', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: see LICENSE file' +
        String.fromCharCode(10, 10) +
        'Licensed under GPL-2.0.' +
        String.fromCharCode(10) +
        'Licensed under GPL-2.0-only.',
      licenses,
      { includeDiffs: false },
    )
    const gplOnly = response.results.find(
      (result) => result.licenseId === 'GPL-2.0-only',
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('Malformed SPDX identifier ignored')
    expect(gplOnly).toMatchObject({
      confidence: 'Likely',
      flags: { needsManualReview: false },
      score: { f1: 1 },
    })
    expect(
      response.results.filter((result) => result.licenseId === 'GPL-2.0-only'),
    ).toHaveLength(1)
  })

  it('adds diff details when reviewing unsupported SPDX expressions with body text', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT OR LicenseRef-Commercial' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('SPDX expression needs review')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Possible',
    })
    expect(
      response.results[0]?.diffSegments?.every(
        (segment) => segment.type === 'equal',
      ),
    ).toBe(true)
    expect(response.results[0]?.diff).not.toContain('SPDX-License-Identifier')
    expect(response.results[0]?.diff).not.toContain('LicenseRef-Commercial')
  })

  it('loads lazy diff details from body text for unsupported SPDX expressions', () => {
    const input =
      'SPDX-License-Identifier: MIT OR LicenseRef-Commercial' +
      String.fromCharCode(10, 10) +
      (byId.get('MIT') || '')
    const response = rankLicenses(input, licenses, { includeDiffs: false })
    const eagerResponse = rankLicenses(input, licenses)
    const result = response.results[0]
    if (!result) throw new Error('Expected MIT body result')
    const eagerResult = eagerResponse.results[0]
    if (!eagerResult) throw new Error('Expected eager MIT body result')

    const segments = diffSegmentsForResult(input, result, licenses)
    const diff = formatDiffSegments(segments || [])

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('SPDX expression needs review')
    expect(segments).toBeDefined()
    expect(segments).toEqual(eagerResult.diffSegments)
    expect(segments?.every((segment) => segment.type === 'equal')).toBe(true)
    expect(diff).not.toContain('SPDX-License-Identifier')
    expect(diff).not.toContain('LicenseRef-Commercial')
  })

  it('marks AND and WITH SPDX body matches for manual review', () => {
    for (const [expression, bodyLicense] of [
      ['MIT AND Apache-2.0', 'MIT'],
      ['Apache-2.0 WITH LLVM-exception', 'Apache-2.0'],
    ] as const) {
      const response = rankLicenses(
        'SPDX-License-Identifier: ' +
          expression +
          String.fromCharCode(10, 10) +
          (byId.get(bodyLicense) || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, expression).toBe('mixed-license-text')
      expect(response.spdxExpression, expression).toBe(expression)
      expect(response.message, expression).toContain(
        'SPDX expression needs review',
      )
      expect(response.results[0], expression).toMatchObject({
        licenseId: bodyLicense,
        confidence: 'Possible',
        flags: { needsManualReview: true },
      })
      expect(response.results[0]?.explanation, expression).toContain(
        'conjunctive or uses WITH exceptions',
      )
    }
  })

  it('loads lazy diff details from body text for malformed SPDX declarations', () => {
    const input =
      'SPDX-License-Identifier:' +
      String.fromCharCode(10, 10) +
      (byId.get('MIT') || '')
    const response = rankLicenses(input, licenses, { includeDiffs: false })
    const eagerResponse = rankLicenses(input, licenses)
    const result = response.results[0]
    if (!result) throw new Error('Expected MIT body result')
    const eagerResult = eagerResponse.results[0]
    if (!eagerResult) throw new Error('Expected eager MIT body result')

    const segments = diffSegmentsForResult(input, result, licenses)
    const diff = formatDiffSegments(segments || [])

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('Malformed SPDX identifier ignored')
    expect(segments).toBeDefined()
    expect(segments).toEqual(eagerResult.diffSegments)
    expect(segments?.every((segment) => segment.type === 'equal')).toBe(true)
    expect(diff).not.toContain('SPDX-License-Identifier')
  })

  it('loads lazy diff details from cleaned body text after malformed SPDX title declarations', () => {
    const input =
      '/*' +
      String.fromCharCode(10) +
      ' * SPDX-License-Identifier: The MIT License */' +
      String.fromCharCode(10, 10) +
      'Apache License 2.0'
    const response = rankLicenses(input, licenses, { includeDiffs: false })
    const eagerResponse = rankLicenses(input, licenses)
    const result = response.results[0]
    if (!result) throw new Error('Expected Apache body result')
    const eagerResult = eagerResponse.results[0]
    if (!eagerResult) throw new Error('Expected eager Apache body result')

    const segments = diffSegmentsForResult(input, result, licenses)
    const diff = formatDiffSegments(segments || [])

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('Malformed SPDX identifier ignored')
    expect(result.licenseId).toBe('Apache-2.0')
    expect(segments).toBeDefined()
    expect(segments).toEqual(eagerResult.diffSegments)
    expect(diff).not.toContain('/*')
    expect(diff).not.toContain('SPDX-License-Identifier')
    expect(diff).not.toContain('The MIT License')
  })

  it('does not load lazy diff details when SPDX declarations leave no body', () => {
    const result = rankLicenses('MIT License', licenses, {
      includeDiffs: false,
    }).results[0]
    if (!result) throw new Error('Expected MIT header result')

    expect(
      diffSegmentsForResult('SPDX-License-Identifier:', result, licenses),
    ).toBeUndefined()
  })

  it('falls back to same-line license text after malformed SPDX prefixes', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: see LICENSE file ' + (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('Malformed SPDX identifier ignored')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })
  })

  it('falls back to license labels after empty malformed SPDX lines', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier:' + String.fromCharCode(10) + 'License: MIT',
      licenses,
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
    expect(response.results[0]?.diffSegments).toBeDefined()
  })

  it('does not fall back to license labels after empty malformed SPDX lines with restrictive bodies', () => {
    for (const body of [
      'License: MIT' + String.fromCharCode(10) + 'For non-commercial use only',
      'License: MIT' +
        String.fromCharCode(10) +
        'This software, name, and logo may not be used.',
      'License: MIT' +
        String.fromCharCode(10) +
        'This software cannot be used.',
      'License: MIT' +
        String.fromCharCode(10) +
        'You cannot copy this software.',
      'License: MIT' +
        String.fromCharCode(10) +
        'This software cannot be used commercially except in compliance with the License.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier:' + String.fromCharCode(10) + body,
        licenses,
      )

      expect(response.inputType, body).toBe('mixed-license-text')
      expect(response.results, body).toHaveLength(0)
      expect(response.message, body).toContain('restrictive license text')
    }
  })

  it('does not fall back to license labels after empty malformed SPDX lines with conflicting headers', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier:' +
        String.fromCharCode(10) +
        'License: MIT' +
        String.fromCharCode(10) +
        'This project is licensed under Apache-2.0',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('restrictive license text')
  })

  it('flags restrictive same-line tails after SPDX identifiers', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT; This project is proprietary.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('restrictive license text')
    expect(response.results).toHaveLength(0)
  })

  it('flags restrictive same-line tails after SPDX-like identifiers', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT; Apache-2.0; This project is proprietary.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('restrictive license text')
    expect(response.results).toHaveLength(0)
  })

  it('flags restrictive same-line tails after SPDX-like identifier lists', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT, BSD-3-Clause; This project is proprietary.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('restrictive license text')
    expect(response.results).toHaveLength(0)
  })

  it('flags no-prefixed derivative and field-of-use restrictions after SPDX identifiers', () => {
    for (const tail of [
      'No derivative works.',
      'No derivatives.',
      'No military use.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10) + tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.message, tail).toContain('restrictive license text')
      expect(response.results, tail).toHaveLength(0)
    }
  })

  it('flags permission-gated and source-disclosure tails after SPDX identifiers', () => {
    for (const tail of [
      'Distribution requires prior written consent.',
      'Use requires permission.',
      'Use requires not only attribution but permission.',
      'Modifications require permission.',
      'These modifications require permission.',
      'Derivative works require permission.',
      'Source code must be disclosed.',
      'The source code must be disclosed.',
      'This source code shall be made available.',
      'Modifications must be open source.',
      'These modifications must be published.',
      'Derivative work must be disclosed.',
      'Derivative works must be open source.',
      'The derivative works must be open source.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10) + tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.message, tail).toContain('restrictive license text')
      expect(response.results, tail).toHaveLength(0)
    }
  })

  it('ignores restrictive prose in SPDX inline comments', () => {
    for (const marker of ['//', '#', '--']) {
      const response = rankLicenses(
        `SPDX-License-Identifier: MIT ${marker} This project is proprietary.`,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, marker).toBe('spdx-expression')
      expect(response.results[0], marker).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('flags restrictive bodies after malformed SPDX input with supported body text', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT OR' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        'This project is proprietary.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('restrictive license text')
    expect(response.results).toHaveLength(0)
  })

  it('flags restrictive tails after malformed SPDX input with supported body text', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: see LICENSE file' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        'This project is proprietary.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('restrictive license text')
    expect(response.results).toHaveLength(0)
  })

  it('does not hard-guess GNU or-later headers as only', () => {
    const response = rankLicenses(
      'This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 2 of the License, or (at your option) any later version.',
      licenses,
    )
    expect(response.results[0]?.licenseId).toBe('GPL-2.0-or-later')
    expect(response.results[0]?.flags.needsManualReview).toBe(false)
    expectNoLicensePrefixes(response, ['GPL-3.', 'LGPL-', 'AGPL-'])
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'GPL-2.0-only' &&
          !result.flags.needsManualReview,
      ),
    ).toBe(false)
  })

  it('does not exact-match SPDX input when any explicit line is malformed', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT AND\nSPDX-License-Identifier: Apache-2.0',
      'SPDX-License-Identifier: [MIT]\nSPDX-License-Identifier: Apache-2.0',
      'SPDX-License-Identifier:\nSPDX-License-Identifier: MIT',
      'SPDX-License-Identifier: MIT\nSPDX-License-Identifier:',
      'SPDX-License-Identifier: LicenseRef-',
      'SPDX-License-Identifier: DocumentRef-doc:LicenseRef-',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.message, input).toContain('Unknown')
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('does not exact-match SPDX input when a later body header conflicts', () => {
    for (const separator of ['.', ';']) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' +
          String.fromCharCode(10) +
          'Licensed under MIT' +
          separator +
          ' Licensed under Apache-2.0',
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, separator).toBe('mixed-license-text')
      expect(response.message, separator).toContain('conflicts')
      expect(response.results[0], separator).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
    }

    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10) +
        'Licensed under Apache-2.0. This project includes bundled fonts for internal use only.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType, 'third-party restrictive tail').toBe(
      'mixed-license-text',
    )
    expect(response.message, 'third-party restrictive tail').toContain(
      'conflicts',
    )
    expect(response.results[0], 'third-party restrictive tail').toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Likely',
    })
  })

  it('flags body conflicts after malformed SPDX input with a supported leading declaration', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10) +
        'SPDX-License-Identifier:',
      'SPDX-License-Identifier: MIT NOT Apache-2.0',
      'SPDX-License-Identifier: MIT Apache-2.0',
    ]) {
      const response = rankLicenses(
        input + String.fromCharCode(10) + (byId.get('Apache-2.0') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.message, input).toContain('conflicts')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Exact',
      })
    }
  })

  it('keeps block-comment continuation SPDX lines that close on the same line', () => {
    const response = rankLicenses(
      '/*' +
        String.fromCharCode(10) +
        ' * SPDX-License-Identifier: MIT */' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]?.licenseId).toBe('Apache-2.0')
  })

  it('flags body conflicts after a bare SPDX prefix', () => {
    const response = rankLicenses(
      'MIT' + String.fromCharCode(10, 10) + (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Exact',
    })
  })

  it('keeps matching full bodies after a bare SPDX prefix', () => {
    const response = rankLicenses(
      'MIT' + String.fromCharCode(10, 10) + (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.message).not.toContain('conflicts')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
    })
  })

  it('keeps bare SPDX prefixes from being scoped into third-party prose', () => {
    const response = rankLicenses(
      'MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices: bundled dependency.' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.message).not.toBe(
      'Detected license text applies to third-party text.',
    )
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
    })
  })

  it('does not let third-party full bodies override bare SPDX prefixes', () => {
    const response = rankLicenses(
      'MIT' +
        String.fromCharCode(10, 10) +
        'This project bundles a third party program licensed under the Apache License 2.0.' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('spdx-expression')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })
  })

  it('keeps project full bodies after bare SPDX and third-party prose', () => {
    const response = rankLicenses(
      'MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices: bundled dependency.' +
        String.fromCharCode(10, 10) +
        'Project license' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.message).not.toBe(
      'License label applies outside the detected third-party text.',
    )
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
    })
  })

  it('flags project restrictive tails after declared SPDX project bodies', () => {
    for (const prefix of ['MIT', 'SPDX-License-Identifier: MIT']) {
      const response = rankLicenses(
        prefix +
          String.fromCharCode(10, 10) +
          'Third-party notices: bundled dependency.' +
          String.fromCharCode(10, 10) +
          'Project license' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || '') +
          String.fromCharCode(10, 10) +
          'This project is for internal use only.',
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('mixed-license-text')
      expect(response.spdxExpression, prefix).toBe('MIT')
      expect(response.results, prefix).toHaveLength(0)
      expect(response.message, prefix).toContain('restrictive license text')
    }
  })

  it('does not let third-party context hide project restrictions before bare SPDX bodies', () => {
    for (const restriction of [
      'Main project license is for internal use only.',
      'Main project license is proprietary.',
      'Main project license is confidential.',
      'Main project license is closed source.',
      'Main project license is under no open source license.',
      'Main project license: all rights reserved.',
    ]) {
      const response = rankLicenses(
        'MIT' +
          String.fromCharCode(10, 10) +
          'This project includes a third-party dependency. ' +
          restriction +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, restriction).toBe('mixed-license-text')
      expect(response.spdxExpression, restriction).toBe('MIT')
      expect(response.results, restriction).toHaveLength(0)
      expect(response.message, restriction).toContain(
        'restrictive license text',
      )
    }
  })

  it('keeps legacy bare SPDX prefixes aligned with SPDX lines', () => {
    const response = rankLicenses(
      'GPL-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('GPL-2.0-only') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('spdx-expression')
    expect(response.spdxExpression).toBe('GPL-2.0')
    expect(response.message).toContain('Legacy SPDX identifier')
    expect(response.results.map((result) => result.licenseId)).toEqual([
      'GPL-2.0-only',
      'GPL-2.0-or-later',
    ])
  })

  it('flags restrictive bodies after a bare SPDX prefix', () => {
    for (const tail of [
      'For educational use only.',
      'For nonprofit use only.',
      'For non-profit use only.',
      'For non profit use only.',
      'Academic use only.',
      'Research use only.',
    ]) {
      const response = rankLicenses(
        'MIT' + String.fromCharCode(10, 10) + tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.spdxExpression, tail).toBe('MIT')
      expect(response.results, tail).toHaveLength(0)
      expect(response.message, tail).toContain('conflicts')
    }
  })

  it('keeps malformed whitespace-separated SPDX tails before matching full bodies', () => {
    for (const header of [
      'SPDX-License-Identifier: MIT Apache-2.0',
      'SPDX-License-Identifier:   MIT Apache-2.0 # generated header',
    ]) {
      const response = rankLicenses(
        header + String.fromCharCode(10, 10) + (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, header).toBe('mixed-license-text')
      expect(response.results, header).toHaveLength(0)
      expect(response.message, header).toContain('conflicts')
    }
  })

  it('ranks short named license headers', () => {
    const cases = [
      {
        text: 'MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'The MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'An MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'Expat License',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under Expat',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the Expat License',
        licenseId: 'MIT',
      },
      {
        text: 'Apache License 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'The Apache License 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under Apache Licence 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Apache 2.0 License',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Mozilla Public License v2.0',
        licenseId: 'MPL-2.0',
      },
      {
        text: 'Mozilla Public Licence 2.0',
        licenseId: 'MPL-2.0',
      },
      {
        text: 'Mozilla Public License v1.0',
        licenseId: 'MPL-1.0',
      },
      {
        text: 'Mozilla Public License v1.1',
        licenseId: 'MPL-1.1',
      },
      {
        text: 'Licensed under the Apache License, Version 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under Apache License, Version 2.0, January 2004',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Apache License, Version 2.0, January 2004',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under the Apache License, Version 2.0. You may not use it except in compliance with the License',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under the Apache License, Version 2.0. You may not use this except in compliance with licence',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under Apache 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under Apache 2',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under Apache v2',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under the Apache License 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under the Apache License 2',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under the Apache Software License 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under the Apache Software License, Version 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'License: MIT',
        licenseId: 'MIT',
      },
      {
        text: 'License: the MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'This project is licenced under the MIT Licence',
        licenseId: 'MIT',
      },
      {
        text:
          'Copyright (c) 2026 Example' +
          String.fromCharCode(10) +
          'Licensed under the MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\nThis project is not proprietary.',
        licenseId: 'MIT',
      },
      {
        text: 'Originally, these source files are licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is under active development. This project is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'Dependency: React\nLicense: MIT\n\nThis project is licensed under the Apache License 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Dependency: React\nLicense: MIT\n\nThis project is under the Apache License 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Dependency: React\nLicense: MIT\n\nThis main project is licensed under Apache 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Dependency: React\nLicense: MIT\n\nMain project software is licensed under Apache 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'License: Apache License 2.0\nLicense: Apache-2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Code in this project is licensed under the MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'Code for this project is licensed under the MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'Source code for this project is licensed under the MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'Software in this project is licensed under the BSD-3-Clause',
        licenseId: 'BSD-3-Clause',
      },
      {
        text: 'License: MIT\nThis project is non-proprietary.',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\nThis project is neither proprietary nor a closed source project.',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\nThis project is not proprietary or closed source.',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\nThis project is not confidential or proprietary.',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\nThis project is not non disclosure or closed source.',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\nThis project is not proprietary, closed source or confidential.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is not proprietary\nLicense: MIT',
        licenseId: 'MIT',
      },
      {
        text: 'This project is non-proprietary\nLicense: MIT',
        licenseId: 'MIT',
      },
      {
        text: 'This project is not closed source\nLicense: Apache-2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'License identifier: MIT',
        licenseId: 'MIT',
      },
      {
        text: 'Project License: MIT',
        licenseId: 'MIT',
      },
      {
        text: 'Project Licence: MIT',
        licenseId: 'MIT',
      },
      {
        text: 'Licence: MIT',
        licenseId: 'MIT',
      },
      {
        text: '## License' + String.fromCharCode(10) + 'MIT',
        licenseId: 'MIT',
      },
      {
        text: 'License' + String.fromCharCode(10) + 'Apache-2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Source license: Apache-2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Package license: the ISC License',
        licenseId: 'ISC',
      },
      {
        text: 'License: Apache-2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Copyright 2026 Example\nLicense: MIT',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\n\nDocumentation\nUsage notes',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\n\nThird-party notices\nBundled font: All rights reserved.',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\n\nThird-party notices\nThis project bundles a proprietary font.',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\n\nThird-party notices\nThis product bundles a proprietary font.',
        licenseId: 'MIT',
      },
      {
        text: 'License: MIT\nThis project depends on React\nThis component is proprietary.',
        licenseId: 'MIT',
      },
      {
        text: 'Package metadata\nLicense identifier: Apache-2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Copyright 2026 Example\nPackage metadata\nLicense: MIT',
        licenseId: 'MIT',
      },
      {
        text: 'Dependency package metadata\nLicense: MIT\n\nPackage metadata\nLicense: Apache-2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text:
          'Third-party notices' +
          String.fromCharCode(10, 10) +
          'License: MIT' +
          String.fromCharCode(10, 10) +
          'Project' +
          String.fromCharCode(10) +
          'License: Apache-2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text:
          'Third-party notices' +
          String.fromCharCode(10, 10) +
          'License: MIT' +
          String.fromCharCode(10, 10) +
          'Project' +
          String.fromCharCode(10, 10) +
          'License: Apache-2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'This project is MIT licensed',
        licenseId: 'MIT',
      },
      {
        text: 'The main project is MIT licensed',
        licenseId: 'MIT',
      },
      {
        text: 'Main source code is MIT licensed',
        licenseId: 'MIT',
      },
      {
        text: 'This project is MIT licenced',
        licenseId: 'MIT',
      },
      {
        text: 'This package is Apache-2.0 licensed',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'This software is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This software is distributed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT Licence',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under MIT',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the terms of the MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'This project is released under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is available under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is provided under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This software is offered under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is covered under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is governed by the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'Available under the MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'Subject to the MIT License',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under MIT-0',
        licenseId: 'MIT-0',
      },
      {
        text: 'Licensed under the MIT No Attribution License',
        licenseId: 'MIT-0',
      },
      {
        text: 'Licensed under CC0-1.0',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'License: CC0',
        licenseId: 'CC0-1.0',
      },
      {
        text: '// License: MIT',
        licenseId: 'MIT',
      },
      {
        text: '/* @license MIT */',
        licenseId: 'MIT',
      },
      {
        text: 'License MIT',
        licenseId: 'MIT',
      },
      {
        text: 'License' + String.fromCharCode(0xa0) + 'MIT',
        licenseId: 'MIT',
      },
      {
        text: 'Project License MIT',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under CC0 v1.0',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'Licensed under CC0 1.0 Universal',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'Released into the public domain under CC0',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'Released to the public domain under CC0 1.0 Universal',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'CC0 1.0 Universal Public Domain Dedication',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'Those files are dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'This work is dedicated to the public domain under the Creative Commons Zero 1.0 Universal Public Domain Dedication.',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'Creative Commons Zero v1.0 Universal Public Domain Dedication',
        licenseId: 'CC0-1.0',
      },
      {
        text: '0BSD License',
        licenseId: '0BSD',
      },
      {
        text: 'The 0BSD License',
        licenseId: '0BSD',
      },
      {
        text: '0-Clause BSD License',
        licenseId: '0BSD',
      },
      {
        text: 'BSD 0-Clause License',
        licenseId: '0BSD',
      },
      {
        text: 'Licensed under 0BSD',
        licenseId: '0BSD',
      },
      {
        text: 'Licensed under 0-Clause BSD License',
        licenseId: '0BSD',
      },
      {
        text: 'Licensed under Zero-Clause BSD License',
        licenseId: '0BSD',
      },
      {
        text: 'Licensed under EPL-2.0',
        licenseId: 'EPL-2.0',
      },
      {
        text: 'Licensed under EPL v2.0',
        licenseId: 'EPL-2.0',
      },
      {
        text: 'Licensed under EPL v2',
        licenseId: 'EPL-2.0',
      },
      {
        text: 'Licensed under MPL v2.0',
        licenseId: 'MPL-2.0',
      },
      {
        text: 'Licensed under MPL v1.0',
        licenseId: 'MPL-1.0',
      },
      {
        text: 'Licensed under MPL v1.1',
        licenseId: 'MPL-1.1',
      },
      {
        text: 'Licensed under MPLv1.0',
        licenseId: 'MPL-1.0',
      },
      {
        text: 'Licensed under MPLv1.1',
        licenseId: 'MPL-1.1',
      },
      {
        text: 'Licensed under MPL v2',
        licenseId: 'MPL-2.0',
      },
      {
        text: 'Licensed under MPLv2',
        licenseId: 'MPL-2.0',
      },
      {
        text: 'Licensed under MPL 2',
        licenseId: 'MPL-2.0',
      },
      {
        text: 'Licensed under CDDL v1.0',
        licenseId: 'CDDL-1.0',
      },
      {
        text: 'Licensed under CDDL v1',
        licenseId: 'CDDL-1.0',
      },
      {
        text: 'Licensed under EPL-2.0 (the "License")',
        licenseId: 'EPL-2.0',
      },
      {
        text: 'Licensed under MIT (this License)',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under MIT (MIT)',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under Apache-2.0 (Apache License 2.0)',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under ASL 2.0 (Apache License 2.0)',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under MIT. Third-party component is proprietary.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under GPL v2 only',
        licenseId: 'GPL-2.0-only',
      },
      {
        text: 'Licensed under GNU GPL v3 only',
        licenseId: 'GPL-3.0-only',
      },
      {
        text: 'Licensed under LGPL v2.1 only',
        licenseId: 'LGPL-2.1-only',
      },
      {
        text: 'Licensed under AGPL v3 only',
        licenseId: 'AGPL-3.0-only',
      },
      {
        text: 'Licensed under the GNU General Public License version 2 only',
        licenseId: 'GPL-2.0-only',
      },
      {
        text: 'Licensed under the GNU General Public License version 2 or later',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under GPL v2 or any later version',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under GPL v2 or at your option any later version',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under the GNU General Public License version 2.0 or later',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under GPL v2 or later',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under GPLv2 or later',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'License: GPLv2 or later',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'License: GPL-2.0 or later',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under GPL v2+',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under GPLv2+',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under GNU GPL v2+',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under the GNU General Public License v2+',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under the GNU General Public License version 2+',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under the terms of the GNU General Public License v2+',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under GNU GPL v2 or later',
        licenseId: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under the GNU Lesser General Public License version 2.1 only',
        licenseId: 'LGPL-2.1-only',
      },
      {
        text: 'Licensed under the GNU Library General Public License version 2.1 only',
        licenseId: 'LGPL-2.1-only',
      },
      {
        text: 'Licensed under the GNU Library General Public License version 2.1 or later',
        licenseId: 'LGPL-2.1-or-later',
      },
      {
        text: 'Licensed under LGPL v2.1 or later',
        licenseId: 'LGPL-2.1-or-later',
      },
      {
        text: 'Licensed under LGPL v2.1+',
        licenseId: 'LGPL-2.1-or-later',
      },
      {
        text: 'Licensed under LGPL v3 or at your option any later version',
        licenseId: 'LGPL-3.0-or-later',
      },
      {
        text: 'Licensed under the GNU Affero General Public License version 3 only',
        licenseId: 'AGPL-3.0-only',
      },
      {
        text: 'Licensed under AGPLv3+',
        licenseId: 'AGPL-3.0-or-later',
      },
      {
        text: 'Licensed under ISC',
        licenseId: 'ISC',
      },
      {
        text: 'The ISC License',
        licenseId: 'ISC',
      },
      {
        text: 'Licensed under the ISC License provided that the above copyright notice and this permission notice appear in all copies.',
        licenseId: 'ISC',
      },
      {
        text: 'Licensed under the Boost Software License',
        licenseId: 'BSL-1.0',
      },
      {
        text: 'Licensed under the Boost License',
        licenseId: 'BSL-1.0',
      },
      {
        text: 'Licensed under the NCSA Open Source License',
        licenseId: 'NCSA',
      },
      {
        text: 'Licensed under the EUPL',
        licenseId: 'EUPL-1.2',
      },
      {
        text: 'Licensed under the EUPL 1.2',
        licenseId: 'EUPL-1.2',
      },
      {
        text: 'Licensed under the EUPL License 1.2',
        licenseId: 'EUPL-1.2',
      },
      {
        text: 'Licensed under the EUPL License version 1.2',
        licenseId: 'EUPL-1.2',
      },
      {
        text: 'Licensed under the EUPL Licence v 1.2',
        licenseId: 'EUPL-1.2',
      },
      {
        text: 'Licensed under the EUPL License v1.2',
        licenseId: 'EUPL-1.2',
      },
      {
        text: 'This program is made available under the terms of the Eclipse Public License 2.0',
        licenseId: 'EPL-2.0',
      },
      {
        text: 'Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under ASL 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under Zlib',
        licenseId: 'Zlib',
      },
      {
        text: 'Licensed under the zlib/libpng License',
        licenseId: 'Zlib',
      },
      {
        text: 'A PostgreSQL License',
        licenseId: 'PostgreSQL',
      },
      {
        text: 'Licensed under the Unlicense License',
        licenseId: 'Unlicense',
      },
      {
        text: 'Licensed under the BSD 3-Clause License.',
        licenseId: 'BSD-3-Clause',
      },
      {
        text: 'Licensed under Simplified BSD License',
        licenseId: 'BSD-2-Clause',
      },
      {
        text: 'Licensed under New BSD License',
        licenseId: 'BSD-3-Clause',
      },
      {
        text: 'Licensed under Revised BSD License',
        licenseId: 'BSD-3-Clause',
      },
      {
        text: 'Licensed under Modified BSD License',
        licenseId: 'BSD-3-Clause',
      },
      {
        text: 'Licensed under BSD 3-Clause (Modified BSD License)',
        licenseId: 'BSD-3-Clause',
      },
      {
        text: 'Licensed under Modified BSD License (BSD 3-Clause)',
        licenseId: 'BSD-3-Clause',
      },
      {
        text: 'Licensed under the 2-Clause BSD License',
        licenseId: 'BSD-2-Clause',
      },
      {
        text: 'Licensed under the 3-Clause BSD License',
        licenseId: 'BSD-3-Clause',
      },
      {
        text: 'Licensed under Academic Free License version 3.0',
        licenseId: 'AFL-3.0',
      },
      {
        text: 'Academic Free License v3.0',
        licenseId: 'AFL-3.0',
      },
      {
        text: 'Academic Free License (“AFL”) v. 3.0',
        licenseId: 'AFL-3.0',
      },
      {
        text: 'MIT No Attribution',
        licenseId: 'MIT-0',
      },
      {
        text: 'Licensed under the WTFPL',
        licenseId: 'WTFPL',
      },
      {
        text: 'Do What The F*ck You Want To Public License',
        licenseId: 'WTFPL',
      },
      {
        text: 'Licensed under Creative Commons Zero version 1.0 Universal',
        licenseId: 'CC0-1.0',
      },
      {
        text: 'Licensed under Mozilla Public License version 2.0',
        licenseId: 'MPL-2.0',
      },
      {
        text: 'This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0',
        licenseId: 'MPL-2.0',
      },
      {
        text: 'Licensed under Eclipse Public License v 2.0',
        licenseId: 'EPL-2.0',
      },
      {
        text: 'Licensed under the Eclipse Public License 2.0 (the License)',
        licenseId: 'EPL-2.0',
      },
      {
        text: 'Licensed under EPL-2.0. Copyright 2026 Example',
        licenseId: 'EPL-2.0',
      },
      {
        text: 'Licensed under ISC. © 2026 Example',
        licenseId: 'ISC',
      },
    ]

    for (const testCase of cases) {
      const response = rankLicenses(testCase.text, licenses, {
        includeDiffs: false,
      })
      expect(response.inputType, testCase.text).toBe('license-header')
      expect(response.results[0], testCase.text).toMatchObject({
        licenseId: testCase.licenseId,
        confidence: 'Likely',
        score: { precision: 1, recall: 1, f1: 1 },
      })
      expect(
        response.results.filter(
          (result) => result.licenseId === testCase.licenseId,
        ),
        testCase.licenseId,
      ).toHaveLength(1)
    }
  })

  it('marks ambiguous GNU version headers for manual review', () => {
    for (const [text, expectedIds] of [
      ['Licensed under GPL v2', ['GPL-2.0-only', 'GPL-2.0-or-later']],
      ['Licensed under GPLv2', ['GPL-2.0-only', 'GPL-2.0-or-later']],
      ['License: GPL v2', ['GPL-2.0-only', 'GPL-2.0-or-later']],
      [
        'GNU General Public License Version 3',
        ['GPL-3.0-only', 'GPL-3.0-or-later'],
      ],
      [
        'Project license: GNU Affero General Public License Version 3',
        ['AGPL-3.0-only', 'AGPL-3.0-or-later'],
      ],
      [
        'GNU Affero General Public License Version 3',
        ['AGPL-3.0-only', 'AGPL-3.0-or-later'],
      ],
      [
        'GNU Lesser General Public License Version 2.1',
        ['LGPL-2.1-only', 'LGPL-2.1-or-later'],
      ],
    ] as const) {
      const response = rankLicenses(text, licenses, { includeDiffs: false })

      expect(response.inputType, text).toBe('license-header')
      expect(
        response.results.slice(0, 2).map((result) => result.licenseId),
        text,
      ).toEqual(expectedIds)
      for (const result of response.results.slice(0, 2)) {
        expect(result.confidence, result.licenseId).toBe('Possible')
        expect(result.flags.needsManualReview, result.licenseId).toBe(true)
      }
    }
  })

  it('keeps Apache headers with benign modal use clauses', () => {
    for (const text of [
      'Licensed under the Apache License, Version 2.0. You may not use this file except in compliance with the terms of the License',
      'Licensed under the Apache License, Version 2.0. Do not use except in compliance with the License',
      'Licensed under the Apache License, Version 2.0. Do not use this file except in compliance with the License',
      'Licensed under the Apache License, Version 2.0. You may not use or redistribute this software except in compliance with the License',
      'Licensed under the Apache License, Version 2.0. This software may not be used or redistributed except in compliance with the License',
    ]) {
      const response = rankLicenses(text, licenses, { includeDiffs: false })

      expect(response.inputType, text).toBe('license-header')
      expect(response.results[0], text).toMatchObject({
        licenseId: 'Apache-2.0',
      })
    }
  })

  it('keeps SPDX identifiers with branding use clauses', () => {
    for (const tail of [
      "You may not use this software's name to endorse products.",
      "This software's name and logo must not be used to endorse products.",
      "This software's name cannot be used to endorse products.",
      "You may not use my software's name to endorse products.",
      "You may not use the project's trademarks to endorse products.",
      'You may not use the project name, logo, or trademarks to endorse products.',
      'You may not use the trademark, but you may copy this software.',
      "Do not use the project's trademarks to endorse products.",
      "This software's name must not be used to endorse products.",
      "The project's trademarks must not be used to endorse products.",
      'The name of this project must not be used to endorse products.',
      'The trademark of this project must not be used to endorse products.',
      'The name Acme must not be used to endorse products.',
      'The name Acme Corp must not be used to endorse products.',
      'This file may not be used except in compliance with the terms and conditions of the License.',
      'You may not use or redistribute this software except in compliance with the License.',
      'This software may not be used or redistributed except in compliance with the License.',
      'This file cannot be used except in compliance with the License.',
      'You may not use in a commercially reasonable manner.',
      'This license imposes no commercial use restrictions.',
      'No redistribution restrictions.',
      'No derivative work restrictions.',
      'No derivative works restrictions.',
      'No derivative work or redistribution restrictions.',
      'No derivative works or use restrictions.',
      'Use requires no permission.',
      'Distribution requires no prior written consent.',
      'Modifications require no permission.',
      'These modifications require no permission.',
      'Redistribution requires no authorization.',
      'Redistribution requires this permission notice.',
      'Redistribution requires retaining this permission notice.',
      'Redistribution requires retaining the permission and copyright notices.',
      'Redistribution requires retaining the permission copyright notices.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10) + tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('spdx-expression')
      expect(response.results[0], tail).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('flags project restrictions after third-party full-license bodies', () => {
    for (const restriction of [
      'Main project license: proprietary.',
      'Main project license. It is proprietary.',
      'Do not reverse engineer this project.',
      'This main project is confidential.',
    ]) {
      for (const prefix of ['MIT', 'SPDX-License-Identifier: MIT']) {
        const response = rankLicenses(
          prefix +
            String.fromCharCode(10, 10) +
            'Project license' +
            String.fromCharCode(10, 10) +
            (byId.get('MIT') || '') +
            String.fromCharCode(10, 10) +
            'Third-party notices:' +
            String.fromCharCode(10, 10) +
            (byId.get('Apache-2.0') || '') +
            String.fromCharCode(10, 10) +
            restriction,
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, `${prefix}: ${restriction}`).toBe(
          'mixed-license-text',
        )
        expect(response.spdxExpression, `${prefix}: ${restriction}`).toBe('MIT')
        expect(response.results, `${prefix}: ${restriction}`).toHaveLength(0)
        expect(response.message, `${prefix}: ${restriction}`).toContain(
          'restrictive license text',
        )
      }
    }
  }, 10_000)

  it('does not accept project-owned personal-use prefixes before license labels', () => {
    expectNoExactOrLikelyLicense(
      'This project is for personal use only' +
        String.fromCharCode(10) +
        'License: MIT',
      'MIT',
    )
  })

  it('does not accept named headers with cannot action restrictions', () => {
    for (const text of [
      'License: MIT' +
        String.fromCharCode(10) +
        'You cannot copy this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You can not distribute this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        "You can't sublicense this software.",
    ]) {
      expectNoExactOrLikelyLicense(text, 'MIT')
    }
  })

  it('does not rank short technical phrases as named license headers', () => {
    for (const [input, licenseId] of [
      ['Expat', 'MIT'],
      ['MIT License key', 'MIT'],
      ['ISC license key', 'ISC'],
      [
        'This work is dedicated to the public domain under the MIT License.',
        'MIT',
      ],
    ]) {
      expectNoExactOrLikelyLicense(input, licenseId)
    }
  })

  it('ranks short bare license aliases', () => {
    for (const [input, licenseId] of [
      ['Apache v2', 'Apache-2.0'],
      ['MPL v2', 'MPL-2.0'],
      ['CDDL v1', 'CDDL-1.0'],
      ['EPL v2', 'EPL-2.0'],
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(classifyInput(input, knownIds), input).toBe('unknown')
      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId,
        confidence: 'Likely',
      })
    }
  })

  it('does not rank curated shorthand aliases as bare license titles', () => {
    const response = rankLicenses('New BSD', licenses)

    expect(response.inputType).toBe('unknown')
    expect(response.results).toHaveLength(0)
  })

  it('does not treat historical license labels as current labels', () => {
    for (const input of [
      'Previously\nLicense: MIT',
      'Formerly\nLicense: MIT',
      'This project was previously licensed as\nLicense: MIT',
      'Historically\nLicense: MIT',
      'Historical license\nLicense: MIT',
      'Original license\nLicense: MIT',
    ]) {
      expectNoExactOrLikelyLicense(input, 'MIT')
    }

    const response = rankLicenses(
      'Previously' +
        String.fromCharCode(10) +
        'License: MIT' +
        String.fromCharCode(10, 10) +
        'Project' +
        String.fromCharCode(10) +
        'License: Apache-2.0',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Likely',
    })
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'MIT' && result.confidence === 'Likely',
      ),
    ).toBe(false)
  })

  it('does not hard-guess ambiguous MPL 1.x headers', () => {
    for (const input of ['Licensed under MPL 1', 'Licensed under MPLv1']) {
      expectNoExactOrLikelyLicense(input, 'MPL-1.0')
      expectNoExactOrLikelyLicense(input, 'MPL-1.1')
    }
  })

  it('keeps specific GNU license labels when repeated with legacy labels', () => {
    const orLater = rankLicenses(
      'License: GPL-2.0\nLicense: GPL-2.0-or-later',
      licenses,
      { includeDiffs: false },
    )
    expect(orLater.inputType).toBe('license-header')
    expect(orLater.results[0]).toMatchObject({
      licenseId: 'GPL-2.0-or-later',
      confidence: 'Likely',
      flags: { needsManualReview: false },
    })

    const only = rankLicenses(
      'License: GPL-2.0-only\nLicense: GPL-2.0',
      licenses,
      { includeDiffs: false },
    )
    expect(only.inputType).toBe('license-header')
    expect(only.results[0]).toMatchObject({
      licenseId: 'GPL-2.0-only',
      confidence: 'Likely',
      flags: { needsManualReview: false },
    })

    const orLaterFirst = rankLicenses(
      'License: GPL-2.0-or-later\nLicense: GPL-2.0',
      licenses,
      { includeDiffs: false },
    )
    expect(orLaterFirst.results[0]).toMatchObject({
      licenseId: 'GPL-2.0-or-later',
      confidence: 'Likely',
      flags: { needsManualReview: false },
    })
  })

  it('rejects conflicting or mismatched named license headers', () => {
    const cases = [
      'License: MIT\nLicense: Apache-2.0',
      'Licenses: MIT\nLicense: Apache-2.0',
      'License: MIT\nLicense: GPL-2.0 and MIT',
      'Licensed under the EUPL 1.1',
      'Licensed under the EUPL License 1.1',
      'Licensed under the EUPL Licence 1.1',
      'Licensed under the EUPL License v1.1',
      'Licensed under the EUPL Licence v1.1',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })
      expect(response.message, input).toContain('Unknown')
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('accepts plural and explicit current license labels', () => {
    for (const input of ['Licenses: MIT', 'Current license: MIT']) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
    }

    const currentLabelBodyConflict = rankLicenses(
      'Current license: MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )
    expect(currentLabelBodyConflict.inputType).toBe('mixed-license-text')
    expect(currentLabelBodyConflict.results).toHaveLength(0)
    expect(currentLabelBodyConflict.message).toContain('conflicts')
  })

  it('skips standalone prefixed license label values before body checks', () => {
    for (const label of [
      'Project License',
      'Source License',
      'Package License',
    ]) {
      const response = rankLicenses(
        label +
          String.fromCharCode(10) +
          'MIT' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, label).toBe('mixed-license-text')
      expect(response.results, label).toHaveLength(0)
      expect(response.message, label).toContain('conflicts')
    }
  })

  it('lets current project labels override dependency label context', () => {
    const response = rankLicenses(
      'Dependency license: Proprietary' +
        String.fromCharCode(10) +
        'Project license: MIT',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('keeps current project labels after later scoped labels share the same license', () => {
    const response = rankLicenses(
      'Project license: MIT' +
        String.fromCharCode(10) +
        'Dependency license: MIT',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('does not treat negated license headers as explicit matches', () => {
    const cases = [
      'This project is not licensed under the MIT License',
      'This project is not released under the MIT License',
      'No part of this project is licensed under the MIT License',
      'No part of this software, version 2.0, is licensed under the MIT License',
      'No part of this software, e.g. this module, is licensed under the MIT License',
      'No part of this software, provided by Example Inc., is licensed under the MIT License',
      'No part of this project is MIT licensed',
      'No part of this software is Apache-2.0 licensed',
      'No part of this tool is MIT licensed',
      'No part of this source code is MIT licensed',
      'No part of this CLI is licensed under MIT',
      'No part of this app is Apache-2.0 licensed',
      'These files were reviewed. None of them are licensed under the MIT License',
      'Neither this project nor these files are licensed under the MIT License',
      'Neither this project nor its documentation is licensed under the MIT License',
      'This project is not currently licensed under the Apache License 2.0',
      "This project isn't licensed under the MIT License",
      'This project has not been licensed under the MIT License',
      'This project has no dependency licensed under the MIT License.',
      'This project has no external dependency licensed under the MIT License.',
      'This project has no external parser component licensed under the MIT License.',
      'No dependency of this project is licensed under the MIT License.',
      'No dependencies of this project are licensed under the MIT License.',
      'No font of this project is licensed under the MIT License.',
      'This project has never been licensed under the MIT License',
      'This project is not being licensed under the MIT License',
      'This project is not itself licensed under the MIT License',
      'This project is by no means licensed under the MIT License',
      'This project is under no circumstances licensed under the MIT License',
      'This project is by no means and under no circumstances licensed under the MIT License',
      'This project was not relicensed under the Apache License 2.0',
      'This project has not been relicensed under the Apache License 2.0',
      'This project is not released or licensed under the MIT License',
      'This project is not distributed or licensed under the MIT License',
      'This project is not open source or currently licensed under the MIT License',
      'This project is not now licensed under the MIT License',
      'This project is not now nor ever licensed under the MIT License',
      'This project is not now or ever licensed under the MIT License',
      'This project is not, in any sense, licensed under the MIT License',
      'This project is by no means currently licensed under the MIT License',
      'This project is not actually currently licensed under the MIT License',
      'This code is proprietary, nor is the project licensed under the MIT License',
      'This code is proprietary, nor has this project been licensed under the MIT License',
      'These files are proprietary, nor are these files licensed under the MIT License',
      'This project is not licensed under the MIT License but a tool is licensed under the ISC License',
      'The dependency is licensed under the MIT License. This project is proprietary.',
      'The dependency is under the MIT License. This project is proprietary.',
      'A dependency of this project is licensed under the MIT License.',
      'The third party dependency used by this project is licensed under the MIT License.',
      'The bundled component used by this project is licensed under the MIT License.',
      'An external library used by this project is licensed under the MIT License.',
      'Code included in this project is licensed under the MIT License.',
      'Code included as part of this project is licensed under the MIT License.',
      'External libraries used by this project are licensed under the MIT License.',
      'Bundled components used by this project are licensed under the MIT License.',
      'Embedded plugins in this project are licensed under the MIT License.',
      'Documentation code in this project is licensed under the MIT License',
      'Test code in this project is licensed under the MIT License',
      'Sample code in this project is licensed under the MIT License',
      'The documentation code in this project is licensed under the MIT License',
      'The docs code in this project is licensed under the MIT License',
      'The test code in this project is licensed under the MIT License',
      'The sample code in this project is licensed under the MIT License',
      'A sample code in this project is licensed under the MIT License',
      'An example code in this project is licensed under the MIT License',
      'A docs code in this project is licensed under the MIT License',
      'A module of this project is licensed under the MIT License',
      'The helper for this project is licensed under the MIT License',
      'This project uses React and Vue, which are licensed under the MIT License. This project is proprietary.',
      'This project uses React and Vue. They are licensed under the MIT License. This project is proprietary.',
      'This project uses React. It is licenced under the MIT License. This project is proprietary.',
      'This project includes a dependency. The dependency we licensed under MIT.',
      'This project includes a dependency. The dependency we are licensed under MIT.',
      'This project includes the dependency we licensed under MIT.',
      'This project includes dependencies. The dependencies we licensed under MIT.',
      'This project uses React and Vue. React is licensed under the MIT License. This project is proprietary.',
      'This project uses React and Vue. Vue is licensed under the MIT License. This project is proprietary.',
      'This project depends on React. React is licensed under the MIT License. This project is proprietary.',
      'This project requires React. React is licensed under the MIT License. This project is proprietary.',
      'This project depends on React. React package metadata\nLicense: MIT\nThis project is proprietary.',
      'This project depends on React\nLicense: MIT',
      'React package metadata\nSome other line\nLicense: MIT',
      'Dependency package metadata\nMore info\nLicense: MIT',
      'Dependency package metadata\n\nLicense: MIT',
      'This project depends on React\nMore text\nLicense: MIT',
      'Dependency package metadata\nLicense: MIT\nThis project is proprietary.',
      'External dependency metadata\nLicense: MIT\nThis project is proprietary.',
      'React dependency metadata\nLicense: MIT\nThis project is proprietary.',
      'React package metadata\nLicense: MIT\nThis project is proprietary.',
      'License: MIT\nThis project is proprietary.',
      'License: MIT\nThis project depends on React\nThis project is proprietary.',
      'License: MIT\nThird-party notices\nBundled font: see font license\nThis project is proprietary.',
      'License: MIT\nThird-party notices\nThis product is proprietary.',
      'License: MIT\nThird-party notices\nThis code is proprietary.',
      'License: MIT\nThird-party notices\nDo not redistribute this project.',
      'License: MIT\nThird-party notices\nBundled font: proprietary.\nLicense terms\nProprietary. All rights reserved.',
      'License: MIT\nThird-party notices\nDocumentation only',
      'License: MIT\nThird-party notices\nFor documentation only',
      'License: MIT\nDo not redistribute',
      'License: MIT\nDo not sell',
      'License: MIT\nDo not sublicense',
      'License: MIT\nOnly for internal use',
      'License: MIT\nNot for commercial use',
      'License: MIT\nFor non-commercial use only',
      'License: MIT\nInternal use only',
      'This project is confidential\nLicense: MIT',
      'License: MIT\nConfidential.',
      'This project is licensed under MIT License. All rights reserved.',
      'This project is licensed under MIT License. This project is proprietary.',
      'License: MIT\nThis project is not proprietary but closed source.',
      'License: MIT\nDocumentation only',
      'License: MIT\nFor documentation only',
      'License: MIT\nOnly for documentation',
      'License: MIT\nFor test code only',
      'License: MIT\nTest code only',
      'License: MIT\nFor sample code only',
      'License: MIT\nFor documentation only\nMore project text',
      'License: MIT\nDocumentation only\nExtra',
      'License: MIT\nOnly for documentation purposes',
      'This project is proprietary\nLicense: MIT',
      'All rights reserved\nLicense: MIT',
      'This project is proprietary. Licensed under MIT.',
      'All rights reserved. Licensed under MIT.',
      'The dependency\nLicense: MIT',
      'The plugin is\nLicense: MIT',
      'The plugin\nLicense: MIT',
      'Dependency: react\nLicense: MIT',
      'Component metadata\nLicense: MIT',
      'Library metadata\nLicense: MIT',
      'Plugin metadata\nLicense: MIT',
      'Plugin info\nLicense: MIT',
      'Parser metadata\nLicense: MIT',
      'Parser info\nLicense: MIT',
      'Tool metadata\nLicense: MIT',
      'Tool info\nLicense: MIT',
      'Helper metadata\nLicense: MIT',
      'This project has no third-party fonts; dependency metadata\nLicense: MIT',
      'Included third party code\nLicense: MIT',
      'Third party\nLicense: MIT',
      'Third-party\nLicense: MIT',
      'Third-party notices\nLicense: MIT',
      'Third party metadata\nLicense: MIT',
      'Vendored code\nLicense: MIT',
      'Docs\nLicense: MIT',
      'Docs\nSection header\nLicense: MIT',
      'Docs\n\nLicense: MIT',
      'Copyright 2026 Example\nDocs\nLicense: MIT',
      'Tests\nLicense: MIT',
      'Examples\nLicense: MIT',
      'The docs\nLicense: MIT',
      'Our examples\nLicense: MIT',
      'This project docs\nLicense: MIT',
      'Test code\nLicense identifier: BSL-1.0',
      'Test code\nOverview\nLicense identifier: BSL-1.0',
      'Test code\n\nLicense identifier: BSL-1.0',
      'Copyright 2026\nLicense: MIT\nAll rights reserved. Proprietary.',
      'The optional dependency React is licensed under the MIT License. This project is proprietary.',
      'The optional dependency\nLicense: MIT',
      'The external parser component is licensed under the MIT License. This project is proprietary.',
      'The third-party dependency used by this project for parser integration is licensed under the MIT License. This project is proprietary.',
      'The bundled dependency is subject to the terms of the MIT License and remains licensed under the ISC License. This project is proprietary.',
      'A dependency of this project is licensed under the MIT License. This project is proprietary.',
      'This project is proprietary, nor is it licensed under the MIT License',
      'This project is proprietary, nor will it be licensed under the MIT License',
      'This project is neither licensed under the MIT License nor the Apache License 2.0',
      'This project will not be licensed under the MIT License',
      'This project will be licensed under the MIT License',
      'This project may be licensed under the MIT License',
      'This project could be licensed under the MIT License',
      'This project is going to be licensed under the MIT License',
      "This project can't be licensed under the MIT License",
      'This project cannot currently be licensed under the MIT License',
      "This project can't currently be licensed under the MIT License",
      "This project can't now be licensed under the MIT License",
      "This project can't really currently be licensed under the MIT License",
      "This project isn't currently licensed under the MIT License",
      "This project isn't now licensed under the MIT License",
      "This project isn't actually currently licensed under the MIT License",
      "This project isn't really explicitly licensed under the MIT License",
      "This project hasn't yet been licensed under the MIT License",
      "This project hasn't yet actually been licensed under the MIT License",
      "These files weren't ever licensed under the MIT License",
      "This project won't be licensed under the MIT License",
      "These files aren't licensed under the MIT License",
      "This project hasn't been licensed under the MIT License",
      "This project wasn't licensed under the MIT License",
      "These files weren't licensed under the MIT License",
      'This project will never be licensed under the MIT License',
      'This project is not going to be licensed under the MIT License',
      'This project is not, and never will be, licensed under the MIT License',
      'This project will no longer be licensed under the MIT License',
      'This project was previously licensed under the MIT License',
      'Previous releases are licensed under the MIT License',
      'Old versions are licensed under the MIT License',
      'The docs are under the MIT License but code is proprietary',
      'Our documentation is under the MIT License but code is proprietary',
      'The project docs are under the MIT License but code is proprietary',
      'This documentation is under the MIT License but code is proprietary',
      'The documentation for this project is under the MIT License but code is proprietary',
      'The docs for this project are under the MIT License but code is proprietary',
      'Tests are under the MIT License',
      'These tests are under the MIT License',
      'Examples are under the Apache License 2.0',
      'This project examples are under the Apache License 2.0',
      'Sample code is under the MIT License',
      'Test code is under the MIT License',
      'The project test code is under the MIT License',
      'Example code is under the MIT License',
      'Tests are MIT licensed',
      'Examples are Apache-2.0 licensed',
      'This project was initially licensed under the MIT License, but is now proprietary.',
      'This project was first licensed under the MIT License, but is now proprietary.',
      'This project was previously released and licensed under the MIT License. It is now proprietary.',
      'This project is now popular and was previously also licensed under the MIT License',
      'This project was licensed under the MIT License. See LICENSE for details.',
      'This project had been licensed under the MIT License.',
      'These files were licensed under the MIT License.',
      'This project used to be licensed under the MIT License',
      'This project used to be distributed as open source and licensed under the MIT License',
      'Although this codebase was originally licensed under the MIT License, it has since been relicensed and is now proprietary.',
      'Licensed under Apache License 2.0 with LLVM exception',
      'Licensed under the MIT License WITH LLVM exception',
      'Licensed under the MIT License WITH GCC-exception-3.1',
      'Licensed under the MIT License with an exception',
      'Licensed under the MIT License with custom exceptions',
      'Licensed under the MIT License with additional permissions described in a separate contributor grant for generated parser output as an exception.',
      'This project is now licensed under the MIT License with additional permissions described under the GCC runtime exception',
      'Licensed under BSD 3-Clause License OR Apache License 2.0',
      'Licensed under the MIT License and/or Apache License 2.0.',
      'Licensed under the MIT License and also the ISC License.',
      'Licensed under the MIT License or the terms of the Apache License 2.0.',
      'Licensed under the MIT License and the terms of the Apache License 2.0.',
      'Licensed under the MIT License or the terms and conditions of the Apache License 2.0.',
      'Licensed under the MIT License and the terms and conditions of the Apache License 2.0.',
      'Licensed under the BSD 3-Clause License or at your option any later version.',
      'Licensed under BSD 3-Clause License or compatible terms.',
      'Licensed under the MIT License or later.',
      'Licensed under the MIT License unless otherwise noted',
      'Licensed under the MIT License or a commercial license',
      'Licensed under MIT for non-commercial use only',
      'Licensed under the MIT License for non-commercial use except in compliance with the License',
      'Licensed under the MIT License for documentation only',
      'Licensed under the MIT License only for evaluation',
      'Licensed under the MIT License only for evaluation except in compliance with the License',
      'Licensed under the MIT License only to evaluate this package',
      'Licensed under the MIT License only to evaluate this package except in compliance with the License',
      'Licensed under the MIT License provided that you do not sell it',
      'Licensed under the MIT License and commercial use only',
      'Licensed under the MIT License. Copyright 2026 Example. Also licensed under Apache License 2.0',
      'Licensed under the MIT License or commercial terms',
      'Licensed under the MIT License or other commercial terms',
      'Licensed under BSD 3-Clause Clear License.',
      'Licensed under GPL-2.0-only WITH Classpath-exception-2.0',
      'Licensed under GPL-2.0-only WITH Linux-syscall-note',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })
      expect(response.message, input).toContain('Unknown')
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('matches affirmative headers after unrelated nor prose', () => {
    const response = rankLicenses(
      'This software comes with neither warranty nor support but is licensed under the MIT License.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('matches affirmative headers after unrelated nor-is prose', () => {
    const cases = [
      'This project, which has no warranty nor is supported, is licensed under the MIT License.',
      'This project has no warranty, nor is it actively supported, but it is licensed under the MIT License.',
      'This project, which has neither documentation nor a code review process, is licensed under the MIT License.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
    }
  })

  it('matches project headers after unrelated subject-to prose', () => {
    const response = rankLicenses(
      'This project is subject to the terms of service and is licensed under the MIT License. Copyright 2026 Example Project release documentation package source files.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('matches affirmative headers after unrelated no prose', () => {
    const cases = [
      'No part of this README is legal advice. This project is licensed under the MIT License.',
      'No code is perfect. This project is licensed under the MIT License.',
      'These tests pass. None are failing. This project is licensed under the MIT License.',
      'This project has no external dependencies. Licensed under the MIT License.',
      'This project has no dependencies. Licensed under the MIT License.',
      'These files have no dependencies. Licensed under the MIT License.',
      'These files have no tests nor are they. Licensed under the MIT License.',
      'This project has no external dependencies. Released under the MIT License.',
      'This project has no external dependencies. Distributed under the MIT License.',
      'This project has no external dependencies. Subject to the terms of the MIT License.',
      'This project has no external dependencies. We are available under the MIT License.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
    }
  })

  it('matches named headers followed by prose', () => {
    const cases = [
      {
        text: 'This project is licensed under the MIT License. See LICENSE for details.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License. See LICENSE for details. Contribution restrictions are documented separately.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under MIT. See LICENSE for details.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License. This README includes installation steps, screenshots, release notes, support policy, contribution guidelines, and other project documentation for users.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is licensed under the MIT License with no warranty.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under MIT. No warranty.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under GPLv3 only. No warranty.',
        licenseId: 'GPL-3.0-only',
      },
      {
        text: 'Licensed under Apache-2.0. No warranties.',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under MIT. This software is provided without warranty.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under MIT. The software is provided as is without warranty of any kind.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under MIT. The software is provided as is without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under MIT License (MIT)',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License with no restrictions.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License. This license imposes no commercial use restrictions.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under MIT. No redistribution restrictions.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License without restriction.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License with no restrictive terms.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License with all source files included.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License with the following copyright notice.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is licensed under the MIT License and is provided without warranty.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License and the license text is included below.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License and the license is included below.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License and the license can be found below.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License and the license appears below.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License and the license follows.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is licensed under the Apache License 2.0 and is provided without warranty.',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under the Apache License 2.0 and the license text is included below.',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under the Apache License 2.0 and the license is included below.',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'Licensed under the MIT License and compatible with Node 18.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License or read this later for updates.',
        licenseId: 'MIT',
      },
      {
        text: 'This project includes bundled assets and is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project uses React and is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project includes parser dependency Foo. We are licensed under MIT.',
        licenseId: 'MIT',
      },
      {
        text: 'This project includes parser dependency Library. We are licensed under MIT.',
        licenseId: 'MIT',
      },
      {
        text: "This project includes parser dependency Foo. We're licensed under MIT.",
        licenseId: 'MIT',
      },
      {
        text: 'This project includes parser dependency Foo. We licensed under MIT.',
        licenseId: 'MIT',
      },
      {
        text: 'This project includes third-party assets and is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'These files include third-party assets and are licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This code includes third-party assets and is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project has no dependencies. The project is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This dependency-free project is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project, which has no external dependency, is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This widely used and battle tested networking library, which currently has no external dependencies whatsoever, is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project, whose only dependency is small, is now licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'Originally closed source, our work is now open and licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'Once released, the tool is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This app is first licensed under the MIT License before it is published.',
        licenseId: 'MIT',
      },
      {
        text: 'This bundled project is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This helper is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This package has no external dependencies and is licensed under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is licensed under MIT with no warranty.',
        licenseId: 'MIT',
      },
      {
        text: 'Licensed under the MIT License with no warranty or support.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is licensed under the Apache License 2.0. See LICENSE for details.',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'This project is licensed under the terms of the Apache License 2.0.',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'This project is licensed under the terms and conditions of the Apache License 2.0.',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'This project is subject to the terms and conditions of the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'This project is under the MIT License.',
        licenseId: 'MIT',
      },
      {
        text: 'The main code is under GPL version 2 only.',
        licenseId: 'GPL-2.0-only',
      },
      {
        text: 'This project is licensed under the Apache License 2.0 with no warranty.',
        licenseId: 'Apache-2.0',
      },
      {
        text: 'This project is licensed under MPL 2.0. See LICENSE for details.',
        licenseId: 'MPL-2.0',
      },
      {
        text: 'This project is licensed under CC0-1.0. See LICENSE for details.',
        licenseId: 'CC0-1.0',
      },
    ]

    for (const testCase of cases) {
      const response = rankLicenses(testCase.text, licenses, {
        includeDiffs: false,
      })

      expect(response.inputType, testCase.text).toBe('license-header')
      expect(response.results[0], testCase.text).toMatchObject({
        licenseId: testCase.licenseId,
        confidence: 'Likely',
      })
    }
  })

  it('matches current headers after unrelated historical prose', () => {
    const cases = [
      'Previously proprietary, this project is now licensed under the MIT License.',
      'Previously proprietary, this project is licensed under the MIT License.',
      'This bundled note is irrelevant. This project is now licensed under the MIT License.',
      'This project was renamed and is licensed under the MIT License.',
      'The author was contacted and the project is licensed under the MIT License.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
    }
  })

  it('matches explicit headers after copyright preambles', () => {
    const response = rankLicenses(
      'Copyright 2026 Example Corporation. This file contains source code, generated types, API wrappers, test fixtures, release notes, screenshots, installation tips, and additional project metadata. Licensed under the MIT License.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('does not treat carried component headers as source preamble headers', () => {
    const cases = [
      'Copyright 2026 Example. This package bundles Foo docs examples fixtures screenshots metadata release notes command line references browser snapshots parser assets generated cases and compatibility reports. Foo is licensed under the MIT License.',
      'This package bundles Foo which is third party. Foo is licensed under the MIT License.',
      'This package bundles Foo which is third party. It is licensed under the MIT License.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.message, input).toContain('Unknown')
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('does not treat compatible terms as explicit named headers', () => {
    const response = rankLicenses(
      'Licensed under BSD 3-Clause compatible terms',
      licenses,
      { includeDiffs: false },
    )

    expect(response.message).toContain('Unknown')
    expect(response.results).toHaveLength(0)
  })

  it('does not treat restrictive license tails as named headers', () => {
    const cases = [
      'Licensed under the MIT License but not documentation',
      'Licensed under the MIT License excluding commercial use',
      'Licensed under the MIT License but restricted to internal use',
      'Licensed under the MIT License but limited to internal use',
      'Licensed under the MIT License but restricted by a non-commercial addendum',
      'Licensed under the MIT License but limited by the field-of-use terms below',
      'Licensed under the MIT License but solely for evaluation purposes',
      'Licensed under the MIT License restricted to internal use',
      'Licensed under the MIT License limited to enterprise customers',
      'Licensed under the MIT License not for commercial use',
      'Licensed under MIT with no warranty for non-commercial use only',
      'Licensed under MIT. No warranty for non-commercial use only.',
      'Licensed under MIT see custom restrictions below',
      'Licensed under the MIT License. See LICENSE for details. For non-commercial use only.',
      'Licensed under the MIT License. See LICENSE for details. Custom restrictions below.',
      'Licensed under MIT Copyright 2026 Example for non-commercial use only',
      'Licensed under MIT Copyright 2026 Example Corporation and contributors for non-commercial use only',
      'Licensed under the MIT License and do not redistribute',
      'Licensed under the MIT License and do not use commercially',
      'This project is licensed under the MIT License and do not modify it.',
      'Licensed under the MIT License. Do not reverse engineer.',
      'Licensed under MIT. Provided without warranty for non-commercial use only.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.message, input).toContain('Unknown')
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('matches benign prose after restricted-tail words', () => {
    const cases = [
      'Licensed under the MIT License but limited warranty applies',
      'Licensed under the MIT License but solely maintained by volunteers',
      'Licensed under the MIT License for commercial support, contact us',
      'Licensed under the MIT License for commercial support only',
      'Licensed under the MIT License for commercial services only',
      'This project is licensed under MIT for commercial support only',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
    }
  })

  it('does not treat repeated licensed-under operands as single named headers', () => {
    const cases = [
      'Licensed under the MIT License and licensed under the Apache License 2.0.',
      'Licensed under the MIT License. Also licensed under the Apache License 2.0.',
      'Licensed under the MIT License. It is also licensed under the Apache License 2.0.',
      'Licensed under the MIT License, Apache License 2.0.',
      'Licensed under MIT. Copyright 2026 Example. Also licensed under Apache License 2.0.',
      'This project is not only licensed under the MIT License but also under the Apache License 2.0.',
      'This project is licensed under the MIT License and is licensed under the Apache License 2.0.',
      'This project is licensed under the MIT License but is also licensed under the Apache License 2.0.',
      'This project is licensed under the MIT Licence but is also licenced under the Apache License 2.0.',
      'Licensed under the MIT License as well as the Apache License 2.0.',
      'Licensed under the MIT License plus the Apache License 2.0.',
      'Licensed under the MIT Licence plus licenced under the Apache License 2.0.',
      'Licensed under the MIT License together with the Apache License 2.0.',
      'Licensed under the MIT License along with the Apache License 2.0.',
      'Licensed under the MIT License with no warranty or the Apache License 2.0.',
      'Licensed under the MIT License with no warranty and also under the Apache License 2.0.',
      'Licensed under the MIT License with no warranties whatsoever and also under the Apache License 2.0.',
      'Licensed under BSD 3-Clause (BSD 2-Clause).',
      'Licensed under GPL v2 (GPL v3).',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.message, input).toContain('Unknown')
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('uses current headers after past-tense headers', () => {
    const cases = [
      'This project was licensed under the MIT License, but is now licensed under the Apache License 2.0',
      'This project was licensed under the MIT License. It is now licensed under the Apache License 2.0',
      'This project was previously relicensed under the MIT License. It is now licensed under the Apache License 2.0',
      'This project was licensed under the MIT License, but has since been licensed under the Apache License 2.0',
      'This project had been licensed under the MIT License, but is now licensed under the Apache License 2.0',
      'This project was formerly also licensed under the MIT License. It is licensed under the Apache License 2.0',
      'This project is licensed under the MIT License, but it is now licensed under the Apache License 2.0.',
      'This project is licenced under the MIT Licence, but it is now licenced under the Apache License 2.0.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'MIT' && result.confidence === 'Likely',
        ),
        input,
      ).toBe(false)
    }
  })

  it('uses remaining current headers after historical headers', () => {
    const cases = [
      'This project was licensed under the ISC License and remains licensed under the MIT License.',
      'This project was licensed under the ISC License and is still licensed under the MIT License.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'ISC' && result.confidence === 'Likely',
        ),
        input,
      ).toBe(false)
    }
  })

  it('uses relicensed headers as current headers', () => {
    const cases = [
      'This project was licensed under the MIT License and later relicensed under the Apache License 2.0.',
      'This project has been relicensed under the Apache License 2.0.',
      'This project was relicensed under the Apache License 2.0.',
      'These files were relicensed under the Apache License 2.0.',
      'This project had been relicensed under the Apache License 2.0.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'MIT' && result.confidence === 'Likely',
        ),
        input,
      ).toBe(false)
    }
  })

  it('uses current headers after historical headers', () => {
    const response = rankLicenses(
      'Previously, this project was licensed under the MIT License. It is now licensed under the Apache License 2.0',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Likely',
    })
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'MIT' && result.confidence === 'Likely',
      ),
    ).toBe(false)
  })

  it('does not use unrelated third-party headers after negated headers', () => {
    const response = rankLicenses(
      'This project is not licensed under the MIT License. The bundled third-party helper is now licensed under the Apache License 2.0. Our code remains proprietary.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.message).toContain('Unknown')
    expect(response.results).toHaveLength(0)
  })

  it('uses current headers after unrelated third-party headers', () => {
    const response = rankLicenses(
      'The bundled third-party helper is now licensed under the Apache License 2.0. The main project source is now licensed under the MIT License.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'Apache-2.0' && result.confidence === 'Likely',
      ),
    ).toBe(false)
  })

  it('uses project headers after long unrelated third-party headers', () => {
    const response = rankLicenses(
      'The bundled third-party helper source maintained by Example for optional parser integration and compatibility testing is licensed under the MIT License. The project is licensed under the Apache License 2.0.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Likely',
    })
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'MIT' && result.confidence === 'Likely',
      ),
    ).toBe(false)
  })

  it('uses project headers after unrelated third-party headers', () => {
    const response = rankLicenses(
      'The bundled third-party helper is licensed under the MIT License. The project is licensed under the Apache License 2.0.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Likely',
    })
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'MIT' && result.confidence === 'Likely',
      ),
    ).toBe(false)
  })

  it('uses affirmative project headers after negated headers', () => {
    const cases = [
      'This project is not licensed under the MIT License. It is licensed under the Apache License 2.0.',
      'This project is not licensed under the MIT License but is licensed under the Apache License 2.0.',
      'This project is not licensed under the MIT License. This project has been licensed under the Apache License 2.0.',
      'This project is not licensed under the MIT License. It is still licensed under the Apache License 2.0.',
      'This project is not licensed under the MIT License but is instead licensed under the Apache License 2.0.',
      'This project was not relicensed under the MIT License. It remains licensed under the Apache License 2.0.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'MIT' && result.confidence === 'Likely',
        ),
        input,
      ).toBe(false)
    }
  })

  it('uses project headers after embedded third-party headers', () => {
    const cases = [
      'This project includes a third-party helper licensed under the ISC License and is licensed under the MIT License.',
      'These files include a third-party helper licensed under the ISC License and are licensed under the MIT License.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'ISC' && result.confidence === 'Likely',
        ),
        input,
      ).toBe(false)
    }
  })

  it('does not use third-party current headers', () => {
    const cases = [
      'The bundled third-party helper is now licensed under the Apache License 2.0.',
      'The vendored helper remains licensed under the MIT License.',
      'The bundled helper is still licensed under the MIT License.',
      'The bundled helper was licensed under the Foo License but is now licensed under the MIT License. Our code remains proprietary.',
      'The bundled third-party library with no dependencies is licensed under the MIT License.',
      'The bundled third-party helper has since been licensed under the Apache License 2.0.',
      'The bundled third-party helper continues to be licensed under the MIT License. Our code remains proprietary.',
      'The plugin is licensed under the MIT License. This project is proprietary.',
      'The external plugin used by our team is licensed under the MIT License. This project is proprietary.',
      'The bundled extension used by our team is licensed under the MIT License. This project is proprietary.',
      'The third-party library that our project bundles is licensed under the MIT License.',
      'This software is free. The bundled helper is licensed under the MIT License.',
      'Our project is on GitHub. The vendored helper is licensed under the MIT License.',
      'This project is popular. The bundled helper is licensed under the MIT License.',
      'This project has a dependency licensed under the MIT License. Our code remains proprietary.',
      'This project has a dependency. The dependency is licensed under the MIT License. This project is proprietary.',
      'This project has a dependency. The dependency is licensed under the MIT No Attribution License. This project is proprietary.',
      'This project uses React, which is licensed under the MIT License. This project is proprietary.',
      'This project uses React, licensed under the MIT License. This project is proprietary.',
      'This project uses React. React is licensed under the MIT License. This project is proprietary.',
      'This project uses React. It is licensed under the MIT License. This project is proprietary.',
      'This project includes React, which is licensed under the MIT License. This project is proprietary.',
      'This project bundles React, which is licensed under the MIT License. This project is proprietary.',
      'This project vendors React, which is licensed under the MIT License. This project is proprietary.',
      'This project ships with React, which is licensed under the MIT License. This project is proprietary.',
      'The React package used by this project is licensed under the MIT License. This project is proprietary.',
      'This project uses a dependency licensed under the MIT License. Our code remains proprietary.',
      'The dependency used by this project for parser integration is licensed under the MIT License. This project is proprietary.',
      'The external parser component used by this project is licensed under the MIT License. This project is proprietary.',
      'The included parser is licensed under the MIT License. This project is proprietary.',
      'The bundled third-party helper is licensed under the ISC License and is licensed under the MIT License. Our code remains proprietary.',
      'The bundled font is licensed under the Foo License. The font is now licensed under the MIT License. Our code remains proprietary.',
      'The bundled asset is licensed under the Foo License. The asset is now licensed under the MIT License. Our code remains proprietary.',
      'The bundled third-party parser is licensed under the ISC License. The parser is now licensed under the MIT License.',
      'The bundled third-party tool is licensed under the ISC License. The tool is now licensed under the MIT License.',
      'This project includes a third-party helper licensed under the ISC License. It is now licensed under the Apache License 2.0.',
      'This project includes a third-party helper licensed under the ISC License. The helper is now licensed under the Apache License 2.0.',
      'The bundled third-party helper is licensed under the ISC License. Its source is licensed under the MIT License. Our code remains proprietary.',
      'The bundled third-party helper source maintained by Example for optional parser integration and compatibility testing is now licensed under the Apache License 2.0.',
      'The bundled third-party cryptography helper library that our team integrated years ago and has maintained ever since across many releases is now licensed under the Apache License 2.0.',
      'The bundled third-party helper is licensed under the MIT License. It is now licensed under the Apache License 2.0. Our code remains proprietary.',
      'The bundled third-party helper source maintained by Example for optional parser integration and compatibility testing is licensed under the MIT License. It is now licensed under the Apache License 2.0. Our code remains proprietary.',
      'The bundled third-party helper source maintained by Example for optional parser integration and compatibility testing is licensed under the MIT License. The helper source is now licensed under the Apache License 2.0. Our code remains proprietary.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.message, input).toContain('Unknown')
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('uses later current headers after superseded unknown headers', () => {
    const cases = [
      'This project is licensed under the Foo License, but is now licensed under the MIT License.',
      'This project is licensed under the Foo License, but the project is now licensed under the MIT License.',
      'This project is licensed under the Foo License, with older packaging notes, migration guidance, compatibility details, distribution history, contributor notes, release policy, archive information, and support caveats, but the project is now licensed under the MIT License.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
    }
  })

  it('does not let later headers override affirmative unknown headers', () => {
    const cases = [
      'This project is licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'This project was relicensed under the Foo License. It is licensed under the Apache License 2.0.',
      'This project has no public issues. This project is licensed under the Foo License. It is licensed under the Apache License 2.0.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.message, input).toContain('Unknown')
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('does not let later affirmative unknown headers override earlier named headers', () => {
    const response = rankLicenses(
      'Licensed under the MIT License. This project is licensed under the Foo License.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.message).toContain('Unknown')
    expect(response.results).toHaveLength(0)
  })

  it('keeps earlier named headers before later third-party unknown headers', () => {
    const response = rankLicenses(
      'Licensed under the MIT License. The included parser is licensed under the Foo License.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('uses later project headers after third-party unknown headers', () => {
    const cases = [
      'The bundled third-party helper is licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'The bundled font is licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'Bundled font licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'The bundled plugin licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'The bundled extension licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'The external asset is licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'The included parser is licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'This project includes a third-party helper licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'This project uses a dependency licensed under the Foo License. The project is licensed under the Apache License 2.0.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
    }
  })

  it('uses later affirmative headers after nor-negated unknown headers', () => {
    const cases = [
      'This project is proprietary, nor is it licensed under the Foo License, but it is licensed under the Apache License 2.0.',
      'This project is proprietary, nor is the project licensed under the Foo License, but it is licensed under the Apache License 2.0.',
      'This project is proprietary, nor has this project been licensed under the Foo License. It is licensed under the Apache License 2.0.',
      'These files are proprietary, nor are these files licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'Neither this project nor these files are licensed under the Foo License. It is licensed under the Apache License 2.0.',
      'This project is proprietary, nor will this project be licensed under the Foo License. It is licensed under the Apache License 2.0.',
    ]

    for (const header of cases) {
      const input =
        'This README has setup notes, support policy, screenshots, and unrelated project metadata. ' +
        header
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
    }
  })

  it('uses later affirmative headers after negated unknown headers', () => {
    const cases = [
      'This is not licensed under the Foo License but is licensed under the Apache License 2.0.',
      'This project is not now nor ever licensed under the Foo License. It is licensed under the Apache License 2.0.',
      'This project is not now or ever licensed under the Foo License. It is licensed under the Apache License 2.0.',
      'This project will not be licensed under the Foo License. It is licensed under the Apache License 2.0.',
      'This project has no dependency licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'No dependency is licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'This project uses no plugin licensed under the Foo License. The project is licensed under the Apache License 2.0.',
      'This project is not going to be licensed under the Foo License, but it is licensed under the Apache License 2.0.',
      'This project never will be licensed under the Foo License, but it is licensed under the Apache License 2.0.',
    ]

    for (const header of cases) {
      const input =
        'This README has setup notes, support policy, screenshots, and unrelated project metadata. ' +
        header
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
    }
  })

  it('uses later project headers after historical unknown headers', () => {
    const cases = [
      'This project was formerly also licensed under the Foo License. It is licensed under the Apache License 2.0.',
      'This project was initially licensed under the Foo License. It is now licensed under the Apache License 2.0.',
      'This project was previously distributed and licensed under the Foo License. It is now licensed under the Apache License 2.0.',
      'This project was previously released and licensed under the Foo License. It is now licensed under the Apache License 2.0.',
      'This project was previously published and licensed under the Foo License. It is now licensed under the Apache License 2.0.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
    }
  })

  it('uses later project headers after many third-party headers', () => {
    const input =
      'The bundled third-party helper is licensed under the ISC License. '.repeat(
        256,
      ) + 'The project is licensed under the Apache License 2.0.'

    const response = rankLicenses(input, licenses, { includeDiffs: false })

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Likely',
    })
  })

  it('uses later affirmative headers after negated headers', () => {
    const response = rankLicenses(
      'This project is not licensed under the MIT License. The command line interface and browser build are now explicitly licensed under the Apache License 2.0',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Likely',
    })
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'MIT' && result.confidence === 'Likely',
      ),
    ).toBe(false)
  })

  it('does not require review for explicit GNU SPDX prose headers', () => {
    const cases = [
      { text: 'Licensed under GPL-2.0-only', licenseId: 'GPL-2.0-only' },
      {
        text: 'Licensed under LGPL-3.0-or-later',
        licenseId: 'LGPL-3.0-or-later',
      },
    ]

    for (const testCase of cases) {
      const response = rankLicenses(testCase.text, licenses, {
        includeDiffs: false,
      })

      expect(response.inputType, testCase.text).toBe('license-header')
      expect(response.results[0], testCase.text).toMatchObject({
        licenseId: testCase.licenseId,
        confidence: 'Likely',
        flags: { needsManualReview: false },
      })
      expect(
        response.results.filter(
          (result) => result.licenseId === testCase.licenseId,
        ),
        testCase.licenseId,
      ).toHaveLength(1)
    }
  })

  it('maps legacy GNU IDs in prose headers to manual-review candidates', () => {
    const cases = [
      {
        text: 'Licensed under GPL-2.0',
        licenseIds: ['GPL-2.0-only', 'GPL-2.0-or-later'],
      },
      {
        text: 'Licensed under GPL-2.0+',
        licenseIds: ['GPL-2.0-or-later'],
      },
    ]

    for (const testCase of cases) {
      const response = rankLicenses(testCase.text, licenses, {
        includeDiffs: false,
      })

      expect(response.inputType, testCase.text).toBe('license-header')
      expect(response.results.map((result) => result.licenseId)).toEqual(
        testCase.licenseIds,
      )
      expect(
        response.results.every(
          (result) =>
            result.flags.isLegacyId &&
            result.flags.needsManualReview &&
            result.confidence === 'Possible' &&
            result.score.f1 === 0 &&
            result.score.precision === 0 &&
            result.score.recall === 0,
        ),
        testCase.text,
      ).toBe(true)
    }
  })

  it('marks versionless GNU notices as ambiguous', () => {
    const notices = [
      {
        familyPrefix: 'GPL-',
        text: 'This program is free software; you can redistribute it and modify it under the terms of the GNU General Public License as published by the Free Software Foundation.',
      },
      {
        familyPrefix: 'LGPL-',
        text: 'This library is free software; you can redistribute it and modify it under the terms of the GNU Lesser General Public License as published by the Free Software Foundation.',
      },
      {
        familyPrefix: 'AGPL-',
        text: 'This network service is free software; you can redistribute it and modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation.',
      },
    ]

    for (const notice of notices) {
      const response = rankLicenses(notice.text, licenses)
      const familyResults = response.results.filter((result) =>
        result.licenseId.startsWith(notice.familyPrefix),
      )
      const gnuResults = response.results.filter((result) =>
        /^(?:AGPL|GPL|LGPL)-/.test(result.licenseId),
      )

      expect(response.inputType, notice.familyPrefix).toBe('license-header')
      expect(familyResults.length, notice.familyPrefix).toBeGreaterThan(0)
      expect(
        familyResults.every(
          (result) =>
            result.flags.needsManualReview && result.confidence === 'Possible',
        ),
        notice.familyPrefix,
      ).toBe(true)
      expect(gnuResults, notice.familyPrefix).toHaveLength(familyResults.length)
    }
  })

  it('handles common GNU version-or-later notices', () => {
    const response = rankLicenses(
      'This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License version 2 or later.',
      licenses,
    )
    expect(response.results[0]?.licenseId).toBe('GPL-2.0-or-later')
    expect(response.results[0]?.flags.needsManualReview).toBe(false)
    expectNoLicensePrefixes(response, ['GPL-3.', 'LGPL-', 'AGPL-'])
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'GPL-2.0-only' &&
          !result.flags.needsManualReview,
      ),
    ).toBe(false)
  })

  it('respects GNU version-or-later notices before full-body ambiguity', () => {
    const gpl = byId.get('GPL-2.0-only') || ''
    const response = rankLicenses(
      'GNU General Public License version 2 or later\n\n' + gpl,
      licenses,
      { includeDiffs: false },
    )
    expect(response.results[0]?.licenseId).toBe('GPL-2.0-or-later')
    expect(response.results[0]?.flags.needsManualReview).toBe(false)
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'GPL-2.0-only' &&
          !result.flags.needsManualReview,
      ),
    ).toBe(false)
  })

  it('handles wrapped GNU version-or-later notices', () => {
    const response = rankLicenses(
      'This program is free software; you can redistribute it and/or modify it under the terms of the GNU\nGeneral Public License version 2 or later.',
      licenses,
    )
    expect(response.results[0]?.licenseId).toBe('GPL-2.0-or-later')
    expect(response.results[0]?.flags.needsManualReview).toBe(false)
    expectNoLicensePrefixes(response, ['GPL-3.', 'LGPL-', 'AGPL-'])
  })

  it('keeps GNU version-or-later notices on the requested version', () => {
    const response = rankLicenses(
      'This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License version 3 or later.',
      licenses,
    )
    expect(response.results[0]?.licenseId).toBe('GPL-3.0-or-later')
    expect(response.results[0]?.flags.needsManualReview).toBe(false)
    expectNoLicensePrefixes(response, ['GPL-2.', 'LGPL-', 'AGPL-'])
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'GPL-2.0-or-later' &&
          !result.flags.needsManualReview,
      ),
    ).toBe(false)
  })

  it('handles common GNU version-only notices', () => {
    const response = rankLicenses(
      'This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License version 2 only.',
      licenses,
    )
    expect(response.results[0]?.licenseId).toBe('GPL-2.0-only')
    expect(response.results[0]?.flags.needsManualReview).toBe(false)
    expectNoLicensePrefixes(response, ['GPL-3.', 'LGPL-', 'AGPL-'])
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'GPL-2.0-or-later' &&
          !result.flags.needsManualReview,
      ),
    ).toBe(false)
  })

  it('keeps standard GNU version-or-later notices on the requested version', () => {
    const response = rankLicenses(
      'This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 3 of the License, or (at your option) any later version.',
      licenses,
    )
    expect(response.results[0]?.licenseId).toBe('GPL-3.0-or-later')
    expect(response.results[0]?.flags.needsManualReview).toBe(false)
    expectNoLicensePrefixes(response, ['GPL-2.', 'LGPL-', 'AGPL-'])
    expect(
      response.results.some(
        (result) =>
          result.licenseId === 'GPL-2.0-or-later' &&
          !result.flags.needsManualReview,
      ),
    ).toBe(false)
  })

  it('parses GNU SPDX suffixes after long license names', () => {
    const cases = [
      {
        text: 'Licensed under the GNU General Public License - 2.0-or-later',
        expected: 'GPL-2.0-or-later',
      },
      {
        text: 'Licensed under the GNU Lesser General Public License - 3.0-only',
        expected: 'LGPL-3.0-only',
      },
    ]

    for (const testCase of cases) {
      const response = rankLicenses(testCase.text, licenses)
      expect(response.inputType, testCase.expected).toBe('license-header')
      expect(response.results[0], testCase.expected).toMatchObject({
        licenseId: testCase.expected,
        flags: { needsManualReview: false },
      })
    }
  })

  it('keeps LGPL minor-version notices on the requested family and version', () => {
    const response = rankLicenses(
      'This library is free software; you can redistribute it and/or modify it under the terms of the GNU Lesser General Public License version 2.1 or later.',
      licenses,
    )
    expect(response.results[0]?.licenseId).toBe('LGPL-2.1-or-later')
    expect(response.results[0]?.flags.needsManualReview).toBe(false)
    expectNoLicensePrefixes(response, ['LGPL-3.', 'GPL-', 'AGPL-'])
    expect(
      response.results.some(
        (result) =>
          result.licenseId.startsWith('GPL-') &&
          !result.flags.needsManualReview,
      ),
    ).toBe(false)
  })

  it('does not treat empty SPDX tags as SPDX expressions', () => {
    for (const input of [
      'SPDX-License-Identifier:',
      'SPDX-License-Identifier:\nMIT',
      'SPDX-License-Identifier: # MIT',
      'SPDX-License-Identifier: // MIT',
      'SPDX-License-Identifier: ; MIT',
      '/* SPDX-License-Identifier: */',
      'SPDX-License-Identifier: AND',
      'SPDX-License-Identifier: OR',
      'SPDX-License-Identifier: WITH',
      'SPDX-License-Identifier: (AND OR)',
      'SPDX-License-Identifier: <MIT>',
      'SPDX-License-Identifier: [MIT]',
      'SPDX-License-Identifier: {MIT}',
      'SPDX-License-Identifier: Copyright:',
      'SPDX-License-Identifier: DocumentRef-example:MIT',
      'SPDX-License-Identifier: MIT)',
      'SPDX-License-Identifier: (MIT',
      'SPDX-License-Identifier: (MIT OR)',
      'SPDX-License-Identifier: (OR MIT)',
      'SPDX-License-Identifier: MIT AND',
      'SPDX-License-Identifier: MIT Apache-2.0',
    ]) {
      const response = rankLicenses(input, licenses)

      expect(response.inputType, input).toBe('unknown')
      expect(response.spdxExpression, input).toBeUndefined()
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('does not rank unknown SPDX identifiers as text matches', () => {
    expect(
      rankLicenses('SPDX-License-Identifier: Not-A-License', licenses),
    ).toMatchObject({
      inputType: 'spdx-expression',
      spdxExpression: 'Not-A-License',
      results: [],
      message:
        'Unknown: compound SPDX expressions, WITH exceptions, and unknown SPDX IDs need a future parser.',
    })
  })

  it('treats lowercase SPDX compound operators like uppercase operators', () => {
    expect(rankLicenses('MIT or Apache-2.0', licenses)).toMatchObject({
      inputType: 'spdx-expression',
      spdxExpression: 'MIT or Apache-2.0',
      results: [],
    })
  })

  it('does not mark modern GNU IDs as legacy results', () => {
    const response = rankLicenses(byId.get('GPL-3.0-only') || '', licenses, {
      includeDiffs: false,
    })
    expect(
      response.results.find((result) => result.licenseId === 'GPL-3.0-only')
        ?.flags.isLegacyId,
    ).toBe(false)
  })

  it('does not return Exact for conflicting repeated SPDX lines', () => {
    expect(
      rankLicenses(
        'SPDX-License-Identifier: MIT\nSPDX-License-Identifier: Apache-2.0',
        licenses,
      ),
    ).toMatchObject({
      inputType: 'spdx-expression',
      results: [],
    })
  })

  it('does not return Exact when SPDX identifiers conflict with full bodies', () => {
    for (const prefix of [
      'SPDX-License-Identifier: MIT',
      '- SPDX-License-Identifier: MIT',
    ]) {
      const response = rankLicenses(
        prefix + String.fromCharCode(10, 10) + (byId.get('Apache-2.0') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('mixed-license-text')
      expect(response.spdxExpression, prefix).toBe('MIT')
      expect(response.message, prefix).toContain('conflicts')
      expect(response.results[0], prefix).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Exact',
      })
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'MIT' && result.confidence === 'Exact',
        ),
      ).toBe(false)
    }
  })

  it('deduplicates conflicting SPDX body header matches across segments', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'This file is licensed under the Apache License 2.0.' +
        String.fromCharCode(10) +
        'Really, it is the Apache License 2.0.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('conflicts')
    expect(
      response.results.filter((result) => result.licenseId === 'Apache-2.0'),
    ).toHaveLength(1)
  })

  it('keeps stronger conflicting SPDX body header matches when deduplicating', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Licensed under GPL-2.0.' +
        String.fromCharCode(10) +
        'Licensed under GPL-2.0-only.',
      licenses,
      { includeDiffs: false },
    )
    const gplOnly = response.results.find(
      (result) => result.licenseId === 'GPL-2.0-only',
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('conflicts')
    expect(gplOnly).toMatchObject({
      confidence: 'Likely',
      flags: { needsManualReview: false },
      score: { f1: 1 },
    })
    expect(
      response.results.filter((result) => result.licenseId === 'GPL-2.0-only'),
    ).toHaveLength(1)
  })

  it('keeps SPDX identifiers ahead of third-party full-body notices', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('spdx-expression')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('SPDX license identifier detected')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })
  })

  it('keeps SPDX identifiers with project bodies ahead of third-party full-body notices', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('spdx-expression')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('SPDX license identifier detected')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })
  })

  it('detects later project full-body conflicts after third-party SPDX notices', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || '') +
        String.fromCharCode(10, 10) +
        'Project license' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-2-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]).toMatchObject({
      licenseId: 'BSD-2-Clause',
    })
  })

  it('detects project full-body conflicts after third-party SPDX notices with prose boundaries', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || '') +
        String.fromCharCode(10, 10) +
        'The project itself is licensed under BSD-2-Clause.' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-2-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]).toMatchObject({
      licenseId: 'BSD-2-Clause',
    })
  })

  it('keeps SPDX identifiers when third-party notices negate the declared license', () => {
    for (const body of [
      'Third-party notices' +
        String.fromCharCode(10, 10) +
        'This bundled library is not licensed under MIT.' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      'Third-party notices' +
        String.fromCharCode(10, 10) +
        'This library is not licensed under MIT.',
      'Third-party notices' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || '') +
        String.fromCharCode(10, 10) +
        'This bundled library is not licensed under MIT.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('spdx-expression')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], body).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('rejects negated SPDX identifiers after third-party full-body notices', () => {
    for (const tail of [
      'This project is not licensed under MIT.',
      'This project is not licensed under MIT; internal use only.',
      'No part of this project is MIT licensed.',
      'No part of this project is licensed under MIT.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || '') +
          String.fromCharCode(10, 10) +
          tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.spdxExpression, tail).toBe('MIT')
      expect(response.results, tail).toHaveLength(0)
      expect(response.message, tail).toContain('conflicts')
    }
  })

  it('rejects project-scoped SPDX restrictions before third-party full-body notices', () => {
    for (const prefix of [
      'This project is proprietary.',
      'This source file is not licensed under any open source license.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' +
          String.fromCharCode(10, 10) +
          prefix +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('mixed-license-text')
      expect(response.spdxExpression, prefix).toBe('MIT')
      expect(response.results, prefix).toHaveLength(0)
      expect(response.message, prefix).toContain('conflicts')
    }
  })

  it('keeps declared full bodies ahead of restrictive named-body guards', () => {
    for (const expected of ['Zlib', 'PostgreSQL']) {
      const response = rankLicenses(
        'SPDX-License-Identifier: ' +
          expected +
          String.fromCharCode(10, 10) +
          (byId.get(expected) || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, expected).toBe('spdx-expression')
      expect(response.spdxExpression, expected).toBe(expected)
      expect(response.message, expected).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], expected).toMatchObject({
        licenseId: expected,
        confidence: 'Exact',
      })
    }
  })

  it('keeps full body conflicts ahead of restrictive named-body guards', () => {
    for (const expected of ['Zlib', 'PostgreSQL']) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' +
          String.fromCharCode(10, 10) +
          (byId.get(expected) || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, expected).toBe('mixed-license-text')
      expect(response.spdxExpression, expected).toBe('MIT')
      expect(response.message, expected).toContain('detected license text')
      expect(response.results[0], expected).toMatchObject({
        licenseId: expected,
        confidence: 'Exact',
      })
    }
  })

  it('does not return Exact when declared full bodies have restrictive tails', () => {
    const mitText = byId.get('MIT') || ''
    const mitBodies = [
      mitText,
      mitText.replace('<year> <copyright holders>', '2026 Example Corporation'),
      mitText.replace('<year> <copyright holders>', '2026 Permission Labs'),
    ]

    for (const body of mitBodies) {
      for (const tail of [
        'For non-commercial use only',
        'For commercial use only',
        'For trial use only',
        'For demo use only',
        'This package is restricted to internal use',
        'See LICENSE for details. For non-commercial use only',
        'See LICENSE for details' +
          String.fromCharCode(10) +
          'For non-commercial use only',
        'No commercial use.',
        'No redistribution.',
        'Commons Clause',
        'The Commons Clause applies',
        'gap0 gap1 for non-commercial use only',
        'This project includes a bundled parser licensed under Apache License 2.0 for non-commercial use only, but this project is licensed under MIT for non-commercial use only',
        'This project includes a third party library. This library is restricted to internal use only. This project is licensed under MIT for non-commercial use only',
        'This project includes a bundled parser licensed under Apache License 2.0 for non-commercial use only, but this project is licensed under MIT for non-commercial use only as a bundled dependency',
        'This project is licensed under MIT for non-commercial use only as a bundled dependency',
        'The bundled parser is only for internal use and this package is restricted to internal use',
      ]) {
        const response = rankLicenses(
          'SPDX-License-Identifier: MIT' +
            String.fromCharCode(10, 10) +
            body +
            String.fromCharCode(10, 10) +
            tail,
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, tail).toBe('mixed-license-text')
        expect(response.spdxExpression, tail).toBe('MIT')
        expect(response.message, tail).toContain('restrictive license text')
        expect(response.results, tail).toHaveLength(0)
      }
    }
  })

  it('keeps declared near-complete full bodies with restrictive license terms', () => {
    const euplText = (byId.get('EUPL-1.2') || '').replace(
      'EUROPEAN UNION PUBLIC LICENCE',
      'EUROPEAN UNION PUBLIC LICENSE',
    )

    const response = rankLicenses(
      'SPDX-License-Identifier: EUPL-1.2' +
        String.fromCharCode(10, 10) +
        euplText,
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('spdx-expression')
    expect(response.spdxExpression).toBe('EUPL-1.2')
    expect(response.message).not.toContain('restrictive license text')
    expect(response.results[0]).toMatchObject({
      licenseId: 'EUPL-1.2',
    })
  })

  it('does not return Exact when full bodies have restrictive tails without SPDX identifiers', () => {
    const mitText = byId.get('MIT') || ''
    const mitBodies = [
      mitText,
      mitText.replace('<year> <copyright holders>', '2026 Example Corporation'),
    ]

    for (const tail of [
      'This project is proprietary.',
      'This package: All rights reserved.',
      'This library: All rights reserved.',
      'This component: All rights reserved.',
      'For non-commercial use only.',
      'For testing use only.',
      'No commercial use.',
      'No redistribution.',
      'All rights reserved.',
      'Commons Clause',
      'Proprietary.',
    ]) {
      for (const body of mitBodies) {
        const response = rankLicenses(
          body + String.fromCharCode(10, 10) + tail,
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, tail).toBe('mixed-license-text')
        expect(response.message, tail).toContain('restrictive license text')
        expect(response.results, tail).toHaveLength(0)
      }
    }
  })

  it('does not treat appended supported full bodies as restrictive tails', () => {
    for (const body of [
      [byId.get('MIT'), byId.get('MIT')].join(String.fromCharCode(10, 10)),
      [byId.get('MIT'), byId.get('Apache-2.0')].join(
        String.fromCharCode(10, 10),
      ),
      [byId.get('Apache-2.0'), byId.get('MIT')].join(
        String.fromCharCode(10, 10),
      ),
    ]) {
      const response = rankLicenses(body, licenses, { includeDiffs: false })

      expect(response.inputType, body).toBe('mixed-license-text')
      expect(response.results.length, body).toBeGreaterThan(0)
      expect(response.message, body).not.toContain('restrictive')
    }
  })

  it('rejects restrictive tails after appended supported full bodies', () => {
    const response = rankLicenses(
      [byId.get('MIT'), byId.get('Apache-2.0'), 'All rights reserved.'].join(
        String.fromCharCode(10, 10),
      ),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('restrictive')
  })

  it('does not return Exact when full bodies have restrictive prefixes without SPDX identifiers', () => {
    const mitText = byId.get('MIT') || ''
    const crlfMitText = mitText.replace(/\n/g, String.fromCharCode(13, 10))

    for (const [prefix, body] of [
      ['This project is proprietary.', mitText],
      ['Proprietary.', mitText],
      ['All rights reserved.', mitText],
      ['This project is proprietary.', crlfMitText],
      [
        'This project is proprietary.' +
          String.fromCharCode(10, 10) +
          'License information',
        mitText,
      ],
      [
        'This project is proprietary.' +
          String.fromCharCode(10, 10) +
          'License overview',
        mitText,
      ],
      [
        'This project is proprietary.' +
          String.fromCharCode(10, 10) +
          'License overviews',
        mitText,
      ],
      [
        'This project is proprietary.' +
          String.fromCharCode(10, 10) +
          'License summary',
        mitText,
      ],
      [
        'This project is proprietary.' +
          String.fromCharCode(10, 10) +
          'License summaries',
        mitText,
      ],
      ['No license is granted.', mitText],
      ['This project is under no license.', mitText],
      ['Permission is not granted.', mitText],
    ]) {
      const response = rankLicenses(
        prefix + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('mixed-license-text')
      expect(response.message, prefix).toContain('restrictive license text')
      expect(response.results, prefix).toHaveLength(0)
    }
  })

  it('keeps explanatory permission prefaces before full bodies', () => {
    const mitText = byId.get('MIT') || ''

    for (const prefix of [
      'No license is granted by default. The following MIT License applies:',
      'Permission is not granted except as described below.',
    ]) {
      const response = rankLicenses(
        prefix + String.fromCharCode(10, 10) + mitText,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('mixed-license-text')
      expect(response.message, prefix).not.toContain('restrictive license text')
      expect(response.results[0], prefix).toMatchObject({
        licenseId: 'MIT',
      })
    }
  })

  it('does not return Likely when near-complete full bodies have restrictive context', () => {
    const mitText = (byId.get('MIT') || '').replace(
      'Permission is hereby granted',
      'Permission is hereby explicitly granted',
    )

    for (const input of [
      'This project is proprietary.' + String.fromCharCode(10, 10) + mitText,
      mitText + String.fromCharCode(10, 10) + 'This project is proprietary.',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.message, input).toContain('restrictive license text')
      expect(response.results, input).toHaveLength(0)
    }
  })

  it('does not treat third-party full-body tails as project restrictions', () => {
    const mitText = byId.get('MIT') || ''

    for (const tail of [
      'Bundled font: All rights reserved.',
      'External asset: All rights reserved.',
    ]) {
      for (const prefix of [
        '',
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10),
      ]) {
        const response = rankLicenses(
          prefix + mitText + String.fromCharCode(10, 10) + tail,
          licenses,
          { includeDiffs: false },
        )

        expect(response.message, tail).not.toContain('restrictive license text')
        expect(response.results[0], tail).toMatchObject({
          licenseId: 'MIT',
        })
      }
    }
  })

  it('does not ignore bare rights-reserved prose after a second supported full body', () => {
    const response = rankLicenses(
      (byId.get('MIT') || '').replace(
        '<year> <copyright holders>',
        '2026 Example Corporation',
      ) +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-2-Clause') || '') +
        String.fromCharCode(10, 10) +
        'All rights reserved.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('restrictive license text')
    expect(response.results).toHaveLength(0)
  })

  it('does not return Exact when SPDX identifiers have proprietary project bodies', () => {
    for (const body of [
      'This project is proprietary. No permission is granted to use this software.',
      'This package is proprietary.',
      'This library is closed source.',
      'This product is proprietary.',
      'No permission is granted to use this software.',
      'No permission is granted to use, copy, modify, or distribute this software.',
      'No permission is granted for this project.',
      'Redistribution prohibited.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('mixed-license-text')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain('restrictive license text')
      expect(response.results, body).toHaveLength(0)
    }

    const sameLineTailResponse = rankLicenses(
      'SPDX-License-Identifier: MIT; This project is proprietary.',
      licenses,
      { includeDiffs: false },
    )

    expect(sameLineTailResponse.inputType).toBe('mixed-license-text')
    expect(sameLineTailResponse.spdxExpression).toBe('MIT')
    expect(sameLineTailResponse.message).toContain('restrictive license text')
    expect(sameLineTailResponse.results).toHaveLength(0)
  })

  it('keeps prose SPDX marker mentions in body analysis', () => {
    const response = rankLicenses(
      'This project is proprietary. See SPDX-License-Identifier: MIT in examples.' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('restrictive license text')
    expect(response.results).toHaveLength(0)
  })

  it('does not return Exact when declared GNU bodies have restrictive tails', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: GPL-3.0-only' +
        String.fromCharCode(10, 10) +
        (byId.get('GPL-3.0-only') || '') +
        String.fromCharCode(10, 10) +
        'This product is proprietary.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('GPL-3.0-only')
    expect(response.message).toContain('restrictive license text')
    expect(response.results).toHaveLength(0)
  })
  it('keeps declared full bodies ahead of benign follow-up prose', () => {
    for (const tail of [
      'For commercial support, contact us',
      'Liability is limited to the extent permitted by applicable law.',
      'Liability is limited to the extent required by statute.',
      'Liability is limited to the extent of direct damages.',
      'It is limited to the extent permitted by law.',
      'This project is limited to the extent permitted by applicable law.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || '') +
          String.fromCharCode(10, 10) +
          tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('spdx-expression')
      expect(response.spdxExpression, tail).toBe('MIT')
      expect(response.message, tail).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], tail).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('keeps declared full bodies ahead of later third-party license restrictions', () => {
    for (const tail of [
      'Apache License 2.0 for non-commercial use only (parser dependency)',
      'Licensed under Apache License 2.0 for non-commercial use only (bundled dependency)',
      'This project includes a third party library. This library is restricted to internal use only. The library is licensed under Apache License 2.0 for non-commercial use only',
      'This project bundles several third-party fonts. They are licensed under their own terms. Redistribution prohibited.',
      'This project uses several bundled fonts. See LICENSE for details. Redistribution prohibited.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || '') +
          String.fromCharCode(10, 10) +
          tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('spdx-expression')
      expect(response.spdxExpression, tail).toBe('MIT')
      expect(response.message, tail).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], tail).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('does not return Exact when SPDX identifiers conflict with named headers', () => {
    for (const header of [
      'Licensed under Apache License 2.0',
      'Apache License 2.0',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + header,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, header).toBe('mixed-license-text')
      expect(response.spdxExpression, header).toBe('MIT')
      expect(response.message, header).toContain('conflicts')
      expect(response.results[0], header).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'MIT' && result.confidence === 'Exact',
        ),
        header,
      ).toBe(false)
    }
  })

  it('does not let named headers hide conflicting full license bodies', () => {
    const response = rankLicenses(
      'MIT License' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('does not suppress conflicts between license labels and named body headers', () => {
    for (const testCase of [
      {
        body: 'This project is licensed under Apache License 2.0',
        licenseId: 'Apache-2.0',
      },
      {
        body: 'This project is licensed under the ISC License',
        licenseId: 'ISC',
      },
    ]) {
      const response = rankLicenses(
        'License: MIT' + String.fromCharCode(10, 10) + testCase.body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, testCase.body).toBe('mixed-license-text')
      expect(response.message, testCase.body).toContain('conflicts')
      expect(response.results[0], testCase.body).toMatchObject({
        licenseId: testCase.licenseId,
        confidence: 'Likely',
      })
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'MIT' && result.confidence === 'Exact',
        ),
        testCase.body,
      ).toBe(false)
    }
  })

  it('does not return Exact when SPDX identifiers have restrictive labels', () => {
    for (const label of [
      'License: Non-commercial',
      'License: Personal use only',
      'License: This project has a commercial license only available upon request',
      "License: This project's license is commercial license only available upon request",
      'License:\nCommercial license only available upon request',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10) + label,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, label).toBe('mixed-license-text')
      expect(response.results, label).toHaveLength(0)
      expect(response.message, label).toContain('restrictive license text')
    }
  })

  it('does not return Exact when SPDX identifiers have restrictive named bodies', () => {
    for (const body of [
      'Licensed under the MIT License for non-commercial use only',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'for non-commercial use only',
      'License: MIT for internal use only',
      'Licensed under the MIT License for educational use only',
      'Licensed under the MIT License for nonprofit use only',
      'Licensed under the MIT License for non-profit use only',
      'Licensed under the MIT License for non profit use only',
      'Licensed under the MIT License for research use only',
      'Licensed under the MIT License for academic use only',
      'Licensed under the MIT License. For non-commercial use only',
      'Licensed under the MIT License. See LICENSE for details. For non-commercial use only',
      'Licensed under the MIT License. See LICENSE for details' +
        String.fromCharCode(10) +
        'For non-commercial use only',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'Personal use only',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This project is for personal use only',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not redistribute this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not redistribute this software. You may not use this file except in compliance with the License.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You must not sublicense this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You must not use this file.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software may not be redistributed.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software must not be sublicensed.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software may not be used.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software cannot be used.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software can not be used.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This file must not be used.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software cannot be redistributed.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You cannot copy this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You can not distribute this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        "You can't sublicense this software.",
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use or redistribute this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use the trademark or redistribute this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use the trademark, redistribute this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use the trademark or the software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software and trademark may not be used.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software, name, and logo may not be used.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software, project name, and logo may not be used.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use the project name, logo, or software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use the project name, logo, copy, or distribute the software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use the project name, logo, or copy the software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use it or redistribute it.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use it or reproduce it.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use it or sublicense it.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use, copy, modify, or sublicense this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use, reproduce, modify, or distribute the software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use these files.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use my software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use it.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use them.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use this tool.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use this app.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use this repo.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use this cli.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'Do not use.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'Do not use for commercial purposes.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use for documentation purposes.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use except under a commercial license.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You must not use except under a commercial license.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use commercially.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use this software commercially except in compliance with the License.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use this software for commercial purposes except in compliance with the License.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'This software cannot be used commercially except in compliance with the License.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You cannot use this software for commercial purposes except in compliance with the License.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You shall not redistribute this software.',
      'Licensed under the MIT License' +
        String.fromCharCode(10) +
        'You may not use this software except in compliance with a separate commercial license.',
      'MIT License' +
        String.fromCharCode(10) +
        'Copyright (c) 2026 Example' +
        String.fromCharCode(10) +
        'Permission is hereby granted for non-commercial use only',
      'This project is licensed under MIT. But not for commercial use',
      'This project uses MIT. But not for commercial use',
      'This project has MIT for non-commercial use only',
      'This project is licensed under MIT however for non-commercial use only',
      'This project uses MIT however for non-commercial use only',
      'This project uses MIT pad0 for non-commercial use only',
      'This project is licensed under MIT pad0 for non-commercial use only',
      'This project is licensed under MIT although for non-commercial use only',
      'This project is licensed under MIT though for non-commercial use only',
      'This project is under MIT. But not for commercial use',
      'This project is licensed under MIT. However, for non-commercial use only',
      'This project is licensed under MIT. But only for internal use',
      'This project is licensed under MIT. For internal only',
      'This project is licensed under MIT. However, for commercial distribution only',
      'This project is licensed under MIT. Use is restricted to internal use',
      'This project is licensed under MIT. The use is restricted to internal use',
      'This project is licensed under MIT. Usage is restricted to internal use',
      'This project is licensed under MIT. Distribution is restricted to internal use',
      'This project is licensed under MIT. Commercial use is restricted to internal use',
      'This project is licensed under MIT. Commercial distribution is restricted to internal use',
      'This project is licensed under MIT. It has no third-party dependencies. Commercial use is restricted to internal use',
      'This project is licensed under MIT. It ships without bundled assets. Commercial use is restricted to internal use',
      'This library is restricted to internal use. This project is licensed under MIT',
      'This package is restricted to internal use. This project is licensed under MIT',
      'The module is restricted to internal use. This project is licensed under MIT',
      'This project is licensed under MIT. The bundled parser is only for internal use. Commercial use of this project is restricted to internal use',
      'This project is licensed under MIT. Additional terms apply for non-commercial use only',
      'This project is licensed under MIT. The bundled parser which we integrated long ago and have maintained across dozens of releases spanning several years is provided for non-commercial use only and commercial use of this project is restricted to internal use',
      'This project is licensed under MIT. It is restricted to internal use',
      'This project is licensed under MIT. It has been restricted to internal use',
      'This project is licensed under MIT. They have been restricted to internal use',
      'This project is licensed under MIT. This package is restricted to internal use',
      'This project is licensed under MIT. This code is restricted to internal use',
      'This project is licensed under MIT. The main code is restricted to internal use',
      'This project is licensed under MIT. The primary library is restricted to internal use',
      'This project is licensed under MIT. The primary component is restricted to internal use',
      'This project is licensed under MIT. The main module is restricted to internal use',
      'This project is licensed under MIT. This module is restricted to internal use',
      'This project is licensed under MIT. This parser is restricted to internal use',
      'This project is licensed under MIT. This helper is restricted to internal use',
      'This project is licensed under MIT. This component is restricted to internal use',
      'This project is licensed under MIT. This plugin is restricted to internal use',
      'This project is licensed under MIT. This extension is restricted to internal use',
      'This project is licensed under MIT. The software has been restricted to internal use',
      'This project is licensed under MIT. The dependency is only for internal use. This package is restricted to internal use',
      'This project is licensed under MIT. The dependency is only for internal use. The package is restricted to internal use',
      'This project is licensed under MIT. The dependency is only for internal use. That package is restricted to internal use',
      'This project is licensed under MIT but the bundled parser is only for internal use and this package is restricted to internal use',
      'This project includes a bundled parser licensed under Apache License 2.0 for non-commercial use only, but this project is licensed under MIT for non-commercial use only',
      'This project includes a third party library. This library is restricted to internal use only. This project is licensed under MIT for non-commercial use only',
      'This project is licensed under MIT. For commercial use only',
      'This project is licensed under MIT. For testing use only',
      'This project is licensed under MIT. For trial use only',
      'This project is licensed under MIT. Demo use only',
      'This project is licensed under MIT. Commercial use only',
      'This project is licensed under MIT. Commercial license only',
      'This project is licensed under MIT. Documentation license only',
      'This project is licensed under MIT. Internal license only',
      'This project is licensed under MIT. For commercial license only',
      'This project is licensed under MIT. Non commercial license only',
      'This project has a commercial license only.',
      'This project has a commercial license only available upon request.',
      'This project has a commercial license only, contact us for terms.',
      'This project has an internal license only.',
      'This project has a documentation license only.',
      'This project is under a commercial license only.',
      'This project is licensed under a commercial license only.',
      'This project is under the terms of a commercial license only.',
      'The project license is commercial license only.',
      "This project's license is commercial license only available upon request.",
      'This component has a commercial license only.',
      'The component has a commercial license only.',
      'Notes: Commercial license only',
      'Notes: Commercial license only available upon request',
      'Project notice: Commercial license only',
      'Project notice: Commercial license only available upon request',
      'This project is licensed under MIT. No commercial use',
      'This project is licensed under MIT. No redistribution',
      'This project is licensed under MIT. Private use only',
      'This project is licensed under MIT. Educational use only',
      'This project is licensed under MIT. Nonprofit use only',
      'This project is licensed under MIT. Non-profit use only',
      'This project is licensed under MIT. Research use only',
      'This project is licensed under MIT. Academic use only',
      'Non-commercial use only',
      'Commercial license only',
      'Documentation license only',
      'Internal license only',
      'For commercial license only',
      'Non commercial license only',
      'Commercial license only available upon request, internal use only',
      'Commercial license only available upon request for internal use',
      'Commercial license only available upon request to commercial customers only',
      'Commercial license only available upon request to internal users only',
      'Commercial license only available upon request from sales to commercial customers only',
      'Commercial license only available upon request by email to internal users only',
      'Internal use only',
      'Evaluation use only',
      'Educational use only',
      'Nonprofit use only',
      'Non-profit use only',
      'Research use only',
      'Academic use only',
      'Testing use only',
      'Trial use only',
      'Demo use only',
      'No commercial use',
      'No redistribution',
      'This project includes a third party dependency. The package is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a third party dependency. This package is licensed under Apache License 2.0 for non-commercial use only',
      'This project is licensed under MIT. However, use is limited to internal use',
      'This project is licensed under MIT. Use has been restricted to internal use',
      'Licensed under Apache License 2.0 for non-commercial use only',
      'Licensed under the MIT License for non-commercial use only for this package',
      'Licensed under the MIT License for non-commercial use only for this library',
      'Licensed under the MIT License for non-commercial use only for this parser module',
      'MIT for non-commercial use only',
      'MIT with use restricted to internal use',
      'MIT is restricted to internal use',
      'MIT internal use only',
      'The MIT License for non-commercial use only',
      'The main code is under the MIT License for non-commercial use only',
      'This project uses MIT for non-commercial use only',
      'This project is under MIT for non-commercial use only as a browser extension',
      'This project is under MIT for non-commercial use only as a bundled parser',
      'This project is under MIT for non-commercial use only as a bundled dependency',
      'This project is under MIT for non-commercial use only as a third party component',
      'Licensed under the MIT License for non-commercial use only. Third-party dependencies are listed separately',
      Array.from({ length: 20 }, (_, index) => 'notice' + index).join(' ') +
        ' This project uses MIT for non-commercial use only',
      Array.from({ length: 70 }, (_, index) => 'notice' + index).join(' ') +
        ' This project uses MIT for non-commercial use only',
      'This project uses MIT ' +
        Array.from({ length: 70 }, (_, index) => 'gap' + index).join(' ') +
        ' for non-commercial use only',
      'This project uses MIT ' +
        Array.from({ length: 135 }, (_, index) => 'gap' + index).join(' ') +
        ' for non-commercial use only',
      'This project uses MIT for non-commercial use only ' +
        Array.from({ length: 55 }, (_, index) => 'context' + index).join(' '),
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('mixed-license-text')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain('restrictive license text')
      expect(response.results, body).toHaveLength(0)
    }
  })

  it('keeps clean SPDX header bodies ahead of later third-party restrictions', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: Apache-2.0' +
        String.fromCharCode(10, 10) +
        'This project is licensed under the Apache License 2.0. The bundled parser which we integrated long ago and have maintained across dozens of releases spanning several years is provided for non-commercial use only.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('spdx-expression')
    expect(response.spdxExpression).toBe('Apache-2.0')
    expect(response.message).toContain('SPDX license identifier detected')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Exact',
    })
  })

  it('keeps third-party all-rights notices from conflicting with SPDX headers', () => {
    for (const body of [
      'This project includes a third-party font. All rights reserved.',
      'This project includes a third-party font (all rights reserved).',
      'This project includes a third-party font that is all rights reserved.',
      'This project includes a third-party font. It is all rights reserved.',
      'This project bundles a font that is all rights reserved.',
      'This project bundles libraries that have all rights reserved.',
      'This project bundles a dependency. All rights reserved.',
      'This project includes external code. All rights reserved.',
      'Dependencies are all rights reserved.',
      'Components have all rights reserved.',
      "All rights reserved by this project's dependencies.",
      'All rights reserved by this project’s dependencies.',
      "All rights reserved by these files' dependencies.",
      'All rights reserved by these files’ dependencies.',
      'This project has no third-party fonts; dependencies are all rights reserved.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('spdx-expression')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], body).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('keeps third-party license-only notices from conflicting with SPDX headers', () => {
    for (const body of [
      'Third-party notices' +
        String.fromCharCode(10) +
        'Commercial license only',
      'Third-party notices Commercial license only',
      'Third-party notices' +
        String.fromCharCode(10) +
        'AcmeParser component has a commercial license only.',
      'Third-party notices' +
        String.fromCharCode(10) +
        'This component has a commercial license only.',
      'Third-party notices' +
        String.fromCharCode(10) +
        'License: Commercial license only.',
      'This project bundles a third-party parser that has a commercial license only.',
      'This project includes a parser that has a commercial license only.',
      'This project includes the library that has a commercial license only.',
      'This project includes a module which is a commercial license only.',
      'This project includes AcmeParser component that has a commercial license only.',
      'This project includes AcmeParser component which has a commercial license only.',
      'This project includes a third-party parser with a commercial license only.',
      'This project includes a third-party parser under a commercial license only.',
      'This project includes a third-party parser under the terms of a commercial license only.',
      'AcmeParser component has a commercial license only.',
      'The AcmeParser component has a commercial license only.',
      'Package: AcmeParser' +
        String.fromCharCode(10) +
        'Commercial license only',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('spdx-expression')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], body).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('keeps restrictive dependency notes from conflicting with SPDX headers', () => {
    for (const body of [
      'The dependency is proprietary.',
      'This project has a proprietary dependency.',
      'This project has a proprietary runtime dependency.',
      'This project includes a proprietary dependency.',
      'This project includes a closed source optional dependency.',
      'Dependencies may be proprietary.',
      'Includes a proprietary dependency.',
      'Some dependencies use proprietary licenses.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('spdx-expression')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], body).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('rejects SPDX headers with project restrictions after dependency notes', () => {
    for (const body of [
      'This project has a proprietary dependency and is proprietary.',
      'This project includes a proprietary dependency but remains closed source.',
      'This project has a proprietary dependency; it remains proprietary.',
      'This project has a proprietary dependency. It remains proprietary.',
      'This project has a proprietary dependency. Private use only.',
      'This project has a proprietary dependency. This software may not be used.',
      'This project has a proprietary dependency. It is not licensed under MIT.',
      'This project has a proprietary dependency. This source is not open source.',
      'This project has a proprietary dependency and is not licensed under MIT.',
      'This project has a proprietary dependency and is not open source.',
      'This project has a proprietary dependency and is not free software.',
      'This project has a proprietary dependency and is under no open source license.',
      'Intro paragraph.' +
        String.fromCharCode(10) +
        'This project has a proprietary dependency and is proprietary.',
      'This project has a proprietary dependency and no license is granted.',
      'This project has a proprietary dependency and no license or permission is granted.',
      'This project has a proprietary dependency and no license or other permission is granted.',
      'This project has a proprietary dependency. No license is granted, nor permission is granted.',
      'This project has a proprietary dependency and permission is not granted.',
      'The dependency is proprietary.' +
        String.fromCharCode(10) +
        'Private use only.',
      'This project and its dependencies are private.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('mixed-license-text')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain('restrictive license text')
      expect(response.results, body).toHaveLength(0)
    }
  })

  it('falls back to named headers in malformed SPDX lines', () => {
    for (const [input, licenseId] of [
      ['SPDX-License-Identifier: Apache License 2.0', 'Apache-2.0'],
      ['SPDX-License-Identifier: Apache License, Version 2.0', 'Apache-2.0'],
      [
        'SPDX-License-Identifier: Apache License 2.0 (Apache-2.0)',
        'Apache-2.0',
      ],
      ['SPDX-License-Identifier: The Apache License 2.0', 'Apache-2.0'],
      ['SPDX-License-Identifier: The MIT License', 'MIT'],
      ['<!-- SPDX-License-Identifier: The MIT License -->', 'MIT'],
      [
        'SPDX-License-Identifier: Apache License 2.0' +
          String.fromCharCode(10) +
          'SPDX-License-Identifier: Apache License 2.0',
        'Apache-2.0',
      ],
      ['SPDX-License-Identifier: The Unlicense', 'Unlicense'],
    ] as const) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.message, input).toContain(
        'License candidates ranked by explicit header wording.',
      )
      expect(response.results[0], input).toMatchObject({
        licenseId,
        confidence: 'Likely',
      })
    }

    const conflictingMalformedHeadersResponse = rankLicenses(
      'SPDX-License-Identifier: Apache License 2.0' +
        String.fromCharCode(10) +
        'SPDX-License-Identifier: MIT License',
      licenses,
      { includeDiffs: false },
    )
    expect(conflictingMalformedHeadersResponse.inputType).toBe('unknown')
    expect(conflictingMalformedHeadersResponse.message).toContain('Unknown')
    expect(conflictingMalformedHeadersResponse.results).toHaveLength(0)
  })

  it('does not hide body headers after malformed SPDX title fallbacks', () => {
    for (const [input, licenseId] of [
      [
        'SPDX-License-Identifier: The MIT License' +
          String.fromCharCode(10) +
          'Apache License 2.0',
        'Apache-2.0',
      ],
      [
        'SPDX-License-Identifier: Apache License 2.0' +
          String.fromCharCode(10) +
          'MIT License',
        'MIT',
      ],
      [
        'SPDX-License-Identifier: The MIT License' +
          String.fromCharCode(10) +
          'BSD 2-Clause "Simplified" License',
        'BSD-2-Clause',
      ],
      [
        '<!-- SPDX-License-Identifier: The MIT License -->' +
          String.fromCharCode(10) +
          'Apache License 2.0',
        'Apache-2.0',
      ],
      [
        '<!-- SPDX-License-Identifier: The MIT License --> Apache License 2.0',
        'Apache-2.0',
      ],
      [
        '<!-- SPDX-License-Identifier: The MIT License /* note */ --> Apache License 2.0',
        'Apache-2.0',
      ],
      [
        '<!-- SPDX-License-Identifier: The MIT License --> Apache License 2.0' +
          String.fromCharCode(10) +
          'Notes',
        'Apache-2.0',
      ],
      [
        '/* SPDX-License-Identifier: The MIT License */ Apache License 2.0',
        'Apache-2.0',
      ],
      [
        '/*' +
          String.fromCharCode(10) +
          ' * SPDX-License-Identifier: The MIT License */' +
          String.fromCharCode(10) +
          'Apache License 2.0',
        'Apache-2.0',
      ],
    ] as const) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.message, input).toContain(
        'Malformed SPDX identifier ignored',
      )
      expect(response.results[0]?.licenseId, input).toBe(licenseId)
    }
  })

  it('does not let body header fallbacks hide restrictive malformed SPDX bodies', () => {
    for (const input of [
      '<!-- SPDX-License-Identifier: The MIT License --> Private use only.' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      'SPDX-License-Identifier: The MIT License' +
        String.fromCharCode(10) +
        'Private use only.' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      'SPDX-License-Identifier: Private use only.' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      'SPDX-License-Identifier: The MIT License Private use only.' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      'SPDX-License-Identifier: MIT License (private use only)' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      'SPDX-License-Identifier: MIT License (for internal use only)' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      'SPDX-License-Identifier: MIT (private (nested) use only)' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      'SPDX-License-Identifier: MIT License (Apache-2.0) (private use only)' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      '<!-- SPDX-License-Identifier: MIT License (private use only) --> Apache License 2.0',
      '/* SPDX-License-Identifier: MIT License (private use only) */ Apache License 2.0',
      '<!-- SPDX-License-Identifier: MIT (license for internal use only) --> Apache License 2.0',
      '<!-- SPDX-License-Identifier: MIT; Private use only. --> Apache License 2.0',
      '/* SPDX-License-Identifier: MIT; Private use only. */ Apache License 2.0',
      '<!-- SPDX-License-Identifier: Private use only. --> Apache License 2.0',
      '/* SPDX-License-Identifier: Private use only */ Apache License 2.0',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.results, input).toHaveLength(0)
      expect(response.message, input).toContain('restrictive license text')
    }
  })

  it('does not use third-party body headers after malformed SPDX prefixes', () => {
    for (const input of [
      'SPDX-License-Identifier: see LICENSE file' +
        String.fromCharCode(10, 10) +
        'This project includes a bundled parser. It is licensed under Apache License 2.0.',
      'SPDX-License-Identifier: The MIT License' +
        String.fromCharCode(10, 10) +
        'This project includes a bundled parser. It is licensed under Apache License 2.0.',
      'SPDX-License-Identifier: Apache License 2.0' +
        String.fromCharCode(10, 10) +
        'This project includes a bundled parser. It is licensed under MIT License.',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('unknown')
      expect(response.results, input).toHaveLength(0)
      expect(response.message, input).toContain('Unknown')
    }
  })

  it('flags restrictive malformed SPDX wrappers without a body', () => {
    for (const input of [
      '<!-- SPDX-License-Identifier: MIT (private use only) -->',
      '/* SPDX-License-Identifier: MIT (private use only) */',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.results, input).toHaveLength(0)
      expect(response.message, input).toContain('restrictive license text')
    }
  })

  it('keeps conventional copyright all-rights notices after SPDX headers', () => {
    for (const tail of [
      '',
      String.fromCharCode(10) + 'See LICENSE for details',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' +
          String.fromCharCode(10) +
          'Copyright 2026 Example' +
          String.fromCharCode(10) +
          'All rights reserved' +
          tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('spdx-expression')
      expect(response.spdxExpression, tail).toBe('MIT')
      expect(response.message, tail).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], tail).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('rejects restrictions attached to copyright all-rights notices after SPDX headers', () => {
    for (const body of [
      'Copyright 2026 Example All rights reserved for non-commercial use only',
      'Copyright 2026 Example All rights reserved Commons Clause applies',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('mixed-license-text')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain('restrictive license text')
      expect(response.results, body).toHaveLength(0)
    }
  })

  it('does not let project package wording hide later rights-reserved restrictions', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'This package is licensed under MIT.' +
        String.fromCharCode(10, 10) +
        'All rights reserved.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('restrictive license text')
    expect(response.results).toHaveLength(0)
  })

  it('rejects project-owned all-rights notices with third-party context', () => {
    for (const body of [
      'This project includes third-party dependencies, but this project retains all rights reserved.',
      'This project includes third-party dependencies, but the project source is all rights reserved.',
      'This project includes third-party dependencies and is all rights reserved.',
      'This project documents dependencies, all rights reserved.',
      'This project is proprietary; it also bundles third-party code. All rights reserved.',
      'All rights reserved by this project and third-party dependencies.',
      'This project retains all rights reserved and the bundled font which is all rights reserved.',
      'This project source is included here. All rights reserved.',
      'This software may not be embedded elsewhere. All rights reserved.',
      'This project has no third-party dependencies. All rights reserved.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('mixed-license-text')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain('restrictive license text')
      expect(response.results, body).toHaveLength(0)
    }
  })

  it('rejects project-owned all-rights label suffixes with third-party context', () => {
    for (const suffix of [
      'All rights reserved by this project and third-party dependencies.',
      "All rights reserved by this project's dependencies. This project is all rights reserved.",
      'This project has no third-party dependencies. All rights reserved.',
    ]) {
      const response = rankLicenses(
        'License: MIT' + String.fromCharCode(10) + suffix,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, suffix).toBe('unknown')
      expect(response.results, suffix).toHaveLength(0)
    }
  })

  it('keeps third-party all-rights label suffixes', () => {
    for (const suffix of [
      'This project includes a font. All rights reserved.',
      'This project includes a third-party font. It is all rights reserved.',
      'This project bundles a font that is all rights reserved.',
      'This project bundles a dependency. All rights reserved.',
      'This project includes a component. All rights reserved.',
      'This project includes a library. All rights reserved.',
      'Dependencies are all rights reserved.',
      'Components have all rights reserved.',
      "All rights reserved by this project's dependencies.",
      'All rights reserved by this project’s dependencies.',
      "All rights reserved by these files' dependencies.",
      'All rights reserved by these files’ dependencies.',
    ]) {
      const response = rankLicenses(
        'License: MIT' + String.fromCharCode(10) + suffix,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, suffix).toBe('license-header')
      expect(response.results[0], suffix).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
    }
  })

  it('keeps benign license continuation boilerplate after clean SPDX headers', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: ISC' +
        String.fromCharCode(10, 10) +
        'Licensed under the ISC License. Provided that the above copyright notice and this permission notice appear in all copies.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('spdx-expression')
    expect(response.spdxExpression).toBe('ISC')
    expect(response.message).toContain('SPDX license identifier detected')
    expect(response.results[0]).toMatchObject({
      licenseId: 'ISC',
      confidence: 'Exact',
    })
  })

  it('does not carry license restrictions onto unrelated follow-up sentences', () => {
    for (const body of [
      'This project is licensed under MIT. The dependency is only for internal use',
      'This project is licensed under MIT. The bundled parser is only for internal use',
      'This project is licensed under MIT. The bundled parser is restricted to internal use only',
      'This project is licensed under MIT however the bundled parser is for internal use only',
      'This project is licensed under MIT but the bundled parser is for internal use only',
      'This project is licensed under MIT but the bundled library is for internal use only',
      'This project is licensed under MIT but the bundled package is for internal use only',
      'This project is licensed under MIT although the bundled parser is for internal use only',
      'This project is licensed under MIT. Tests are only for internal use',
      'This project is licensed under MIT and the bundled parser is only for internal use',
      'This project is licensed under MIT, but includes third-party dependencies for non-commercial use only',
      'This project uses MIT and includes third-party components for internal use only',
      'This dependency uses MIT for non-commercial use only',
      'This component uses MIT for non-commercial use only',
      'This module uses MIT' +
        String.fromCharCode(10) +
        'for non-commercial use only',
      'This project is licensed under MIT and tests are only for internal use',
      'This project is licensed under MIT and documentation is only for internal use',
      'This project is licensed under MIT. For commercial support, contact us',
      'This project is licensed under MIT. Commercial license only available upon request',
      'This project is licensed under MIT. Commercial license only available on request from sales',
      'This project is licensed under MIT. This is not a commercial license only situation',
      'This project is licensed under MIT. This project is not commercial-license-only',
      'This project is licensed under MIT. This project has no commercial-license-only restriction',
      'This project is licensed under MIT. This project is not licensed under a commercial license only',
      'This project is licensed under MIT. See the commercial license only section of our website',
      'This project is licensed under MIT. It is not subject to a commercial license only model',
      'This project is licensed under MIT. Use without commercial license only restrictions',
      'This project is licensed under MIT. This product is clearly not marketed as a commercial license only offering',
      'This project is licensed under MIT. It is never distributed as a commercial license only product',
      'This project is licensed under MIT. This project has never been marketed as a commercial license only product',
      'This project is licensed under MIT. This project has not been distributed as a commercial license only offering',
      'This project is licensed under MIT. This project is not being marketed as a commercial license only product',
      'This project is licensed under MIT. This project is currently not being marketed as a commercial license only product',
      "This project is licensed under MIT. This product isn't marketed as a commercial license only offering",
      'This project is licensed under MIT for commercial reasons documented in the notes only',
      'This project is licensed under MIT. These fonts are restricted to internal use',
      'This project is licensed under MIT. These assets are restricted to internal use',
      'This project is licensed under MIT. These libraries are restricted to internal use',
      'Licensed under the MIT License for commercial support, contact us',
      'This project is licensed under MIT. For internal documentation, see docs/internal.md',
      'This project is licensed under MIT. For internal use cases, see README.',
      'This project is licensed under MIT. For internal usage cases, see README.',
      'This project is licensed under MIT. Only tests are for internal use',
      'This project is licensed under MIT. Only the bundled parser is for internal use',
      'This project is licensed under the MIT License. Except in compliance with the License, redistribute freely',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('spdx-expression')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], body).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('does not treat restrictive third-party named bodies as SPDX conflicts', () => {
    for (const body of [
      'The bundled parser is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a bundled parser. It is licensed under Apache License 2.0 for non-commercial use only',
      'The bundled parser is only for internal use. It is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a third party parser. The parser is restricted to internal use only',
      'This project includes a third party helper. The helper is restricted to internal use only',
      'This project includes a third party library. The library is restricted to internal use only',
      'This project includes a third party package. The package is restricted to internal use only',
      'This project includes a third party software. The software is restricted to internal use only',
      'This project includes a third party library. This library is restricted to internal use only',
      'This project includes a third party library. This library is restricted to internal use only. The library is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a third party package. This package is restricted to internal use only',
      'This project includes a third party software. This software is restricted to internal use only',
      'This project includes a third party library. The library is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a third party package. The package is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a third party software. The software is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a third party library. This library is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a third party package. This package is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a third party software. This software is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a bundled parser. Licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a bundled parser. Apache License 2.0 for non-commercial use only',
      'This project includes a bundled parser. Licensed under MIT for non-commercial use only',
      'This project includes a bundled parser. MIT for non-commercial use only',
      'This project includes a bundled parser. It is licensed under Apache License 2.0. But not for commercial use',
      'This project includes a third party library. This is licensed under Apache-2.0.',
      'This project includes a bundled ' +
        'metadata'.repeat(700) +
        ' parser restricted to internal use only',
      'This project includes a bundled parser licensed under Apache License 2.0. But not for commercial use',
      'This project is licensed under MIT. The bundled parser is licensed under Apache License 2.0. But not for commercial use',
      'This project is licensed under MIT. The bundled parser is licensed under Apache License 2.0. This parser is restricted to internal use',
      'The bundled parser is licensed under ISC. MIT for non-commercial use only',
      'This project includes AcmeParser. AcmeParser is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes AcmeParser. AcmeParser has been licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a bundled parser. Its source files are licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a bundled parser. Its source code is licensed under Apache License 2.0 for non-commercial use only',
      'This project includes a bundled parser. The parser source files are licensed under Apache License 2.0 for non-commercial use only',
      'This project is MIT. The bundled parser uses Apache License 2.0 for non-commercial use only',
      'This project is licensed under the Apache License 2.0. The bundled parser which we integrated long ago and have maintained across dozens of releases spanning several years is provided for non-commercial use only',
      'Apache License 2.0 for non-commercial use only continues to be the license for the bundled parser component',
      'Apache License 2.0 for non-commercial use only (parser dependency)',
      'Licensed under Apache License 2.0 for non-commercial use only (bundled dependency)',
      'This project uses AcmeParser under Apache License 2.0 for non-commercial use only as a parser dependency',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('spdx-expression')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], body).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('does not treat technical phrases starting with license IDs as SPDX conflicts', () => {
    for (const body of [
      'Zlib compression is restricted to internal use',
      'ISC networking code is restricted to internal use',
      'Apache License 2.0 compression is restricted to internal use',
      'Licensed under Apache License 2.0 compression is restricted to internal use',
      'This project uses Apache License 2.0 compression which is restricted to internal use',
      'This project uses Zlib compression which is restricted to internal use',
      'This project uses Zlib compression only for internal data',
      'Licensed under Zlib compression library which is restricted to internal use',
      'This project includes ISC networking code restricted to internal use',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('spdx-expression')
      expect(response.spdxExpression, body).toBe('MIT')
      expect(response.message, body).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], body).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('detects SPDX conflicts in inline and diluted bodies', () => {
    const apache = byId.get('Apache-2.0') || ''
    const mit = byId.get('MIT') || ''
    const mitWithHolder = mit.replace(
      '<year> <copyright holders>',
      '2026 Example Corporation',
    )
    const separator = String.fromCharCode(10, 10)
    const cases = [
      {
        text:
          '/* SPDX-License-Identifier: MIT */ ' + apache.split(/\s+/).join(' '),
        declared: 'MIT',
        expected: 'Apache-2.0',
        confidence: 'Exact',
      },
      {
        text:
          'SPDX-License-Identifier: MIT' +
          separator +
          (byId.get('WTFPL') || ''),
        declared: 'MIT',
        expected: 'WTFPL',
        confidence: 'Exact',
      },
      {
        text: 'SPDX-License-Identifier: Apache-2.0' + separator + mitWithHolder,
        declared: 'Apache-2.0',
        expected: 'MIT',
        confidence: 'Likely',
      },
      {
        text:
          'SPDX-License-Identifier: Apache-2.0' +
          separator +
          mit +
          separator +
          Array.from({ length: 300 }, (_, index) => 'projectword' + index).join(
            ' ',
          ),
        declared: 'Apache-2.0',
        expected: 'MIT',
        confidence: 'Possible',
      },
      {
        text:
          'SPDX-License-Identifier: Apache-2.0' +
          separator +
          mit +
          separator +
          apache,
        declared: 'Apache-2.0',
        expected: 'MIT',
        confidence: 'Possible',
      },
      {
        text:
          'SPDX-License-Identifier: Apache-2.0' +
          separator +
          apache +
          separator +
          mit,
        declared: 'Apache-2.0',
        expected: 'MIT',
        confidence: 'Possible',
      },
    ]

    for (const testCase of cases) {
      const response = rankLicenses(testCase.text, licenses, {
        includeDiffs: false,
      })

      expect(response.inputType, testCase.expected).toBe('mixed-license-text')
      expect(response.spdxExpression, testCase.expected).toBe(testCase.declared)
      expect(response.message, testCase.expected).toContain('conflicts')
      expect(response.results[0], testCase.expected).toMatchObject({
        licenseId: testCase.expected,
        confidence: testCase.confidence,
      })
      expect(
        response.results.some(
          (result) =>
            result.licenseId === testCase.declared &&
            result.confidence === 'Exact',
        ),
        testCase.expected,
      ).toBe(false)
    }
  })

  it('uses body GNU context for SPDX conflicts', () => {
    const separator = String.fromCharCode(10, 10)
    const cases = [
      {
        text:
          'SPDX-License-Identifier: GPL-3.0-only' +
          separator +
          (byId.get('AGPL-3.0-only') || ''),
        expectedPrefix: 'AGPL-3.0-',
      },
      {
        text:
          'SPDX-License-Identifier: GPL-3.0-only' +
          separator +
          (byId.get('LGPL-3.0-only') || ''),
        expectedPrefix: 'LGPL-3.0-',
      },
      {
        text:
          'SPDX-License-Identifier: GPL-2.0-only' +
          separator +
          (byId.get('LGPL-2.1-only') || ''),
        expectedPrefix: 'LGPL-2.1-',
      },
      {
        text:
          'SPDX-License-Identifier: GPL-2.0-only' +
          separator +
          (byId.get('GPL-3.0-only') || ''),
        expectedPrefix: 'GPL-3.0-',
      },
    ]

    for (const testCase of cases) {
      const response = rankLicenses(testCase.text, licenses, {
        includeDiffs: false,
      })

      expect(response.inputType, testCase.expectedPrefix).toBe(
        'mixed-license-text',
      )
      expect(response.message, testCase.expectedPrefix).toContain('conflicts')
      expect(
        response.results[0]?.licenseId.startsWith(testCase.expectedPrefix),
        testCase.expectedPrefix,
      ).toBe(true)
      expect(response.results[0]?.confidence, testCase.expectedPrefix).toBe(
        'Possible',
      )
      expect(
        response.results[0]?.flags.needsManualReview,
        testCase.expectedPrefix,
      ).toBe(true)
    }
  })

  it('does not exempt explicit GNU counterpart notices from SPDX conflicts', () => {
    const separator = String.fromCharCode(10, 10)
    for (const testCase of [
      {
        declared: 'GPL-2.0-only',
        notice: 'GNU General Public License version 2 or later',
        body: byId.get('GPL-2.0-only') || '',
        expected: 'GPL-2.0-or-later',
      },
      {
        declared: 'GPL-2.0-or-later',
        notice: 'GNU General Public License version 2 only',
        body: byId.get('GPL-2.0-only') || '',
        expected: 'GPL-2.0-only',
      },
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: ' +
          testCase.declared +
          separator +
          testCase.notice +
          separator +
          testCase.body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, testCase.expected).toBe('mixed-license-text')
      expect(response.spdxExpression, testCase.expected).toBe(testCase.declared)
      expect(response.message, testCase.expected).toContain('conflicts')
      expect(response.results[0], testCase.expected).toMatchObject({
        licenseId: testCase.expected,
      })
    }
  })

  it('does not return Exact for unsupported compound SPDX expressions', () => {
    expect(
      rankLicenses('SPDX-License-Identifier: MIT OR Not-A-License', licenses),
    ).toMatchObject({
      inputType: 'spdx-expression',
      results: [],
    })
    expect(
      rankLicenses(
        'SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception',
        licenses,
      ),
    ).toMatchObject({
      inputType: 'spdx-expression',
      results: [],
    })
    expect(
      rankLicenses(
        'SPDX-License-Identifier: GPL-2.0-only WITH SHL-2.0',
        licenses,
      ),
    ).toMatchObject({
      inputType: 'spdx-expression',
      results: [],
    })
    expect(
      rankLicenses(
        'SPDX-License-Identifier: DocumentRef-example:LicenseRef-Custom',
        licenses,
      ),
    ).toMatchObject({
      inputType: 'spdx-expression',
      spdxExpression: 'DocumentRef-example:LicenseRef-Custom',
      results: [],
    })
    expect(
      rankLicenses(
        'SPDX-License-Identifier: Classpath-exception-2.0',
        licenses,
      ),
    ).toMatchObject({
      inputType: 'unknown',
      results: [],
    })
    expect(
      rankLicenses(
        'SPDX-License-Identifier: MIT WITH LicenseRef-Custom',
        licenses,
      ),
    ).toMatchObject({
      inputType: 'unknown',
      results: [],
    })
    expect(
      rankLicenses(
        'SPDX-License-Identifier: LicenseRef-Custom+Exception',
        licenses,
      ),
    ).toMatchObject({
      inputType: 'unknown',
      results: [],
    })
    expect(
      rankLicenses(
        'SPDX-License-Identifier: MIT AND Classpath-exception-2.0',
        licenses,
      ),
    ).toMatchObject({
      inputType: 'unknown',
      results: [],
    })
    expect(
      rankLicenses('Apache-2.0 WITH LLVM-exception', licenses),
    ).toMatchObject({
      inputType: 'spdx-expression',
      results: [],
    })
    expect(rankLicenses('(MIT OR Apache-2.0)', licenses)).toMatchObject({
      inputType: 'spdx-expression',
      spdxExpression: '(MIT OR Apache-2.0)',
      results: [],
    })
    expect(
      rankLicenses('MIT AND (Apache-2.0 OR BSD-2-Clause)', licenses),
    ).toMatchObject({
      inputType: 'spdx-expression',
      spdxExpression: 'MIT AND (Apache-2.0 OR BSD-2-Clause)',
      results: [],
    })
  })

  it('parses SPDX expressions in license label values', () => {
    for (const [input, expression] of [
      ['License: MIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['License:\nMIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['# License: MIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['// License: MIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['License-Identifier: MIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['Package: demo\nLicense: MIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['License: MIT\nLicense: MIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['License:\n# comment\nMIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['License:\n/* comment */\nMIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['License:\n/*\ncomment\n*/\nMIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['/* License:\n * MIT OR Apache-2.0\n */', 'MIT OR Apache-2.0'],
      ['License:\n/* comment */ MIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      ['License:\n/* still open\n*/ MIT OR Apache-2.0', 'MIT OR Apache-2.0'],
      [
        '#!/bin/sh\nLicense:\n# comment\nMIT OR Apache-2.0',
        'MIT OR Apache-2.0',
      ],
      ['License: MIT OR Not-A-License', 'MIT OR Not-A-License'],
      ['Project license: MIT AND Apache-2.0', 'MIT AND Apache-2.0'],
      [
        'License identifier\nApache-2.0 WITH LLVM-exception',
        'Apache-2.0 WITH LLVM-exception',
      ],
    ] as const) {
      const response = rankLicenses(input, licenses)

      expect(response.inputType, input).toBe('spdx-expression')
      expect(response.spdxExpression, input).toBe(expression)
      expect(response.results, input).toHaveLength(0)
      expect(response.message, input).toContain('SPDX expressions')
    }
  })

  it('routes unsupported SPDX IDs in license label values to review', () => {
    for (const [input, expression] of [
      ['License: BSD-4-Clause', 'BSD-4-Clause'],
      ['Project license: GPL-1.0-only', 'GPL-1.0-only'],
      ['License:\nBSD-4-Clause', 'BSD-4-Clause'],
      ['License:\n# comment\nGPL-1.0-only', 'GPL-1.0-only'],
      ['/* License:\n * BSD-4-Clause\n */', 'BSD-4-Clause'],
    ] as const) {
      const response = rankLicenses(input, licenses)

      expect(response.inputType, input).toBe('spdx-expression')
      expect(response.spdxExpression, input).toBe(expression)
      expect(response.results, input).toHaveLength(0)
      expect(response.message, input).toContain('unknown SPDX IDs')
    }
  })

  it('scores supported license text after SPDX OR expressions', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT OR Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT OR Apache-2.0')
    expect(response.message).toContain('detected license text separately')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })
  })

  it('checks license label SPDX expressions against body text', () => {
    const declaredBodyResponse = rankLicenses(
      'License: MIT OR Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )
    expect(declaredBodyResponse.inputType).toBe('mixed-license-text')
    expect(declaredBodyResponse.spdxExpression).toBe('MIT OR Apache-2.0')
    expect(declaredBodyResponse.message).toContain(
      'detected license text separately',
    )
    expect(declaredBodyResponse.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })

    const conflictingBodyResponse = rankLicenses(
      'License: MIT OR Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-3-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )
    expect(conflictingBodyResponse.inputType).toBe('mixed-license-text')
    expect(conflictingBodyResponse.spdxExpression).toBe('MIT OR Apache-2.0')
    expect(conflictingBodyResponse.message).toContain('conflicts')
    expect(conflictingBodyResponse.results[0]).toMatchObject({
      licenseId: 'BSD-3-Clause',
      confidence: 'Exact',
    })

    const metadataConflictResponse = rankLicenses(
      'Package: demo' +
        String.fromCharCode(10) +
        'License-Identifier: MIT OR Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-3-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )
    expect(metadataConflictResponse.inputType).toBe('mixed-license-text')
    expect(metadataConflictResponse.spdxExpression).toBe('MIT OR Apache-2.0')
    expect(metadataConflictResponse.message).toContain('conflicts')
    expect(metadataConflictResponse.results[0]).toMatchObject({
      licenseId: 'BSD-3-Clause',
      confidence: 'Exact',
    })

    const thirdPartyFullBodyResponse = rankLicenses(
      'License: MIT OR Apache-2.0' +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-3-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )
    expect(thirdPartyFullBodyResponse.inputType).toBe('spdx-expression')
    expect(thirdPartyFullBodyResponse.spdxExpression).toBe('MIT OR Apache-2.0')
    expect(thirdPartyFullBodyResponse.message).toContain('SPDX expressions')
    expect(thirdPartyFullBodyResponse.results).toHaveLength(0)

    const thirdPartyBlankLineResponse = rankLicenses(
      'Third-party dependencies:' +
        String.fromCharCode(10, 10) +
        'License: MIT OR Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-3-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )
    expect(thirdPartyBlankLineResponse.inputType).toBe('mixed-license-text')
    expect(thirdPartyBlankLineResponse.spdxExpression).toBeUndefined()
    expect(thirdPartyBlankLineResponse.message).not.toContain('conflicts')
    expect(thirdPartyBlankLineResponse.results[0]).toMatchObject({
      licenseId: 'BSD-3-Clause',
      confidence: 'Likely',
    })

    const thirdPartyLabelResponse = rankLicenses(
      'Third-party dependencies:' +
        String.fromCharCode(10) +
        'License: MIT OR Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-3-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )
    expect(thirdPartyLabelResponse.inputType).toBe('mixed-license-text')
    expect(thirdPartyLabelResponse.spdxExpression).toBeUndefined()
    expect(thirdPartyLabelResponse.message).not.toContain('conflicts')
    expect(thirdPartyLabelResponse.results[0]).toMatchObject({
      licenseId: 'BSD-3-Clause',
      confidence: 'Likely',
    })

    const scopedAwayCompoundLabelResponse = rankLicenses(
      'License: MIT OR Apache-2.0' +
        String.fromCharCode(10) +
        'for docs only' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-3-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )
    expect(scopedAwayCompoundLabelResponse.inputType).toBe('mixed-license-text')
    expect(scopedAwayCompoundLabelResponse.spdxExpression).toBeUndefined()
    expect(scopedAwayCompoundLabelResponse.message).not.toContain('conflicts')
    expect(scopedAwayCompoundLabelResponse.results[0]).toMatchObject({
      licenseId: 'BSD-3-Clause',
      confidence: 'Likely',
    })

    const scopedAwayMalformedLabelResponse = rankLicenses(
      'License: MIT, Apache-2.0' +
        String.fromCharCode(10) +
        'for docs only' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-3-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )
    expect(scopedAwayMalformedLabelResponse.inputType).toBe(
      'mixed-license-text',
    )
    expect(scopedAwayMalformedLabelResponse.message).not.toContain(
      'without AND/OR',
    )
    expect(scopedAwayMalformedLabelResponse.results[0]).toMatchObject({
      licenseId: 'BSD-3-Clause',
      confidence: 'Likely',
    })

    const scopedAwayCommentGapResponse = rankLicenses(
      'License:' +
        String.fromCharCode(10) +
        '# for docs only' +
        String.fromCharCode(10) +
        'MIT OR Apache-2.0',
      licenses,
      { includeDiffs: false },
    )
    expect(scopedAwayCommentGapResponse.inputType).toBe('unknown')
    expect(scopedAwayCommentGapResponse.spdxExpression).toBeUndefined()
    expect(scopedAwayCommentGapResponse.results).toHaveLength(0)
  })

  it('rejects non-Apache license headers with official-looking date tails', () => {
    for (const input of [
      'Licensed under MIT License 1 January 2004',
      'Licensed under GPL v2 January 2004',
      'Licensed under Apache License, Version 2.0, February 2025',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.results, input).toHaveLength(0)
      expect(response.message, input).toContain('Unknown')
    }
  })

  it('rejects malformed SPDX ID lists that include only one body license', () => {
    for (const expression of [
      'MIT, Apache-2.0',
      'MIT; Apache-2.0',
      'MIT / Apache-2.0',
      'MIT, Apache-2.0; internal note',
      'MIT; Apache-2.0; internal note',
    ]) {
      const response = rankLicenses(
        `SPDX-License-Identifier: ${expression}` +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, expression).toBe('mixed-license-text')
      expect(response.message, expression).toContain(
        'Malformed SPDX identifier lists multiple licenses',
      )
      expect(response.results, expression).toHaveLength(0)
    }

    for (const expression of [
      'MIT, Apache-2.0',
      'MIT / Apache-2.0',
      String.fromCharCode(10) + 'MIT, Apache-2.0',
    ]) {
      const response = rankLicenses(
        `License: ${expression}` +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, expression).toBe('mixed-license-text')
      expect(response.message, expression).toContain(
        'License label lists multiple licenses without AND/OR; detected license text separately.',
      )
      expect(
        response.results.map((result) => result.licenseId),
        expression,
      ).toContain('MIT')
    }

    const allDeclaredBodyResponse = rankLicenses(
      'License: MIT, Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(allDeclaredBodyResponse.inputType).toBe('mixed-license-text')
    expect(allDeclaredBodyResponse.message).not.toContain('Unknown')
    expect(allDeclaredBodyResponse.message).not.toContain('without AND/OR')
    expect(
      allDeclaredBodyResponse.results.map((result) => result.licenseId),
    ).toEqual(expect.arrayContaining(['MIT', 'Apache-2.0']))

    const allSlashDeclaredBodyResponse = rankLicenses(
      'License: MIT / Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(allSlashDeclaredBodyResponse.inputType).toBe('mixed-license-text')
    expect(allSlashDeclaredBodyResponse.message).not.toContain('Unknown')
    expect(allSlashDeclaredBodyResponse.message).not.toContain('without AND/OR')
    expect(
      allSlashDeclaredBodyResponse.results.map((result) => result.licenseId),
    ).toEqual(expect.arrayContaining(['MIT', 'Apache-2.0']))

    const legacyAliasResponse = rankLicenses(
      'SPDX-License-Identifier: GPL-2.0, MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(legacyAliasResponse.inputType).toBe('mixed-license-text')
    expect(legacyAliasResponse.message).toContain(
      'Malformed SPDX identifier lists multiple licenses',
    )
    expect(legacyAliasResponse.results).toHaveLength(0)
  })

  it('does not treat duplicate legacy aliases as malformed multi-ID SPDX lists', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: GPL-2.0, GPL-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('GPL-2.0-only') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).not.toContain(
      'Malformed SPDX identifier lists multiple licenses',
    )
    expect(
      response.results.some((result) => result.licenseId === 'GPL-2.0-only'),
    ).toBe(true)
  })

  it('does not report conflicts for malformed lowercase SPDX expressions that include the body license', () => {
    for (const expression of ['Apache-2.0 or MIT!', 'Apache-2.0 and MIT!']) {
      const response = rankLicenses(
        `SPDX-License-Identifier: ${expression}` +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, expression).toBe('mixed-license-text')
      expect(response.message, expression).toContain('ignored')
      expect(response.message, expression).not.toContain('conflicts')
      expect(response.results[0], expression).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('does not treat lowercase SPDX ID suffixes as SPDX operators', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: GPL-2.0-or-later MIT!' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })
  })

  it('keeps body matches after unknown SPDX identifiers under manual review', () => {
    for (const expression of [
      'Foo-Bar',
      'LicenseRef-Proprietary',
      'DocumentRef-example:LicenseRef-Custom',
    ]) {
      const response = rankLicenses(
        `SPDX-License-Identifier: ${expression}` +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, expression).toBe('mixed-license-text')
      expect(response.spdxExpression, expression).toBe(expression)
      expect(response.message, expression).toContain(
        'detected license text separately',
      )
      expect(response.results[0], expression).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Possible',
        flags: { needsManualReview: true },
      })
      expect(response.results[0]?.explanation, expression).toContain(
        'unsupported IDs',
      )
    }
  })

  it('keeps supported SPDX OR alternatives when prose negates another option', () => {
    for (const [negatedLicense, bodyLicense, expectedConfidence] of [
      ['MIT', 'Apache-2.0', 'Exact'],
      ['Apache-2.0', 'MIT', 'Likely'],
    ] as const) {
      const response = rankLicenses(
        `SPDX-License-Identifier: MIT OR Apache-2.0` +
          String.fromCharCode(10, 10) +
          `This project is not licensed under ${negatedLicense}.` +
          String.fromCharCode(10, 10) +
          (byId.get(bodyLicense) || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, bodyLicense).toBe('mixed-license-text')
      expect(response.spdxExpression, bodyLicense).toBe('MIT OR Apache-2.0')
      expect(response.message, bodyLicense).toContain(
        'detected license text separately',
      )
      expect(response.results[0], bodyLicense).toMatchObject({
        licenseId: bodyLicense,
        confidence: expectedConfidence,
      })
    }
  })

  it('rejects SPDX AND expressions when prose negates one declared license', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT AND Apache-2.0' +
        String.fromCharCode(10, 10) +
        'This project is not licensed under MIT.' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT AND Apache-2.0')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('restrictive license text')
  })

  it('does not treat GNU or-later SPDX IDs as OR alternatives when negated', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: GPL-2.0-or-later' +
        String.fromCharCode(10, 10) +
        'This project is not licensed under GPL-2.0-or-later.' +
        String.fromCharCode(10, 10) +
        (byId.get('GPL-2.0-or-later') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('GPL-2.0-or-later')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('restrictive license text')
  })

  it('keeps supported SPDX OR alternatives when third-party prose negates another option', () => {
    for (const [negatedLicense, bodyLicense, expectedConfidence] of [
      ['MIT', 'Apache-2.0', 'Exact'],
      ['Apache-2.0', 'MIT', 'Likely'],
    ] as const) {
      const response = rankLicenses(
        `SPDX-License-Identifier: MIT OR Apache-2.0` +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10) +
          `This library is not licensed under ${negatedLicense}.` +
          String.fromCharCode(10, 10) +
          (byId.get(bodyLicense) || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, bodyLicense).toBe('mixed-license-text')
      expect(response.spdxExpression, bodyLicense).toBe('MIT OR Apache-2.0')
      expect(response.message, bodyLicense).toContain(
        'detected license text separately',
      )
      expect(response.results[0], bodyLicense).toMatchObject({
        licenseId: bodyLicense,
        confidence: expectedConfidence,
      })
    }
  })

  it('keeps supported SPDX OR alternatives when third-party prose has a generic license negation', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT OR Apache-2.0' +
        String.fromCharCode(10, 10) +
        'This library is not licensed under any open source license.' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT OR Apache-2.0')
    expect(response.message).toContain('detected license text separately')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Exact',
    })
  })

  it('does not treat multiple supported bodies after unknown SPDX identifiers as restrictive', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: Foo-Bar' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        (byId.get('GPL-3.0-only') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('Foo-Bar')
    expect(response.message).toContain('detected license text separately')
    expect(response.results.length).toBeGreaterThan(0)
    expect(
      response.results.some((result) =>
        ['MIT', 'GPL-3.0-only'].includes(result.licenseId),
      ),
    ).toBe(true)
  })

  it('does not return body matches after unknown SPDX identifiers with restrictive tails', () => {
    for (const tail of [
      'All rights reserved. Redistribution prohibited.',
      'Redistribution and use in source and binary forms are prohibited.',
      'Copyright 2024. Redistribution and use in source and binary forms are prohibited. All rights reserved.',
      'This component is proprietary.',
      'No permission is granted to use, copy, modify, or distribute this software.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: Foo-Bar' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || '') +
          String.fromCharCode(10, 10) +
          tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.spdxExpression, tail).toBe('Foo-Bar')
      expect(response.message, tail).toContain('restrictive license text')
      expect(response.results, tail).toHaveLength(0)
    }
  })

  it('keeps body matches after unknown SPDX identifiers with negated prohibitions', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: Foo-Bar' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        'Redistribution is not prohibited.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('Foo-Bar')
    expect(response.message).toContain('detected license text separately')
    expect(response.results.some((result) => result.licenseId === 'MIT')).toBe(
      true,
    )
  })

  it('returns conflicting body matches after unsupported SPDX expressions', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT OR Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('GPL-3.0-only') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT OR Apache-2.0')
    expect(response.message).toContain('detected license text')
    expect(response.results[0]?.licenseId).toBe('GPL-3.0-only')
  })
  it('does not return body matches after unsupported SPDX expressions with restrictive tails', () => {
    for (const tail of [
      'This package is proprietary.',
      'This product is proprietary.',
      'Do not redistribute',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT OR Apache-2.0' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || '') +
          String.fromCharCode(10, 10) +
          tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.spdxExpression, tail).toBe('MIT OR Apache-2.0')
      expect(response.message, tail).toContain('restrictive license text')
      expect(response.results, tail).toHaveLength(0)
    }
  })

  it('treats legacy SPDX IDs as aliases requiring review', () => {
    const response = rankLicenses('SPDX-License-Identifier: GPL-2.0', licenses)
    expect(response.legacyAlias?.legacyId).toBe('GPL-2.0')
    expect(response.results.map((result) => result.licenseId)).toEqual([
      'GPL-2.0-only',
      'GPL-2.0-or-later',
    ])
    expect(
      response.results.every((result) => result.flags.needsManualReview),
    ).toBe(true)
    expect(
      response.results.every(
        (result) =>
          result.score.f1 === 0 &&
          result.score.precision === 0 &&
          result.score.recall === 0,
      ),
    ).toBe(true)
  })

  it('treats equivalent legacy body declarations as declared SPDX IDs', () => {
    for (const testCase of [
      {
        declared: 'GPL-2.0-or-later',
        bodyDeclaration: 'License: GPL-2.0+',
      },
      {
        declared: 'GPL-2.0-only',
        bodyDeclaration: 'License: GPL-2.0',
      },
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: ' +
          testCase.declared +
          String.fromCharCode(10, 10) +
          testCase.bodyDeclaration,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, testCase.declared).toBe('spdx-expression')
      expect(response.spdxExpression, testCase.declared).toBe(testCase.declared)
      expect(response.message, testCase.declared).not.toContain('conflicts')
      expect(
        response.results.some(
          (result) => result.licenseId === testCase.declared,
        ),
        testCase.declared,
      ).toBe(true)
    }
  })

  it('lets conflicting full bodies override legacy SPDX aliases', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: GPL-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.legacyAlias?.legacyId).toBe('GPL-2.0')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Exact',
      flags: { needsManualReview: false },
    })
  })

  it('lets conflicting full bodies override malformed legacy SPDX aliases', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: GPL-2.0 Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.legacyAlias).toBeUndefined()
    expect(response.message).toContain('conflicts')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Apache-2.0',
      confidence: 'Exact',
      flags: { needsManualReview: false },
    })
  })

  it('adds diff details to conflicting SPDX body results', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      'SPDX-License-Identifier: GPL-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      'SPDX-License-Identifier: MIT Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      'MIT' + String.fromCharCode(10, 10) + (byId.get('Apache-2.0') || ''),
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: true })
      const result = response.results[0]
      const lazyResponse = rankLicenses(input, licenses, {
        includeDiffs: false,
      })
      const lazyResult = lazyResponse.results[0]

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.message, input).toContain('conflicts')
      expect(result?.licenseId, input).toBe('Apache-2.0')
      expect(result?.diff, input).toBeTruthy()
      expect(result?.diffSegments?.length, input).toBeGreaterThan(0)
      expect(lazyResult?.licenseId, input).toBe(result?.licenseId)
      expect(diffForResult(input, lazyResult, licenses), input).toBe(
        result?.diff,
      )
      expect(diffSegmentsForResult(input, lazyResult, licenses), input).toEqual(
        result?.diffSegments,
      )
      const spreadLazyResult = lazyResult ? { ...lazyResult } : lazyResult
      expect(diffForResult(input, spreadLazyResult, licenses), input).toBe(
        result?.diff,
      )
    }
  })

  it('loads lazy diff details from project body for third-party SPDX conflicts', () => {
    const input =
      'SPDX-License-Identifier: MIT' +
      String.fromCharCode(10, 10) +
      'Third-party notices' +
      String.fromCharCode(10, 10) +
      (byId.get('Apache-2.0') || '') +
      String.fromCharCode(10, 10) +
      'Project license' +
      String.fromCharCode(10, 10) +
      (byId.get('BSD-2-Clause') || '')
    const response = rankLicenses(input, licenses, { includeDiffs: true })
    const result = response.results[0]
    const lazyResponse = rankLicenses(input, licenses, { includeDiffs: false })
    const lazyResult = lazyResponse.results[0]

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('conflicts')
    expect(result?.licenseId).toBe('BSD-2-Clause')
    expect(lazyResult?.licenseId).toBe(result?.licenseId)
    expect(diffForResult(input, lazyResult, licenses)).toBe(result?.diff)
    expect(diffSegmentsForResult(input, lazyResult, licenses)).toEqual(
      result?.diffSegments,
    )
  })

  it('loads lazy diff details from project body after scoped-away license labels', () => {
    const input =
      'License: MIT OR Apache-2.0' +
      String.fromCharCode(10) +
      'for docs only' +
      String.fromCharCode(10, 10) +
      (byId.get('BSD-3-Clause') || '')
    const response = rankLicenses(input, licenses, { includeDiffs: true })
    const result = response.results[0]
    const lazyResponse = rankLicenses(input, licenses, { includeDiffs: false })
    const lazyResult = lazyResponse.results[0]

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('ranked by shingle F1 score')
    expect(result?.licenseId).toBe('BSD-3-Clause')
    expect(result?.diff).toBeTruthy()
    expect(result?.diff).not.toContain('License:')
    expect(lazyResult?.licenseId).toBe(result?.licenseId)
    expect(diffForResult(input, lazyResult, licenses)).toBe(result?.diff)
    expect(diffSegmentsForResult(input, lazyResult, licenses)).toEqual(
      result?.diffSegments,
    )
  })

  it('checks CR-only SPDX body text for conflicts', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(13) +
        (byId.get('GPL-3.0-only') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]?.licenseId).toBe('GPL-3.0-only')
  })

  it('does not suppress embedded GNU bodies as declared SPDX noise', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        (byId.get('GPL-3.0-only') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]?.licenseId).toBe('GPL-3.0-only')
  })
  const ambiguousGnuCounterpartCases = [
    { declared: 'GPL-2.0-or-later', bodyId: 'GPL-2.0-only' },
    { declared: 'GPL-3.0-or-later', bodyId: 'GPL-3.0-only' },
    { declared: 'AGPL-3.0-or-later', bodyId: 'AGPL-3.0-only' },
    { declared: 'LGPL-2.1-or-later', bodyId: 'LGPL-2.1-only' },
    { declared: 'LGPL-3.0-or-later', bodyId: 'LGPL-3.0-only' },
    { declared: 'GPL-2.0-only', bodyId: 'GPL-2.0-or-later' },
    { declared: 'GPL-3.0-only', bodyId: 'GPL-3.0-or-later' },
    { declared: 'AGPL-3.0-only', bodyId: 'AGPL-3.0-or-later' },
    { declared: 'LGPL-2.1-only', bodyId: 'LGPL-2.1-or-later' },
    { declared: 'LGPL-3.0-only', bodyId: 'LGPL-3.0-or-later' },
  ]

  for (const testCase of ambiguousGnuCounterpartCases) {
    it(`does not treat ${testCase.bodyId} body as a conflict for ${testCase.declared}`, () => {
      const separator = String.fromCharCode(10, 10)
      const response = rankLicenses(
        'SPDX-License-Identifier: ' +
          testCase.declared +
          separator +
          (byId.get(testCase.bodyId) || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, testCase.declared).toBe('spdx-expression')
      expect(response.spdxExpression, testCase.declared).toBe(testCase.declared)
      expect(response.message, testCase.declared).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0], testCase.declared).toMatchObject({
        licenseId: testCase.declared,
        confidence: 'Exact',
      })
    })
  }

  it('maps plus-form legacy GNU IDs to or-later candidates', () => {
    const response = rankLicenses('SPDX-License-Identifier: GPL-2.0+', licenses)
    expect(response.inputType).toBe('spdx-expression')
    expect(response.legacyAlias?.legacyId).toBe('GPL-2.0+')
    expect(response.results.map((result) => result.licenseId)).toEqual([
      'GPL-2.0-or-later',
    ])
    expect(
      response.results.every(
        (result) =>
          result.flags.isLegacyId &&
          result.flags.needsManualReview &&
          result.score.f1 === 0 &&
          result.score.precision === 0 &&
          result.score.recall === 0,
      ),
    ).toBe(true)
  })

  it('keeps tiny notice overlaps at possible confidence', () => {
    const response = rankLicenses(
      'Copyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.',
      licenses,
      { includeDiffs: false },
    )
    expect(response.inputType).toBe('license-notice')
    expect(response.results.length).toBeGreaterThan(0)
    expect(
      response.results.every((result) => result.confidence !== 'Likely'),
    ).toBe(true)
    expect(response.results[0]?.confidence).toBe('Possible')
  })

  it('does not hard-guess unrelated text', () => {
    const response = rankLicenses(randomText, licenses)
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('Unknown')
  })

  it('returns unknown for repeated unknown license headers', () => {
    const chunk = 'not licensed under foo '
    const input = chunk.repeat(Math.floor((1024 * 1024) / chunk.length))
    const response = rankLicenses(input, licenses, { includeDiffs: false })

    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('Unknown')
  })

  it('keeps negated named headers bounded to recent context', () => {
    const filler = 'released or distributed '.repeat(2_000)
    const input = filler + 'This project is not licensed under MIT.'

    expectNoExactOrLikelyLicense(input, 'MIT')
  })

  it('keeps high-scoring short-license variants even when classification is unknown', () => {
    const zlib = byId.get('Zlib') || ''
    const variant = zlib
      .replace('zlib License\n\n', '')
      .replace('This software is provided', 'The Example package is provided')
    const response = rankLicenses(variant, licenses, { includeDiffs: false })
    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results[0]).toMatchObject({
      licenseId: 'Zlib',
      confidence: 'Likely',
    })
  })

  it('keeps precision-qualified unknown matches when the top F1 result is imprecise', () => {
    const input =
      'Copyright (c) 2026 Example\n\n' +
      'Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\n' +
      'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.'
    const response = rankLicenses(input, licenses, { includeDiffs: false })

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results.some((result) => result.licenseId === 'ISC')).toBe(
      true,
    )
  })

  it('surfaces full license texts embedded in long context', () => {
    const input =
      (byId.get('MIT') || '') +
      '\n\n' +
      Array.from({ length: 300 }, (_, index) => 'projectword' + index).join(' ')
    const response = rankLicenses(input, licenses, { includeDiffs: false })

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Possible',
    })
  })

  it('keeps GNU full licenses ambiguous when embedded in long context', () => {
    const input =
      (byId.get('GPL-3.0-only') || '') +
      String.fromCharCode(10, 10) +
      Array.from({ length: 300 }, (_, index) => 'projectword' + index).join(' ')
    const response = rankLicenses(input, licenses, { includeDiffs: false })

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results[0]?.licenseId).toMatch(/^GPL-3.0-/)
    expect(response.results[0]?.confidence).toBe('Possible')
    expect(response.results[0]?.flags.needsManualReview).toBe(true)
    expect(
      response.results.some(
        (result) =>
          result.licenseId.startsWith('GPL-3.0-') &&
          !result.flags.needsManualReview,
      ),
    ).toBe(false)
  })

  it('keeps GNU full licenses ambiguous when they conflict with SPDX headers', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('GPL-3.0-only') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT')
    expect(response.message).toContain('conflicts')
    expect(response.results[0]?.licenseId).toMatch(/^GPL-3.0-/)
    expect(response.results[0]?.confidence).toBe('Possible')
    expect(response.results[0]?.flags.needsManualReview).toBe(true)
    expect(
      response.results.some(
        (result) =>
          result.licenseId.startsWith('GPL-3.0-') &&
          !result.flags.needsManualReview,
      ),
    ).toBe(false)
  })

  it('shows diffs for near-exact full text changes', () => {
    const gpl = byId.get('GPL-3.0-only') || ''
    const changed = gpl.replace(
      'freedom to share and change',
      'freedom to share and inspect',
    )
    const response = rankLicenses(changed, licenses)
    const gplResult = response.results.find(
      (result) => result.licenseId === 'GPL-3.0-only',
    )
    if (!gplResult) throw new Error('Expected GPL-3.0-only result')
    expect(gplResult.diff).toBeTruthy()
    expect(
      gplResult.diffSegments?.some((segment) => segment.type === 'insert'),
    ).toBe(true)
    expect(
      gplResult.diffSegments?.some((segment) => segment.type === 'delete'),
    ).toBe(true)
    expect(gplResult.diff).not.toBe(
      'No material differences after normalization.',
    )
  })

  it('shows late diffs for near-exact long text changes', () => {
    const gpl = byId.get('GPL-3.0-only') || ''
    const changed = gpl.replace(
      'You should also get your employer',
      'You should also get your organization',
    )
    const response = rankLicenses(changed, licenses)
    const gplResult = response.results.find(
      (result) => result.licenseId === 'GPL-3.0-only',
    )
    if (!gplResult) throw new Error('Expected GPL-3.0-only result')
    expect(gplResult.diff).toContain('organization')
    expect(gplResult.diff).toContain('employer')
    expect(
      gplResult.diffSegments?.map((segment) => segment.text).join(' '),
    ).toContain('organization')
    expect(
      gplResult.diffSegments?.map((segment) => segment.text).join(' '),
    ).toContain('employer')
  })

  it('limits structured diff summaries to the display budget', () => {
    const mit = byId.get('MIT') || ''
    const changed = mit.replace(
      'Permission is hereby granted',
      'X'.repeat(5000) + ' Permission is hereby granted',
    )
    const response = rankLicenses(changed, licenses)
    const mitResult = response.results.find(
      (result) => result.licenseId === 'MIT',
    )
    if (!mitResult) throw new Error('Expected MIT result')

    const displayLength = (mitResult.diffSegments || []).reduce(
      (sum, segment, index) =>
        sum +
        segment.text.length +
        (segment.type === 'equal' ? 0 : 2) +
        (index === 0 ? 0 : 1),
      0,
    )
    expect(displayLength).toBeLessThanOrEqual(2000)
    expect(
      mitResult.diffSegments?.map((segment) => segment.text).join(''),
    ).not.toContain('X'.repeat(5000))
  })

  it('does not split astral characters when truncating diff summaries', () => {
    const emoji = '😀'
    const segments = explainNormalizedDiffSegments(
      'a',
      'x' + emoji.repeat(2500) + 'a',
    )
    const formatted = formatDiffSegments(segments)

    expect(hasUnpairedSurrogate(formatted)).toBe(false)
    expect(segments.some((segment) => hasUnpairedSurrogate(segment.text))).toBe(
      false,
    )
  })

  it('does not drop later edits before applying the diff summary budget', () => {
    const left =
      Array.from({ length: 90 }, (_value, index) => `s${index} a${index}`).join(
        ' ',
      ) + ' finalold'
    const right =
      Array.from({ length: 90 }, (_value, index) => `s${index} b${index}`).join(
        ' ',
      ) + ' finalnew'
    const formatted = formatDiffSegments(
      explainNormalizedDiffSegments(left, right),
    )

    expect(formatted).toMatch(/final\s+- old\s+\+ new/)
  })

  it('uses code points for the large diff summary guard', () => {
    const emojiText = '😀'.repeat(60_001)

    expect(
      explainNormalizedDiffSegments(emojiText, emojiText)[0]?.text,
    ).not.toBe('Diff summary disabled for large inputs.')
  })

  it('skips expensive diff summaries for large inputs', () => {
    const mitResult = rankLicenses(
      byId.get('MIT') || '',
      licenses,
    ).results.find((result) => result.licenseId === 'MIT')
    if (!mitResult) throw new Error('Expected MIT result')

    expect(diffForResult('x'.repeat(120_001), mitResult, licenses)).toBe(
      'Diff summary disabled for large inputs.',
    )
  })

  it('ignores unrelated later-version prose after GNU version-only notices', () => {
    const cases = [
      'This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License version 2 only. The documentation may be updated in any later version of this package.',
      'This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License version 2 only while documentation may be updated in any later version of this package.',
      'This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License version 2 only, although the manual ships in this or any later version of the docs.',
    ]

    for (const input of cases) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })
      expect(response.results[0]?.licenseId, input).toBe('GPL-2.0-only')
      expect(response.results[0]?.flags.needsManualReview, input).toBe(false)
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'GPL-2.0-or-later' &&
            !result.flags.needsManualReview,
        ),
        input,
      ).toBe(false)
    }
  })

  it(
    'does not let third-party GNU mentions suppress full license bodies',
    { timeout: 30_000 },
    () => {
      for (const mention of [
        'The bundled dependency uses the GNU Lesser General Public License version 2.1.',
        'The bundled dependency that uses the GNU Lesser General Public License version 2.1 is documented separately.',
        'The bundled library which is licensed under the GNU Lesser General Public License version 2.1 is documented separately.',
        'The bundled library which is licenced under the GNU Lesser General Public License version 2.1 is documented separately.',
        'The bundled dependency is licensed under the terms of the GNU Lesser General Public License version 2.1.',
        'The bundled font uses the GNU Lesser General Public License version 2.1.',
        'The bundled SDK uses the GNU Lesser General Public License version 2.1.',
        'The bundled framework uses the GNU Lesser General Public License version 2.1.',
        'The bundled service uses the GNU Lesser General Public License version 2.1.',
        'The bundled dependency uses the popular GNU Lesser General Public License version 2.1.',
        'The bundled code uses the GNU Lesser General Public License version 2.1.',
        'The bundled binary uses the GNU Lesser General Public License version 2.1.',
        'The bundled file uses the GNU Lesser General Public License version 2.1.',
        'The bundled work uses the GNU Lesser General Public License version 2.1.',
        'The bundled portion uses the GNU Lesser General Public License version 2.1.',
        'The bundled artifact uses the GNU Lesser General Public License version 2.1.',
        'The dependency from our vendor compliance list included in this release artifact is licensed under the GNU Lesser General Public License version 2.1.',
        'The bundled product is licensed under the GNU Lesser General Public License version 2.1.',
        'The included application is licensed under the GNU Lesser General Public License version 2.1.',
        'The bundled dependency that utilizes the GNU Lesser General Public License version 2.1 is documented separately.',
        'The bundled dependency incorporates the GNU Lesser General Public License version 2.1.',
        'The bundled dependency is subject to the terms of the GNU Lesser General Public License version 2.1.',
        'The bundled dependency is licensed under terms of the GNU Lesser General Public License version 2.1.',
        'Bundled with the GNU Lesser General Public License version 2.1.',
        'This distribution includes the GNU Lesser General Public License version 2.1.',
        'This package is shipped with the GNU Lesser General Public License version 2.1.',
      ]) {
        const response = rankLicenses(
          mention +
            String.fromCharCode(10, 10) +
            (byId.get('GPL-3.0-only') || ''),
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, mention).toBe('full-license-text')
        expect(response.results[0]?.licenseId, mention).toBe('GPL-3.0-only')
        expect(response.results[0]?.confidence, mention).not.toBe('Unknown')
      }
    },
  )

  it('orders mixed-license text by score instead of precision-only confidence', () => {
    const mit0 = byId.get('MIT-0') || ''
    const variant = mit0.split(/\s+/).slice(20, 100).join(' ')
    const response = rankLicenses(variant, licenses, { includeDiffs: false })
    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results[0]?.licenseId).toBe('MIT-0')
    expect(response.results[0]?.confidence).not.toBe('Unknown')
  })

  it('rejects restrictive SPDX tails', () => {
    for (const tail of [
      'Do not redistribute',
      'This source file is proprietary.',
      'This project is not licensed under MIT.',
      'No part of this project is MIT licensed.',
      'No part of this project is licensed under MIT.',
      'This source file is not licensed under any open source license.',
      'This tool is proprietary.',
      'The tool is proprietary.',
      'The parser is proprietary.',
      'This project is confidential.',
      'Confidential and proprietary.',
      'This project is for internal use only.',
      'This project is for internal use cases only.',
      'This project is for internal usage cases only.',
      'Private use only.',
      'For internal use cases only.',
      'For internal usage cases only.',
      'For nonprofit use only.',
      'For non-profit use only.',
      'For non profit use only.',
      'For educational use only.',
      'Academic use only.',
      'Research use only.',
      'This project is proprietary.' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.results, tail).toHaveLength(0)
      expect(response.message, tail).toContain('conflicts')
    }
  })

  it('rejects restrictive same-line SPDX tails', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT for internal use only',
      'SPDX-License-Identifier: MIT for commercial license only',
      'SPDX-License-Identifier: MIT for documentation license only',
      'SPDX-License-Identifier: MIT for non commercial license only',
      'SPDX-License-Identifier: MIT; internal use only',
      'SPDX-License-Identifier: MIT; commercial license only',
      'SPDX-License-Identifier: MIT; documentation license only',
      'SPDX-License-Identifier: MIT; non commercial license only',
      'SPDX-License-Identifier: MIT; INTERNAL USE ONLY',
      'SPDX-License-Identifier: MIT; private use only',
      'SPDX-License-Identifier: MIT; SSPL-1.0 for internal use only',
      'SPDX-License-Identifier: MIT; Apache-2.0 SSPL-1.0 for internal use only',
      'SPDX-License-Identifier: MIT; LicenseRef-Proprietary for internal use only',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.results, input).toHaveLength(0)
      expect(response.message, input).toContain('conflicts')
    }
  })

  it('rejects restrictive same-line SPDX tails before full bodies', () => {
    for (const prefix of [
      'SPDX-License-Identifier: MIT for internal use only',
      'SPDX-License-Identifier: MIT Apache-2.0 for internal use only',
      'SPDX-License-Identifier: MIT; This project is proprietary.',
    ]) {
      const response = rankLicenses(
        prefix + String.fromCharCode(10, 10) + (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('mixed-license-text')
      expect(response.results, prefix).toHaveLength(0)
      expect(response.message, prefix).toContain('conflicts')
    }
  })

  it('does not treat standalone SPDX exceptions as body license declarations', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'License: Classpath-exception-2.0',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('spdx-expression')
    expect(response.message).not.toContain('conflicts')
    expect(response.results[0]?.licenseId).toBe('MIT')
  })

  it('ignores benign SPDX annotation tails after known IDs', () => {
    for (const [input, licenseId] of [
      ['SPDX-License-Identifier: MIT License', 'MIT'],
      ['SPDX-License-Identifier: MIT (MIT License)', 'MIT'],
      ['SPDX-License-Identifier: MIT (The MIT License)', 'MIT'],
      ['/* SPDX-License-Identifier: MIT (MIT License) */', 'MIT'],
      ['/*\n * SPDX-License-Identifier: MIT (MIT License) */', 'MIT'],
      ['<!-- SPDX-License-Identifier: MIT (MIT License) -->', 'MIT'],
      ['SPDX-License-Identifier: Apache-2.0 (Apache License)', 'Apache-2.0'],
      [
        'SPDX-License-Identifier: Apache-2.0 (The Apache License 2.0)',
        'Apache-2.0',
      ],
      ['SPDX-License-Identifier: CC0-1.0 (public domain)', 'CC0-1.0'],
      ['SPDX-License-Identifier: ISC (The ISC License)', 'ISC'],
      ['SPDX-License-Identifier: WTFPL (WTFPL License)', 'WTFPL'],
    ] as const) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('spdx-expression')
      expect(response.message, input).toContain(
        'SPDX license identifier detected',
      )
      expect(response.results[0]?.licenseId, input).toBe(licenseId)
      expect(response.results[0]?.confidence, input).toBe('Exact')
    }
  })

  it('does not ignore restrictive SPDX annotation tails after known IDs', () => {
    for (const [input, inputType, message] of [
      [
        'SPDX-License-Identifier: MIT (commercial license only)',
        'mixed-license-text',
        'restrictive license text',
      ],
      [
        'SPDX-License-Identifier: MIT (internal license only)',
        'mixed-license-text',
        'restrictive license text',
      ],
      [
        'SPDX-License-Identifier: MIT (documentation license only)',
        'mixed-license-text',
        'restrictive license text',
      ],
      [
        'SPDX-License-Identifier: MIT (proprietary license)',
        'unknown',
        'Unknown',
      ],
      [
        'SPDX-License-Identifier: MIT (license for internal use only)',
        'unknown',
        'Unknown',
      ],
    ] as const) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe(inputType)
      expect(response.results, input).toHaveLength(0)
      expect(response.message, input).toContain(message)
    }
  })

  it('does not ignore mismatched SPDX annotation tails after known IDs', () => {
    for (const [input, declaredId] of [
      ['SPDX-License-Identifier: MIT (Apache License)', 'MIT'],
      ['SPDX-License-Identifier: Apache-2.0 (MIT License)', 'Apache-2.0'],
      ['SPDX-License-Identifier: Apache-2.0 (Apache)', 'Apache-2.0'],
      ['SPDX-License-Identifier: MIT (public domain)', 'MIT'],
      ['SPDX-License-Identifier: MIT License (public domain)', 'MIT'],
      ['SPDX-License-Identifier: MIT License (Apache License)', 'MIT'],
    ] as const) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).not.toBe('spdx-expression')
      expect(response.spdxExpression, input).toBeUndefined()
      expect(
        response.results.some(
          (result) =>
            result.licenseId === declaredId && result.confidence === 'Exact',
        ),
        input,
      ).toBe(false)
      expect(response.message, input).toMatch(/Unknown|conflicts/)
    }
  })

  it('checks conflicts after benign SPDX annotation tails', () => {
    for (const [input, licenseId] of [
      [
        'SPDX-License-Identifier: MIT (MIT License)\nApache License 2.0',
        'Apache-2.0',
      ],
      [
        'SPDX-License-Identifier: MIT License (MIT License)\nApache License 2.0',
        'Apache-2.0',
      ],
      [
        'SPDX-License-Identifier: Apache-2.0 (Apache License)\nMIT License',
        'MIT',
      ],
      ['SPDX-License-Identifier: ISC License\n0BSD License', '0BSD'],
    ] as const) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.message, input).toContain('conflicts')
      expect(response.results[0]?.licenseId, input).toBe(licenseId)
    }
  })

  it('keeps duplicate declared title bodies after benign SPDX annotation tails', () => {
    for (const [input, licenseId] of [
      ['SPDX-License-Identifier: MIT (MIT License)\nMIT License', 'MIT'],
      ['SPDX-License-Identifier: MIT (MIT License)\nThe MIT License', 'MIT'],
      ['SPDX-License-Identifier: 0BSD (0BSD License)\n0BSD License', '0BSD'],
      [
        'SPDX-License-Identifier: WTFPL (WTFPL License)\nWTFPL License',
        'WTFPL',
      ],
    ] as const) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('spdx-expression')
      expect(response.spdxExpression, input).toBe(licenseId)
      expect(response.results[0]?.licenseId, input).toBe(licenseId)
      expect(response.results[0]?.confidence, input).toBe('Exact')
    }
  })

  it('does not hide unsupported SPDX declarations behind benign annotations', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT (MIT License)\nSPDX-License-Identifier: LicenseRef-Commercial License',
      'SPDX-License-Identifier: MIT (MIT License)\nSPDX-License-Identifier: Foo-1.0 License',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).not.toBe('spdx-expression')
      expect(response.spdxExpression, input).toBeUndefined()
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'MIT' && result.confidence === 'Exact',
        ),
        input,
      ).toBe(false)
    }
  })

  it('routes unknown SPDX WITH exceptions to review before body matches', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT WITH Foo-exception' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.spdxExpression).toBe('MIT WITH Foo-exception')
    expect(response.message).toContain('SPDX expression needs review')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Possible',
      flags: { needsManualReview: true },
    })
  })

  it('does not synthesize invalid SPDX expressions from annotated IDs', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT License' +
        String.fromCharCode(10) +
        'SPDX-License-Identifier: Apache-2.0 License',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('unknown')
    expect(response.spdxExpression).toBeUndefined()
    expect(response.results).toHaveLength(0)
  })

  it('does not reduce compound SPDX annotations to the first declared ID', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT Apache-2.0 License',
      'SPDX-License-Identifier: MIT OR Apache-2.0 License',
      '/* SPDX-License-Identifier: MIT OR Apache-2.0 License */',
      'SPDX-License-Identifier: MIT AND Apache-2.0 License',
      'SPDX-License-Identifier: MIT WITH LLVM-exception License',
      'SPDX-License-Identifier: MIT Apache License 2.0',
      'SPDX-License-Identifier: MIT --> Apache License 2.0',
      'SPDX-License-Identifier: MIT */ Apache License 2.0',
      'SPDX-License-Identifier: MIT Apache License 2.0\nBSD 3-Clause License',
      'SPDX-License-Identifier: The MIT License\nSPDX-License-Identifier: Apache License 2.0\nBSD 3-Clause License',
      'SPDX-License-Identifier: The MIT License Apache License 2.0\nBSD 3-Clause License',
      '<!-- SPDX-License-Identifier: MIT Apache-2.0 --> Notes. BSD 3-Clause License',
      '<!-- SPDX-License-Identifier: MIT (Apache-2.0) --> Apache License 2.0',
      '<!-- SPDX-License-Identifier: MIT Apache License 2.0 --> Notes. BSD 3-Clause License',
      '/* SPDX-License-Identifier: MIT Apache-2.0 */ Notes. BSD 3-Clause License',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).not.toBe('spdx-expression')
      expect(response.spdxExpression, input).toBeUndefined()
      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'MIT' && result.confidence === 'Exact',
        ),
        input,
      ).toBe(false)
      expect(response.message, input).toContain('Unknown')
    }
  })

  it('ignores stray explicit SPDX closing markers before body fallback', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT -->' +
        String.fromCharCode(10) +
        'Apache License 2.0',
      'SPDX-License-Identifier: MIT */' +
        String.fromCharCode(10) +
        'Apache License 2.0',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.results[0]?.licenseId, input).toBe('Apache-2.0')
      expect(response.message, input).toContain(
        'Malformed SPDX identifier ignored',
      )
    }
  })

  it('rejects SPDX-like tails after complete supported license text', () => {
    for (const tail of [
      'SSPL-1.0',
      'SSPL-1.0 (Server Side Public License)',
      'Apache-2.0 (Apache License)',
      'BUSL-1.1',
      'Elastic-2.0',
      'PolyForm-Noncommercial-1.0.0',
      'Not-A-License',
      'LicenseRef-',
      'DocumentRef-doc:LicenseRef-',
      'MIT WITH GPL-2.0-only',
      'MIT WITH LicenseRef-Custom',
      'MIT with GPL-2.0-only',
      'MIT with LicenseRef-Custom',
      'LicenseRef- or Apache-2.0',
      'GPL-2.0+',
    ]) {
      const response = rankLicenses(
        (byId.get('MIT') || '') + String.fromCharCode(10, 10) + tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.results, tail).toHaveLength(0)
      expect(response.message, tail).toContain('conflicts')
    }
  })

  it('does not reject third-party SPDX-like tails after supported license text', () => {
    for (const tail of [
      'License: MIT',
      'License: MIT (MIT License)',
      'DocumentRef-guide',
      'Reference: DocumentRef-guide',
      'DocumentRef-doc:Section-1',
      'Third-party dependencies:' +
        String.fromCharCode(10) +
        'Apache-2.0' +
        String.fromCharCode(10) +
        'License: Elastic-2.0',
      'Third-party dependencies:' +
        String.fromCharCode(10) +
        'License: Apache-2.0 (Apache License)',
      'Third-party notices:' +
        String.fromCharCode(10) +
        'Thank you for reading.' +
        String.fromCharCode(10) +
        'License: Elastic-2.0',
    ]) {
      const response = rankLicenses(
        (byId.get('MIT') || '') + String.fromCharCode(10, 10) + tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.message, tail).not.toContain('conflicts')
      expect(response.results[0], tail).toMatchObject({
        licenseId: 'MIT',
      })
    }
  })

  it('does not report scoped-away full license bodies as current licenses', () => {
    for (const prefix of ['Docs:', 'Sample license text:']) {
      const response = rankLicenses(
        prefix + String.fromCharCode(10, 10) + (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('full-license-text')
      expect(response.message, prefix).toContain('Unknown')
      expect(response.results, prefix).toHaveLength(0)
    }
  })

  it(
    'keeps SPDX identifiers with restrictive third-party full-license tails',
    { timeout: 60_000 },
    () => {
      for (const tail of [
        'License: Proprietary',
        'License Identifier: Proprietary',
        'License: private',
        'License Identifier: redistribution prohibited',
        'License: Proprietary' +
          String.fromCharCode(10) +
          'License Identifier: Proprietary',
        'License' + String.fromCharCode(10) + 'Proprietary',
        'License: MIT' + String.fromCharCode(10) + 'License: Proprietary',
      ]) {
        const response = rankLicenses(
          'SPDX-License-Identifier: MIT' +
            String.fromCharCode(10, 10) +
            'Third-party notices:' +
            String.fromCharCode(10) +
            tail +
            String.fromCharCode(10, 10) +
            (byId.get('MIT') || ''),
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, tail).toBe('spdx-expression')
        expect(response.message, tail).not.toContain('conflicts')
        expect(response.results[0], tail).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Exact',
        })
      }

      for (const body of [
        'Previously licensed as' +
          String.fromCharCode(10) +
          'License: Proprietary',
        'License: Proprietary' +
          String.fromCharCode(10) +
          'For documentation only',
        'License: Proprietary' +
          String.fromCharCode(10) +
          'For documentation only' +
          String.fromCharCode(10) +
          'For example purposes only',
        'License' +
          String.fromCharCode(10) +
          'Proprietary' +
          String.fromCharCode(10) +
          'For documentation only',
      ]) {
        const response = rankLicenses(
          'SPDX-License-Identifier: MIT' +
            String.fromCharCode(10, 10) +
            body +
            String.fromCharCode(10, 10) +
            (byId.get('MIT') || ''),
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, body).toBe('spdx-expression')
        expect(response.message, body).not.toContain('conflicts')
        expect(response.results[0], body).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Exact',
        })
      }

      for (const tail of [
        'This library is for internal use only.',
        'See license document.' +
          String.fromCharCode(10, 10) +
          'This library is for internal use only.',
      ]) {
        const response = rankLicenses(
          'SPDX-License-Identifier: MIT' +
            String.fromCharCode(10, 10) +
            'Third-party notices:' +
            String.fromCharCode(10, 10) +
            (byId.get('Apache-2.0') || '') +
            String.fromCharCode(10, 10) +
            tail,
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, tail).toBe('spdx-expression')
        expect(response.message, tail).not.toContain('conflicts')
        expect(response.results[0], tail).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Exact',
        })
      }

      for (const prefix of ['MIT', 'SPDX-License-Identifier: MIT']) {
        const response = rankLicenses(
          prefix +
            String.fromCharCode(10, 10) +
            'Third-party notices:' +
            String.fromCharCode(10, 10) +
            (byId.get('MIT') || '') +
            String.fromCharCode(10, 10) +
            'This library is for internal use only.',
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, prefix).toBe('spdx-expression')
        expect(response.message, prefix).not.toContain('conflicts')
        expect(response.results[0], prefix).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Exact',
        })
      }

      for (const prefix of ['MIT', 'SPDX-License-Identifier: MIT']) {
        const response = rankLicenses(
          prefix +
            String.fromCharCode(10, 10) +
            'Project license' +
            String.fromCharCode(10, 10) +
            (byId.get('MIT') || '') +
            String.fromCharCode(10, 10) +
            'Third-party notices:' +
            String.fromCharCode(10, 10) +
            (byId.get('Apache-2.0') || '') +
            String.fromCharCode(10, 10) +
            'This library is for internal use only.',
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, prefix).toBe('spdx-expression')
        expect(response.message, prefix).not.toContain('conflicts')
        expect(response.results[0], prefix).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Exact',
        })
      }
    },
  )

  it('rejects project-scoped restrictive labels after inactive sections', () => {
    for (const body of [
      'Third-party notices:' +
        String.fromCharCode(10) +
        'Project license: Proprietary',
      'Third-party notices:' +
        String.fromCharCode(10) +
        'Project license: private',
      'Third-party notices:' +
        String.fromCharCode(10) +
        'Project license' +
        String.fromCharCode(10) +
        'Proprietary',
      'Third-party notices:' +
        String.fromCharCode(10) +
        'Source license: Proprietary',
      'Third-party notices:' +
        String.fromCharCode(10) +
        'Package license identifier: distribution prohibited',
      'Project licensing' +
        String.fromCharCode(10) +
        'License: Proprietary' +
        String.fromCharCode(10) +
        'For documentation only',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' +
          String.fromCharCode(10, 10) +
          body +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('mixed-license-text')
      expect(response.results, body).toHaveLength(0)
      expect(response.message, body).toContain('restrictive license text')
    }
  }, 10_000)

  it('keeps unsupported SPDX body matches with inactive restrictive labels', () => {
    for (const prefix of [
      'SPDX-License-Identifier: LicenseRef-Custom',
      'SPDX-License-Identifier: see LICENSE file',
    ]) {
      const response = rankLicenses(
        prefix +
          String.fromCharCode(10, 10) +
          'Third-party notices:' +
          String.fromCharCode(10) +
          'License: private' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('mixed-license-text')
      expect(response.message, prefix).not.toContain('conflicts')
      expect(response.results[0], prefix).toMatchObject({
        licenseId: 'MIT',
      })
    }
  }, 10_000)

  it('keeps body section boundaries after stripping SPDX declaration lines', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices:' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || '') +
        String.fromCharCode(10, 10) +
        'Project license' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('spdx-expression')
    expect(response.message).not.toContain('conflicts')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Exact',
    })
  })

  it('keeps SPDX identifiers when prose negates a different license', () => {
    for (const tail of [
      'This project is not licensed under Apache-2.0.',
      'No part of this project is Apache-2.0 licensed.',
      'No part of this project is licensed under Apache-2.0.',
    ]) {
      const response = rankLicenses(
        'SPDX-License-Identifier: MIT' + String.fromCharCode(10, 10) + tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('spdx-expression')
      expect(response.spdxExpression, tail).toBe('MIT')
      expect(response.results[0], tail).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Exact',
      })
    }
  })

  it('rejects contradictory license label suffixes', () => {
    for (const input of [
      'License: MIT for internal use only',
      'License: MIT\nThis project is not licensed under MIT.',
      'License: MIT\nNo part of this project is MIT licensed.',
      'License: MIT\nNo part of this project is licensed under MIT.',
      'License: MIT\nThis project is not licensed under any open source license.',
      'License: MIT\nThis source file is not licensed under any open source license.',
      'License: MIT\nThis project is not made available under any open source license.',
      'License: MIT\nNo permission is granted to use this project.',
      'License: MIT\nNo license is granted.',
      'License: MIT\nPermission is not granted.',
      'License: MIT\nThis project is for internal use only.',
      'License: MIT\nCommercial license only.',
      'License: MIT\nCommercial license only, contact us for terms.',
      'License: MIT\nInternal license only.',
      'License: MIT\nFor commercial license only.',
      'License: MIT\nNon commercial license only.',
      'License: MIT\nThis project has a commercial license only.',
      'License: MIT\nThis project has a commercial license only available upon request.',
      'License: MIT\n\nThird-party notices\nThis project has a commercial license only.',
      'License: MIT\n\nThird-party notices\nThis project has a commercial license only available upon request.',
      'License: MIT\nThis project has an internal license only.',
      'License: MIT\nThe project license is commercial license only.',
      "License: MIT\nThis project's license is commercial license only available upon request.",
      'License: MIT\n\nThird-party notices\nProject notice: Commercial license only.',
      'License: MIT\nThis component has a commercial license only.',
      'License: MIT\nThe component has a commercial license only.',
      'License: MIT\nNotes: Commercial license only.',
      'License: MIT\nNotes: Commercial license only available upon request.',
      'License: MIT\nProject notice: Commercial license only.',
      'License: MIT\nLicense: Commercial license only.',
      'License: MIT\nLicense:\nCommercial license only available upon request.',
      'License: MIT\nLicense: Internal license only.',
      'License: MIT\nConfidential.',
      'License: MIT\nSource available only.',
      'License: MIT\nSource code available only.',
    ]) {
      expectNoExactOrLikelyLicense(input, 'MIT')
    }

    for (const input of [
      'License: GPLv2 or later\nSource available only.',
      'License: GPLv2 or later\nSource code available only.',
    ]) {
      expectNoExactOrLikelyLicense(input, 'GPL-2.0-or-later')
    }
  })

  it('keeps license labels with permissive copyright suffix notices', () => {
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10, 10) +
        'Copyright 2026 Example Corp' +
        String.fromCharCode(10) +
        'all rights reserved.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('keeps license labels when prose negates a different license', () => {
    for (const tail of [
      'This project is not licensed under Apache-2.0.',
      'No part of this project is Apache-2.0 licensed.',
      'No part of this project is licensed under Apache-2.0.',
      'This project is not licensed under Apache-2.0.' +
        String.fromCharCode(10, 10) +
        'Licensed under MIT.',
    ]) {
      const response = rankLicenses(
        'License: MIT' + String.fromCharCode(10, 10) + tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('license-header')
      expect(response.results[0], tail).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
    }
  })

  it('rejects contradictory license label prefixes', () => {
    for (const input of [
      'This project is not licensed under MIT.\nLicense: MIT',
      'This project is not licensed under MIT.\n\nLicense: MIT',
      'This project is not licensed under the MIT License.\n\nLicense: MIT',
      'This project is not licensed under an MIT License.\n\nLicense: MIT',
      'This project is not licensed under the terms of the MIT License.\n\nLicense: MIT',
      'This project is not licensed under the terms of an MIT License.\n\nLicense: MIT',
      'This project is not licensed under MIT.\n\nProject\nLicense: MIT',
      'This file is not licensed under MIT.\n\nLicense: MIT',
      'This project is not released under MIT.\n\nLicense: MIT',
      'This project is not distributed under MIT.\n\nLicense: MIT',
      'This project is not available under MIT.\n\nLicense: MIT',
      'This project is not made available under MIT.\n\nLicense: MIT',
      'This project is not MIT licensed.\n\nLicense: MIT',
      'This project is not MIT licensed.\n\nProject\nLicense: MIT',
      'This project is not released or distributed under MIT.\n\nLicense: MIT',
      'This project is not released, distributed, or available under MIT.\n\nLicense: MIT',
      'No part of this project is released under MIT.\n\nLicense: MIT',
      'No part of this project is released, distributed, or available under MIT.\n\nLicense: MIT',
      'No part of this project is MIT licensed.\n\nLicense: MIT',
      'No part of this project is MIT licensed.\n\nProject\nLicense: MIT',
      'No part of this project is MIT licensed.\n\nSource\nLicense: MIT',
      'No part of this project is Apache-2.0 or MIT licensed.\n\nLicense: MIT',
      'No part of this project is Apache-2.0 or the MIT License licensed.\n\nLicense: MIT',
      'No part of this project is released under the MIT License.\n\nLicense: MIT',
      'This project is not licensed under Apache-2.0 or MIT.\n\nLicense: MIT',
      'This project is not licensed under Apache-2.0 or the MIT License.\n\nLicense: MIT',
      'This project is not licensed under the Apache License 2.0 or the MIT License.\n\nLicense: MIT',
      'This project is not licensed under Apache-2.0 or GPL-3.0 or MIT.\n\nLicense: MIT',
      'This project is not licensed under Apache-2.0, GPL-3.0, or MIT.\n\nLicense: MIT',
      'This project is not licensed under Apache-2.0, GPL-3.0, MIT.\n\nLicense: MIT',
      'No license is granted.\nLicense: MIT',
      'No license is granted.\n\nProject\nLicense: MIT',
      'Permission is not granted.\nLicense: MIT',
    ]) {
      expectNoExactOrLikelyLicense(input, 'MIT')
    }
  })

  it('rejects negated license label prefixes before declared full bodies', () => {
    for (const separator of [
      String.fromCharCode(10),
      String.fromCharCode(10, 10),
    ]) {
      expectNoExactOrLikelyLicense(
        'This project is not licensed under MIT.' +
          separator +
          'License: MIT' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        'MIT',
      )
      expectNoExactOrLikelyLicense(
        'This project is not released or distributed under MIT.' +
          separator +
          'License: MIT' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        'MIT',
      )
      expectNoExactOrLikelyLicense(
        'This project is not made available under MIT.' +
          separator +
          'License: MIT' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        'MIT',
      )
      expectNoExactOrLikelyLicense(
        'This project is not MIT licensed.' +
          separator +
          (byId.get('MIT') || ''),
        'MIT',
      )
      expectNoExactOrLikelyLicense(
        'This project is not licensed under the terms of an MIT License.' +
          separator +
          (byId.get('MIT') || ''),
        'MIT',
      )
      expectNoExactOrLikelyLicense(
        'No part of this project is released, distributed, or available under MIT.' +
          separator +
          'License: MIT' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        'MIT',
      )
    }
    expectNoExactOrLikelyLicense(
      'This project is not licensed under MIT.' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '').toLowerCase(),
      'MIT',
    )
  })

  it('keeps prefixed license labels when prose negates a different license', () => {
    for (const input of [
      'This project is not licensed under Apache-2.0.' +
        String.fromCharCode(10, 10) +
        'License: MIT',
      'This project is not licensed under the Apache License 2.0.' +
        String.fromCharCode(10, 10) +
        'License: MIT',
      'This project is not licensed under Apache-2.0.' +
        String.fromCharCode(10, 10) +
        'Project' +
        String.fromCharCode(10) +
        'License: MIT',
      'This project is not released under Apache-2.0.' +
        String.fromCharCode(10, 10) +
        'License: MIT',
      'This file is not licensed under Apache-2.0.' +
        String.fromCharCode(10, 10) +
        'License: MIT',
      'No part of this project is Apache-2.0 licensed.' +
        String.fromCharCode(10, 10) +
        'License: MIT',
      'This project is not Apache-2.0 licensed.' +
        String.fromCharCode(10, 10) +
        'License: MIT',
      'Third-party notices' +
        String.fromCharCode(10) +
        'All rights reserved.' +
        String.fromCharCode(10, 10) +
        'Project' +
        String.fromCharCode(10) +
        'License: MIT',
      'Third-party notices' +
        String.fromCharCode(10) +
        'No license is granted.' +
        String.fromCharCode(10, 10) +
        'Project' +
        String.fromCharCode(10) +
        'License: MIT',
      'No dependency of this project is licensed under the MIT License.' +
        String.fromCharCode(10, 10) +
        'License: MIT',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'MIT',
        confidence: 'Likely',
      })
    }
  })

  it('keeps prefixed license labels when prose negates a different license list', () => {
    for (const input of [
      'This project is not licensed under Apache-2.0 or MIT.' +
        String.fromCharCode(10, 10) +
        'License: ISC',
      'This project is not licensed under Apache-2.0 or the MIT License.' +
        String.fromCharCode(10, 10) +
        'License: ISC',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('license-header')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'ISC',
        confidence: 'Likely',
      })
    }
  })

  it('keeps prefixed full bodies when prose negates a different license', () => {
    const response = rankLicenses(
      'This project is not licensed under Apache-2.0.' +
        String.fromCharCode(10, 10) +
        'License: MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('rejects negated labels after declared full bodies', () => {
    for (const tail of [
      'This project is not licensed under MIT.',
      'This project is not licensed under any open source license.',
    ]) {
      const response = rankLicenses(
        'License: MIT' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || '') +
          String.fromCharCode(10, 10) +
          tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.results, tail).toHaveLength(0)
      expect(response.message, tail).toContain('conflicts')
    }
  })

  it('matches Blue Oak versionless headers', () => {
    const response = rankLicenses(
      'Licensed under the Blue Oak Model License',
      licenses,
      { includeDiffs: false },
    )
    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'BlueOak-1.0.0',
      confidence: 'Likely',
    })
  })

  it('flags conflicting label and full-body licenses', () => {
    for (const [label, body] of [
      ['Apache-2.0', byId.get('Apache-2.0') || ''],
      [
        'filled BSD-2-Clause',
        (byId.get('BSD-2-Clause') || '').replace(
          '<year> <owner>',
          '2026 Example Corp',
        ),
      ],
    ]) {
      const response = rankLicenses(
        'License: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, label).toBe('mixed-license-text')
      expect(response.results, label).toHaveLength(0)
      expect(response.message, label).toContain('conflicts')
    }
  })

  it('flags conflicting label and named license bodies', () => {
    for (const body of ['Apache License 2.0', 'Licensed under Apache-2.0']) {
      const response = rankLicenses(
        'License: MIT' + String.fromCharCode(10, 10) + body,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, body).toBe('mixed-license-text')
      expect(response.results[0], body).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
      expect(response.message, body).toContain('conflicts')
    }
  })

  it('rejects restrictive markers after current license labels', () => {
    for (const marker of [
      'UNLICENSED',
      'No license',
      'No open source license',
      'Not open source',
      'Not licensed',
    ]) {
      const response = rankLicenses(
        'License: MIT' + String.fromCharCode(10) + marker,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, marker).toBe('mixed-license-text')
      expect(response.results, marker).toHaveLength(0)
      expect(response.message, marker).toContain('restrictive license text')
    }
  })

  it('keeps restrictive markers in third-party sections scoped away', () => {
    for (const marker of ['UNLICENSED', 'No license', 'Not open source']) {
      for (const body of [
        'Third-party notices' + String.fromCharCode(10) + marker,
        'Dependencies:' + String.fromCharCode(10) + marker,
        'Component licenses' + String.fromCharCode(10) + marker,
        'Copyright 2024' +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10) +
          marker,
        'Third-party notices' +
          String.fromCharCode(10) +
          'See below' +
          String.fromCharCode(10) +
          marker,
        'Third-party notices' +
          String.fromCharCode(10) +
          'See the license below' +
          String.fromCharCode(10) +
          marker,
        'Third-party notices' +
          String.fromCharCode(10) +
          'See the following license' +
          String.fromCharCode(10) +
          marker,
        'Third-party notices' +
          String.fromCharCode(10) +
          'Name: AcmeParser' +
          String.fromCharCode(10) +
          marker,
        'Third-party notices' +
          String.fromCharCode(10) +
          'Package: AcmeParser' +
          String.fromCharCode(10) +
          marker,
      ]) {
        const response = rankLicenses(
          'License: MIT' + String.fromCharCode(10, 10) + body,
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, body).toBe('license-header')
        expect(response.results[0], body).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Likely',
        })
      }
    }
  })

  it('rejects restrictive markers after returning to project scope', () => {
    for (const projectSection of [
      'Project',
      'Copyright 2024',
      'Package includes the following',
    ]) {
      const response = rankLicenses(
        'License: MIT' +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10) +
          'UNLICENSED' +
          String.fromCharCode(10, 10) +
          projectSection +
          String.fromCharCode(10) +
          'Not licensed',
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, projectSection).toBe('mixed-license-text')
      expect(response.results, projectSection).toHaveLength(0)
      expect(response.message, projectSection).toContain(
        'restrictive license text',
      )
    }
  })

  it('adds diff details to conflicting label named-body results', () => {
    const input =
      'License: MIT' + String.fromCharCode(10, 10) + 'Apache License 2.0'
    const response = rankLicenses(input, licenses, { includeDiffs: true })
    const result = response.results[0]
    const lazyResponse = rankLicenses(input, licenses, { includeDiffs: false })
    const lazyResult = lazyResponse.results[0]

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.message).toContain('conflicts')
    expect(result?.licenseId).toBe('Apache-2.0')
    expect(result?.diff).toBeTruthy()
    expect(result?.diffSegments?.length).toBeGreaterThan(0)
    expect(lazyResult?.licenseId).toBe(result?.licenseId)
    expect(diffForResult(input, lazyResult, licenses)).toBe(result?.diff)
    expect(diffSegmentsForResult(input, lazyResult, licenses)).toEqual(
      result?.diffSegments,
    )
  })

  it('rejects restrictive labels before full bodies', () => {
    for (const label of [
      'License: Proprietary',
      'License: UNLICENSED',
      'License: No license',
      'License: Not open source',
    ]) {
      const response = rankLicenses(
        label + String.fromCharCode(10, 10) + (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, label).toBe('mixed-license-text')
      expect(response.results, label).toHaveLength(0)
      expect(response.message, label).toContain('restrictive license text')
    }
  })

  it('rejects bare no-license prefixes before full bodies', () => {
    for (const prefix of ['UNLICENSED', 'No license', 'Not open source']) {
      const response = rankLicenses(
        prefix + String.fromCharCode(10, 10) + (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('mixed-license-text')
      expect(response.results, prefix).toHaveLength(0)
      expect(response.message, prefix).toContain('restrictive license text')
    }
  })

  it('does not let conflicting labels fall back to full bodies', () => {
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10) +
        'License: Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('conflicts')
  })

  it('flags conflicting named headers around full bodies', () => {
    for (const input of [
      'Licensed under Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        'Apache License 2.0',
    ]) {
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.results[0], input).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Likely',
      })
      expect(response.message, input).toContain('conflicts')
    }
  })

  it('keeps permissive copyright notices before declared full bodies', () => {
    for (const notice of [
      'Copyright 2026 Example Corp' +
        String.fromCharCode(10) +
        'All rights reserved.',
      'Copyright 2026 Example Corp. All rights reserved.',
      'Copyright 2026 Example Advanced Research Software Engineering License ' +
        'Compliance Documentation Integration Platform International ' +
        'Distributed Systems Applied Tools Working Group Foundation. ' +
        'All rights reserved.',
      'Copyright 2026 ' +
        Array.from({ length: 40 }, (_, index) => 'holder' + index).join(' ') +
        String.fromCharCode(10) +
        'All rights reserved.',
      'Copyright 2026 Example Corp. Redistribution is not prohibited.',
      'Copyright 2026 Example Corp. Redistribution is not prohibited or forbidden.',
      'Copyright 2026 Bundled Vendor, redistribution is forbidden.',
    ]) {
      const response = rankLicenses(
        'License: BSD-3-Clause' +
          String.fromCharCode(10, 10) +
          notice +
          String.fromCharCode(10, 10) +
          (byId.get('BSD-3-Clause') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.message, notice).not.toContain('restrictive license text')
      expect(response.results[0], notice).toMatchObject({
        licenseId: 'BSD-3-Clause',
      })
      expect(response.results[0]?.confidence, notice).not.toBe('Unknown')
    }
  }, 10_000)

  it('still rejects project-owned all-rights-reserved labels before full bodies', () => {
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10, 10) +
        'This project has all rights reserved.' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('conflicts')
  })

  it('rejects restrictive copyright notice prefixes before declared full bodies', () => {
    for (const [declaration, notice] of [
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp. Do not distribute this software.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 This project All rights reserved.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 This project' +
          String.fromCharCode(10) +
          'All rights reserved.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp distribution prohibited.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp redistribution is forbidden.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp copying is not allowed.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp internal use only.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp. Redistribution is not prohibited, ' +
          'but copying is not allowed.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp. Redistribution to parties not ' +
          'expressly authorized is prohibited.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp. Redistribution is prohibited but ' +
          'selling is not forbidden.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp, all use prohibited.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp, not for redistribution.',
      ],
      [
        'SPDX-License-Identifier: BSD-3-Clause',
        'Copyright 2026 Example Corp' +
          String.fromCharCode(10) +
          'No permission is granted to use this software.',
      ],
      [
        '',
        'Copyright 2026 Example Corp' +
          String.fromCharCode(10) +
          'Not for redistribution.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp' +
          String.fromCharCode(10) +
          'Redistribution is not permitted.',
      ],
      [
        'SPDX-License-Identifier: BSD-3-Clause',
        'Copyright 2026 Example Corp' +
          String.fromCharCode(10) +
          'This project is closed source.',
      ],
      [
        'License: BSD-3-Clause',
        'Copyright 2026 Example Corp' +
          String.fromCharCode(10) +
          'Use prohibited.' +
          String.fromCharCode(10) +
          'All rights reserved.',
      ],
    ]) {
      const response = rankLicenses(
        declaration +
          String.fromCharCode(10, 10) +
          notice +
          String.fromCharCode(10, 10) +
          (byId.get('BSD-3-Clause') || ''),
        licenses,
        { includeDiffs: false },
      )

      const label = `${declaration} ${notice}`
      expect(response.inputType, label).toBe('mixed-license-text')
      expect(response.results, label).toHaveLength(0)
      expect(response.message, label).toContain('conflicts')
    }
  })

  it('rejects restrictive prefixes before full bodies with malformed license labels', () => {
    for (const label of ['License: garbage', 'License garbage']) {
      const response = rankLicenses(
        label +
          String.fromCharCode(10, 10) +
          'This project is proprietary.' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, label).toBe('mixed-license-text')
      expect(response.results, label).toHaveLength(0)
      expect(response.message, label).toContain('conflicts')
    }
  })

  it('rejects restrictive prefixes after scoped-away license labels', () => {
    for (const label of [
      'Dependency: React' + String.fromCharCode(10) + 'License: MIT',
      'Third-party notices' + String.fromCharCode(10) + 'License: MIT',
    ]) {
      const response = rankLicenses(
        label +
          String.fromCharCode(10, 10) +
          'This project is proprietary.' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, label).toBe('mixed-license-text')
      expect(response.results, label).toHaveLength(0)
      expect(response.message, label).toContain('conflicts')
    }
  })

  it('uses current labels after scoped-away labels for full-body conflicts', () => {
    const response = rankLicenses(
      'Dependency: React' +
        String.fromCharCode(10) +
        'License: MIT' +
        String.fromCharCode(10, 10) +
        'Project license' +
        String.fromCharCode(10) +
        'Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-2-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('conflicts')
  })

  it('rejects restrictive custom SPDX prefixes before supported full bodies', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: LicenseRef-Proprietary' +
        String.fromCharCode(10, 10) +
        'This project is proprietary.' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('conflicts')
  })

  it('rejects restrictive custom SPDX prefixes without supported full bodies', () => {
    const response = rankLicenses(
      'SPDX-License-Identifier: LicenseRef-Proprietary' +
        String.fromCharCode(10, 10) +
        'This project is proprietary.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('conflicts')
  })

  it('rejects restrictive declared SPDX prefixes before supported full bodies', () => {
    for (const [licenseId, text] of [
      ['Apache-2.0', byId.get('Apache-2.0') || ''],
      ['GPL-2.0-only', byId.get('GPL-2.0-only') || ''],
    ]) {
      const response = rankLicenses(
        `SPDX-License-Identifier: ${licenseId}` +
          String.fromCharCode(10, 10) +
          'This project is proprietary.' +
          String.fromCharCode(10, 10) +
          text,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, licenseId).toBe('mixed-license-text')
      expect(response.results, licenseId).toHaveLength(0)
      expect(response.message, licenseId).toContain('conflicts')
    }
  })

  it('flags conflicting label and ambiguous GNU full-body licenses', () => {
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('GPL-2.0-only') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('conflicts')
  })

  it('does not flag extra full bodies when the label body is also present', () => {
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        (byId.get('BSD-2-Clause') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.results.length).toBeGreaterThan(0)
    expect(response.results.some((result) => result.licenseId === 'MIT')).toBe(
      true,
    )
  })

  it('keeps label matches ahead of third-party full-body notices', () => {
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('keeps label matches ahead of third-party labeled full-body notices', () => {
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        'License: Apache-2.0' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it('keeps label matches with project bodies ahead of third-party full-body notices', () => {
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10, 10) +
        (byId.get('MIT') || '') +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || ''),
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('license-header')
    expect(response.results[0]).toMatchObject({
      licenseId: 'MIT',
      confidence: 'Likely',
    })
  })

  it(
    'detects later project full-body conflicts after third-party label notices',
    { timeout: 30_000 },
    () => {
      const response = rankLicenses(
        'License: MIT' +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || '') +
          String.fromCharCode(10, 10) +
          'Project license' +
          String.fromCharCode(10, 10) +
          (byId.get('BSD-2-Clause') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType).toBe('mixed-license-text')
      expect(response.results).toHaveLength(0)
      expect(response.message).toContain('conflicts')
    },
  )

  it(
    'detects project full-body conflicts after third-party label notices with prose boundaries',
    { timeout: 30_000 },
    () => {
      const response = rankLicenses(
        'License: MIT' +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || '') +
          String.fromCharCode(10, 10) +
          'The project itself is licensed under BSD-2-Clause.' +
          String.fromCharCode(10, 10) +
          (byId.get('BSD-2-Clause') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType).toBe('mixed-license-text')
      expect(response.results).toHaveLength(0)
      expect(response.message).toContain('conflicts')
    },
  )

  it(
    'keeps label matches when third-party notices negate the declared license',
    { timeout: 30_000 },
    () => {
      for (const body of [
        'Third-party notices' +
          String.fromCharCode(10, 10) +
          'This bundled library is not licensed under MIT.' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || ''),
        'Third-party notices' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || '') +
          String.fromCharCode(10, 10) +
          'This bundled library is not licensed under MIT.',
      ]) {
        const response = rankLicenses(
          'License: MIT' + String.fromCharCode(10, 10) + body,
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, body).toBe('license-header')
        expect(response.results[0], body).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Likely',
        })
      }
    },
  )

  it(
    'keeps label matches ahead of bare third-party restrictions before full-body notices',
    { timeout: 30_000 },
    () => {
      for (const restriction of [
        'All rights reserved.',
        'Confidential.',
        'License:' + String.fromCharCode(10) + 'Commercial license only',
      ]) {
        const response = rankLicenses(
          'License: MIT' +
            String.fromCharCode(10, 10) +
            'Third-party notices' +
            String.fromCharCode(10, 10) +
            restriction +
            String.fromCharCode(10, 10) +
            (byId.get('Apache-2.0') || ''),
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, restriction).toBe('license-header')
        expect(response.results[0], restriction).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Likely',
        })
      }
    },
  )

  it(
    'keeps label matches ahead of bare third-party restrictions after full-body notices',
    { timeout: 30_000 },
    () => {
      for (const restriction of ['All rights reserved.', 'Confidential.']) {
        const response = rankLicenses(
          'License: MIT' +
            String.fromCharCode(10, 10) +
            'Third-party notices' +
            String.fromCharCode(10, 10) +
            (byId.get('Apache-2.0') || '') +
            String.fromCharCode(10, 10) +
            restriction,
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, restriction).toBe('license-header')
        expect(response.results[0], restriction).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Likely',
        })
      }
    },
  )

  it(
    'keeps label matches ahead of bare restrictions after filled third-party full-body notices',
    { timeout: 30_000 },
    () => {
      const bsd2 = (byId.get('BSD-2-Clause') || '').replace(
        '<year> <owner>',
        '2026 Example Corp',
      )
      for (const restriction of ['All rights reserved.', 'Confidential.']) {
        const response = rankLicenses(
          'License: MIT' +
            String.fromCharCode(10, 10) +
            'Third-party notices' +
            String.fromCharCode(10, 10) +
            bsd2 +
            String.fromCharCode(10, 10) +
            restriction,
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, restriction).toBe('license-header')
        expect(response.results[0], restriction).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Likely',
        })
      }
    },
  )

  it(
    'does not use scoped-away labels before third-party full-body notices',
    { timeout: 30_000 },
    () => {
      for (const label of [
        'Dependency: React' + String.fromCharCode(10) + 'License: MIT',
        'License: MIT' + String.fromCharCode(10) + 'For documentation only',
      ]) {
        const response = rankLicenses(
          label +
            String.fromCharCode(10, 10) +
            'Third-party notices' +
            String.fromCharCode(10, 10) +
            (byId.get('Apache-2.0') || ''),
          licenses,
          { includeDiffs: false },
        )

        expect(
          response.results.some(
            (result) =>
              result.licenseId === 'MIT' &&
              (result.confidence === 'Exact' || result.confidence === 'Likely'),
          ),
          label,
        ).toBe(false)
        expect(
          response.results.some(
            (result) =>
              result.licenseId === 'Apache-2.0' &&
              (result.confidence === 'Exact' || result.confidence === 'Likely'),
          ),
          label,
        ).toBe(false)
        expect(response.inputType, label).toBe('mixed-license-text')
        expect(response.message, label).toBe(
          'License label applies outside the detected third-party text.',
        )
      }
    },
  )

  it(
    'handles capitalized third-party label contexts like lowercase ones',
    { timeout: 30_000 },
    () => {
      const body = String.fromCharCode(10, 10) + (byId.get('Apache-2.0') || '')
      const lowerResponse = rankLicenses(
        'dependency metadata' + String.fromCharCode(10) + 'License: MIT' + body,
        licenses,
        { includeDiffs: false },
      )
      expect(lowerResponse.inputType).toBe('full-license-text')
      expect(lowerResponse.results[0]).toMatchObject({
        licenseId: 'Apache-2.0',
        confidence: 'Exact',
      })
      expect(
        lowerResponse.results.some(
          (result) =>
            result.licenseId === 'MIT' &&
            (result.confidence === 'Exact' || result.confidence === 'Likely'),
        ),
      ).toBe(false)
      for (const heading of [
        'Dependency Metadata',
        'Dependency Metadata:',
        'Dependency Metadata：',
      ]) {
        const capitalizedResponse = rankLicenses(
          heading + String.fromCharCode(10) + 'License: MIT' + body,
          licenses,
          { includeDiffs: false },
        )

        expect(capitalizedResponse.inputType, heading).toBe(
          lowerResponse.inputType,
        )
        expect(capitalizedResponse.message, heading).toBe(lowerResponse.message)
        expect(
          capitalizedResponse.results.map((result) => result.licenseId),
          heading,
        ).toEqual(lowerResponse.results.map((result) => result.licenseId))
      }

      for (const heading of [
        'Dependency: React',
        'dependency: react',
        'Dependency：React',
        'dependency：react',
      ]) {
        const keyValueResponse = rankLicenses(
          heading + String.fromCharCode(10) + 'License: MIT' + body,
          licenses,
          { includeDiffs: false },
        )
        expect(keyValueResponse.inputType, heading).toBe('mixed-license-text')
        expect(keyValueResponse.message, heading).toBe(
          'License label applies outside the detected third-party text.',
        )
        expect(keyValueResponse.results, heading).toEqual([])
      }
    },
  )

  it('does not treat third-party notice bodies as project licenses', () => {
    for (const prefix of [
      'This project includes third-party notices.',
      'Third-party license:',
      'Third-party notice:',
    ]) {
      const response = rankLicenses(
        prefix +
          String.fromCharCode(10, 10) +
          'MIT License' +
          String.fromCharCode(10, 10) +
          (byId.get('MIT') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(
        response.results.some(
          (result) =>
            result.licenseId === 'MIT' &&
            (result.confidence === 'Exact' || result.confidence === 'Likely'),
        ),
        prefix,
      ).toBe(false)
    }
  })

  it(
    'uses later project full-body text after scoped-away labels and third-party notices',
    { timeout: 30_000 },
    () => {
      const response = rankLicenses(
        'Dependency: React' +
          String.fromCharCode(10) +
          'License: MIT' +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || '') +
          String.fromCharCode(10, 10) +
          'The project is licensed under BSD-2-Clause.' +
          String.fromCharCode(10, 10) +
          (byId.get('BSD-2-Clause') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType).toBe('mixed-license-text')
      expect(response.message).toContain('ranked by shingle F1 score')
      expect(response.results[0]).toMatchObject({
        licenseId: 'BSD-2-Clause',
        confidence: 'Likely',
      })
    },
  )

  it(
    'keeps standalone label matches ahead of third-party full-body notices',
    { timeout: 30_000 },
    () => {
      for (const label of [
        'License',
        'Project License',
        'Source License',
        'Package License',
      ]) {
        const response = rankLicenses(
          label +
            String.fromCharCode(10) +
            'MIT' +
            String.fromCharCode(10, 10) +
            'Third-party notices' +
            String.fromCharCode(10, 10) +
            (byId.get('Apache-2.0') || ''),
          licenses,
          { includeDiffs: false },
        )

        expect(response.inputType, label).toBe('license-header')
        expect(response.results[0], label).toMatchObject({
          licenseId: 'MIT',
          confidence: 'Likely',
        })
      }
    },
  )

  it('rejects negated labels after third-party full-body notices', () => {
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || '') +
        String.fromCharCode(10, 10) +
        'This project is not licensed under MIT.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('conflicts')
  })

  it('rejects restrictive prefixes before third-party full-body notices', () => {
    for (const prefix of [
      'This project is proprietary.',
      'Confidential.',
      'This source file is not licensed under any open source license.',
    ]) {
      const response = rankLicenses(
        'License: MIT' +
          String.fromCharCode(10, 10) +
          prefix +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || ''),
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, prefix).toBe('mixed-license-text')
      expect(response.results, prefix).toHaveLength(0)
      expect(response.message, prefix).toContain('conflicts')
    }
  })

  it('rejects project-scoped restrictions before third-party full-body notices', () => {
    for (const prefix of [
      'This project is proprietary.',
      'This source file is not licensed under any open source license.',
    ]) {
      const input =
        'License: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        prefix +
        String.fromCharCode(10, 10) +
        (byId.get('Apache-2.0') || '')
      const response = rankLicenses(input, licenses, { includeDiffs: false })

      expect(response.inputType, input).toBe('mixed-license-text')
      expect(response.results, input).toHaveLength(0)
      expect(response.message, input).toContain('conflicts')
    }
  })

  it('rejects restrictive tails after third-party full-body notices', () => {
    for (const tail of [
      'This project is confidential.',
      'See license document.' +
        String.fromCharCode(10, 10) +
        'This project is confidential.',
    ]) {
      const response = rankLicenses(
        'License: MIT' +
          String.fromCharCode(10, 10) +
          'Third-party notices' +
          String.fromCharCode(10, 10) +
          (byId.get('Apache-2.0') || '') +
          String.fromCharCode(10, 10) +
          tail,
        licenses,
        { includeDiffs: false },
      )

      expect(response.inputType, tail).toBe('mixed-license-text')
      expect(response.results, tail).toHaveLength(0)
      expect(response.message, tail).toContain('conflicts')
    }
  })

  it('rejects restrictive tails after filled third-party full-body notices', () => {
    const bsd2 = (byId.get('BSD-2-Clause') || '').replace(
      '<year> <owner>',
      '2026 Example Corp',
    )
    const response = rankLicenses(
      'License: MIT' +
        String.fromCharCode(10, 10) +
        'Third-party notices' +
        String.fromCharCode(10, 10) +
        bsd2 +
        String.fromCharCode(10, 10) +
        'This project is confidential.',
      licenses,
      { includeDiffs: false },
    )

    expect(response.inputType).toBe('mixed-license-text')
    expect(response.results).toHaveLength(0)
    expect(response.message).toContain('conflicts')
  })
})
