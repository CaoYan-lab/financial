import { describe, expect, it } from 'vitest'

// 直接复现 realtimeSubscriptionService 中的花括号配平提取逻辑做等价测试。
// 逻辑必须与 handleStdout/findJsonObjectEnd 保持一致。
function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

type Parsed = unknown[]

/** 复刻 handleStdout 的事件提取（喂入若干 chunk，模拟流式到达） */
function feedChunks(chunks: string[]): { parsed: Parsed; leftover: string } {
  let buffer = ''
  const parsed: Parsed = []
  for (const chunk of chunks) {
    buffer += chunk
    let index = 0
    const current = buffer
    while (index < current.length) {
      const start = current.indexOf('{', index)
      if (start === -1) {
        index = current.length
        break
      }
      const end = findJsonObjectEnd(current, start)
      if (end === -1) {
        index = start
        break
      }
      const candidate = current.slice(start, end + 1)
      try {
        parsed.push(JSON.parse(candidate))
      } catch {
        // 跳过无法解析片段
      }
      index = end + 1
    }
    buffer = index < current.length ? current.slice(index) : ''
  }
  return { parsed, leftover: buffer }
}

describe('实时订阅流 JSON 提取器', () => {
  it('单行单事件可解析', () => {
    const { parsed, leftover } = feedChunks(['{"kind":"ready","tickers":["A"]}\n'])
    expect(parsed).toHaveLength(1)
    expect((parsed[0] as { kind: string }).kind).toBe('ready')
    expect(leftover).toBe('')
  })

  it('多个事件粘在同一 chunk 可全部解析', () => {
    const { parsed } = feedChunks([
      '{"kind":"quote","ticker":"A"}\n{"kind":"quote","ticker":"B"}\n',
    ])
    expect(parsed).toHaveLength(2)
    expect((parsed[1] as { ticker: string }).ticker).toBe('B')
  })

  it('大事件跨 chunk 截断后仍能完整解析（核心修复）', () => {
    const event = JSON.stringify({
      kind: 'orderBook',
      ticker: '07747',
      asks: Array.from({ length: 20 }, (_, i) => ({ price: `$${72 + i * 0.02}`, size: 1000 + i, depth: i })),
      bids: Array.from({ length: 20 }, (_, i) => ({ price: `$${71 - i * 0.02}`, size: 900 + i, depth: i })),
    })
    // 在事件中间任意位置切成两半
    const cutAt = Math.floor(event.length * 0.4)
    const { parsed, leftover } = feedChunks([event.slice(0, cutAt), event.slice(cutAt) + '\n'])
    expect(parsed).toHaveLength(1)
    expect((parsed[0] as { kind: string }).kind).toBe('orderBook')
    expect(leftover).toBe('')
  })

  it('字符串内含花括号/转义不影响配平', () => {
    const event = '{"kind":"error","message":"unexpected } in {\\"payload\\"}"}\n'
    const { parsed } = feedChunks([event])
    expect(parsed).toHaveLength(1)
    expect((parsed[0] as { message: string }).message).toContain('} in')
  })

  it('futu SDK 非 JSON 日志行被跳过且不报错', () => {
    const { parsed, leftover } = feedChunks([
      '2026-09-01 10:27:50 | _init_connect_sync: New connect ready\n',
      '{"kind":"ticker","ticker":"07747"}\n',
    ])
    expect(parsed).toHaveLength(1)
    expect((parsed[0] as { ticker: string }).ticker).toBe('07747')
    expect(leftover).toBe('')
  })

  it('不完整尾行保留到 buffer 等待后续 chunk', () => {
    const { parsed, leftover } = feedChunks(['{"kind":"quote","tic'])
    expect(parsed).toHaveLength(0)
    expect(leftover).toBe('{"kind":"quote","tic')
  })
})
