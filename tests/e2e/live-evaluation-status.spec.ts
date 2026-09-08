import { expect, test, type Page } from '@playwright/test'

const now = '2026-09-07T16:00:00.000Z'

const strategyConfig = {
  ok: true,
  mode: 'live',
  selection: {
    strategyId: 'balanced',
    promptPackId: 'prompt-v1',
    executionMode: 'candidate_pool',
    updatedAt: now,
  },
  strategyOptions: [
    { id: 'balanced', label: '稳健趋势策略', version: 1, summary: '控制波动与仓位集中度。', enabledFor: ['live'] },
    { id: 'growth', label: '成长动量策略', version: 1, summary: '关注趋势延续与成交确认。', enabledFor: ['live'] },
  ],
  promptPackOptions: [
    { id: 'prompt-v1', label: '实盘提示词第一版', version: 1, summary: '实盘决策约束。', enabledFor: ['live'] },
  ],
  activeStrategy: {
    id: 'balanced',
    version: 1,
    label: '稳健趋势策略',
    summary: '控制波动与仓位集中度。',
    enabledFor: ['live'],
    riskControls: {},
    trendFilters: {},
  },
  activePromptPack: {
    id: 'prompt-v1',
    version: 1,
    label: '实盘提示词第一版',
    summary: '实盘决策约束。',
    enabledFor: ['live'],
    systemPrompts: {},
    hardConstraints: {},
    requiredJson: {},
  },
  warnings: [],
}

const candidatePool = {
  executionMode: 'candidate_pool',
  enabled: true,
  promptVersion: 'review-v1',
  promptLabel: '组合裁决',
  promptSummary: '组合裁决',
  promptConfigVersion: 1,
  promptRawYaml: '',
  presetId: 'balanced',
  presetLabel: '平衡',
  timingPresets: [],
  decisionRuleCount: 1,
  requiredJsonKeys: [],
  candidates: [],
}

function emptyPage() {
  return { items: [], page: 1, pageSize: 12, total: 0, totalPages: 1 }
}

async function loginOwner(page: Page) {
  const response = await page.request.post('/api/auth/login', {
    data: { username: 'e2e_owner', password: 'OwnerPassword12' },
  })
  expect(response.status()).toBe(200)
}

async function mockFutuApis(page: Page) {
  await page.route('**/api/live-trading/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/live-trading/dashboard') {
      await route.fulfill({ json: {
        account: {
          ok: true,
          selectedAccountId: '真实账户',
          summary: { totalAssets: '$1,000.00', buyingPower: '$800.00' },
          positions: [],
          risk: { warnings: [] },
          trading: { environment: 'REAL' },
          warnings: [],
        },
        engine: {
          running: true,
          mode: 'REAL',
          accountId: '真实账户',
          startedAt: now,
          lastRunAt: now,
          nextRunAt: now,
          universe: ['AAPL', '07747'],
          strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
          runIntervalMs: 60_000,
          pendingOrderCount: 0,
          submittedOrderCount: 0,
          signalCount: 0,
          lastError: '',
        },
        evaluationStatus: {
          state: 'WAITING_MARKET',
          title: '实盘评估运行中，当前等待开市',
          summary: '股票池共 2 个标的，当前均不进入模型评估，也不会生成策略信号。',
          activeCount: 0,
          waitingCount: 2,
          totalCount: 2,
          updatedAt: now,
          items: [
            { ticker: 'AAPL', market: '美股', marketState: 'CLOSED', marketLabel: '休市', evaluationState: 'WAITING_MARKET', reason: '美股当前处于周末、节假日或休市状态。' },
            { ticker: '07747', market: '港股', marketState: 'CLOSED', marketLabel: '休市', evaluationState: 'WAITING_MARKET', reason: '港股休市后大模型请求已关闭。' },
          ],
        },
        universe: [],
        llmRuntimeConfig: { model: 'deepseek', modelLabel: '深度求索', concurrency: 2, maxConcurrency: 4, disableUsOvernightLlm: true },
        modelOptions: [],
        latestSignals: [],
        pendingOrders: [],
        submittedOrders: [],
        skippedTickers: [],
        warnings: [],
        liveTradingEnabled: false,
        autoSubmitEnabled: false,
        autoCancelEnabled: false,
        marketableLimitTimeoutSeconds: 90,
        limitTimeoutSeconds: 600,
        brokerSyncIntervalSeconds: 30,
        modelReviewIntervalSeconds: 60,
        candidatePool,
      } })
      return
    }
    if (path === '/api/live-trading/trade-strategy-config') {
      await route.fulfill({ json: strategyConfig })
      return
    }
    if (path.includes('/history/')) {
      await route.fulfill({ json: emptyPage() })
      return
    }
    if (path === '/api/live-trading/managed-orders') {
      await route.fulfill({ json: { ok: true, orders: [], events: [], supervisor: { running: false } } })
      return
    }
    if (path === '/api/live-trading/futu-orders') {
      await route.fulfill({ json: { ok: true, orders: [], page: 1, pageSize: 12, total: 0, totalPages: 1, warnings: [] } })
      return
    }
    await route.continue()
  })
}

