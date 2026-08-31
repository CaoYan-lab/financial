import type { UniverseCompany } from '../../shared/types.js'

const shareClassGroups: Record<string, { group: string; preferredTicker: string }> = {
  GOOG: { group: 'Alphabet', preferredTicker: 'GOOG' },
  GOOGL: { group: 'Alphabet', preferredTicker: 'GOOG' },
  'BRK.A': { group: 'Berkshire Hathaway', preferredTicker: 'BRK.B' },
  'BRK.B': { group: 'Berkshire Hathaway', preferredTicker: 'BRK.B' },
}

export function lockTopThirtyUniverse(companies: UniverseCompany[]): UniverseCompany[] {
  const selected = new Map<string, UniverseCompany>()
  const seenGroups = new Set<string>()

  for (const company of companies) {
    const normalizedTicker = company.ticker.toUpperCase()
    const shareClass = shareClassGroups[normalizedTicker]
    const groupKey = shareClass?.group ?? normalizedTicker

    if (seenGroups.has(groupKey)) {
      const current = selected.get(groupKey)
      if (current && shareClass?.preferredTicker === normalizedTicker) {
        selected.set(groupKey, {
          ...company,
          ticker: normalizedTicker,
          companyName: shareClass.group,
          shareClassGroup: shareClass.group,
          selectedTickerReason: `Selected ${shareClass.preferredTicker} as the more liquid analysis ticker.`,
        })
      }
      continue
    }

    seenGroups.add(groupKey)
    selected.set(groupKey, {
      ...company,
      ticker: shareClass?.preferredTicker ?? normalizedTicker,
      companyName: shareClass?.group ?? company.companyName,
      shareClassGroup: shareClass?.group,
      selectedTickerReason: shareClass
        ? shareClass.group === 'Alphabet'
          ? 'Selected GOOG (Google-C) as the requested analysis ticker.'
          : `Selected ${shareClass.preferredTicker} as the more liquid analysis ticker.`
        : company.selectedTickerReason,
    })

    if (selected.size === 30) {
      break
    }
  }

  const locked = [...selected.values()].slice(0, 30).map((company, index) => ({
    ...company,
    rank: index + 1,
  }))

  if (locked.length !== 30) {
    throw new Error(`Universe selection requires 30 companies after share-class merging; received ${locked.length}.`)
  }

  return locked
}
