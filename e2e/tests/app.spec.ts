import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';

let app: ElectronApplication;
let page: Page;
let userDataDir = '';

test.beforeAll(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ava-e2e-data-'));

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
  if (userDataDir) {
    await fs.rm(userDataDir, { recursive: true, force: true });
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

test('Dev Unit Test entry is available in development', async () => {
  const backButton = page.getByRole('button', { name: 'Back', exact: true });
  await expect(backButton).toBeVisible();
  await backButton.click();
  await expect(page.getByRole('button', { name: /New session|新对话/i })).toBeVisible();

  const unitTestButton = page.getByRole('button', { name: /Unit Test/i });
  await expect(unitTestButton).toBeVisible();
});
