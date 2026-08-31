import type { TradePreviewResponse } from '../../../shared/types'
import type { UiLanguage } from '@/stores/uiStore'

export default function OrderPreviewDrawer({ preview, language }: { preview?: TradePreviewResponse; language: UiLanguage }) {
  if (!preview) return null

  return (
    <div className="rounded-2xl border border-rose-200 bg-white p-4 text-sm text-stone-700">
      <p className="font-mono text-lg font-semibold text-stone-950">
        {preview.orderSide} {preview.quantity} {preview.ticker} @ {preview.limitPrice}
      </p>
      <p className="mt-2">{language === 'zh' ? '预估名义金额' : 'Estimated notional'}: {preview.estimatedNotional}</p>
      <div className="mt-3 space-y-2">
        {preview.riskWarnings.map((warning) => (
          <p key={warning} className="text-rose-700">
            - {warning}
          </p>
        ))}
      </div>
    </div>
  )
}
