import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const analyticsEndpoint = env.VITE_ANALYTICS_ENDPOINT?.replace(/\/$/, '');
  const analyticsWebsiteId = env.VITE_ANALYTICS_WEBSITE_ID;

  return {
    plugins: [
      react(),
      {
        name: 'optional-analytics',
        transformIndexHtml(html) {
          if (!analyticsEndpoint || !analyticsWebsiteId) return html;
          const script = `<script defer src="${analyticsEndpoint}/umami" data-website-id="${analyticsWebsiteId.replaceAll('"', '')}"></script>`;
          return html.replace('</body>', `    ${script}\n  </body>`);
        },
      },
    ],
    resolve: { alias: { '@': resolve(__dirname, 'src') } },
    server: { host: '0.0.0.0', allowedHosts: true },
  };
});
