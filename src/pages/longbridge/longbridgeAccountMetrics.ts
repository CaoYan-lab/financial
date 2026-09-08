export function resolveLongbridgeUsdOverview(
  metrics: Record<string, string | undefined>,
): string {
  return metrics['美金总览'] ?? metrics['账户净资产'] ?? '不可用'
}
