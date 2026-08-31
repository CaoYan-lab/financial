/**
 * local server entry file, for local development
 */
import app from './app.js';
import { aShareLiveTradingEngine } from './ashare/aShareLiveTradingEngine.js'
import { logger } from './utils/logger.js'

/**
 * start server with port
 */
const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  logger.info({ event: 'server.started', port: PORT }, 'Server ready')
  const dashboard = aShareLiveTradingEngine.refreshSubscriptions()
  logger.info(
    {
      event: 'ashare.realtime.bootstrap',
      universeCount: dashboard.universe.length,
      subscribedTickers: dashboard.realtime.subscribedTickers,
      running: dashboard.realtime.running,
    },
    'A-share realtime subscriptions bootstrapped from universe',
  )
});

/**
 * close server
 */
process.on('SIGTERM', () => {
  logger.info({ event: 'server.sigterm' }, 'SIGTERM signal received')
  server.close(() => {
    logger.info({ event: 'server.closed' }, 'Server closed')
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info({ event: 'server.sigint' }, 'SIGINT signal received')
  server.close(() => {
    logger.info({ event: 'server.closed' }, 'Server closed')
    process.exit(0);
  });
});

export default app;
