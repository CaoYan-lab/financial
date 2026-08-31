import { create } from 'zustand'
import type {
  ReportGenerationResult,
  ReportHistorySummary,
  ReportPromptArchive,
  SourceStatusResponse,
  TopOpportunitySnapshot,
} from '../../shared/types'

type ReportState = {
  report?: ReportGenerationResult
  recentReports?: ReportHistorySummary[]
  promptArchive?: ReportPromptArchive
  latestTopOpportunities?: TopOpportunitySnapshot[]
  sourceStatus?: SourceStatusResponse
  isGenerating: boolean
  error?: string
  setReport: (report: ReportGenerationResult) => void
  setRecentReports: (recentReports: ReportHistorySummary[]) => void
  setPromptArchive: (promptArchive: ReportPromptArchive) => void
  setLatestTopOpportunities: (latestTopOpportunities: TopOpportunitySnapshot[]) => void
  setSourceStatus: (sourceStatus: SourceStatusResponse) => void
  setGenerating: (isGenerating: boolean) => void
  setError: (error?: string) => void
}

export const useReportStore = create<ReportState>((set) => ({
  isGenerating: false,
  setReport: (report) => set({ report, error: undefined }),
  setRecentReports: (recentReports) => set({ recentReports }),
  setPromptArchive: (promptArchive) => set({ promptArchive }),
  setLatestTopOpportunities: (latestTopOpportunities) => set({ latestTopOpportunities }),
  setSourceStatus: (sourceStatus) => set({ sourceStatus }),
  setGenerating: (isGenerating) => set({ isGenerating }),
  setError: (error) => set({ error }),
}))
