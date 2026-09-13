export type TradingPromptBroker = 'futu' | 'longbridge'
export type TradingPromptRole = 'single' | 'portfolio' | 'managed'
export type TradingPromptMode = 'legacy' | 'shadow' | 'live'
export type TradingPromptReleaseStatus = {
  revision: number
  selectedMode: TradingPromptMode
  effectiveModes: Record<TradingPromptRole, TradingPromptMode | 'blocked'>
  environmentOverrides: Partial<Record<TradingPromptRole, string>>
  liveAvailable: boolean
  blockers: string[]
  updatedAt: string | null
  productionPrompt: {
    version: string
    label: string
    source: string
    roles: Record<TradingPromptRole, {
      label: string
      instruction: string
    }>
  }
}
export type TradingPromptAudit = {
  requestId: string
  broker: TradingPromptBroker
  role: TradingPromptRole
  version: string
  mode: 'shadow' | 'live'
  ordersEnabled: boolean
  inputHash: string
  promptHash: string
  requestedAt: string
  completedAt: string
  sourceValidUntil: string | null
  contextUsableAtResponse: boolean
  contractValid: boolean
  policyValid: boolean
  errors: string[]
  dataGaps: string[]
  output: Record<string, unknown> | null
  rawText: string
  artifactId?: string
}

export type TradingPromptComparisonRun = {
  id: string
  startedAt: string
  completedAt: string | null
  status: 'RUNNING' | 'COMPLETED' | 'FAILED'
  universeCount: number
  totalCases: number
  completedCases: number
  passedCases: number
  failedCases: number
  reportPath: string | null
  error: string | null
}

export type TradingPromptComparisonResult = {
  id: number
  runId: string
  broker: TradingPromptBroker
  mode: 'legacy' | 'live'
  ticker: string
  modelRequested: boolean
  contextOk: boolean
  marketPrice: number | null
  marketUpdatedAt: string | null
  action: string
  approved: boolean
  requestOk: boolean
  contractValid: boolean | null
  policyValid: boolean | null
  contextUsableAtResponse: boolean | null
  durationMs: number
  reason: string
  riskAssessment: string
  errors: string[]
  rawOutput: unknown
  contextSummary: Record<string, unknown>
  createdAt: string
}

export type TradingPromptComparisonResponse = {
  ok: true
  run: TradingPromptComparisonRun | null
  results: TradingPromptComparisonResult[]
}
