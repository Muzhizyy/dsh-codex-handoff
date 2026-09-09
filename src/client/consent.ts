import type { Consent, CreateRequest } from '../shared/types.js'

export interface ConsentSelection {
  readonly mode: 'smart' | 'full'
  readonly useModel: boolean
}

export interface ConsentState {
  readonly acceptedAt: number
  readonly selection: ConsentSelection
}

export function consentFor(selection: ConsentSelection): Consent {
  if (selection.mode === 'full') {
    return {
      disclosureVersion: 'full-v1',
      accepted: true,
      acceptedMode: 'full',
      modelAnalysis: false,
      fullPersistence: true,
    }
  }
  return selection.useModel
    ? {
        disclosureVersion: 'smart-v1',
        accepted: true,
        acceptedMode: 'smart',
        modelAnalysis: true,
        fullPersistence: false,
      }
    : {
        disclosureVersion: 'smart-v1',
        accepted: true,
        acceptedMode: 'smart',
        modelAnalysis: false,
        fullPersistence: false,
      }
}

export function isConsentValid(consent: Consent | undefined, selection: ConsentSelection): consent is Consent {
  if (consent === undefined) return false
  const expected = consentFor(selection)
  return JSON.stringify(consent) === JSON.stringify(expected)
}

export function requestUsesModel(request: CreateRequest): boolean {
  return request.mode === 'smart' && request.smart.useModel
}
