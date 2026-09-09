// @ts-check
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

const runScript = (script) => {
  execFileSync(process.execPath, [script], { stdio: 'inherit' });
};

const machineReadableFiles = () => ({
  name: 'oshima-machine-readable-files',
  hooks: {
    'astro:config:setup': ({ command, isRestart }) => {
      if (!isRestart && (command === 'dev' || command === 'build')) {
        runScript('scripts/generate-sitemap.mjs');
      }
    },
    'astro:build:start': () => {
      runScript('scripts/write-deploy-version.mjs');
    },
  },
});

// https://astro.build/config
export default defineConfig({
  site: 'https://oshima-new-villa.com',
  integrations: [machineReadableFiles()],
  vite: {
    plugins: [tailwindcss()]
  }
});
