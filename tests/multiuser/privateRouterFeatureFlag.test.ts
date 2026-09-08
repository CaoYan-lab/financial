import { createServer, type Server } from 'node:http'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createMultiUserPrivateRouter } from '../../api/cloud/multiuser/http/privateRouter.js'

describe('多用户私有路由暗开关', () => {
  const originalEnabled = process.env.MULTIUSER_ENABLED
  let server: Server | undefined

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve())
      })
      server = undefined
    }
    if (originalEnabled === undefined) delete process.env.MULTIUSER_ENABLED
    else process.env.MULTIUSER_ENABLED = originalEnabled
  })

  it('关闭时完整退出 Router 并回落到原有 Longbridge 路由', async () => {
    process.env.MULTIUSER_ENABLED = 'false'
    const app = express()
    app.use(createMultiUserPrivateRouter())
    app.get('/longbridge/workbench/dashboard', (_req, res) => {
      res.json({ source: 'legacy' })
    })
    server = createServer(app)
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器端口不可用')

    const response = await fetch(`http://127.0.0.1:${address.port}/longbridge/workbench/dashboard`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ source: 'legacy' })
  })
})
