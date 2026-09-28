import { createHash } from 'node:crypto'
import type { PostgresSubscriptionRepository } from '../../persistence/src/postgresSubscriptionRepository.js'
import type {
  PaymentChannel,
  PaymentProvider,
  VerifiedPaymentWebhook,
} from './paymentProvider.js'
import { PaymentProviderError } from './paymentProvider.js'

type OrderView = {
  orderId: string
  businessOrderNo: string
  planCode: string
  billingPeriod: string
  currency: 'CNY'
  payableAmountMinor: number
  status: string
  quoteExpiresAt: string
}

export class PaymentService {
  private readonly providers: Map<PaymentChannel, PaymentProvider>

  constructor(
    private readonly repository: PostgresSubscriptionRepository,
    providers: PaymentProvider[],
  ) {
    this.providers = new Map(providers.map(provider => [provider.channel, provider]))
  }

  availability(): Array<{
    channel: PaymentChannel
    displayName: string
    available: boolean
    unavailableReason: string | null
  }> {
    return [...this.providers.values()].map(provider => ({
      channel: provider.channel,
      displayName: provider.displayName,
      available: provider.available,
      unavailableReason: provider.unavailableReason,
    }))
  }

  async startPayment(input: {
    userId: string
    orderId: string
    channel: PaymentChannel
    now?: Date
  }): Promise<unknown> {
    const provider = this.provider(input.channel)
    if (!provider.available) {
      throw new PaymentProviderError(provider.unavailableReason ?? 'PAYMENT_CHANNEL_UNAVAILABLE')
    }
    const order = await this.repository.getOrder(input.userId, input.orderId) as OrderView | null
    if (!order) throw new PaymentProviderError('ORDER_NOT_FOUND')
    if (!['CREATED', 'FAILED'].includes(order.status)) {
      throw new PaymentProviderError('ORDER_NOT_PAYABLE')
    }
    const now = input.now ?? new Date()
    const quoteExpiresAt = new Date(order.quoteExpiresAt)
    if (quoteExpiresAt.getTime() <= now.getTime()) {
      throw new PaymentProviderError('ORDER_QUOTE_EXPIRED')
    }
    const payment = await provider.createPayment({
      orderId: order.orderId,
      businessOrderNo: order.businessOrderNo,
      description: `长富${order.planCode}-${order.billingPeriod}`,
      amountMinor: order.payableAmountMinor,
      currency: order.currency,
      expiresAt: quoteExpiresAt,
    })
    return this.repository.markPaymentPending({
      userId: input.userId,
      orderId: input.orderId,
      channel: input.channel,
      providerOrderId: payment.providerOrderId,
      paymentUrl: payment.paymentUrl,
      qrCodePayload: payment.qrCodePayload,
      expiresAt: payment.expiresAt,
      now,
    })
  }

  async handleWebhook(input: {
    channel: PaymentChannel
    rawBody: Buffer
    headers: Readonly<Record<string, string | string[] | undefined>>
    now?: Date
  }): Promise<{ duplicate: boolean; orderId: string }> {
    const provider = this.provider(input.channel)
    if (!provider.available) throw new PaymentProviderError('PAYMENT_CHANNEL_UNAVAILABLE')
    const event: VerifiedPaymentWebhook = await provider.verifyWebhook(
      input.rawBody,
      input.headers,
    )
    return this.repository.applyPaidOrder({
      channel: input.channel,
      ...event,
      rawBodyHash: createHash('sha256').update(input.rawBody).digest('hex'),
      ...(input.now ? { now: input.now } : {}),
    })
  }

  private provider(channel: PaymentChannel): PaymentProvider {
    const provider = this.providers.get(channel)
    if (!provider) throw new PaymentProviderError('PAYMENT_CHANNEL_UNKNOWN')
    return provider
  }
}
