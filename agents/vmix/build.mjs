import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseApiOrigin } from './configuration.mjs';

const apiOrigin = process.env.CMS_STUDIO_API_ORIGIN ? parseApiOrigin(process.env.CMS_STUDIO_API_ORIGIN) : '';

await build({
  entryPoints: [fileURLToPath(new URL('./src/service.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/vmix-agent.cjs', import.meta.url)),
  platform: 'node', target: 'node22', format: 'cjs', bundle: true,
  define: { 'process.env.CMS_STUDIO_API_ORIGIN': JSON.stringify(apiOrigin) },
});
