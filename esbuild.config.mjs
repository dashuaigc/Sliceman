import { build } from 'esbuild';

await build({
  entryPoints: ['src/ui/panel.js'],
  bundle: true,
  format: 'cjs',
  outfile: 'dist/panel.js',
  platform: 'browser',
  target: ['chrome88'],
  external: ['photoshop', 'uxp'],
}).then(() => console.log('build ok'));
