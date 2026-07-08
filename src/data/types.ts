export interface LicenseEntry {
  licenseId: string
  name: string
  text: string
  seeAlso: string[]
  isOsiApproved: boolean
  isFsfLibre?: boolean
  isDeprecated: boolean
  sourceVersion: string
}

export interface LegacyAlias {
  legacyId: string
  candidates: string[]
  message: string
}
