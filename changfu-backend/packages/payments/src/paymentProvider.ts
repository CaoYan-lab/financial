export type PaymentChannel = 'WECHAT' | 'ALIPAY' | 'DOUYIN'

export type PayableOrder = {
  orderId: string
  businessOrderNo: string
  description: string
  amountMinor: number
  currency: 'CNY'
  expiresAt: Date
}

export type PaymentCreation = {
  providerOrderId: string
  paymentUrl: string | null
  qrCodePayload: string | null
  expiresAt: Date
}

export type PaymentQuery = {
  status: 'PENDING' | 'PAID' | 'FAILED' | 'CLOSED'
  providerTransactionId: string | null
  paidAt: Date | null
}

export type VerifiedPaymentWebhook = {
  providerEventId: string
  providerOrderId: string
  providerTransactionId: string
  businessOrderNo: string
  amountMinor: number
  currency: string
  occurredAt: Date
  metadata: Record<string, unknown>
}

export type PaymentProvider = {
  readonly channel: PaymentChannel
  readonly displayName: string
  readonly available: boolean
  readonly unavailableReason: string | null
  createPayment(order: PayableOrder): Promise<PaymentCreation>
  queryPayment(providerOrderId: string): Promise<PaymentQuery>
  verifyWebhook(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<VerifiedPaymentWebhook>
  closePayment(providerOrderId: string): Promise<void>
}

export class PaymentProviderError extends Error {
  constructor(readonly code: string) {
    super('支付渠道请求未完成')
    this.name = 'PaymentProviderError'
  }
}

export function unavailablePaymentProvider(
  channel: PaymentChannel,
  displayName: string,
  reason = 'PAYMENT_CREDENTIALS_MISSING',
): PaymentProvider {
  const reject = async (): Promise<never> => {
    throw new PaymentProviderError(reason)
  }
  return {
    channel,
    displayName,
    available: false,
    unavailableReason: reason,
    createPayment: reject,
    queryPayment: reject,
    verifyWebhook: reject,
    closePayment: reject,
  }
}
