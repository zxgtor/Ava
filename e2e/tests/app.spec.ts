import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  // Launch Electron application
  app = await electron.launch({
    args: [
      path.join(__dirname, '../../apps/shell'),
      '--user-data-dir=' + path.join(__dirname, '../e2e-data')
    ]
  });
  
  // Wait for the first window to load
  page = await app.firstWindow();
});

test.afterAll(async () => {
  if (app) {
    await app.close();
  }
});

test('App starts and shows main UI', async () => {
  // Verify Window Title
  const title = await page.title();
  expect(title).toBe('Ava');

  // Verify SideBar exists (has width 60 and contains "对话" or "新对话")
  const sidebar = page.locator('div.w-60').filter({ hasText: /新对话|对话/i });
  await expect(sidebar).toBeVisible();

  // Verify ChatInput exists
  const promptInput = page.locator('textarea');
  await expect(promptInput).toBeVisible();
});

test('Settings pane can be opened', async () => {
  // Click on Settings icon
  const settingsButton = page.locator('button[title="设置"]');
  await settingsButton.click();

  // Verify Settings Title is visible
  // The Settings view has a header text "设置"
  const settingsHeading = page.locator('div.text-center').filter({ hasText: '设置' });
  await expect(settingsHeading).toBeVisible();
});
