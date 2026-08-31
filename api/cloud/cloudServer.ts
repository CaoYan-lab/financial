/**
 * 云端 Web 函数入口（veFaaS Web 应用 / 本地云模式）。
 * 与本地开发入口 api/server.ts 完全独立：不包含交易引擎引导等长驻逻辑。
 * 环境变量：CLOUD_MODE=1、AUTH_ENABLED=true、DATABASE_URL、AUTH_JWT_SECRET、
 *          ADMIN_USERNAME/ADMIN_PASSWORD（仅首启播种）、PORT（默认 4001，veFaaS 用 8000）。
 */
import { createCloudApp } from './http/cloudWebApp.js'
import { ensureAdminSeeded } from './auth/authService.js'
import { closePool } from './db/pgClient.js'
import { logger } from '../utils/logger.js'

const port = Number(process.env.PORT || 4001)

async function bootstrap(): Promise<void> {
  try {
    const seed = await ensureAdminSeeded()
    if (seed.seeded) {
      logger.info({ event: 'auth.admin.seeded', username: seed.username }, '管理员账号已从环境变量播种')
    }
  } catch (error) {
    logger.error(
      { event: 'auth.admin.seed.failed', error: error instanceof Error ? error.message : String(error) },
      '管理员播种失败（不阻断启动）',
    )
  }

  const cloudApp = createCloudApp()
  const server = cloudApp.listen(port, '0.0.0.0', () => {
    logger.info({ event: 'cloud.server.started', port }, 'Cloud server ready')
  })

  const shutdown = (signal: string): void => {
    logger.info({ event: 'cloud.server.sigterm', signal }, 'Shutdown signal received')
    server.close(() => {
      void closePool().finally(() => process.exit(0))
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

void bootstrap()
