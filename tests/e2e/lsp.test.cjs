const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { launch, close } = require('./support.cjs');
const { verifyLsp } = require('./lsp.cjs');
const { seedProblem, openProblem, waitInitialized } = require('./workspace.cjs');

test('LSP: packaged backend completes unsaved UTF-16 code offline and restarts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE LSP 日本語 '));
  let app;
  const contest = `lsp-e2e-${Date.now()}`;
  try {
    app = await launch(root, { hostEnv: { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' } });
    await app.page.context().setOffline(true);
    await waitInitialized(app.page);
    await openProblem(app.page, await seedProblem(app, contest, 'lsp'));
    await verifyLsp(app.page);
  } finally {
    if (app) await close(app);
    if (app) for (const kind of ['library/problems', 'workspaces']) await rm(path.join(app.dataDir, kind, contest), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
