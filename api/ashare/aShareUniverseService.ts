import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AShareInstrumentLookupCandidate, AShareUniverseItem, AShareUniverseResponse } from './types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..', '..')
const universePath = path.join(projectRoot, '.data', 'a-share-universe.json')

export function getAshareUniverse(): AShareUniverseResponse {
  return {
    ok: true,
    universe: readUniverse(),
    updatedAt: new Date().toISOString(),
  }
}

export function addAshareUniverseItem(candidate: AShareInstrumentLookupCandidate): AShareUniverseResponse {
  const current = readUniverse()
  const normalizedTicker = candidate.ticker.toUpperCase()
  const nextItem: AShareUniverseItem = {
    ...candidate,
    ticker: normalizedTicker,
    futuCode: candidate.futuCode.toUpperCase(),
    addedAt: new Date().toISOString(),
  }
  const next = [nextItem, ...current.filter((item) => item.ticker.toUpperCase() !== normalizedTicker)]
  writeUniverse(next)
  return {
    ok: true,
    universe: next,
    updatedAt: new Date().toISOString(),
  }
}

export function removeAshareUniverseItem(ticker: string): AShareUniverseResponse {
  const normalizedTicker = ticker.toUpperCase()
  const next = readUniverse().filter((item) => item.ticker.toUpperCase() !== normalizedTicker)
  writeUniverse(next)
  return {
    ok: true,
    universe: next,
    updatedAt: new Date().toISOString(),
  }
}

function readUniverse(): AShareUniverseItem[] {
  try {
    if (!fs.existsSync(universePath)) return []
    const parsed = JSON.parse(fs.readFileSync(universePath, 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed.filter(isUniverseItem) : []
  } catch {
    return []
  }
}

function writeUniverse(universe: AShareUniverseItem[]) {
  fs.mkdirSync(path.dirname(universePath), { recursive: true })
  fs.writeFileSync(universePath, JSON.stringify(universe, null, 2))
}

function isUniverseItem(input: unknown): input is AShareUniverseItem {
  const item = input as Partial<AShareUniverseItem>
  return Boolean(item?.ticker && item?.futuCode && item?.market === 'CN' && item?.tradingCurrency === 'CNY')
}
