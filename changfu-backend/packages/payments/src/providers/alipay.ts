import {
  PaymentProviderError,
  unavailablePaymentProvider,
  type PayableOrder,
  type PaymentCreation,
  type PaymentProvider,
  type PaymentQuery,
  type VerifiedPaymentWebhook,
} from '../paymentProvider.js'

export type AlipayClient = {
  createPageOrder(order: PayableOrder): Promise<PaymentCreation>
  queryOrder(providerOrderId: string): Promise<PaymentQuery>
  verifyFormWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<VerifiedPaymentWebhook>
  closeOrder(providerOrderId: string): Promise<void>
}

export function createAlipayPaymentProvider(client?: AlipayClient): PaymentProvider {
  if (!client) return unavailablePaymentProvider('ALIPAY', '支付宝')
  return {
    channel: 'ALIPAY',
    displayName: '支付宝',
    available: true,
    unavailableReason: null,
    createPayment: order => client.createPageOrder(order),
    queryPayment: providerOrderId => client.queryOrder(providerOrderId),
    verifyWebhook: async (rawBody, headers) => {
      if (!rawBody.length) throw new PaymentProviderError('ALIPAY_WEBHOOK_EMPTY')
      return client.verifyFormWebhook(rawBody, headers)
    },
    closePayment: providerOrderId => client.closeOrder(providerOrderId),
  }
}