async function mockLongbridgeApis(page: Page) {
  await page.route('**/api/longbridge/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/longbridge/workbench/dashboard') {
      await route.fulfill({ json: {
        ok: true,
        sourceStatus: { authStatus: 'authenticated', tradingAvailable: false },
        accountMetrics: [
          { label: '账户净资产', value: '$1,000.00' },
          { label: '最大购买力', value: '$800.00' },
        ],
        positions: [],
        riskCards: [],
        dataPanels: [],
        researchPanels: [],
        tradingPanels: [],
        warnings: [],
        updatedAt: now,
      } })
      return
    }
    if (path === '/api/longbridge/live-trading/dashboard') {
      await route.fulfill({ json: {
        ok: true,
        engine: {
          running: true,
          mode: 'REAL',
          accountId: '长桥账户',
          startedAt: now,
          lastRunAt: now,
          nextRunAt: now,
          universe: ['AAPL', '07747'],
          strategy: 'LLM_AUTONOMOUS_STOCK_TRADER',
          runIntervalMs: 60_000,
          pendingOrderCount: 0,
          submittedOrderCount: 0,
          signalCount: 0,
          lastError: '',
        },
        evaluationStatus: {
          state: 'PARTIAL',
          title: '实盘评估运行中，部分市场等待开市',
          summary: '1 个标的正在评估，1 个标的等待市场开放。',
          activeCount: 1,
          waitingCount: 1,
          totalCount: 2,
          updatedAt: now,
          items: [
            { ticker: 'AAPL', market: '美股', marketState: 'RTH', marketLabel: '盘中', evaluationState: 'ACTIVE', reason: '当前处于策略允许的评估时段。' },
            { ticker: '07747', market: '港股', marketState: 'CLOSED', marketLabel: '休市', evaluationState: 'WAITING_MARKET', reason: '港股休市后大模型请求已关闭。' },
          ],
        },
        liveTradingEnabled: false,
        autoSubmitEnabled: false,
        autoCancelEnabled: false,
        marketableLimitTimeoutSeconds: 90,
        limitTimeoutSeconds: 600,
        brokerSyncIntervalSeconds: 30,
        modelReviewIntervalSeconds: 60,
        signals: [],
        pendingOrders: [],
        candidatePool,
        warnings: [],
        updatedAt: now,
      } })
      return
    }
    if (path === '/api/longbridge/live-trading/config') {
      await route.fulfill({ json: {
        llmRuntimeConfig: { model: 'deepseek', modelLabel: '深度求索', concurrency: 2, maxConcurrency: 4, disableUsOvernightLlm: true },
        modelOptions: [],
        tradeStrategyConfig: strategyConfig,
        candidatePoolConfig: candidatePool,
      } })
      return
    }
    if (path.includes('/history/')) {
      await route.fulfill({ json: emptyPage() })
      return
    }
    if (path.endsWith('/managed-orders')) {
      await route.fulfill({ json: { ok: true, orders: [], events: [], supervisor: { running: false } } })
      return
    }
    if (path.endsWith('/orders')) {
      await route.fulfill({ json: { ok: true, orders: [], page: 1, pageSize: 12, total: 0, totalPages: 1, warnings: [] } })
      return
    }
    await route.continue()
  })
}

test('Futu 顶部展示休市状态并打开全部策略详情', async ({ page }, testInfo) => {
  await loginOwner(page)
  await mockFutuApis(page)
  await page.goto('/live-trading')
  await expect(page.getByRole('heading', { name: '实盘评估运行中，当前等待开市' })).toBeVisible()
  await expect(page.getByText('风控拦截')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('futu-status-banner.png'), fullPage: false })
  await page.getByRole('button', { name: '查看实盘评估详情说明' }).click()
  const dialog = page.getByRole('dialog', { name: '策略与标的详情' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('稳健趋势策略', { exact: true })).toHaveCount(2)
  await expect(dialog.getByText('成长动量策略', { exact: true })).toBeVisible()
  await expect(dialog.getByText('07747', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('futu-status-dialog.png'), fullPage: false })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Longbridge 移动端展示部分运行状态且弹窗无横向溢出', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await loginOwner(page)
  await mockLongbridgeApis(page)
  await page.goto('/longbridge/live-trading')
  await expect(page.getByRole('heading', { name: '实盘评估运行中，部分市场等待开市' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('longbridge-mobile-status-banner.png'), fullPage: false })
  await page.getByRole('button', { name: '查看实盘评估详情说明' }).click()
  await expect(page.getByRole('dialog', { name: '策略与标的详情' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: testInfo.outputPath('longbridge-mobile-status-dialog.png'), fullPage: false })
})

test('owner 可在用户管理中批准成员实盘门禁', async ({ page }) => {
  await loginOwner(page)
  let approved = false
  await page.route('**/api/multiuser/users**', async (route) => {
    const request = route.request()
    if (request.method() === 'PUT' && request.url().endsWith('/longbridge-live-gate')) {
      approved = true
      await route.fulfill({ json: { success: true, liveTradingEnabled: true } })
      return
    }
    await route.fulfill({ json: {
      success: true,
      users: [
        {
          userId: 'owner-1',
          username: 'e2e_owner',
          displayName: '管理员',
          role: 'owner',
          active: true,
          mustChangePassword: false,
          sessionsValidAfter: now,
        },
        {
          userId: 'member-1',
          username: 'chuangye',
          displayName: 'chuangye',
          role: 'member',
          active: true,
          mustChangePassword: false,
          sessionsValidAfter: now,
          longbridgeConnection: {
            id: 'binding-1',
            platform: 'longbridge',
            status: 'verified',
            credentialSource: 'encrypted_bundle',
          },
          longbridgeLiveGate: {
            shadowVerifiedAt: approved ? now : undefined,
            liveTradingEnabled: approved,
            autoSubmitEnabled: false,
          },
        },
      ],
    } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '用户管理' }).click()
  await expect(page.getByText('chuangye · 已启用 · 长桥 已连接 · 实盘未批准')).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '批准实盘' }).click()
  await expect(page.getByText('chuangye · 已启用 · 长桥 已连接 · 实盘已批准')).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭实盘' })).toBeVisible()
})
