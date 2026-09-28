import {
  PaymentProviderError,
  unavailablePaymentProvider,
  type PayableOrder,
  type PaymentCreation,
  type PaymentProvider,
  type PaymentQuery,
  type VerifiedPaymentWebhook,
} from '../paymentProvider.js'

export type DouyinPayClient = {
  createOrder(order: PayableOrder): Promise<PaymentCreation>
  queryOrder(providerOrderId: string): Promise<PaymentQuery>
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<VerifiedPaymentWebhook>
  closeOrder(providerOrderId: string): Promise<void>
}

export function createDouyinPaymentProvider(client?: DouyinPayClient): PaymentProvider {
  if (!client) return unavailablePaymentProvider('DOUYIN', '抖音支付')
  return {
    channel: 'DOUYIN',
    displayName: '抖音支付',
    available: true,
    unavailableReason: null,
    createPayment: order => client.createOrder(order),
    queryPayment: providerOrderId => client.queryOrder(providerOrderId),
    verifyWebhook: async (rawBody, headers) => {
      if (!rawBody.length) throw new PaymentProviderError('DOUYIN_WEBHOOK_EMPTY')
      return client.verifyWebhookSignature(rawBody, headers)
    },
    closePayment: providerOrderId => client.closeOrder(providerOrderId),
  }
}
