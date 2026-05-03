import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'path';

let app: ElectronApplication;
let page: Page;
let previewServer: http.Server | null = null;
let previewUrl = '';
let previewRoot = '';
let userDataDir = '';

test.beforeAll(async () => {
  previewRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ava-preview-e2e-'));
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ava-e2e-data-'));
  previewServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end([
      '<!doctype html>',
      '<html>',
      '<head><title>Ava Preview E2E</title></head>',
      '<body style="margin:0;background:#123;color:white"><h1>Preview E2E</h1>',
      '<script>console.warn("preview-test-warning"); console.error("preview-test-error");</script>',
      '</body>',
      '</html>',
    ].join(''));
  });
  await new Promise<void>(resolve => {
    previewServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = previewServer.address();
  if (!address || typeof address === 'string') throw new Error('failed to start preview test server');
  previewUrl = `http://127.0.0.1:${address.port}/`;

  // Launch Electron application
  app = await electron.launch({
    args: [
      path.join(__dirname, '../../apps/shell'),
      '--user-data-dir=' + userDataDir
    ],
    env: {
      ...process.env,
      AVA_E2E: '1',
    },
  });
  
  // Wait for the first window to load
  page = await app.firstWindow();
});

test.afterAll(async () => {
  if (app) {
    await app.close();
  }
  if (previewServer) {
    await new Promise<void>(resolve => previewServer?.close(() => resolve()));
  }
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
  if (previewRoot) {
    await fs.rm(previewRoot, { recursive: true, force: true });
  }
});

test('App starts and shows main UI', async () => {
  // Verify Window Title
  const title = await page.title();
  expect(title).toBe('Ava');

  // Verify sidebar actions exist.
  await expect(page.getByRole('button', { name: /New session|新对话/i })).toBeVisible();

  // Verify ChatInput exists
  const promptInput = page.locator('textarea');
  await expect(promptInput).toBeVisible();
});

test('Settings pane can be opened', async () => {
  // Click on Settings icon
  const settingsButton = page.getByRole('button', { name: /Settings|设置/i });
  await settingsButton.click();

  // Verify Settings Title is visible
  const settingsHeading = page.getByText(/Settings|设置/i).first();
  await expect(settingsHeading).toBeVisible();
});

test('Dev Unit Test pane can be opened', async () => {
  const backButton = page.getByRole('button', { name: 'Back', exact: true });
  await expect(backButton).toBeVisible();
  await backButton.click();
  await expect(page.getByRole('button', { name: /New session|新对话/i })).toBeVisible();

  const unitTestButton = page.getByRole('button', { name: /Unit Test/i });
  await expect(unitTestButton).toBeVisible();
  await unitTestButton.click();
  await expect(page.getByRole('heading', { name: 'Unit Test' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Built-in Tools', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'MCP Tools', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skills', exact: true })).toBeVisible();
});

test('Preview built-in tools capture console and screenshot', async () => {
  const consoleResult = await app.evaluate(async ({}, url) => {
    const tools = (globalThis as any).__avaBuiltInTools;
    if (!tools) throw new Error('missing __avaBuiltInTools test hook');
    return tools.callTool('preview.console', { url, waitMs: 250 }, {});
  }, previewUrl);

  expect(consoleResult.ok).toBe(true);
  expect(consoleResult.content.messages.some((message: any) =>
    message.level === 'error' && String(message.text).includes('preview-test-error'),
  )).toBe(true);

  const outputPath = path.join(previewRoot, 'preview.png');
  const screenshotResult = await app.evaluate(async ({}, args) => {
    const tools = (globalThis as any).__avaBuiltInTools;
    if (!tools) throw new Error('missing __avaBuiltInTools test hook');
    return tools.callTool('preview.screenshot', {
      url: args.url,
      outputPath: args.outputPath,
      waitMs: 250,
      width: 640,
      height: 420,
    }, { activeFolderPath: args.previewRoot });
  }, { url: previewUrl, outputPath, previewRoot });

  expect(screenshotResult.ok).toBe(true);
  expect(screenshotResult.content.screenshotPath).toBe(outputPath);
  const screenshot = await fs.stat(outputPath);
  expect(screenshot.size).toBeGreaterThan(0);
});
