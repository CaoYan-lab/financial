import {
  PaymentProviderError,
  unavailablePaymentProvider,
  type PayableOrder,
  type PaymentCreation,
  type PaymentProvider,
  type PaymentQuery,
  type VerifiedPaymentWebhook,
} from '../paymentProvider.js'

export type WechatPayClient = {
  createNativeOrder(order: PayableOrder): Promise<PaymentCreation>
  queryOrder(providerOrderId: string): Promise<PaymentQuery>
  verifyAndDecryptWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<VerifiedPaymentWebhook>
  closeOrder(providerOrderId: string): Promise<void>
}

export function createWechatPaymentProvider(client?: WechatPayClient): PaymentProvider {
  if (!client) return unavailablePaymentProvider('WECHAT', '微信支付')
  return {
    channel: 'WECHAT',
    displayName: '微信支付',
    available: true,
    unavailableReason: null,
    createPayment: order => client.createNativeOrder(order),
    queryPayment: providerOrderId => client.queryOrder(providerOrderId),
    verifyWebhook: async (rawBody, headers) => {
      if (!rawBody.length) throw new PaymentProviderError('WECHAT_WEBHOOK_EMPTY')
      return client.verifyAndDecryptWebhook(rawBody, headers)
    },
    closePayment: providerOrderId => client.closeOrder(providerOrderId),
  }
}
