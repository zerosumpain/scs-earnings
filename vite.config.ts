import { defineConfig } from 'vite';

// Static bundle deployed under strangeramblings.com/projects/scs-earnings/.
// `base: './'` keeps all asset URLs relative so it works from any sub-path.
export default defineConfig({
  base: './',
  server: {
    host: true,
    allowedHosts: ['homeserv', 'homeserv.tail668b8c.ts.net', 'localhost'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
