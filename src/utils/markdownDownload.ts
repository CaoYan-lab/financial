export function downloadMarkdown(markdown: string, batchId: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `top30-csp-report-${batchId}.md`
  link.click()
  URL.revokeObjectURL(url)
}

