export type LongbridgeChildCredentialOverrides = {
  appKey: string
  appSecret: string
  accessToken: string
}

export function buildLongbridgeOrderChildEnvironment(input: {
  credentials?: LongbridgeChildCredentialOverrides
  allowSubmit?: boolean
} = {}): NodeJS.ProcessEnv | undefined {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.credentials
      ? {
          LONGBRIDGE_APP_KEY: input.credentials.appKey,
          LONGBRIDGE_APP_SECRET: input.credentials.appSecret,
          LONGBRIDGE_ACCESS_TOKEN: input.credentials.accessToken,
        }
      : {}),
    ...(input.allowSubmit === undefined
      ? {}
      : { LONGBRIDGE_LIVE_TRADING_ENABLED: input.allowSubmit ? 'true' : 'false' }),
  }

  if (process.env.CLOUD_MODE === '1' && process.env.MULTIUSER_LOCAL_DIRECT !== 'true') {
    const proxyUrl = process.env.LONGBRIDGE_ORDER_PROXY_URL?.trim()
    if (!proxyUrl) return undefined
    env.HTTPS_PROXY = proxyUrl
    env.HTTP_PROXY = proxyUrl
    env.NO_PROXY = ''
    return env
  }

  for (const name of [
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
  ]) {
    delete env[name]
  }
  return env
}

export function longbridgeOrderProxyConfigured(): boolean {
  return process.env.CLOUD_MODE !== '1'
    || process.env.MULTIUSER_LOCAL_DIRECT === 'true'
    || Boolean(process.env.LONGBRIDGE_ORDER_PROXY_URL?.trim())
}
