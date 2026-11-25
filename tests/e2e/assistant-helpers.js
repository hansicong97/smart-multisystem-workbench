import { setTimeout as delay } from 'node:timers/promises';

export const assistantEntry = (shell) => shell.getByRole('button', { name: '助手', exact: true });

export async function waitForAssistantView(electron) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const page of electron.context().pages()) {
      if (page.url() === 'about:blank' && await page.locator('html[data-assistant-surface]').count()) return page;
    }
    await delay(60);
  }
  throw new Error('未找到助手原生视图');
}

export async function openAssistant(electron, shell) {
  const entry = assistantEntry(shell);
  await entry.waitFor();
  if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click();
  const surface = await waitForAssistantView(electron);
  surface.setDefaultTimeout(12_000);
  await surface.locator('.assistant-panel').waitFor();
  await waitForAssistantLayout(surface);
  return surface;
}

export const waitForAssistantLayout = (surface) => surface.waitForFunction(() => {
  const panel = document.querySelector('.assistant-panel')?.getBoundingClientRect();
  return panel && panel.width > 0 && panel.bottom <= window.innerHeight + 1;
});

export const assistantContext = (shell) => shell.evaluate(async () => {
  const snapshot = await window.workbench.snapshot();
  return snapshot.pages.find(({ id }) => id === snapshot.active)?.assistant ?? null;
});
