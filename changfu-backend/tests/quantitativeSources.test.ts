import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import {
  calculateFinraShortMetrics,
  parseFinraShortVolume,
  type FinraShortVolumePoint,
} from '../packages/research/src/finraResearchClient.js'
import {
  extractFactsAsOf,
  extractRecentEvents,
  selectLatestFactAsOf,
} from '../packages/research/src/secResearchClient.js'
import { PostgresPublicSourceCache } from '../packages/research/src/publicSourceCache.js'

test('SEC point-in-time 只选择 capturedAt 前已申报的最新重述值', () => {
  const selected = selectLatestFactAsOf('Revenue', {
    USD: [
      {
        val: 90,
        end: '2025-12-31',
        filed: '2026-02-01',
        form: '10-K',
        accn: 'old',
      },
      {
        val: 100,
        end: '2025-12-31',
        filed: '2026-03-01',
        form: '10-K',
        accn: 'restated',
      },
      {
        val: 120,
        end: '2026-03-31',
        filed: '2026-05-01',
        form: '10-Q',
        accn: 'future',
      },
    ],
  }, new Date('2026-03-15T00:00:00.000Z'))
  assert.equal(selected?.value, 100)
  assert.equal(selected?.accession, 'restated')
})

test('SEC 标准字段保留申报日、期间、单位与 accession', () => {
  const facts = extractFactsAsOf({
    facts: {
      'us-gaap': {
        Revenues: {
          units: {
            USD: [{
              val: 100,
              start: '2026-01-01',
              end: '2026-03-31',
              filed: '2026-04-20',
              form: '10-Q',
              fy: 2026,
              fp: 'Q1',
              accn: '0001',
              frame: 'CY2026Q1',
            }],
          },
        },
      },
    },
  }, new Date('2026-05-01T00:00:00.000Z'))
  assert.deepEqual(facts.revenue, {
    concept: 'Revenues',
    value: 100,
    unit: 'USD',
    filedAt: '2026-04-20',
    periodStart: '2026-01-01',
    periodEnd: '2026-03-31',
    form: '10-Q',
    fiscalYear: 2026,
    fiscalPeriod: 'Q1',
    accession: '0001',
    frame: 'CY2026Q1',
  })
})

test('SEC 事件只纳入已知时点前的 10-K/10-Q/8-K/Form 4', () => {
  const events = extractRecentEvents({
    filings: {
      recent: {
        accessionNumber: ['a', 'b', 'c'],
        form: ['8-K', '4', 'S-8'],
        filingDate: ['2026-01-01', '2026-01-02', '2026-01-03'],
        acceptanceDateTime: ['20260101120000', '20260102120000', '20260103120000'],
        reportDate: ['2025-12-31', '', ''],
        primaryDocument: ['a.htm', 'b.htm', 'c.htm'],
      },
    },
  }, '0000320193', new Date('2026-01-02T23:59:59.000Z'))
  assert.deepEqual(events.map(event => event.form), ['8-K', 'Form 4'])
  assert.match(events[0]!.sourceUrl, /sec\.gov\/Archives\/edgar/)
})

test('FINRA short volume 使用官方总成交分母，不等同 short interest', () => {
  const point = parseFinraShortVolume(
    [
      'Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market',
      '20261007|NVDA|400|10|1000|Q',
    ].join('\n'),
    'NVDA',
    '2026-10-07',
  )
  assert.equal(point?.shortVolumeRatio, 0.4)
  assert.equal(point?.denominator, 'FINRA_CONSOLIDATED_REPORTED_TOTAL_VOLUME')
})

test('FINRA 20/60 日均值、z-score 与 5 日变化按时间降序计算', () => {
  const points: FinraShortVolumePoint[] = Array.from({ length: 60 }, (_, index) => {
    const ratio = index === 0 ? 0.8 : 0.4
    return {
      date: `2026-09-${String(60 - index).padStart(2, '0')}`,
      symbol: 'NVDA',
      shortVolume: ratio * 1000,
      shortExemptVolume: 0,
      totalVolume: 1000,
      shortVolumeRatio: ratio,
      denominator: 'FINRA_CONSOLIDATED_REPORTED_TOTAL_VOLUME',
    }
  })
  const metrics = calculateFinraShortMetrics(points)
  assert.equal(metrics.availability, 'AVAILABLE')
  assert.equal(metrics.observations, 60)
  assert.ok((metrics.zScore60 ?? 0) > 7)
  assert.ok(Math.abs((metrics.change5Day ?? 0) - 0.4) < 1e-10)
})

test('官方数据缓存合并同一进程内的并发请求', async () => {
  let fetchCount = 0
  let writeCount = 0
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: [] }
      writeCount += 1
      return { rows: [] }
    },
  } as unknown as Pick<Pool, 'query'>
  const cacheA = new PostgresPublicSourceCache(pool)
  const cacheB = new PostgresPublicSourceCache(pool)
  const input = {
    source: 'FINRA' as const,
    cacheKey: 'test-concurrent-key',
    asOf: new Date('2026-10-08T00:00:00.000Z'),
    expiresAt: new Date('2026-10-09T00:00:00.000Z'),
    fetcher: async () => {
      fetchCount += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return { value: 1 }
    },
  }
  const [left, right] = await Promise.all([
    cacheA.getOrFetch(input),
    cacheB.getOrFetch(input),
  ])
  assert.equal(fetchCount, 1)
  assert.equal(writeCount, 1)
  assert.deepEqual(left.payload, right.payload)
})
