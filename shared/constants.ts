export const UNAVAILABLE = 'unavailable'

export const LOW_IV_RANK_THRESHOLD = 25
export const HIGH_CAPITAL_REQUIREMENT = 80000
export const MIN_DTE = 30
export const MAX_DTE = 45

export const DATA_SOURCES = {
  universePrimary: 'https://stockanalysis.com/list/biggest-companies/',
  universeFallback: 'https://companiesmarketcap.com',
  futuOpenD: 'Futu OpenD',
  futuDocs: 'https://openapi.futunn.com/futu-api-doc/',
} as const

export const SPECIAL_FLAGS = {
  lowIvWait: 'Low IV - Wait',
  lowIvCore: 'Low IV - Acceptable for core position building',
  highCapital: 'High Capital Requirement',
  optionChainUnavailable:
    'Futu option chain or snapshot field unavailable; do not estimate',
} as const
