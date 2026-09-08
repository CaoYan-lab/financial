import { expect, test } from '@playwright/test'

test('owner 与 member 浏览器会话隔离且 Futu 解锁不串用', async ({ browser }) => {
  const owner = await browser.newContext()
  const member = await browser.newContext()
  const ownerRequest = owner.request
  const memberRequest = member.request

  const ownerLogin = await ownerRequest.post('/api/auth/login', {
    data: { username: 'e2e_owner', password: 'OwnerPassword12' },
  })
  expect(ownerLogin.status()).toBe(200)

  const create = await ownerRequest.post('/api/multiuser/users', {
    data: {
      username: 'e2e_member',
      displayName: '端到端成员',
      temporaryPassword: 'MemberPassword12',
    },
  })
  expect(create.status()).toBe(201)

  const memberLogin = await memberRequest.post('/api/auth/login', {
    data: { username: 'e2e_member', password: 'MemberPassword12' },
  })
  expect(memberLogin.status()).toBe(200)

  const ownerSession = await ownerRequest.get('/api/multiuser/session')
  const memberSession = await memberRequest.get('/api/multiuser/session')
  expect((await ownerSession.json()).profile.role).toBe('owner')
  expect((await memberSession.json()).profile.role).toBe('member')

  const memberFutu = await memberRequest.get('/api/account/dashboard')
  expect(memberFutu.status()).toBe(428)
  expect((await memberFutu.json()).code).toBe('PASSWORD_CHANGE_REQUIRED')

  await new Promise((resolve) => setTimeout(resolve, 1_100))
  const changed = await memberRequest.post('/api/multiuser/password/change', {
    data: { currentPassword: 'MemberPassword12', newPassword: 'MemberPassword34' },
  })
  expect(changed.status()).toBe(200)
  expect((await memberRequest.get('/api/multiuser/session')).status()).toBe(401)

  const memberRelogin = await memberRequest.post('/api/auth/login', {
    data: { username: 'e2e_member', password: 'MemberPassword34' },
  })
  expect(memberRelogin.status()).toBe(200)
  const forbidden = await memberRequest.get('/api/account/dashboard')
  expect(forbidden.status()).toBe(403)
  expect((await forbidden.json()).code).toBe('FUTU_FORBIDDEN')

  const setup = await ownerRequest.post('/api/multiuser/futu/secondary-password', {
    data: { currentPassword: 'OwnerPassword12', secondaryPassword: 'FutuPassword12' },
  })
  expect(setup.status()).toBe(200)
  const unlock = await ownerRequest.post('/api/multiuser/futu/unlock', {
    data: { secondaryPassword: 'FutuPassword12' },
  })
  expect(unlock.status()).toBe(200)
  expect((await ownerRequest.get('/api/multiuser/futu/access')).status()).toBe(200)
  expect((await memberRequest.get('/api/multiuser/futu/access')).status()).toBe(200)
  expect((await memberRequest.get('/api/multiuser/futu/access').then((r) => r.json())).status).toBe('forbidden')

  const ownerPage = await owner.newPage()
  await ownerPage.goto('/')
  await ownerPage.getByRole('button', { name: '账户与安全' }).click()
  await ownerPage.getByRole('button', { name: '长桥账户连接' }).click()
  await expect(ownerPage.getByLabel('App Key')).toBeVisible()
  await expect(ownerPage.getByLabel('App Secret')).toBeVisible()
  await expect(ownerPage.getByLabel('Access Token')).toBeVisible()
  await expect(ownerPage.getByText('所有者默认账户')).toHaveCount(0)
  await expect(ownerPage.getByRole('button', { name: '断开当前连接' })).toHaveCount(0)

  await owner.close()
  await member.close()
})
