import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLongbridgeOrderChildEnvironment,
  longbridgeOrderProxyConfigured,
} from '../api/longbridge/longbridgeOrderProxy.js'

const original = {
  cloudMode: process.env.CLOUD_MODE,
  localDirect: process.env.MULTIUSER_LOCAL_DIRECT,
  proxy: process.env.LONGBRIDGE_ORDER_PROXY_URL,
  httpsProxy: process.env.HTTPS_PROXY,
}

afterEach(() => {
  restore('CLOUD_MODE', original.cloudMode)
  restore('MULTIUSER_LOCAL_DIRECT', original.localDirect)
  restore('LONGBRIDGE_ORDER_PROXY_URL', original.proxy)
  restore('HTTPS_PROXY', original.httpsProxy)
})

describe('Longbridge 订单代理环境', () => {
  it('云端 admin 与租户共用同一代理变量', () => {
    process.env.CLOUD_MODE = '1'
    delete process.env.MULTIUSER_LOCAL_DIRECT
    process.env.LONGBRIDGE_ORDER_PROXY_URL = 'http://10.0.0.8:18080'

    const admin = buildLongbridgeOrderChildEnvironment()
    const tenant = buildLongbridgeOrderChildEnvironment({
      credentials: {
        appKey: 'tenant-key',
        appSecret: 'tenant-secret',
        accessToken: 'tenant-token',
      },
      allowSubmit: true,
    })

    expect(admin).toMatchObject({
      HTTPS_PROXY: 'http://10.0.0.8:18080',
      HTTP_PROXY: 'http://10.0.0.8:18080',
      NO_PROXY: '',
    })
    expect(tenant).toMatchObject({
      HTTPS_PROXY: admin?.HTTPS_PROXY,
      HTTP_PROXY: admin?.HTTP_PROXY,
      NO_PROXY: admin?.NO_PROXY,
      LONGBRIDGE_APP_KEY: 'tenant-key',
      LONGBRIDGE_LIVE_TRADING_ENABLED: 'true',
    })
    expect(longbridgeOrderProxyConfigured()).toBe(true)
  })

  it('云端缺少代理时 admin 与租户都失败关闭', () => {
    process.env.CLOUD_MODE = '1'
    delete process.env.MULTIUSER_LOCAL_DIRECT
    delete process.env.LONGBRIDGE_ORDER_PROXY_URL
    expect(buildLongbridgeOrderChildEnvironment()).toBeUndefined()
    expect(buildLongbridgeOrderChildEnvironment({
      credentials: { appKey: 'key', appSecret: 'secret', accessToken: 'token' },
      allowSubmit: true,
    })).toBeUndefined()
    expect(longbridgeOrderProxyConfigured()).toBe(false)
  })

  it('本地直连模式清除继承的代理变量', () => {
    process.env.CLOUD_MODE = '1'
    process.env.MULTIUSER_LOCAL_DIRECT = 'true'
    process.env.HTTPS_PROXY = 'http://parent-proxy'
    const env = buildLongbridgeOrderChildEnvironment()
    expect(env?.HTTPS_PROXY).toBeUndefined()
  })
})

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
