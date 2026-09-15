import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { resolveTradingPromptMode, saveTradingPromptMode, tradingPromptReleaseStatus } from '../api/live/tradingPromptReleaseService'
import { createTradingPromptRouter, promptModeOriginAllowed } from '../api/routes/tradingPromptRoutes'

describe('提示词服务端模式门禁', () => {
  let dir: string
  let server: Server | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prompt-mode-'))
    vi.stubEnv('TRADING_PROMPT_MODE_DB_PATH', join(dir, 'mode.db'))
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('CLOUD_MODE', '')
    for (const key of Object.keys(process.env).filter(k => k.endsWith('_PROMPT_MODE'))) vi.stubEnv(key, undefined)
  })
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })
  const patch = (mode: string, expectedRevision = 0) => ({ mode, expectedRevision, confirmed: true })

  it('持久化模式，三个角色共用配置，券商和租户互相隔离', async () => {
    expect(await resolveTradingPromptMode('futu', 'single')).toBe('legacy')
    await saveTradingPromptMode('futu', 'default', patch('shadow'))
    for (const role of ['single', 'portfolio', 'managed'] as const) expect(await resolveTradingPromptMode('futu', role)).toBe('shadow')
    expect(await resolveTradingPromptMode('longbridge', 'single')).toBe('legacy')
    await saveTradingPromptMode('longbridge', 'tenant:a', patch('shadow'))
    expect(await resolveTradingPromptMode('longbridge', 'single', 'tenant:a')).toBe('shadow')
    expect((await tradingPromptReleaseStatus('longbridge', 'tenant:a')).effectiveModes.managed).toBe('shadow')
    const tenantLive = await saveTradingPromptMode('longbridge', 'tenant:a', patch('live', 1))
    expect(tenantLive.effectiveModes).toEqual({ single: 'live', portfolio: 'live', managed: 'live' })
    expect(tenantLive.liveAvailable).toBe(true)
    expect(tenantLive.blockers).toEqual([])
    expect(await resolveTradingPromptMode('longbridge', 'single', 'tenant:b')).toBe('legacy')
    await saveTradingPromptMode('futu', 'default', patch('legacy', 1))
    expect((await tradingPromptReleaseStatus('futu')).revision).toBe(2)
  }, 15_000)
  it('实盘模式可持久化，客户端仍不能伪造额外验收字段', async () => {
    const status = await saveTradingPromptMode('futu', 'default', patch('live'))
    expect(status.selectedMode).toBe('live')
    expect(status.productionPrompt.version).toBe('dual-broker-production-v2.4.3-1')
    expect(status.productionPrompt.roles.single.instruction).toContain('富途')
    expect(status.productionPrompt.roles.single.instruction).toContain('生产真实数据实盘决策模式')
    await expect(saveTradingPromptMode('futu', 'default', { ...patch('shadow', 1), verified: true })).rejects.toThrow('字段无效')
    await expect(saveTradingPromptMode('futu', 'default', { ...patch('shadow'), confirmed: false })).rejects.toThrow()
    expect((await tradingPromptReleaseStatus('futu')).revision).toBe(1)
    expect((await tradingPromptReleaseStatus('futu')).liveAvailable).toBe(true)
  })
  it('同版本并发更新只有一个成功，旧页面不能覆盖', async () => {
    const results = await Promise.allSettled([
      saveTradingPromptMode('longbridge', 'default', patch('shadow')),
      saveTradingPromptMode('longbridge', 'default', patch('legacy')),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await tradingPromptReleaseStatus('longbridge')).revision).toBe(1)
  })
  it('环境覆盖可见，非法值不回退，覆盖期间拒绝界面修改', async () => {
    vi.stubEnv('FUTU_SINGLE_PROMPT_MODE', 'shadow')
    expect(await resolveTradingPromptMode('futu', 'single')).toBe('shadow')
    expect((await tradingPromptReleaseStatus('futu')).environmentOverrides.single).toBe('FUTU_SINGLE_PROMPT_MODE')
    await expect(saveTradingPromptMode('futu', 'default', patch('legacy'))).rejects.toThrow('环境变量')
    vi.stubEnv('FUTU_SINGLE_PROMPT_MODE', 'live')
    expect(await resolveTradingPromptMode('futu', 'single')).toBe('live')
    expect((await tradingPromptReleaseStatus('futu')).effectiveModes.single).toBe('live')
    vi.stubEnv('FUTU_SINGLE_PROMPT_MODE', 'invalid')
    await expect(resolveTradingPromptMode('futu', 'single')).rejects.toThrow('无效')
  })
  it('存储故障失败关闭，不降级到旧版执行', async () => {
    vi.stubEnv('TRADING_PROMPT_MODE_DB_PATH', dir)
    await expect(resolveTradingPromptMode('futu', 'single')).rejects.toThrow('存储不可用')
  })
  it('HTTP拒绝跨源写，同源确认后可保存实盘', async () => {
    const app = express()
    app.use(express.json())
    app.use('/mode', createTradingPromptRouter('futu'))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server!.once('listening', resolve))
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    const put = (mode: string, origin: string, revision = 0) => fetch(`${url}/mode`, {
      method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(patch(mode, revision)),
    })
    expect((await put('shadow', 'https://outside.example')).status).toBe(403)
    expect((await put('live', url)).status).toBe(200)
    expect((await put('shadow', 'http://localhost:5174', 1)).status).toBe(200)
    vi.stubEnv('CLOUD_MODE', '1')
    expect((await fetch(`${url}/mode`)).status).toBe(401)
  })
  it('云代理内外协议不一致时只接受已登录的浏览器同源请求', () => {
    vi.stubEnv('CLOUD_MODE', '1')
    const request = (site: string) => ({
      protocol: 'http',
      get: (name: string) => ({
        host: 'internal-function:8000',
        origin: 'https://financial.example.com',
        'sec-fetch-site': site,
      } as Record<string, string>)[name.toLowerCase()],
    } as any)
    expect(promptModeOriginAllowed(request('cross-site'), true)).toBe(false)
    expect(promptModeOriginAllowed(request('same-origin'), false)).toBe(false)
    expect(promptModeOriginAllowed(request('same-origin'), true)).toBe(true)
  })
})
