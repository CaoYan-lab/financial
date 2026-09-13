import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../api/simulation/llmResponseUtils', () => ({
  callArkResponses: mocks.call,
  parseJsonObject: (text: string) => { try { return JSON.parse(text) } catch { return undefined } },
}))
vi.mock('../api/trade_strategy/tradeStrategyConfigService', () => ({
  getTradeStrategyRuntimeConfig: () => ({ activeStrategy: { id: 'real-config', riskControls: { portfolioHeat: { maxPctEquity: 0.05 } }, trendFilters: {} } }),
}))
import { requestProductionDecision, requestProductionShadow, tradingPromptMode, validateProductionOutput } from '../api/live/tradingPromptV2'
import { buildSingleProductionContext, buildPortfolioProductionContext, buildManagedProductionContext, candidateProductionEvidence } from '../api/live/tradingPromptContext'
import { requestLongbridgeLiveTradingDecision } from '../api/longbridge/longbridgeLiveDecisionService'
import { requestLiveTradingDecision } from '../api/live/liveTradingDecisionService'
import { requestLivePortfolioReviewDecision } from '../api/live/livePortfolioReviewDecisionService'
import { requestManagedOrderDecisions } from '../api/live/managedOrderDecisionService'

const now = () => new Date().toISOString()
const account = () => ({
  ok: true, selectedAccountId: 'account-a',
  summary: { accountId: 'account-a', currency: 'USD', tradingCurrency: 'USD', totalAssets: '$10000',
    cash: '$5000', buyingPower: '$20000', financingRiskLevel: 0, initialMargin: '$0', marginCall: '$0',
    source: { timestamp: now() } },
  positions: [],
} as any)
const market = (ticker = 'AAPL') => ({
  ok: true, ticker, symbol: `${ticker}.US`, lastPrice: ticker === 'AAPL' ? 180 : 400,
  updatedAt: now(), bars: [], tickerPoints: [], asks: [], bids: [], marketState: 'TRADING', warnings: [],
} as any)
const single = () => ({
  ticker: 'AAPL', symbol: 'AAPL.US', account: account(), marketData: market(),
  dataWindow: { kline1mBars: 30, tickerPoints: 10, orderBookDepth: 1 },
  universe: [], allPositions: [], managedOpenOrders: [], pendingOrders: [],
} as any)
const hold = () => ({
  approved: false, action: 'HOLD', ticker: 'AAPL', orderQuantity: 0, limitPrice: null,
  positionEffect: 'NONE', reason: '风险预算未知', riskAssessment: '不增加风险',
  evidenceIds: ['E2'], counterEvidenceIds: [], invalidationPrice: null, exitCondition: '不适用', requestedFollowUp: 'REFRESH_DATA',
})
const order = () => ({
  platform: 'longbridge', orderId: 'order-a', ticker: 'AAPL', status: 'TRACKING', canCancel: true,
  ownershipVerified: true, remainingQuantity: 10, executedQuantity: 0, side: 'BUY', lastCheckedAt: now(),
} as any)

