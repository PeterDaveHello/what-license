import { describe, expect, it } from 'vitest'
import { detectSpdxIdentifier } from '../src/core/detect-spdx'
import {
  hasValidSpdxExpressionShape,
  hasSpdxIdToken,
  isSpdxExpressionOperator,
  isSpdxExpressionIdToken,
  isSpdxLikeIdToken,
} from '../src/core/spdx-expression'
import { licenses } from '../src/data/licenses.generated'

const knownIds = new Set(licenses.map((license) => license.licenseId))

describe('SPDX expression token helpers', () => {
  it('recognizes SPDX expression operators case-insensitively', () => {
    for (const token of [
      'AND',
      'OR',
      'WITH',
      'and',
      'or',
      'with',
      'And',
      'Or',
      'With',
    ]) {
      expect(isSpdxExpressionOperator(token), token).toBe(true)
    }
  })

  it('only accepts identifier-shaped non-operator tokens', () => {
    for (const token of [
      'MIT',
      'Apache-2.0',
      'GPL-2.0+',
      'LicenseRef-Custom',
      'DocumentRef-example:LicenseRef-Custom',
    ]) {
      expect(isSpdxExpressionIdToken(token), token).toBe(true)
    }

    for (const token of [
      'AND',
      'OR',
      'WITH',
      'and',
      '(',
      ')',
      '',
      '+',
      '.',
      ':',
      '---',
      '<MIT>',
    ]) {
      expect(isSpdxExpressionIdToken(token), token).toBe(false)
    }
  })

  it('requires complete custom SPDX reference tokens', () => {
    for (const token of [
      'LicenseRef-Custom',
      'LicenseRef-23',
      'DocumentRef-example:LicenseRef-Custom',
      'DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style-2',
    ]) {
      expect(isSpdxLikeIdToken(token, knownIds), token).toBe(true)
      expect(hasValidSpdxExpressionShape(token), token).toBe(true)
    }

    for (const token of [
      'LicenseRef-',
      'LicenseRef-Custom+Exception',
      'LicenseRef-foo:bar',
      'licenseref-Custom',
      'DocumentRef-guide',
      'DocumentRef-doc:Section-1',
      'DocumentRef-example+tool:LicenseRef-Custom',
      'DocumentRef-:LicenseRef-Custom',
      'DocumentRef-doc:LicenseRef-',
      'DocumentRef-doc:LicenseRef-Custom+Exception',
      'documentref-doc:LicenseRef-Custom',
      'DocumentRef-doc:licenseref-Custom',
      'DocumentRef-doc:LicenseRef-Custom:extra',
    ]) {
      expect(isSpdxLikeIdToken(token, knownIds), token).toBe(false)
      expect(hasValidSpdxExpressionShape(token), token).toBe(false)
    }
  })

  it('does not treat arbitrary product version tokens as SPDX-like IDs', () => {
    for (const token of [
      'Product-1.0',
      'Project-2.0',
      'Widget-2026.1',
      '3D-1.0',
      'AI-2.0',
      'US-1.0',
    ]) {
      expect(isSpdxLikeIdToken(token, knownIds), token).toBe(false)
      expect(hasSpdxIdToken(token, knownIds), token).toBe(false)
    }

    for (const token of [
      'SSPL-1.0',
      'sspl-1.0',
      'BUSL-1.1',
      'CC-BY-4.0',
      'CECILL-2.1',
      'Elastic-2.0',
      'NAIST-2003',
      'naist-2003',
      'OFL-1.1',
      'OSL-3.0',
      'osl-3.0',
      'PolyForm-Noncommercial-1.0.0',
      'W3C-20150513',
      'ZPL-2.1',
    ]) {
      expect(isSpdxLikeIdToken(token, knownIds), token).toBe(true)
      expect(hasSpdxIdToken(token, knownIds), token).toBe(true)
    }
  })

  it('keeps SPDX IDs with year-like suffixes in semicolon tails', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT; NAIST-2003',
        knownIds,
      ),
    ).toBeUndefined()
  })
})

