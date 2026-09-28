import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendProblem } from '../../../../packages/http/src/problem.js'
import { readBody } from '../../../../packages/http/src/router.js'
import {
  PaymentProviderError,
  type PaymentChannel,
} from '../../../../packages/payments/src/paymentProvider.js'
import type { PaymentService } from '../../../../packages/payments/src/paymentService.js'

const maxWebhookBytes = 1024 * 1024

export async function handlePaymentWebhookRoute(context: {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  requestId: string
  paymentService: PaymentService
}): Promise<boolean> {
  const match = context.url.pathname.match(
    /^\/internal\/v1\/payments\/(?<channel>wechat|alipay|douyin)\/webhook$/i,
  )
  if (context.request.method !== 'POST' || !match?.groups?.channel) return false
  const channel = match.groups.channel.toUpperCase() as PaymentChannel
  try {
    const result = await context.paymentService.handleWebhook({
      channel,
      rawBody: await readBody(context.request, maxWebhookBytes),
      headers: context.request.headers,
    })
    sendJson(context.response, 200, {
      accepted: true,
      duplicate: result.duplicate,
    })
  } catch (error) {
    const code = error instanceof PaymentProviderError
      ? error.code
      : error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'PAYMENT_WEBHOOK_FAILED'
    const unauthorized = /SIGNATURE|WEBHOOK|MERCHANT/.test(code)
    sendProblem(context.response, unauthorized ? 401 : 503, code, context.requestId)
  }
  return true
}
