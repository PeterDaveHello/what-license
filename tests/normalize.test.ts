import { describe, expect, it } from 'vitest'
import {
  normalizeLoose,
  normalizeStrict,
  stripCommentShell,
  tokenizeWords,
} from '../src/core/normalize'

describe('normalization', () => {
  it('normalizes unicode, whitespace, copyright years, and comment shells', () => {
    expect(normalizeStrict('/* Copyright © 2026  Example  */')).toBe(
      'copyright <year> example',
    )
    expect(normalizeStrict('/*! MIT License */')).toBe('mit license')
    expect(normalizeStrict('/**! MIT License */')).toBe('mit license')
    expect(normalizeStrict('Copyright © 2020–2024 Example')).toBe(
      'copyright <year> example',
    )
    expect(normalizeStrict('Copyright 2020—2024 Example')).toBe(
      'copyright <year> example',
    )
    expect(normalizeStrict('Copyright 2020, 2021 and 2022 Example')).toBe(
      'copyright <year> example',
    )
    expect(normalizeStrict('Copyright © 2020 or 2021 Example')).toBe(
      'copyright <year> example',
    )
    expect(normalizeStrict('Copyright 2020 2021 2022 Example')).toBe(
      'copyright <year> example',
    )
    expect(normalizeStrict('Copyright 2020 --- 2021 Example')).toBe(
      'copyright <year> example',
    )
    expect(normalizeStrict('Copyright © 2020 , , 2021 Example')).toBe(
      'copyright <year> example',
    )
  })

  it('removes shebang comment lines before stripping comment shells', () => {
    expect(normalizeStrict('#!/usr/bin/env node\n// MIT License')).toBe(
      'mit license',
    )
  })

  it('normalizes CRLF input while stripping comment shells', () => {
    expect(stripCommentShell('/*\r\n * MIT License\r\n */')).toBe('MIT License')
  })

  it('strips block comment shells after leading lines', () => {
    expect(normalizeStrict('/**/')).toBe('')
    expect(normalizeStrict('/***/')).toBe('')
    expect(normalizeStrict('/** MIT */')).toBe('mit')
    expect(
      normalizeStrict(
        'SPDX-License-Identifier: MIT\n/* Copyright © 2026 Example */',
      ),
    ).toBe('spdx-license-identifier: mit\ncopyright <year> example')
    expect(normalizeStrict('/*!\n * MIT License\n */')).toBe('mit license')
    expect(
      normalizeStrict('/* MIT License */\n/* Permission is hereby granted */'),
    ).toBe('mit license\npermission is hereby granted')
    expect(
      normalizeStrict(
        'SPDX-License-Identifier: MIT\n/*\n * Copyright © 2026 Example\n */',
      ),
    ).toBe('spdx-license-identifier: mit\ncopyright <year> example')
    expect(
      normalizeStrict(
        'SPDX-License-Identifier: MIT\n/* Copyright © 2026 Example\n * Permission is hereby granted\n */',
      ),
    ).toBe(
      'spdx-license-identifier: mit\ncopyright <year> example\npermission is hereby granted',
    )
    expect(
      normalizeStrict(
        'SPDX-License-Identifier: MIT\n/*\n * Copyright © 2026 Example */',
      ),
    ).toBe('spdx-license-identifier: mit\ncopyright <year> example')
    expect(
      stripCommentShell('/*\n * MIT License */ trailing\nPlain text'),
    ).toBe('MIT License\nPlain text')
    expect(
      stripCommentShell('/*\n * MIT\n */ Copyright (c) 2026 Example'),
    ).toBe('MIT\nCopyright (c) 2026 Example')
    expect(
      normalizeStrict(
        '/* MIT License\nPermission is hereby granted\nCopyright © 2026 Example */',
      ),
    ).toBe(
      'mit license\npermission is hereby granted\ncopyright <year> example',
    )
    expect(
      normalizeStrict(
        '/* MIT License\nPermission is hereby granted\nMIT License */',
      ),
    ).toBe('mit license\npermission is hereby granted\nmit license')
    expect(
      normalizeStrict('/* MIT\nPermission is hereby granted\nMIT */'),
    ).toBe('mit\npermission is hereby granted\nmit')
    expect(
      normalizeStrict('/* Apache\nPermission is hereby granted\nApache */'),
    ).toBe('apache\npermission is hereby granted\napache')
    expect(
      normalizeStrict(
        '/* BSD-3-Clause\nRedistribution and use\nBSD-3-Clause */',
      ),
    ).toBe('bsd-3-clause\nredistribution and use\nbsd-3-clause')
    for (const id of [
      'MS-PL',
      'NCSA',
      'PostgreSQL',
      'WTFPL',
      'AFL-3.0',
      'BSL-1.0',
      'Artistic-2.0',
      'BlueOak-1.0.0',
      'MPL-2.0',
      'MPL 2.0',
      'MPL v2.0',
    ]) {
      expect(normalizeStrict('/* ' + id + '\n' + id + ' */'), id).toBe(
        id.toLowerCase() + '\n' + id.toLowerCase(),
      )
    }
  })

  it('keeps long near-miss block comment lines responsive', () => {
    const input = 'MIT License\n/*' + '*'.repeat(20_000) + 'x'

    expect(normalizeStrict(input)).toBe(input.toLowerCase())
  })

  it('keeps unmatched block markers after leading lines', () => {
    expect(normalizeStrict('MIT License\n/* literal marker')).toBe(
      'mit license\n/* literal marker',
    )
    expect(normalizeStrict('MIT License\nliteral marker */')).toBe(
      'mit license\nliteral marker */',
    )
    expect(normalizeStrict('/* marker\nMIT License\nmarker */')).toBe(
      '/* marker\nmit license\nmarker */',
    )
    expect(normalizeStrict('/* begin\nMIT License\nend */')).toBe(
      '/* begin\nmit license\nend */',
    )
    expect(
      normalizeStrict('/* marker\n/* MIT License */\nMIT License\nmarker */'),
    ).toBe('/* marker\nmit license\nmit license\nmarker */')
  })

  it('normalizes spaces around line breaks', () => {
    expect(normalizeStrict('MIT \n License')).toBe(
      normalizeStrict('MIT\nLicense'),
    )
  })

  it('keeps non-copyright four-digit numbers while normalizing years', () => {
    expect(normalizeLoose('port 8080, copyright 2026, and © 2025')).toBe(
      'port 8080 copyright <year> and copyright <year>',
    )
    expect(normalizeLoose('copyright 2020,\n2021 example')).toBe(
      'copyright <year> 2021 example',
    )
  })

  it('loosens punctuation and tokenizes words', () => {
    expect(normalizeLoose('Permission, hereby granted.')).toBe(
      'permission hereby granted',
    )
    expect(tokenizeWords('Permission, hereby granted.')).toEqual([
      'permission',
      'hereby',
      'granted',
    ])
  })
})