describe('SPDX identifier detection', () => {
  it('detects a standard SPDX license identifier line', () => {
    expect(
      detectSpdxIdentifier('SPDX-License-Identifier: MIT', knownIds),
    ).toMatchObject({
      expression: 'MIT',
      ids: ['MIT'],
    })
  })

  it('uses the current known ID set contents', () => {
    const mutableKnownIds = new Set(['MIT'])
    expect(
      detectSpdxIdentifier('SPDX-License-Identifier: mit', mutableKnownIds),
    ).toMatchObject({
      ids: ['MIT'],
      unsupportedIds: [],
    })
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT; isc',
        mutableKnownIds,
      ),
    ).toMatchObject({
      ids: ['MIT'],
      unsupportedIds: [],
    })

    mutableKnownIds.add('Apache-2.0')
    mutableKnownIds.add('ISC')
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: apache-2.0',
        mutableKnownIds,
      ),
    ).toMatchObject({
      ids: ['Apache-2.0'],
      unsupportedIds: [],
    })

    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT; isc',
        mutableKnownIds,
      ),
    ).toBeUndefined()

    mutableKnownIds.delete('MIT')
    mutableKnownIds.add('Zlib')
    expect(isSpdxLikeIdToken('zlib', mutableKnownIds)).toBe(true)
    expect(isSpdxLikeIdToken('mit', mutableKnownIds)).toBe(false)
    expect(
      detectSpdxIdentifier('SPDX-License-Identifier: zlib', mutableKnownIds),
    ).toMatchObject({
      ids: ['Zlib'],
      unsupportedIds: [],
    })

    const caseConflictingKnownIds = new Set(['Foo-Bar', 'foo-bar'])
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: foo-bar',
        caseConflictingKnownIds,
      ),
    ).toMatchObject({
      ids: ['foo-bar'],
      unsupportedIds: [],
    })

    caseConflictingKnownIds.delete('Foo-Bar')
    caseConflictingKnownIds.add('Foo-Bar')
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: foo-bar',
        caseConflictingKnownIds,
      ),
    ).toMatchObject({
      ids: ['Foo-Bar'],
      unsupportedIds: [],
    })
  })

  it('detects bare expressions with whitespace around parentheses', () => {
    expect(
      detectSpdxIdentifier('( MIT OR Apache-2.0 )', knownIds),
    ).toMatchObject({
      expression: '( MIT OR Apache-2.0 )',
      ids: ['MIT', 'Apache-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('detects bare official SPDX IDs outside the support set', () => {
    expect(detectSpdxIdentifier('BSD-4-Clause', knownIds)).toMatchObject({
      expression: 'BSD-4-Clause',
      ids: ['BSD-4-Clause'],
      unsupportedIds: ['BSD-4-Clause'],
      hasCompoundExpression: false,
      hasConjunctiveExpression: false,
    })
    expect(detectSpdxIdentifier('bsd-4-clause', knownIds)).toMatchObject({
      expression: 'bsd-4-clause',
      ids: ['BSD-4-Clause'],
      unsupportedIds: ['BSD-4-Clause'],
      hasCompoundExpression: false,
      hasConjunctiveExpression: false,
    })
    expect(
      detectSpdxIdentifier('MIT AND BSD-4-Clause', knownIds),
    ).toMatchObject({
      expression: 'MIT AND BSD-4-Clause',
      ids: ['MIT', 'BSD-4-Clause'],
      unsupportedIds: ['BSD-4-Clause'],
      hasCompoundExpression: true,
      hasConjunctiveExpression: true,
    })
    expect(
      detectSpdxIdentifier('GPL-2.0-with-GCC-exception', knownIds),
    ).toMatchObject({
      expression: 'GPL-2.0-with-GCC-exception',
      ids: ['GPL-2.0-with-GCC-exception'],
      unsupportedIds: ['GPL-2.0-with-GCC-exception'],
      hasCompoundExpression: false,
      hasConjunctiveExpression: false,
    })
    expect(detectSpdxIdentifier('Not-A-License', knownIds)).toBeUndefined()
  })

  it('does not read SPDX identifiers from empty tags', () => {
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
      'SPDX-License-Identifier: ---',
      'SPDX-License-Identifier: MIT OR ---',
      'SPDX-License-Identifier: MIT WITH ---',
      'SPDX-License-Identifier: MIT Apache-2.0',
      'SPDX-License-Identifier: DocumentRef-guide',
      'SPDX-License-Identifier: DocumentRef-doc:Section-1',
      'SPDX-License-Identifier: MIT WITH (Classpath-exception-2.0)',
      'SPDX-License-Identifier: (MIT) WITH Classpath-exception-2.0',
      'SPDX-License-Identifier: (MIT OR Apache-2.0) WITH Classpath-exception-2.0',
      'SPDX-License-Identifier: MIT WITH GPL-2.0-only',
      'SPDX-License-Identifier: MIT WITH LicenseRef-Custom',
      'SPDX-License-Identifier: MIT WITH LicenseRef-Custom+Exception',
      'SPDX-License-Identifier: MIT WITH Apache-2.0 WITH GPL-2.0-only',
      'SPDX-License-Identifier: MIT WITH GPL-2.0-with-GCC-exception',
      'SPDX-License-Identifier: MIT WITH MPL-2.0-no-copyleft-exception',
      'SPDX-License-Identifier: Classpath-exception-2.0',
      'SPDX-License-Identifier: MIT AND Classpath-exception-2.0',
      'SPDX-License-Identifier: LicenseRef-',
      'SPDX-License-Identifier: LicenseRef-Custom+Exception',
      'SPDX-License-Identifier: LicenseRef-foo:bar',
      'SPDX-License-Identifier: licenseref-Custom',
      'SPDX-License-Identifier: DocumentRef-example+tool:LicenseRef-Custom',
      'SPDX-License-Identifier: DocumentRef-:LicenseRef-Custom',
      'SPDX-License-Identifier: DocumentRef-doc:LicenseRef-',
      'SPDX-License-Identifier: DocumentRef-doc:LicenseRef-Custom+Exception',
      'SPDX-License-Identifier: documentref-doc:LicenseRef-Custom',
      'SPDX-License-Identifier: DocumentRef-doc:licenseref-Custom',
      'SPDX-License-Identifier: DocumentRef-doc:LicenseRef-Custom:extra',
    ]) {
      expect(detectSpdxIdentifier(input, knownIds), input).toBeUndefined()
    }
  })

  it('ignores prose that only mentions an SPDX tag', () => {
    expect(
      detectSpdxIdentifier('Do not use SPDX-License-Identifier: MIT', knownIds),
    ).toBeUndefined()
  })

  it('detects SPDX identifiers in comments', () => {
    for (const input of [
      '<!-- SPDX-License-Identifier: MIT --> Copyright 2026',
      '/* SPDX-License-Identifier: MIT */ Copyright 2026',
      '/** SPDX-License-Identifier: MIT */ Copyright 2026',
      '/// SPDX-License-Identifier: MIT',
      '//! SPDX-License-Identifier: MIT',
      '- SPDX-License-Identifier: MIT',
    ]) {
      expect(detectSpdxIdentifier(input, knownIds)).toMatchObject({
        expression: 'MIT',
        ids: ['MIT'],
        unsupportedIds: [],
        hasCompoundExpression: false,
      })
    }
  })

  it('trims inline comments after SPDX identifier lines', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT # internal note',
      'SPDX-License-Identifier: MIT // internal note',
      'SPDX-License-Identifier: MIT ; internal note',
      'SPDX-License-Identifier: MIT -- internal note',
      'SPDX-License-Identifier: MIT; internal note',
      'SPDX-License-Identifier: MIT; internal note 2026',
      'SPDX-License-Identifier: MIT; internal-note-here',
      'SPDX-License-Identifier: MIT; issue-123',
      'SPDX-License-Identifier: MIT; note2',
      'SPDX-License-Identifier: MIT; TODO',
      'SPDX-License-Identifier: MIT; TODO-2026',
      'SPDX-License-Identifier: MIT; TODO internal note',
      'SPDX-License-Identifier: MIT; NOTE',
      'SPDX-License-Identifier: MIT; NOTE internal note',
      'SPDX-License-Identifier: MIT; NOTE, internal review',
      'SPDX-License-Identifier: MIT; additional license information',
      'SPDX-License-Identifier: MIT; also see LICENSE',
      'SPDX-License-Identifier: MIT; also see license file',
      'SPDX-License-Identifier: MIT; License, Terms Apply',
      'SPDX-License-Identifier: MIT; Acme, Corp',
      'SPDX-License-Identifier: MIT; Copyright, Holder',
      'SPDX-License-Identifier: MIT; ISC, Inc',
      'SPDX-License-Identifier: MIT; Zlib, Ltd',
      'SPDX-License-Identifier: MIT; INTERNAL, TESTING',
      'SPDX-License-Identifier: MIT; UnknownLicense, AnotherUnknown',
      'SPDX-License-Identifier: MIT; Foo, Bar',
      'SPDX-License-Identifier: MIT; Foo,',
      'SPDX-License-Identifier: MIT; ACME-2024',
      'SPDX-License-Identifier: MIT; TODO AND NOTE',
      'SPDX-License-Identifier: MIT; DocumentRef-guide',
      'SPDX-License-Identifier: MIT; Reference: DocumentRef-guide',
      'SPDX-License-Identifier: MIT; DocumentRef-doc:Section-1',
      'SPDX-License-Identifier: MIT; Apache-2.0 for dependencies',
      'SPDX-License-Identifier: MIT; Apache-2.0 for dependencies; ISC',
      'SPDX-License-Identifier: MIT; Apache-2.0 for package dependencies',
      'SPDX-License-Identifier: MIT; Apache-2.0 for the project dependencies',
      'SPDX-License-Identifier: MIT; Apache License 2.0 for source code dependencies',
      'SPDX-License-Identifier: MIT; also Apache-2.0 for dependencies',
      'SPDX-License-Identifier: MIT; also; Apache-2.0 for dependencies',
      'SPDX-License-Identifier: MIT; also Apache-2.0 for dependencies; ISC',
      'SPDX-License-Identifier: MIT; also; Apache-2.0 for dependencies; ISC',
      'SPDX-License-Identifier: MIT; also under Apache-2.0 for dependencies',
      'SPDX-License-Identifier: MIT; also licensed under Apache-2.0 for runtime dependencies',
      'SPDX-License-Identifier: MIT; also licensed under Apache License 2.0 for dependencies',
      'SPDX-License-Identifier: MIT; see also Apache-2.0 for dependencies',
      'SPDX-License-Identifier: MIT; Apache-2.0 with runtime dependencies',
      'SPDX-License-Identifier: MIT; Apache-2.0 (runtime dependency)',
      'SPDX-License-Identifier: MIT; Apache-2.0 and ISC for dependencies',
      'SPDX-License-Identifier: MIT; UTF-8',
      'SPDX-License-Identifier: MIT; RFC-2119',
      'SPDX-License-Identifier: MIT; ISO-639-1',
      'SPDX-License-Identifier: MIT-- internal note',
      'SPDX-License-Identifier: MIT// internal note',
      'SPDX-License-Identifier: MIT# internal note',
      'SPDX-License-Identifier: MIT /* internal note */',
      'SPDX-License-Identifier: MIT/* internal note */',
    ]) {
      expect(detectSpdxIdentifier(input, knownIds)).toMatchObject({
        expression: 'MIT',
        ids: ['MIT'],
        unsupportedIds: [],
        hasCompoundExpression: false,
      })
    }
  })

  it('trims inline comments after parenthesized SPDX expressions', () => {
    for (const input of [
      'SPDX-License-Identifier: (MIT OR Apache-2.0) # internal note',
      'SPDX-License-Identifier: (MIT OR Apache-2.0) // internal note',
      'SPDX-License-Identifier: (MIT OR Apache-2.0) ; internal note',
      'SPDX-License-Identifier: (MIT OR Apache-2.0) -- internal note',
      'SPDX-License-Identifier: (MIT OR Apache-2.0); internal note',
      'SPDX-License-Identifier: (MIT OR Apache-2.0)// internal note',
      'SPDX-License-Identifier: (MIT OR Apache-2.0)# internal note',
    ]) {
      expect(detectSpdxIdentifier(input, knownIds)).toMatchObject({
        expression: '(MIT OR Apache-2.0)',
        ids: ['MIT', 'Apache-2.0'],
        unsupportedIds: [],
        hasCompoundExpression: true,
      })
    }
  })

  it('rejects semicolon-separated SPDX IDs instead of trimming them', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT; Apache-2.0',
      'SPDX-License-Identifier: MIT; and Apache-2.0',
      'SPDX-License-Identifier: MIT; or Apache-2.0',
      'SPDX-License-Identifier: MIT; with Classpath-exception-2.0',
      'SPDX-License-Identifier: MIT; Apache-2.0 (Apache License)',
      'SPDX-License-Identifier: MIT; Apache-2.0 OR ISC',
      'SPDX-License-Identifier: MIT; Apache-2.0 and ISC',
      'SPDX-License-Identifier: MIT; Zlib',
      'SPDX-License-Identifier: MIT; zlib',
      'SPDX-License-Identifier: MIT; Unlicense',
      'SPDX-License-Identifier: MIT; unlicense',
      'SPDX-License-Identifier: MIT; PostgreSQL',
      'SPDX-License-Identifier: MIT; postgresql',
      'SPDX-License-Identifier: MIT; Apache-2.0 WITH Classpath-exception-2.0',
      'SPDX-License-Identifier: MIT; Apache-2.0 WITH GPL-2.0-only',
      'SPDX-License-Identifier: MIT; Apache-2.0 AND ISC for dependencies',
      'SPDX-License-Identifier: MIT; Classpath-exception-2.0',
      'SPDX-License-Identifier: MIT; Apache-2.0; internal note',
      'SPDX-License-Identifier: MIT; Apache-2.0; ISC',
      'SPDX-License-Identifier: MIT; internal note; also Apache-2.0',
      'SPDX-License-Identifier: MIT; dual license; Apache-2.0',
      'SPDX-License-Identifier: MIT; dual licensed; Apache-2.0',
      'SPDX-License-Identifier: MIT; dual-licensed; Apache-2.0',
      'SPDX-License-Identifier: MIT; dual licensing; Apache-2.0',
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
      'SPDX-License-Identifier: MIT; dual license; LicenseRef-',
      'SPDX-License-Identifier: MIT; dual license; DocumentRef-doc:LicenseRef-',
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
      'SPDX-License-Identifier: MIT; Apache-2.0 for this project and runtime dependencies',
      'SPDX-License-Identifier: MIT; Apache-2.0 for dependencies; GPL-2.0 for this project',
      'SPDX-License-Identifier: MIT; Apache-2.0, ISC',
      'SPDX-License-Identifier: MIT; Not-A-License, ISC',
      'SPDX-License-Identifier: MIT; UnknownLicense, Apache-2.0',
      'SPDX-License-Identifier: Apache-2.0; MIT',
      'SPDX-License-Identifier: MIT; ISC',
      'SPDX-License-Identifier: MIT; Unlicense',
      'SPDX-License-Identifier: MIT; Not-A-License',
      'SPDX-License-Identifier: MIT; LicenseRef-Proprietary',
      'SPDX-License-Identifier: MIT; LicenseRef-',
      'SPDX-License-Identifier: MIT; DocumentRef-doc:LicenseRef-',
      'SPDX-License-Identifier: MIT; SSPL-1.0',
      'SPDX-License-Identifier: MIT; SSPL-1.0 (Server Side Public License)',
      'SPDX-License-Identifier: MIT; BUSL-1.1',
      'SPDX-License-Identifier: MIT; Elastic-2.0',
      'SPDX-License-Identifier: MIT; PolyForm-Noncommercial-1.0.0',
      'SPDX-License-Identifier: MIT; GPL-2.0+',
      'SPDX-License-Identifier: MIT; gpl-2.0+',
      'SPDX-License-Identifier: MIT; gpl-2.0+ (GNU General Public License)',
    ]) {
      expect(detectSpdxIdentifier(input, knownIds), input).toBeUndefined()
    }
  })

  it('trims semicolon notes before later license-looking text without secondary cues', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT; internal note; Apache-2.0',
      'SPDX-License-Identifier: MIT; also internal note; Apache-2.0',
      'SPDX-License-Identifier: MIT; note; Apache License 2.0',
      'SPDX-License-Identifier: MIT; note; BSD 3-Clause',
      'SPDX-License-Identifier: MIT; see also; ISC',
    ]) {
      expect(detectSpdxIdentifier(input, knownIds), input).toMatchObject({
        expression: 'MIT',
        ids: ['MIT'],
        unsupportedIds: [],
        hasCompoundExpression: false,
      })
    }
  })

  it('scans repeated semicolon secondary-license cues without rescanning tails', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT; ' + 'also; '.repeat(20_000),
        knownIds,
      ),
    ).toMatchObject({
      expression: 'MIT',
      ids: ['MIT'],
      unsupportedIds: [],
      hasCompoundExpression: false,
    })
  })

  it('rejects unscanned secondary license tails after the semicolon scan limit', () => {
    for (const input of [
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(100)}also Apache-2.0`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(199)}also; Apache-2.0`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}other licences; Apache-2.0`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}also Apache-2.0; GPL-2.0 for dependencies`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(199)}also Apache-2.0 for dependencies; GPL-2.0 for this project`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}Apache-2.0 for dependencies; ${'note; '.repeat(101)}also GPL-2.0`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}Apache-2.0 for dependencies; ${'note; '.repeat(101)}also; GPL-2.0`,
    ]) {
      expect(detectSpdxIdentifier(input, knownIds), input).toBeUndefined()
    }
  })

  it('trims unscanned semicolon notes without secondary license tails', () => {
    for (const input of [
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(100)}internal note`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(100)}other Apache-2.0`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}see also; ISC`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}the second paragraph mentions Apache-2.0`,
    ]) {
      expect(detectSpdxIdentifier(input, knownIds), input).toMatchObject({
        expression: 'MIT',
        ids: ['MIT'],
        unsupportedIds: [],
        hasCompoundExpression: false,
      })
    }
  })

  it('trims unscanned dependency-scoped license tails after the scan limit', () => {
    for (const input of [
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(100)}also Apache-2.0 for dependencies`,
      `SPDX-License-Identifier: MIT; also; ${'note; '.repeat(100)}Apache-2.0 for dependencies`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(199)}also; Apache-2.0 for dependencies`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}also Apache-2.0 for dependencies`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}also Apache-2.0 for dependencies; ISC`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}also Apache-2.0 for dependencies; internal note`,
      `SPDX-License-Identifier: MIT; ${'note; '.repeat(200)}also Apache-2.0 for dependencies; GPL-2.0 for dependencies`,
    ]) {
      expect(detectSpdxIdentifier(input, knownIds), input).toMatchObject({
        expression: 'MIT',
        ids: ['MIT'],
        unsupportedIds: [],
        hasCompoundExpression: false,
      })
    }
  })

  it('detects GNU or-later IDs without treating them as compound expressions', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: GPL-3.0-or-later',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'GPL-3.0-or-later',
      ids: ['GPL-3.0-or-later'],
      unsupportedIds: [],
      hasCompoundExpression: false,
      hasWithException: false,
    })
  })

  it('deduplicates repeated SPDX lines after canonicalizing IDs', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT\nSPDX-License-Identifier: mit',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'MIT',
      ids: ['MIT'],
      unsupportedIds: [],
      hasCompoundExpression: false,
    })
  })

  it('keeps distinct SPDX expressions with the same IDs', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT OR Apache-2.0\nSPDX-License-Identifier: MIT AND Apache-2.0',
        knownIds,
      ),
    ).toMatchObject({
      expression: '(MIT OR Apache-2.0) AND (MIT AND Apache-2.0)',
      ids: ['MIT', 'Apache-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('deduplicates repeated SPDX expressions with different spacing', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT OR Apache-2.0\nSPDX-License-Identifier: MIT  OR   apache-2.0',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'MIT OR Apache-2.0',
      ids: ['MIT', 'Apache-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('deduplicates repeated SPDX expressions with redundant outer parentheses', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: (MIT OR Apache-2.0)\nSPDX-License-Identifier: MIT OR Apache-2.0',
        knownIds,
      ),
    ).toMatchObject({
      expression: '(MIT OR Apache-2.0)',
      ids: ['MIT', 'Apache-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('deduplicates repeated SPDX expressions with redundant operand parentheses', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: (MIT) OR Apache-2.0\nSPDX-License-Identifier: MIT OR Apache-2.0',
        knownIds,
      ),
    ).toMatchObject({
      expression: '(MIT) OR Apache-2.0',
      ids: ['MIT', 'Apache-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('keeps distinct SPDX expressions with different internal grouping', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT AND (Apache-2.0 OR BSD-2-Clause)\nSPDX-License-Identifier: MIT AND Apache-2.0 OR BSD-2-Clause',
        knownIds,
      ),
    ).toMatchObject({
      expression:
        '(MIT AND (Apache-2.0 OR BSD-2-Clause)) AND (MIT AND Apache-2.0 OR BSD-2-Clause)',
      ids: ['MIT', 'Apache-2.0', 'BSD-2-Clause'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('deduplicates repeated SPDX expressions before combining distinct ones', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT OR Apache-2.0\nSPDX-License-Identifier: MIT  OR   apache-2.0\nSPDX-License-Identifier: MIT AND Apache-2.0',
        knownIds,
      ),
    ).toMatchObject({
      expression: '(MIT OR Apache-2.0) AND (MIT AND Apache-2.0)',
      ids: ['MIT', 'Apache-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('deduplicates repeated SPDX WITH expressions with exception casing differences', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception\nSPDX-License-Identifier: apache-2.0 WITH llvm-exception',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'Apache-2.0 WITH LLVM-exception',
      ids: ['Apache-2.0', 'LLVM-exception'],
      unsupportedIds: [],
      hasCompoundExpression: false,
      hasWithException: true,
    })
  })

  it('deduplicates repeated unsupported SPDX expressions with casing differences', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: Not-A-License\nSPDX-License-Identifier: not-a-license',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'Not-A-License',
      ids: ['Not-A-License'],
      unsupportedIds: ['Not-A-License'],
      hasCompoundExpression: false,
    })
  })

  it('keeps distinct custom SPDX references with different casing', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: LicenseRef-Foo\nSPDX-License-Identifier: LicenseRef-foo',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'LicenseRef-Foo AND LicenseRef-foo',
      ids: ['LicenseRef-Foo', 'LicenseRef-foo'],
      unsupportedIds: ['LicenseRef-Foo', 'LicenseRef-foo'],
      hasCompoundExpression: true,
    })
  })

  it('normalizes identifier casing to canonical SPDX IDs', () => {
    expect(
      detectSpdxIdentifier('SPDX-License-Identifier: mit', knownIds),
    ).toMatchObject({
      expression: 'mit',
      ids: ['MIT'],
    })
  })

  it('treats SPDX list IDs as case-insensitive SPDX-like tokens', () => {
    expect(isSpdxLikeIdToken('beerware')).toBe(true)
    expect(isSpdxLikeIdToken('vim')).toBe(true)
    expect(isSpdxLikeIdToken('w3c')).toBe(true)
  })

  it('keeps unsupported IDs from explicit SPDX lines', () => {
    expect(
      detectSpdxIdentifier('SPDX-License-Identifier: Not-A-License', knownIds),
    ).toMatchObject({
      expression: 'Not-A-License',
      ids: ['Not-A-License'],
      unsupportedIds: ['Not-A-License'],
      hasCompoundExpression: false,
      hasWithException: false,
    })
    expect(detectSpdxIdentifier('Not-A-License', knownIds)).toBeUndefined()
  })

  it('keeps LicenseRef IDs from explicit SPDX lines', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: DocumentRef-example:LicenseRef-Custom',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'DocumentRef-example:LicenseRef-Custom',
      ids: ['DocumentRef-example:LicenseRef-Custom'],
      unsupportedIds: ['DocumentRef-example:LicenseRef-Custom'],
      hasCompoundExpression: false,
      hasWithException: false,
    })
  })

  it('does not treat double hyphens inside IDs as inline comments', () => {
    expect(
      detectSpdxIdentifier('SPDX-License-Identifier: MIT--custom', knownIds),
    ).toMatchObject({
      expression: 'MIT--custom',
      ids: ['MIT--custom'],
      unsupportedIds: ['MIT--custom'],
    })
  })

  it('keeps unsupported IDs and WITH exceptions out of exact single-license matches', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT OR Not-A-License',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'MIT OR Not-A-License',
      ids: ['MIT', 'Not-A-License'],
      unsupportedIds: ['Not-A-License'],
      hasCompoundExpression: true,
    })
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'Apache-2.0 WITH LLVM-exception',
      ids: ['Apache-2.0', 'LLVM-exception'],
      unsupportedIds: [],
      hasCompoundExpression: false,
      hasWithException: true,
    })
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: GPL-2.0-only WITH SHL-2.0',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'GPL-2.0-only WITH SHL-2.0',
      ids: ['GPL-2.0-only', 'SHL-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: false,
      hasWithException: true,
    })
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT WITH Foo-exception',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'MIT WITH Foo-exception',
      ids: ['MIT', 'Foo-exception'],
      unsupportedIds: [],
      hasCompoundExpression: false,
      hasWithException: true,
    })
  })

  it('rejects same-line SPDX IDs without an operator', () => {
    expect(
      detectSpdxIdentifier('SPDX-License-Identifier: MIT Apache-2.0', knownIds),
    ).toBeUndefined()
  })

  it('rejects multi-line SPDX input when any explicit line is malformed', () => {
    for (const input of [
      'SPDX-License-Identifier: MIT AND\nSPDX-License-Identifier: Apache-2.0',
      'SPDX-License-Identifier: [MIT]\nSPDX-License-Identifier: Apache-2.0',
      'SPDX-License-Identifier:\nSPDX-License-Identifier: MIT',
      'SPDX-License-Identifier: MIT\nSPDX-License-Identifier:',
      'SPDX-License-Identifier: MIT\nSPDX-License-Identifier: Apache-2.0 OR',
    ]) {
      expect(detectSpdxIdentifier(input, knownIds), input).toBeUndefined()
    }
  })

  it('marks conflicting repeated SPDX lines as compound input', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT\nSPDX-License-Identifier: Apache-2.0',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'MIT AND Apache-2.0',
      ids: ['MIT', 'Apache-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('parenthesizes compound SPDX lines before combining them', () => {
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT OR Apache-2.0' +
          String.fromCharCode(10) +
          'SPDX-License-Identifier: GPL-3.0-only',
        knownIds,
      ),
    ).toMatchObject({
      expression: '(MIT OR Apache-2.0) AND GPL-3.0-only',
      ids: ['MIT', 'Apache-2.0', 'GPL-3.0-only'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('detects bare parenthesized SPDX compound expressions', () => {
    expect(detectSpdxIdentifier('(MIT OR Apache-2.0)', knownIds)).toMatchObject(
      {
        expression: '(MIT OR Apache-2.0)',
        ids: ['MIT', 'Apache-2.0'],
        unsupportedIds: [],
        hasCompoundExpression: true,
      },
    )

    expect(
      detectSpdxIdentifier('MIT AND (Apache-2.0 OR BSD-2-Clause)', knownIds),
    ).toMatchObject({
      expression: 'MIT AND (Apache-2.0 OR BSD-2-Clause)',
      ids: ['MIT', 'Apache-2.0', 'BSD-2-Clause'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('detects SPDX expressions with lowercase compound operators', () => {
    expect(detectSpdxIdentifier('MIT or Apache-2.0', knownIds)).toMatchObject({
      expression: 'MIT or Apache-2.0',
      ids: ['MIT', 'Apache-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
    expect(
      detectSpdxIdentifier(
        'SPDX-License-Identifier: MIT Or Apache-2.0',
        knownIds,
      ),
    ).toMatchObject({
      expression: 'MIT Or Apache-2.0',
      ids: ['MIT', 'Apache-2.0'],
      unsupportedIds: [],
      hasCompoundExpression: true,
    })
  })

  it('rejects invalid bare SPDX-like prose without ambiguous operator matching', () => {
    const input = 'MIT OR '.repeat(40) + '!'

    expect(detectSpdxIdentifier(input, knownIds)).toBeUndefined()
    expect(detectSpdxIdentifier('MIT or whatever', knownIds)).toBeUndefined()
  })

  it('detects bare WITH expressions as unsupported SPDX input', () => {
    expect(
      detectSpdxIdentifier('Apache-2.0 WITH LLVM-exception', knownIds),
    ).toMatchObject({
      expression: 'Apache-2.0 WITH LLVM-exception',
      ids: ['Apache-2.0', 'LLVM-exception'],
      unsupportedIds: [],
      hasCompoundExpression: false,
      hasWithException: true,
    })
    expect(
      detectSpdxIdentifier('Apache-2.0 with LLVM-exception', knownIds),
    ).toMatchObject({
      expression: 'Apache-2.0 with LLVM-exception',
      ids: ['Apache-2.0', 'LLVM-exception'],
      unsupportedIds: [],
      hasCompoundExpression: false,
      hasWithException: true,
    })
  })

  it('rejects bare WITH expressions with remaining unsupported IDs', () => {
    expect(
      detectSpdxIdentifier(
        'Apache-2.0 WITH LLVM-exception AND Not-A-License',
        knownIds,
      ),
    ).toBeUndefined()
  })

  it('detects plus-form legacy GNU identifiers', () => {
    for (const input of ['SPDX-License-Identifier: GPL-2.0+', 'GPL-2.0+']) {
      expect(detectSpdxIdentifier(input, knownIds)).toMatchObject({
        ids: ['GPL-2.0+'],
        unsupportedIds: [],
        hasCompoundExpression: false,
        hasWithException: false,
        legacyAlias: {
          legacyId: 'GPL-2.0+',
          candidates: ['GPL-2.0-or-later'],
        },
      })
    }
  })

  it('detects legacy GNU identifiers separately', () => {
    expect(
      detectSpdxIdentifier('SPDX-License-Identifier: GPL-2.0', knownIds)
        ?.legacyAlias,
    ).toMatchObject({
      legacyId: 'GPL-2.0',
      candidates: ['GPL-2.0-only', 'GPL-2.0-or-later'],
    })
  })
})
