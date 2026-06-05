import type { LegacyAlias } from './types'

export const legacyAliases: LegacyAlias[] = [
  {
    legacyId: 'GPL-2.0',
    candidates: ['GPL-2.0-only', 'GPL-2.0-or-later'],
    message:
      'GPL-2.0 is a legacy SPDX ID. Confirm whether the original text allows later versions.',
  },
  {
    legacyId: 'GPL-2.0+',
    candidates: ['GPL-2.0-or-later'],
    message: 'GPL-2.0+ is a legacy SPDX ID. Use GPL-2.0-or-later.',
  },
  {
    legacyId: 'GPL-3.0',
    candidates: ['GPL-3.0-only', 'GPL-3.0-or-later'],
    message:
      'GPL-3.0 is a legacy SPDX ID. Confirm whether the original text allows later versions.',
  },
  {
    legacyId: 'GPL-3.0+',
    candidates: ['GPL-3.0-or-later'],
    message: 'GPL-3.0+ is a legacy SPDX ID. Use GPL-3.0-or-later.',
  },
  {
    legacyId: 'LGPL-2.1',
    candidates: ['LGPL-2.1-only', 'LGPL-2.1-or-later'],
    message:
      'LGPL-2.1 is a legacy SPDX ID. Confirm whether the original text allows later versions.',
  },
  {
    legacyId: 'LGPL-2.1+',
    candidates: ['LGPL-2.1-or-later'],
    message: 'LGPL-2.1+ is a legacy SPDX ID. Use LGPL-2.1-or-later.',
  },
  {
    legacyId: 'LGPL-3.0',
    candidates: ['LGPL-3.0-only', 'LGPL-3.0-or-later'],
    message:
      'LGPL-3.0 is a legacy SPDX ID. Confirm whether the original text allows later versions.',
  },
  {
    legacyId: 'LGPL-3.0+',
    candidates: ['LGPL-3.0-or-later'],
    message: 'LGPL-3.0+ is a legacy SPDX ID. Use LGPL-3.0-or-later.',
  },
  {
    legacyId: 'AGPL-3.0',
    candidates: ['AGPL-3.0-only', 'AGPL-3.0-or-later'],
    message:
      'AGPL-3.0 is a legacy SPDX ID. Confirm whether the original text allows later versions.',
  },
  {
    legacyId: 'AGPL-3.0+',
    candidates: ['AGPL-3.0-or-later'],
    message: 'AGPL-3.0+ is a legacy SPDX ID. Use AGPL-3.0-or-later.',
  },
]

export const legacyAliasById = new Map(
  legacyAliases.map((alias) => [alias.legacyId.toLowerCase(), alias]),
)
