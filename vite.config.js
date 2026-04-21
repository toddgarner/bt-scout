import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During `npm run dev`, proxy /api/* to the real ABC endpoint
// so we never hit CORS locally. In production, vercel.json / netlify.toml
// handles the same rewrite.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/inventory': {
        target: 'https://www.abc.virginia.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/inventory/, '/webapi/inventory'),
        headers: {
          'Referer': 'https://www.abc.virginia.gov/',
          'Origin':  'https://www.abc.virginia.gov',
        },
      },
    },
  },
})
