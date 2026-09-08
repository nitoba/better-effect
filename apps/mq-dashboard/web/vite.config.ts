import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const dashboardToken = process.env.MQ_DASHBOARD_TOKEN
const dashboardApiProxy =
  dashboardToken === undefined
    ? { target: 'http://127.0.0.1:3000' }
    : {
        target: 'http://127.0.0.1:3000',
        headers: {
          authorization: `Bearer ${dashboardToken}`,
          'x-dashboard-csrf': dashboardToken
        }
      }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': dashboardApiProxy,
      '/health': 'http://127.0.0.1:3000'
    }
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
