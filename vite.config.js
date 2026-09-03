import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // start.ps1 opens the browser itself, and only after tunneld + bridge pass
    // their health checks. Letting vite open one too meant two windows, the
    // first pointing at a UI whose bridge was not up yet.
    open: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true
      }
    }
  }
})
