import type {
  ManagedBroker,
  ManagedOrder,
  ManagedOrderDecision,
} from '../../shared/managedOrderTypes.js'
import { getActiveArkModel } from '../simulation/llmRuntimeConfigService.js'
import { callArkResponses, parseJsonObject } from '../simulation/llmResponseUtils.js'
import { logger } from '../utils/logger.js'

export type ManagedOrderDecisionContext = {
  order: ManagedOrder
  account: {
    totalAssets?: string
    buyingPower?: string
    positions: unknown[]
  }
  marketData: unknown
}

export async function requestManagedOrderDecisions(input: {
  platform: ManagedBroker
  orders: ManagedOrderDecisionContext[]
}): Promise<Map<string, ManagedOrderDecision>> {
  if (!input.orders.length) return new Map()
  const response = await callArkResponses(buildManagedOrderPrompt(input))
  if (!response.ok) {
    const error = 'error' in response ? response.error : '挂单监管模型调用失败。'
    logger.error(
      { event: 'managed_order.model.failed', platform: input.platform, error },
      '挂单监管模型调用失败',
    )
    return new Map()
  }
  return parseManagedOrderDecisions(response.text, input.orders.map((item) => item.order))
}

export function buildManagedOrderPrompt(input: {
  platform: ManagedBroker
  orders: ManagedOrderDecisionContext[]
}): Array<{ role: string; content: string }> {
  return [
    {
      role: 'system',
      content:
        '你是实盘挂单监管员。只能返回 JSON。你不能改单、追价、重下或创建订单，只能对输入中的系统托管订单输出 KEEP 或 CANCEL。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '判断尚未终态的系统挂单是否应继续等待或撤销剩余数量。',
        platform: input.platform,
        model: getActiveArkModel(),
        hardConstraints: [
          '只能引用 managedOrders 中存在的 platform 和 orderId。',
          '已成交部分不可撤销；CANCEL 仅表示撤销 remainingQuantity。',
          '数据过期、状态未知或理由不足时必须 KEEP。',
          '不得建议改单、重下、修改数量或修改价格。',
        ],
        managedOrders: input.orders,
        requiredJson: {
          decisions: [
            {
              platform: input.platform,
              orderId: '券商订单号',
              action: 'KEEP | CANCEL',
              confidence: 'low | medium | high',
              reason: '中文理由',
              riskAssessment: '中文风险说明',
            },
          ],
          portfolioRationale: '中文组合说明',
        },
      }),
    },
  ]
}

export function parseManagedOrderDecisions(
  text: string,
  knownOrders: ManagedOrder[],
): Map<string, ManagedOrderDecision> {
  const parsed = parseJsonObject(text)
  const known = new Map(knownOrders.map((order) => [`${order.platform}:${order.orderId}`, order]))
  const result = new Map<string, ManagedOrderDecision>()
  const decisions = parsed && Array.isArray(parsed.decisions) ? parsed.decisions : []
  for (const raw of decisions) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const platform = String(record.platform ?? '')
    const orderId = String(record.orderId ?? '')
    const key = `${platform}:${orderId}`
    if (!known.has(key) || result.has(key)) continue
    const action = String(record.action ?? 'KEEP').toUpperCase()
    const confidence = String(record.confidence ?? 'low').toLowerCase()
    if (!['KEEP', 'CANCEL'].includes(action)) continue
    if (!['low', 'medium', 'high'].includes(confidence)) continue
    result.set(key, {
      action: action as ManagedOrderDecision['action'],
      confidence: confidence as ManagedOrderDecision['confidence'],
      source: 'model',
      reason: typeof record.reason === 'string' ? record.reason : '模型未提供理由。',
      riskAssessment:
        typeof record.riskAssessment === 'string'
          ? record.riskAssessment
          : '模型未提供风险说明。',
      decidedAt: new Date().toISOString(),
    })
  }
  return result
}
