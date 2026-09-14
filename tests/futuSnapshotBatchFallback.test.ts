import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Futu 快照批次降级', () => {
  it('隔离无效代码并保留其余批量结果', () => {
    const bridgePath = path.resolve(process.cwd(), 'api/futu_bridge')
    const script = `
import json
from futu_snapshot import fetch_snapshots

class Frame:
    def __init__(self, rows):
        self.rows = rows
        self.empty = not rows

    def iterrows(self):
        for index, row in enumerate(self.rows):
            yield index, row

class QuoteContext:
    def __init__(self):
        self.calls = []

    def get_market_snapshot(self, codes):
        self.calls.append(list(codes))
        if "US.BAD" in codes:
            return 1, "invalid security"
        return 0, Frame([{"code": code, "last_price": 100} for code in codes])

ctx = QuoteContext()
codes = ["US.A", "US.B", "US.C", "US.BAD", "US.D", "US.E", "US.F", "US.G"]
rows, warnings = fetch_snapshots(ctx, codes, 0)
print(json.dumps({
    "codes": sorted(rows.keys()),
    "warnings": warnings,
    "calls": len(ctx.calls),
}))
`
    const result = spawnSync('python3', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: [bridgePath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    })

    expect(result.status, result.stderr).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.codes).toEqual(['US.A', 'US.B', 'US.C', 'US.D', 'US.E', 'US.F', 'US.G'])
    expect(payload.warnings).toEqual(['US.BAD snapshot unavailable: invalid security'])
    expect(payload.calls).toBeLessThan(9)
  })
})
