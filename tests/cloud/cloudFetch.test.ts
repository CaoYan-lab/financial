import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('云端前端鉴权守卫', () => {
  it('任意业务 API 返回 401 时立即切换到未登录状态', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    vi.stubGlobal('window', { fetch: fetchMock })

    const { useAuthStore } = await import('../../src/cloud/authStore')
    const { installCloudFetchGuard } = await import('../../src/cloud/cloudFetch')
    useAuthStore.getState().setAuthed('admin')

    installCloudFetchGuard()
    await window.fetch('/api/longbridge/workbench/dashboard')

    expect(useAuthStore.getState()).toMatchObject({ status: 'anon', username: null })
  })

  it('运行时鉴权配置请求失败时按启用鉴权处理', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')))
    const { fetchAuthConfig } = await import('../../src/cloud/cloudFetch')

    await expect(fetchAuthConfig()).resolves.toBe(true)
  })
})
