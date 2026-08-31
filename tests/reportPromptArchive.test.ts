import { describe, expect, it } from 'vitest'
import { getReportPromptArchive } from '../api/services/reportPromptArchive'

describe('getReportPromptArchive', () => {
  it('保留通俗说明和用户已提供的 Prompt v3 片段', () => {
    const archive = getReportPromptArchive()

    expect(archive.title).toContain('Prompt v3')
    expect(archive.summary).toContain('现金担保卖 Put')
    expect(archive.rawPrompt).toContain('Top 30 Mega-Cap Cash-Secured Put 分析 Prompt v3')
    expect(archive.rawPrompt).toContain('Universe 以 https://stockanalysis.com/list/biggest-companies/')
    expect(archive.source).toBe('user-provided-fragment')
  })
})
