import { useCallback, useEffect, useState } from 'react'
import type { ReportPromptArchive } from '../../shared/types'

export function useReportPrompt() {
  const [promptArchive, setPromptArchive] = useState<ReportPromptArchive>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const response = await fetch('/api/report/prompt')
      if (!response.ok) throw new Error(`Report prompt failed with HTTP ${response.status}.`)
      setPromptArchive((await response.json()) as ReportPromptArchive)
    } catch (promptError) {
      setError(promptError instanceof Error ? promptError.message : 'Unable to load report prompt.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => undefined)
  }, [refresh])

  return { promptArchive, loading, error, refresh }
}
