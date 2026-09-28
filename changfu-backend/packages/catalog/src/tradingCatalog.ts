import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export type DecisionRole =
  | 'SINGLE_DECISION'
  | 'PORTFOLIO_REVIEW'
  | 'MANAGED_ORDER_REVIEW'

type InternalModel = {
  id: string
  name: string
  deploymentId: string
  roles: DecisionRole[]
  capabilities: string[]
  latencyTier: 'FAST' | 'BALANCED' | 'DEEP'
  plans: string[]
}

type InternalPrompt = {
  id: string
  name: string
  version: string
  role: DecisionRole
  summary: string
  constraints: string[]
  outputFields: string[]
  publishedAt: string
  contentHash: string
  body: string
}

export type TradingCatalog = {
  catalogVersion: string
  publishedAt: string
  models: InternalModel[]
  strategies: Array<{
    id: string
    name: string
    version: string
    providers: Array<'FUTU' | 'LONGBRIDGE'>
    markets: Array<'US' | 'HK'>
    instrumentTypes: Array<'STOCK' | 'ETF'>
  }>
  prompts: InternalPrompt[]
  riskPolicies: Array<{ id: string; name: string; version: string }>
}

export type PublicTradingCatalog = Omit<TradingCatalog, 'models' | 'prompts'> & {
  models: Array<Omit<InternalModel, 'deploymentId'>>
  prompts: Array<Omit<InternalPrompt, 'body'>>
}

export class TradingCatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TradingCatalogError'
  }
}

function assertUniqueIds(items: Array<{ id: string }>, kind: string): void {
  const ids = new Set(items.map(item => item.id))
  if (ids.size !== items.length || items.some(item => !item.id)) {
    throw new TradingCatalogError(`${kind} ID 为空或重复`)
  }
}

export async function loadTradingCatalog(path: string): Promise<TradingCatalog> {
  const text = await readFile(path, 'utf8')
  let catalog: TradingCatalog
  try {
    // The checked-in YAML uses JSON syntax, which is a strict YAML subset.
    catalog = JSON.parse(text) as TradingCatalog
  } catch {
    throw new TradingCatalogError('交易目录不是有效的 YAML/JSON 文档')
  }
  if (!catalog.catalogVersion || !Array.isArray(catalog.models)
    || !Array.isArray(catalog.strategies) || !Array.isArray(catalog.prompts)
    || !Array.isArray(catalog.riskPolicies)) {
    throw new TradingCatalogError('交易目录缺少必填集合')
  }
  assertUniqueIds(catalog.models, '模型')
  assertUniqueIds(catalog.strategies, '策略')
  assertUniqueIds(catalog.prompts, '提示词')
  assertUniqueIds(catalog.riskPolicies, '风控策略')

  for (const prompt of catalog.prompts) {
    const actual = createHash('sha256').update(prompt.body, 'utf8').digest('hex')
    if (actual !== prompt.contentHash) {
      throw new TradingCatalogError(`提示词 ${prompt.id} 内容哈希不一致`)
    }
  }
  const roles = new Set<DecisionRole>([
    'SINGLE_DECISION',
    'PORTFOLIO_REVIEW',
    'MANAGED_ORDER_REVIEW',
  ])
  for (const role of roles) {
    if (!catalog.models.some(model => model.roles.includes(role))) {
      throw new TradingCatalogError(`角色 ${role} 没有可用模型`)
    }
    if (!catalog.prompts.some(prompt => prompt.role === role)) {
      throw new TradingCatalogError(`角色 ${role} 没有可用提示词`)
    }
  }
  return catalog
}

export function publicTradingCatalog(catalog: TradingCatalog): PublicTradingCatalog {
  return {
    catalogVersion: catalog.catalogVersion,
    publishedAt: catalog.publishedAt,
    models: catalog.models.map(({ deploymentId: _deploymentId, ...model }) => model),
    strategies: catalog.strategies,
    prompts: catalog.prompts.map(({ body: _body, ...prompt }) => prompt),
    riskPolicies: catalog.riskPolicies,
  }
}

export function resolvePrompt(
  catalog: TradingCatalog,
  id: string,
  role: DecisionRole,
): InternalPrompt {
  const prompt = catalog.prompts.find(item => item.id === id && item.role === role)
  if (!prompt) throw new TradingCatalogError(`提示词 ${id} 不支持角色 ${role}`)
  return prompt
}
