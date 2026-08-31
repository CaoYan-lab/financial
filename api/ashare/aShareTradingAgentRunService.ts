import type { AShareTradingAgentRun } from '../../shared/types.js'
import { aSharePersistence } from './aSharePersistence.js'

const MAX_ITEMS = 200

class AShareTradingAgentRunService {
  private readonly runs: AShareTradingAgentRun[] = aSharePersistence.readLatest('agent_runs', MAX_ITEMS)

  append(run: AShareTradingAgentRun) {
    this.runs.unshift(run)
    this.runs.splice(MAX_ITEMS)
    aSharePersistence.appendAgentRun(run)
  }

  latest(limit = 20): AShareTradingAgentRun[] {
    return this.runs.slice(0, Math.max(0, limit))
  }

  latestForTicker(ticker: string): AShareTradingAgentRun | undefined {
    const normalized = ticker.toUpperCase()
    return this.runs.find((run) => run.ticker.toUpperCase() === normalized)
  }
}

export const aShareTradingAgentRunService = new AShareTradingAgentRunService()