describe('真实服务新版提示词接入（无券商IO）', () => {
  let dir: string
  beforeEach(async () => {
    vi.stubEnv('TRADING_PROMPT_MODE', 'shadow')
    dir = await mkdtemp(join(tmpdir(), 'trading-prompt-test-'))
    vi.stubEnv('TRADING_PROMPT_AUDIT_DIR', dir)
    mocks.call.mockReset().mockResolvedValue({ ok: true, text: JSON.stringify(hold()) })
  })
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) })

  it('版本开关逐层覆盖，未配置保持旧版，支持实盘且非法值阻断', () => {
    vi.unstubAllEnvs()
    expect(tradingPromptMode('futu', 'single')).toBe('legacy')
    vi.stubEnv('TRADING_PROMPT_MODE', 'shadow')
    vi.stubEnv('FUTU_PROMPT_MODE', 'legacy')
    vi.stubEnv('FUTU_MANAGED_PROMPT_MODE', 'shadow')
    expect(tradingPromptMode('futu', 'single')).toBe('legacy')
    expect(tradingPromptMode('futu', 'managed')).toBe('shadow')
    vi.stubEnv('LONGBRIDGE_PROMPT_MODE', 'live')
    expect(tradingPromptMode('longbridge', 'single')).toBe('live')
    vi.stubEnv('LONGBRIDGE_PROMPT_MODE', 'invalid')
    expect(() => tradingPromptMode('longbridge', 'single')).toThrow()
  })

  it.each(['futu', 'longbridge'] as const)('%s单票真实入口保留完整输出但不批准订单', async broker => {
    const input = single()
    const result = await (broker === 'futu' ? requestLiveTradingDecision(input) : requestLongbridgeLiveTradingDecision(input))
    expect(result.action).toBe('HOLD')
    expect(result.ok).toBe(false)
    expect(result.approved).toBe(false)
    expect(result.promptAudit?.contractValid).toBe(true)
    expect(result.promptAudit?.output?.exitCondition).toBe('不适用')
    expect(result.promptAudit?.ordersEnabled).toBe(false)
    const sent = JSON.parse(mocks.call.mock.calls[0][0][1].content)
    expect(sent.marketData.lastPrice).toBe(180)
    expect(sent.risk.availableRiskBudget).toBe(500)
    expect(sent).not.toHaveProperty('synthetic')
    if (broker === 'futu') expect(sent.risk.openingRiskStatus).toBe('UNKNOWN')
    const [scope] = await readdir(dir)
    const [file] = await readdir(join(dir, scope))
    expect((await stat(join(dir, scope, file))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(dir, scope, file), 'utf8')).audit.rawText).toBe(JSON.stringify(hold()))
  })

  it('正数动作、缺字段和未知证据严格校验，不靠补默认值通过', () => {
    const ctx = buildSingleProductionContext('longbridge', single())
    const invalid = { ...hold(), approved: true, action: 'BUY', orderQuantity: 10, limitPrice: 180, positionEffect: 'OPEN_LONG', invalidationPrice: 179 }
    expect(validateProductionOutput(ctx, invalid).policyErrors).toEqual([])
    expect(validateProductionOutput(ctx, { ...hold(), evidenceIds: ['unknown'] }).contractErrors.length).toBeGreaterThan(0)
    const missing: any = hold()
    delete missing.exitCondition
    expect(validateProductionOutput(ctx, missing).contractErrors).toContain('$.exitCondition:missing')
    expect(validateProductionOutput(ctx, { ...hold(), orderQuantity: 0.5 }).contractErrors).toContain('decision_shape')
  })
  it.each(['futu', 'longbridge'] as const)('%s即使模型批准开仓也返回HOLD，不生成执行授权', async broker => {
    const output = { ...hold(), approved: true, action: 'BUY', orderQuantity: 1, limitPrice: 180, positionEffect: 'OPEN_LONG', invalidationPrice: 179 }
    mocks.call.mockResolvedValue({ ok: true, text: JSON.stringify(output) })
    const input = single()
    const r = await (broker === 'futu' ? requestLiveTradingDecision(input) : requestLongbridgeLiveTradingDecision(input))
    expect(r.approved).toBe(false)
    expect(r.action).toBe('HOLD')
    expect(r.promptAudit?.output?.action).toBe('BUY')
    expect(r.promptAudit?.policyValid).toBe(broker === 'longbridge')
    if (broker === 'futu') expect(r.promptAudit?.errors).toContain('opening_risk_unavailable')
  })

  it('期权不是正股，源时间不重写，外币与可平数量缺失可观测', () => {
    const input = single()
    input.account.positions = [{ ticker: 'AAPL', assetType: 'OPTION', quantity: '-10' }]
    input.account.summary.currency = 'HKD'
    input.account.summary.tradingCurrency = 'HKD'
    input.marketData.updatedAt = '2020-01-01T00:00:00Z'
    const ctx = buildSingleProductionContext('futu', input)
    expect(ctx.facts.position.quantity).toBe(0)
    expect(ctx.facts.marketData.updatedAt).toBe('2020-01-01T00:00:00Z')
    expect(ctx.dataGaps).toContain('账户币种与标的币种不一致')
  })

  it('接口失败不回退旧版；配置失败不调用模型', async () => {
    mocks.call.mockResolvedValue({ ok: false, error: 'network' })
    const r = await requestLiveTradingDecision(single())
    expect(r.approved).toBe(false)
    expect(mocks.call).toHaveBeenCalledTimes(1)
    vi.stubEnv('FUTU_SINGLE_PROMPT_MODE', 'invalid')
    const bad = await requestLiveTradingDecision(single())
    expect(bad.approved).toBe(false)
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })
  it('长桥新版实盘仅将完整、合规且未过期的决策交给订单链路', async () => {
    vi.stubEnv('LONGBRIDGE_PROMPT_MODE', 'live')
    const output = {
      ...hold(), approved: true, action: 'BUY', orderQuantity: 1, limitPrice: 180,
      positionEffect: 'OPEN_LONG', invalidationPrice: 170,
    }
    mocks.call.mockResolvedValue({ ok: true, text: JSON.stringify(output) })
    const result = await requestLongbridgeLiveTradingDecision(single())
    expect(result).toMatchObject({ ok: true, approved: true, action: 'BUY', orderQuantity: 1 })
    expect(result.promptAudit).toMatchObject({
      mode: 'live', ordersEnabled: true, contractValid: true, policyValid: true,
    })
  })
  it('组合即使批准候选也只保留原始输出，不下发晋级', async () => {
    const c = { candidateId: 'c1', ticker: 'AAPL', action: 'BUY', firstSeenAt: now() }
    mocks.call.mockResolvedValue({ ok: true, text: JSON.stringify({
      ok: true, promotedCandidates: [{ candidateId: 'c1', riskPlanId: 'unavailable-1', rank: 1, reason: '通过', riskAssessment: '风险', evidenceIds: ['C1'] }],
      watchedCandidates: [], suppressedCandidates: [], expiredCandidates: [], portfolioRationale: '测试',
    }) })
    const r = await requestLivePortfolioReviewDecision({ candidates: [c], account: account(), positions: [], pendingOrders: [], constraints: { maxPromotedOrdersPerReview: 1 } } as any, { broker: 'longbridge' })
    expect(r.promotedCandidates).toEqual([])
    expect(r.promptAudit?.output?.promotedCandidates).toHaveLength(1)
    expect(r.promptAudit?.policyValid).toBe(false)
  })

  it('响应延迟时保留无动作HOLD信号，冻结上下文不可被调用方后续修改', async () => {
    const ctx = buildSingleProductionContext('longbridge', single())
    ctx.sourceValidUntil = new Date(Date.now() + 10).toISOString()
    mocks.call.mockImplementation(async () => {
      ctx.facts.marketData.lastPrice = 999
      await new Promise(resolve => setTimeout(resolve, 30))
      return { ok: true, text: JSON.stringify(hold()) }
    })
    const audit = await requestProductionShadow(ctx)
    expect(audit.contextUsableAtResponse).toBe(false)
    expect(audit.policyValid).toBe(true)
    expect(audit.errors).not.toContain('snapshot_expired_or_unknown')
    const persisted = JSON.parse(await readFile(join(dir, audit.artifactId!), 'utf8'))
    expect(persisted.facts.marketData.lastPrice).toBe(180)

    const actionable = buildSingleProductionContext('longbridge', single())
    actionable.sourceValidUntil = new Date(Date.now() + 10).toISOString()
    mocks.call.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
      return { ok: true, text: JSON.stringify({
        ...hold(), approved: true, action: 'BUY', orderQuantity: 1, limitPrice: 180,
        positionEffect: 'OPEN_LONG', invalidationPrice: 170,
      }) }
    })
    const blocked = await requestProductionDecision(actionable, 'live')
    expect(blocked.policyValid).toBe(false)
    expect(blocked.errors).toContain('snapshot_expired_or_unknown')
  })

  it.each(['longbridge', 'futu'] as const)('%s组合真实入口保存独立候选证据，禁止晋级', async broker => {
    const candidates = ['AAPL', 'MSFT'].map((ticker, i) => ({
      candidateId: `c${i}`, ticker, action: 'BUY', firstSeenAt: now(),
      marketEvidence: candidateProductionEvidence({ ticker, marketData: market(ticker),
        decision: { ...hold(), action: 'BUY', orderQuantity: 1, limitPrice: market(ticker).lastPrice } as any }),
    }))
    const input = { account: account(), positions: [], candidates, pendingOrders: [], constraints: { maxPromotedOrdersPerReview: 2 } } as any
    mocks.call.mockResolvedValue({ ok: true, text: JSON.stringify({
      ok: true, promotedCandidates: [], watchedCandidates: candidates.map(c => ({ candidateId: c.candidateId, reason: '预算未知' })),
      suppressedCandidates: [], expiredCandidates: [], portfolioRationale: '不晋级',
    }) })
    const result = await requestLivePortfolioReviewDecision(input, { broker, promptScope: 'tenant-a:binding-a' })
    expect(result.promotedCandidates).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.promptAudit?.contractValid).toBe(true)
    const payload = JSON.parse(mocks.call.mock.calls[0][0][1].content)
    expect(payload.candidatePool.map(c => c.marketEvidence.market.lastPrice)).toEqual([180, 400])
    expect(payload.candidatePool.every(c => c.rankingMetrics === null)).toBe(true)
    const bad = structuredClone(input)
    bad.candidates[1].marketEvidence.ticker = 'AAPL'
    expect(buildPortfolioProductionContext(broker, bad).facts.candidatePool[1].marketEvidence).toBeNull()
  })

  it.each(['futu', 'longbridge'] as const)('%s挂单真实入口不将模型CANCEL交给监管器', async broker => {
    const contexts = [{ order: { ...order(), platform: broker }, account: { positions: [] }, accountSnapshot: account(), marketData: market() }]
    mocks.call.mockResolvedValue({ ok: true, text: JSON.stringify({
      decisions: [{ platform: broker, orderId: 'order-a', action: 'CANCEL', evidenceIds: ['O1'],
        reason: '取消', riskAssessment: '未知开平仓', requestedFollowUp: 'REFRESH_DATA' }], portfolioRationale: '仅建议',
    }) })
    const result = await requestManagedOrderDecisions({ platform: broker, orders: contexts })
    expect(result.size).toBe(0)
    expect(mocks.call).toHaveBeenCalledTimes(1)
    const ctx = buildManagedProductionContext(broker, contexts)
    expect(ctx.facts.orders[0].positionEffect).toBe('UNKNOWN')
    expect(ctx.facts.orders[0].risk.openingRiskStatus).toBe(broker === 'futu' ? 'UNKNOWN' : 'ALLOWED')
  })

  it('租户审计路径隔离且不包含明文用户标识', async () => {
    const ctx = buildSingleProductionContext('longbridge', single())
    const first = await requestProductionShadow({ ...ctx, scope: 'tenant-one/binding' })
    const second = await requestProductionShadow({ ...ctx, scope: 'tenant-two/binding' })
    expect(first.artifactId!.split('/')[0]).not.toBe(second.artifactId!.split('/')[0])
    expect(first.artifactId).not.toContain('tenant-one')
    expect(await readdir(dir)).toHaveLength(2)
  })

  it('审计失败仍保持不可执行并标记失败', async () => {
    vi.stubEnv('TRADING_PROMPT_AUDIT_DIR', '/dev/null/not-a-directory')
    const result = await requestLongbridgeLiveTradingDecision(single())
    expect(result.approved).toBe(false)
    expect(result.promptAudit?.errors).toContain('audit_write_failed')
    expect(result.promptAudit?.policyValid).toBe(false)
  })
})
