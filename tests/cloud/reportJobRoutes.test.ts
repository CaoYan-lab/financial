import express from 'express'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const taskStoreMocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  enqueueLatestJob: vi.fn(),
  getJob: vi.fn(),
  getWorkerStatus: vi.fn(),
  listWorkerStatus: vi.fn(),
  setEngineDesired: vi.fn(),
}))

vi.mock('../../api/cloud/state/taskStores.js', () => taskStoreMocks)

import { createRouteOverrideRouter } from '../../api/cloud/http/routeOverrides.js'

describe('云端报告异步任务路由', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', createRouteOverrideRouter())
    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试端口不可用')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(() => {
    vi.clearAllMocks()
    taskStoreMocks.enqueueJob.mockResolvedValue('job-1')
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  })

  it('生成请求立即入队并返回 202', async () => {
    const response = await fetch(`${baseUrl}/api/report/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reportWindowDays: 60 }),
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      success: true,
      status: 'queued',
      jobId: 'job-1',
    })
    expect(taskStoreMocks.enqueueJob).toHaveBeenCalledWith(
      'report.generate',
      expect.objectContaining({ reportWindowDays: 60 }),
    )
  })

  it('查询接口返回运行状态', async () => {
    taskStoreMocks.getJob.mockResolvedValue({
      id: 'job-1',
      job_type: 'report.generate',
      payload: { batchId: 'batch-1', requestedBy: null },
      status: 'running',
      result: null,
      last_error: null,
    })

    const response = await fetch(`${baseUrl}/api/report/jobs/job-1`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      status: 'running',
      batchId: 'batch-1',
    })
  })

  it('任务完成后返回完整报告', async () => {
    const report = { batchId: 'batch-1', markdown: '# 报告' }
    taskStoreMocks.getJob.mockResolvedValue({
      id: 'job-1',
      job_type: 'report.generate',
      payload: { batchId: 'batch-1', requestedBy: null },
      status: 'succeeded',
      result: { report },
      last_error: null,
    })

    const response = await fetch(`${baseUrl}/api/report/jobs/job-1`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      status: 'succeeded',
      batchId: 'batch-1',
      report,
    })
  })

  it('长桥订单读取只保留同一用户的最新排队请求', async () => {
    taskStoreMocks.enqueueLatestJob.mockResolvedValue('orders-job-1')
    taskStoreMocks.getJob.mockResolvedValue({
      id: 'orders-job-1',
      job_type: 'longbridge_live.orders',
      payload: { requestedBy: null },
      status: 'succeeded',
      result: {
        response: {
          ok: true,
          orders: [],
          page: 1,
          pageSize: 12,
          total: 0,
          totalPages: 1,
          startDate: '2026-09-16',
          endDate: '2026-09-23',
          warnings: [],
        },
      },
      last_error: null,
    })

    const response = await fetch(`${baseUrl}/api/longbridge/live-trading/orders?page=1&pageSize=12`)

    expect(response.status).toBe(200)
    expect((await response.json()).ok).toBe(true)
    expect(taskStoreMocks.enqueueLatestJob).toHaveBeenCalledWith(
      'longbridge_live.orders',
      expect.objectContaining({ page: 1, pageSize: 12 }),
    )
  })
})
