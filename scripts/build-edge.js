#!/usr/bin/env node

// Build EdgeOne Edge Function bundle using esbuild

const { build } = require('esbuild');
const path = require('path');
const fs = require('fs');

const pkg = require(path.join(__dirname, '..', 'package.json'));
let commit = 'unknown';
try {
  commit = require('child_process').execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {}

// Ensure output directory exists
const outDir = path.join(__dirname, '..', 'edge-functions');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// ─── Node Shim Plugin ─────────────────────────────────────────
// Redirects Node.js builtins (fs, path, etc.) to inline shims so the
// bundle works in EdgeOne edge runtime. Code paths that use these
// modules (fonts, Node JAR proxy) are conditional and won't execute,
// but the shim ensures they don't cause import errors at module load.
const nodeShimPlugin = {
  name: 'node-shim',
  setup(build) {
    const nodeBuiltins = [
      'fs', 'path', 'os', 'dns', 'crypto', 'child_process', 'net',
      'http', 'https', 'stream', 'url', 'util', 'events', 'buffer',
      'assert', 'tty', 'zlib', 'querystring',
    ];
    for (const mod of nodeBuiltins) {
      build.onResolve({ filter: new RegExp(`^${mod}$`) }, () => ({
        path: mod,
        namespace: 'node-shim',
      }));
    }
    build.onLoad({ filter: /.*/, namespace: 'node-shim' }, () => ({
      contents: 'export default {}; export const promises = {};',
      loader: 'js',
    }));
  },
};

// ─── esbuild Build ─────────────────────────────────────────────
build({
  entryPoints: [path.join(__dirname, '..', 'src', 'edge-entry.ts')],
  bundle: true,
  format: 'esm',
  target: 'esnext',
  outfile: path.join(outDir, '[[default]].js'),
  external: [
    // Node-only packages not needed in edge runtime
    'better-sqlite3', '@hono/node-server', 'node-cron', 'dotenv',
  ],
  plugins: [nodeShimPlugin],
  define: {
    '__APP_VERSION__': JSON.stringify(pkg.version),
    '__APP_COMMIT__': JSON.stringify(commit),
  },
  minify: false, // keep readable for debugging; can enable for production
}).then(() => {
  console.log(`Edge function build complete: edge-functions/[[default]].js`);
  console.log(`  Version: ${pkg.version}, Commit: ${commit}`);
}).catch((err) => {
  console.error('Edge function build failed:', err);
  process.exit(1);
});
