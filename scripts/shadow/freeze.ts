import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { createScenarios, legacyInputs } from './scenarios.mjs'
import { buildShadowV2Messages, enrichLegacy, hash, suiteVersion } from './promptSuite.mjs'

const out = resolve(process.argv[2] ?? '.data/shadow-trading/frozen')
if (existsSync(resolve(out, 'dataset.json'))) throw new Error('Frozen dataset exists; choose a new directory')
mkdirSync(out, { recursive: true })
const isolated = mkdtempSync(resolve(out, 'isolated-'))
process.env.SIMULATION_HISTORY_DB_PATH = resolve(isolated, 'config.sqlite3')
process.env.NODE_ENV = 'test'
process.env.LIVE_TRADING_ENABLED = 'false'
process.env.LONGBRIDGE_LIVE_TRADING_ENABLED = 'false'

try {
  const { buildLongbridgeLiveDecisionPrompt } = await import('../../api/longbridge/longbridgeLiveDecisionService.js')
  const { buildLiveDecisionPrompt } = await import('../../api/live/liveTradingDecisionService.js')
  const { buildPortfolioReviewPrompt } = await import('../../api/live/livePortfolioReviewDecisionService.js')
  const { buildManagedOrderPrompt } = await import('../../api/live/managedOrderDecisionService.js')
  const portfolioConfig = parse(readFileSync('trade_strategy/portfolio_review_packs/live_portfolio_candidate_review_v1.yaml', 'utf8'))
  const requests = []
  for (const scenario of createScenarios()) {
    const input = legacyInputs(scenario)
    // Synthetic adapters deliberately exercise the existing builders without broker IO.
    const legacy = scenario.role === 'single'
      ? scenario.broker === 'longbridge'
        ? buildLongbridgeLiveDecisionPrompt(input.single as never)
        : buildLiveDecisionPrompt(input.single as never)
      : scenario.role === 'portfolio'
        ? buildPortfolioReviewPrompt(input.portfolio as never, scenario.facts.contextId, portfolioConfig)
        : buildManagedOrderPrompt(input.managed as never)
    for (const arm of ['legacy', 'legacy_enriched', 'v2'] as const) {
      const messages = arm === 'legacy' ? legacy : arm === 'legacy_enriched'
        ? enrichLegacy(legacy, scenario.facts)
        : buildShadowV2Messages(scenario.role, scenario.broker, scenario.facts)
      if (JSON.stringify(messages).includes(scenario.id) || JSON.stringify(messages).includes('"oracle"')) {
        throw new Error('Evaluator metadata leaked into model messages')
      }
      requests.push({ id: scenario.id, broker: scenario.broker, role: scenario.role, arm, messages, promptHash: hash(messages) })
    }
  }
  const dataset = { suiteVersion, synthetic: true, scenarios: createScenarios(), requests }
  writeFileSync(resolve(out, 'dataset.json'), JSON.stringify(dataset, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ scenarios: dataset.scenarios.length, requests: requests.length, datasetHash: hash(dataset), out }))
} finally {
  rmSync(isolated, { recursive: true, force: true })
}
