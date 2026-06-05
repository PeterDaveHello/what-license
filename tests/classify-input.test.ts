import { describe, expect, it } from 'vitest'
import { classifyInput } from '../src/core/classify-input'
import { licenses } from '../src/data/licenses.generated'

const byId = new Map(
  licenses.map((license) => [license.licenseId, license.text]),
)
const knownIds = new Set(licenses.map((license) => license.licenseId))

function licenseText(licenseId: string): string {
  const text = byId.get(licenseId)
  if (!text) throw new Error(licenseId + ' not found in test data')
  return text
}

describe('input classification', () => {
  it('classifies SPDX identifiers', () => {
    expect(classifyInput('SPDX-License-Identifier: Apache-2.0')).toBe(
      'spdx-expression',
    )
    expect(classifyInput('MIT')).toBe('spdx-expression')
    expect(classifyInput('MIT OR Apache-2.0')).toBe('spdx-expression')
    expect(classifyInput('MIT or Apache-2.0')).toBe('spdx-expression')
    expect(classifyInput('SPDX-License-Identifier: (MIT OR Apache-2.0)')).toBe(
      'spdx-expression',
    )
    expect(
      classifyInput(
        'SPDX-License-Identifier: MIT with Classpath-exception-2.0',
      ),
    ).toBe('spdx-expression')
    expect(classifyInput('SPDX-License-Identifier: MIT /* note */')).toBe(
      'spdx-expression',
    )
    expect(classifyInput('SPDX-License-Identifier: MIT -- note')).toBe(
      'spdx-expression',
    )
    expect(
      classifyInput(
        'SPDX-License-Identifier: DocumentRef-example:LicenseRef-Custom',
      ),
    ).toBe('spdx-expression')
    expect(
      classifyInput(
        'SPDX-License-Identifier: MIT\nSPDX-License-Identifier: mit',
      ),
    ).toBe('spdx-expression')
    expect(classifyInput('SPDX-License-Identifier: MIT; TODO')).toBe(
      'spdx-expression',
    )
    expect(
      classifyInput('SPDX-License-Identifier: MIT; INTERNAL USE ONLY'),
    ).toBe('spdx-expression')
    expect(classifyInput('BUSL-1.1', knownIds)).toBe('spdx-expression')
    expect(classifyInput('SPDX-License-Identifier: BUSL-1.1', knownIds)).toBe(
      'spdx-expression',
    )
  })

  it('does not classify empty SPDX tags as SPDX expressions', () => {
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
      'MIT or whatever',
      'SPDX-License-Identifier: MIT; Apache-2.0',
      'SPDX-License-Identifier: MIT; ISC',
      'SPDX-License-Identifier: MIT; WTFPL',
      'SPDX-License-Identifier: MIT Apache-2.0',
      'SPDX-License-Identifier: (MIT) WITH Classpath-exception-2.0',
      'SPDX-License-Identifier: (MIT OR Apache-2.0) WITH Classpath-exception-2.0',
      'SPDX-License-Identifier: MIT AND\nSPDX-License-Identifier: Apache-2.0',
      'SPDX-License-Identifier: [MIT]\nSPDX-License-Identifier: Apache-2.0',
      'SPDX-License-Identifier:\nSPDX-License-Identifier: MIT',
      'SPDX-License-Identifier: MIT\nSPDX-License-Identifier:',
    ]) {
      expect(classifyInput(input), input).toBe('unknown')
    }
  })

  it('classifies full license text', () => {
    expect(classifyInput(licenseText('MIT'))).toBe('full-license-text')
  })

  it('keeps affirmative permission grants after completed negated clauses', () => {
    const longWarrantyContext =
      ' This file is provided as is without warranty. ' +
      Array.from({ length: 90 }, (_, index) => 'notice' + index).join(' ')
    expect(
      classifyInput(
        'No patent license is granted and permission is hereby granted to use copy modify publish distribute sublicense and sell copies of the Software.' +
          longWarrantyContext,
      ),
    ).toBe('full-license-text')
  })

  it('does not treat negated qualified permission grants as full texts', () => {
    const longWarrantyContext =
      ' This file is provided as is without warranty. ' +
      Array.from({ length: 90 }, (_, index) => 'notice' + index).join(' ')
    for (const input of [
      'No additional permission is granted.' + longWarrantyContext,
      'No separate permission is granted.' + longWarrantyContext,
      'No additional or separate permission is granted.' + longWarrantyContext,
      'No written permission is granted.' + longWarrantyContext,
      'No prior permission is granted.' + longWarrantyContext,
      'No explicit permission is granted.' + longWarrantyContext,
      'No explicit nor written permission is granted.' + longWarrantyContext,
      'No written license or permission is granted.' + longWarrantyContext,
      'No written licence or permission is granted.' + longWarrantyContext,
      'No prior license or permission is granted.' + longWarrantyContext,
      'No explicit license or permission is granted.' + longWarrantyContext,
      'No explicit licences or permission is granted.' + longWarrantyContext,
      'No permission is granted.' + longWarrantyContext,
      'Nor permission is granted.' + longWarrantyContext,
      'Neither license nor permission is granted.' + longWarrantyContext,
      'Neither the license nor permission is granted.' + longWarrantyContext,
      'Neither the license nor the permission is granted.' +
        longWarrantyContext,
      'Neither this license nor permission is granted.' + longWarrantyContext,
      'Neither license nor authorization nor permission is granted.' +
        longWarrantyContext,
      'Neither license nor right nor permission is granted.' +
        longWarrantyContext,
      'No license nor authorization nor permission is granted.' +
        longWarrantyContext,
      'No warranty nor permission is granted.' + longWarrantyContext,
      'Neither license is required nor permission is granted.' +
        longWarrantyContext,
      'Neither this permission is granted nor authorization is granted.' +
        longWarrantyContext,
      'Neither permission is granted nor authorization is granted.' +
        longWarrantyContext,
      'No ' +
        Array.from({ length: 80 }, () => 'other').join(' ') +
        ' license or permission is granted.' +
        longWarrantyContext,
      'No license is granted, nor any other permission is granted.' +
        longWarrantyContext,
      'No patent licenses are granted, nor any other permission is granted.' +
        longWarrantyContext,
      'No explicit and permission is granted.' + longWarrantyContext,
      'No express or permission is granted.' + longWarrantyContext,
      'No explicit and special authorization nor permission is granted.' +
        longWarrantyContext,
      'No explicit or special authorization nor permission is granted.' +
        longWarrantyContext,
      'No explicit and special authorization and permission is granted.' +
        longWarrantyContext,
      'No right granted or permission is granted.' + longWarrantyContext,
      'No and permission is granted.' + longWarrantyContext,
    ]) {
      expect(classifyInput(input), input).toBe('unknown')
    }
  })

  it('classifies full texts before header shortcuts and AS IS grants', () => {
    for (const licenseId of ['Apache-2.0', '0BSD', 'ISC']) {
      expect(classifyInput(licenseText(licenseId)), licenseId).toBe(
        'full-license-text',
      )
    }
  })

  it('classifies BSD-style warranty disclaimers as full license text', () => {
    expect(classifyInput(licenseText('BSD-2-Clause'))).toBe('full-license-text')
  })

  it('does not classify full GNU license text as a short header', () => {
    expect(classifyInput(licenseText('GPL-3.0-only'))).toBe('full-license-text')
  })

  it('classifies headers and notices without calling them full text', () => {
    expect(
      classifyInput(
        'Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.',
      ),
    ).toBe('license-header')
    expect(classifyInput('GNU General Public License v3.0 or later')).toBe(
      'license-header',
    )
    expect(classifyInput('GNU Lesser General Public License v2.1 only')).toBe(
      'license-header',
    )
    expect(
      classifyInput('GNU Lesser General Public License version 2.1 or later'),
    ).toBe('license-header')
    expect(
      classifyInput(
        'The GNU Lesser General Public License version 2.1 or later',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'Copyright (c) 2026 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.',
      ),
    ).toBe('license-notice')
    expect(
      classifyInput(
        'Copyright 2026 Example. Permission to use, copy, modify, and distribute this software for any purpose is granted, provided that this notice appears in all copies. No warranty is provided.',
      ),
    ).toBe('license-notice')
  })

  it('does not treat negated permission statements as grants', () => {
    expect(
      classifyInput(
        'Copyright 2026 Example. No permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. No license or permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. No license or other permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. No patent or other permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. No license is granted, nor permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. Neither license nor permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. Neither the license nor permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. Neither the license nor the permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. Neither permission is granted nor authorization is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. Neither license is required nor permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. Neither this permission is granted nor authorization is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. Neither license nor authorization nor permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. No license nor authorization nor permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. No warranty nor permission is granted to use this software.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example. Nor permission is granted to use this software. No warranty.',
      ),
    ).toBe('unknown')
    expect(
      classifyInput(
        'Copyright 2026 Example.nor permission is granted to use this software. No warranty.',
      ),
    ).toBe('license-notice')

    expect(
      classifyInput(
        'No permission is granted to use this software. ' +
          'No warranty is provided. ' +
          Array.from({ length: 90 }, (_, index) => 'word' + index).join(' '),
      ),
    ).toBe('unknown')

    expect(
      classifyInput(
        'Copyright (c) 2026 Example\n\n' +
          'Permission is hereby granted, free of charge, to any person obtaining a copy of this software. ' +
          'No permission is granted to use Example trademarks.',
      ),
    ).toBe('license-notice')
    expect(
      classifyInput(
        'No permission to use Example trademarks. ' +
          'Copyright (c) 2026 Example. ' +
          'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.',
      ),
    ).toBe('license-notice')
    expect(
      classifyInput(
        'Copyright 2026 Example. No warranty is made and permission is granted to use this software.',
      ),
    ).toBe('license-notice')
    expect(
      classifyInput(
        'Copyright 2026 Example. No license is required, and permission is granted to use this software.',
      ),
    ).toBe('license-notice')
    expect(
      classifyInput(
        'No fee. Permission is hereby granted, free of charge, to any person obtaining a copy of this software. ' +
          'This file is provided as is without warranty. ' +
          Array.from({ length: 90 }, (_, index) => 'notice' + index).join(' '),
      ),
    ).toBe('full-license-text')
  })

  it('classifies short license headers', () => {
    expect(classifyInput('MIT License')).toBe('license-header')
    expect(classifyInput('An MIT License')).toBe('license-header')
    expect(classifyInput('Apache License 2.0')).toBe('license-header')
    expect(classifyInput('Apache License, Version 2.0, January 2004')).toBe(
      'license-header',
    )
    expect(classifyInput('Apache 2.0 License')).toBe('license-header')
    expect(classifyInput('Academic Free License v3.0')).toBe('license-header')
    expect(classifyInput('Blue Oak Model License 1.0.0')).toBe('license-header')
    expect(classifyInput('A PostgreSQL License')).toBe('license-header')
    expect(classifyInput('0BSD License')).toBe('license-header')
    expect(classifyInput('0-Clause BSD License')).toBe('license-header')
    expect(classifyInput('BSD 0-Clause License')).toBe('license-header')
    expect(classifyInput('BSD Zero Clause License')).toBe('license-header')
    expect(classifyInput('Do What The Fuck You Want To Public License')).toBe(
      'license-header',
    )
    expect(classifyInput('Eclipse Public License v2.0')).toBe('license-header')
    expect(classifyInput('European Union Public License 1.2')).toBe(
      'license-header',
    )
    expect(classifyInput('Mozilla Public License v2.0')).toBe('license-header')
    expect(classifyInput('The Unlicense')).toBe('license-header')
    expect(classifyInput('Unlicense License')).toBe('license-header')
    expect(classifyInput('GNU General Public License v2.0')).toBe(
      'license-header',
    )
    expect(classifyInput('GNU Lesser General Public License 2.1')).toBe(
      'license-header',
    )
    expect(
      classifyInput(
        'Creative Commons Zero 1.0 Universal Public Domain Dedication',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'This work is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'This source code is dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'These files are dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'Those files are dedicated to the public domain under the CC0 1.0 Universal Public Domain Dedication.',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'This work is dedicated to the public domain under the Creative Commons Zero 1.0 Universal Public Domain Dedication.',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'Creative Commons Zero 1.0 Universal Public Domain Dedication\n' +
          'This dedication applies worldwide.',
      ),
    ).toBe('license-header')
    expect(
      classifyInput('Licensed under the Apache License, Version 2.0'),
    ).toBe('license-header')
    expect(classifyInput('Licensed under Apache 2.0')).toBe('license-header')
    expect(classifyInput('Licensed under the Apache License 2.0')).toBe(
      'license-header',
    )
    expect(
      classifyInput('This software is licensed under the MIT License.'),
    ).toBe('license-header')
    expect(classifyInput('Licensed under MIT')).toBe('license-header')
    expect(classifyInput('Licensed under MIT-0')).toBe('license-header')
    expect(classifyInput('Licensed under ASL 2.0')).toBe('license-header')
    expect(classifyInput('Licensed under an MIT License')).toBe(
      'license-header',
    )
    expect(classifyInput('Licensed under CC0-1.0')).toBe('license-header')
    expect(classifyInput('Licensed under 0BSD')).toBe('license-header')
    expect(classifyInput('Licensed under EPL-2.0')).toBe('license-header')
    expect(classifyInput('governed by the license agreement')).toBe('unknown')
    expect(classifyInput('governed by the software license agreement')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under the software license')).toBe('unknown')
    expect(classifyInput('licensed under a software license')).toBe('unknown')
    expect(classifyInput('licensed under the public license')).toBe('unknown')
    expect(classifyInput('licensed under the open source license')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under an open source license')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under the project license')).toBe('unknown')
    expect(classifyInput('licensed under the free software license')).toBe(
      'unknown',
    )
    expect(
      classifyInput('licensed under the proprietary software license'),
    ).toBe('unknown')
    expect(classifyInput('licensed under a proprietary software license')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under the source code license')).toBe(
      'unknown',
    )
    expect(
      classifyInput('licensed under the software license version 1.0'),
    ).toBe('unknown')
    expect(
      classifyInput('licensed under the software license version 10'),
    ).toBe('unknown')
    expect(classifyInput('licensed under the software license v2.0')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under the open source license 2.0')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under the open source license v2.0')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under the end user license agreement')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under the project license agreement')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under the MIT License Agreement')).toBe(
      'unknown',
    )
    expect(classifyInput('licensed under the Apache License Agreement')).toBe(
      'unknown',
    )
    expect(
      classifyInput('licensed under the BSD 3-Clause License Agreement'),
    ).toBe('unknown')
    expect(
      classifyInput('subject to the terms of the MIT License Agreement'),
    ).toBe('unknown')
    expect(classifyInput('is under the Apache License Agreement')).toBe(
      'unknown',
    )
    expect(
      classifyInput(
        'Licensed under the MIT License and governed by the contributor license agreement.',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'Licensed under the MIT License and the contributor license agreement.',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'Licensed under the GNU General Public License version 2 or later',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0',
      ),
    ).toBe('license-header')
    expect(
      classifyInput(
        'Licensed under the terms of the Eclipse Public License, v. 2.0',
      ),
    ).toBe('license-header')
    expect(classifyInput('Mozilla Public License v1.0')).toBe('license-header')
    expect(classifyInput('Mozilla Public License v1.1')).toBe('license-header')
    expect(classifyInput('Licensed under MPLv1.0')).toBe('license-header')
    expect(classifyInput('Licensed under MPLv1.1')).toBe('license-header')
    expect(classifyInput('Licensed under ISC')).toBe('license-header')
    expect(classifyInput('Licensed under Zlib')).toBe('license-header')
    expect(classifyInput('Licensed under the WTFPL')).toBe('license-header')
    expect(classifyInput('Licensed under Boost Software License 1.0')).toBe(
      'license-header',
    )
    expect(classifyInput('Licensed under Microsoft Public License')).toBe(
      'license-header',
    )
    expect(classifyInput('Licensed under the Unlicense License')).toBe(
      'license-header',
    )
    expect(classifyInput('Licensed under the BSD 3-Clause License.')).toBe(
      'license-header',
    )
  })

  it('classifies unrelated text as unknown', () => {
    expect(
      classifyInput('Project screenshots, install notes, and release history.'),
    ).toBe('unknown')
    expect(
      classifyInput('This service is subject to the terms of service.'),
    ).toBe('unknown')
    expect(classifyInput('MIT License key')).toBe('unknown')
    expect(classifyInput('ISC license key')).toBe('unknown')
    expect(classifyInput('Licensed under the terms of the agreement')).toBe(
      'unknown',
    )
    expect(classifyInput('Licensed under section 2')).toBe('unknown')
    expect(classifyInput('Governed by article 4')).toBe('unknown')
  })
})
