import type { LegacyAlias } from '../data/types'

export type { LegacyAlias, LicenseEntry } from '../data/types'

export type InputType =
  | 'spdx-expression'
  | 'license-notice'
  | 'license-header'
  | 'full-license-text'
  | 'mixed-license-text'
  | 'unknown'

export type Confidence = 'Exact' | 'Likely' | 'Possible' | 'Unknown'

export interface ScoreBreakdown {
  precision: number
  recall: number
  f1: number
}

export interface DiffSegment {
  type: 'equal' | 'insert' | 'delete'
  text: string
}

export interface MatchResult {
  licenseId: string
  name: string
  confidence: Confidence
  inputType: InputType
  score: ScoreBreakdown
  flags: {
    isDeprecated: boolean
    isOsiApproved: boolean
    isFsfLibre?: boolean
    needsManualReview: boolean
    isLegacyId?: boolean
  }
  explanation: string
  diff?: string
  diffSegments?: DiffSegment[]
  seeAlso: string[]
}

export interface MatchResponse {
  inputType: InputType
  spdxExpression?: string
  legacyAlias?: LegacyAlias
  results: MatchResult[]
  message: string
}
