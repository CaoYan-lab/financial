import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import { traeBadgePlugin } from 'vite-plugin-trae-solo-badge';
import { isDebugHttpRequest } from './api/middleware/requestLogger';
import { logger } from './api/utils/logger';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    traeBadgePlugin({
      variant: 'dark',
      position: 'bottom-right',
      prodOnly: true,
      clickable: true,
      clickUrl: 'https://www.trae.ai/solo?showJoin=1',
      autoTheme: true,
      autoThemeTarget: '#root'
    }), 
    tsconfigPaths(),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            logger.error({ event: 'vite.proxy.error', error: err.message }, 'Vite proxy error');
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            const method = req.method ?? 'GET'
            const path = req.url ?? ''
            const normalizedPath = path.split('?')[0]
            const log = isDebugHttpRequest(method, normalizedPath) ? logger.debug.bind(logger) : logger.info.bind(logger)
            log({ event: 'vite.proxy.request.started', method, path }, 'Vite proxy request started');
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            const method = req.method ?? 'GET'
            const path = req.url ?? ''
            const normalizedPath = path.split('?')[0]
            const statusCode = proxyRes.statusCode ?? 0
            const log = isDebugHttpRequest(method, normalizedPath) && statusCode < 400 ? logger.debug.bind(logger) : logger.info.bind(logger)
            log({ event: 'vite.proxy.request.completed', method, path, statusCode }, 'Vite proxy request completed');
          });
        },
      }
    }
  }
})
