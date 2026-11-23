import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { startMockSites } from '../fixtures/mock-sites.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cache = join(root, '.cache');
const host = `${process.platform}-${process.arch}`;
const name = process.platform === 'darwin' ? 'SMSW.app/Contents/MacOS/SMSW' : 'SMSW.exe';
const executable = resolve(process.env.SMSW_PACKAGED_EXECUTABLE || join(root, 'out', `SMSW-${host}`, name));

async function browserEndpoint(profile, child) {
  const filename = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`应用退出，退出码 ${child.exitCode}`);
    try {
      const [port, path] = (await readFile(filename, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) return `ws://127.0.0.1:${port}${path}`;
    } catch (error) {
      if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error;
    }
    await delay(50);
  }
  throw new Error('应用调试端口未就绪');
}

async function openPackage(config, inspect) {
  const profile = await mkdtemp(join(cache, 'packaged-profile-'));
  let child;
  let browser;
  let exited;
  let stderr = '';
  try {
    if (config) await writeFile(join(profile, 'sites.json'), JSON.stringify(config));
    const startTime = Date.now();
    child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-1500); });
    exited = once(child, 'exit');
    // A startup error is also handled by the awaited 'spawn' event below.
    exited.catch(() => {});
    await once(child, 'spawn');
    const endpoint = await browserEndpoint(profile, child);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 8_000 });
    const context = browser.contexts()[0];
    const shell = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 8_000 });
    await shell.locator('body[data-ready=true]').waitFor({ timeout: 8_000 });
    const readyAt = await shell.evaluate(() =>
      performance.timeOrigin + performance.getEntriesByName('workbench-ready')[0].startTime,
    );
    return await inspect(shell, Math.round(readyAt - startTime));
  } catch (error) {
    if (stderr) console.error(stderr);
    throw error;
  } finally {
    if (browser?.isConnected()) {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close').catch(() => {});
      await browser.close();
    }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = await Promise.race([exited.then(() => true), delay(2_000, false)]);
      if (!closed) {
        child.kill();
        await exited;
      }
    }
    if (dirname(profile) === cache) await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  }
}

async function windowsPrivateMemory() {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `
    $exe = $env:SMSW_MEASURED_EXECUTABLE
    $metrics = Get-Process -Name 'SMSW' -ErrorAction SilentlyContinue | Where-Object Path -EQ $exe
    [pscustomobject]@{ processCount = @($metrics).Count; privateBytes = ($metrics | Measure-Object PrivateMemorySize64 -Sum).Sum } | ConvertTo-Json -Compress
  `], { env: { ...process.env, SMSW_MEASURED_EXECUTABLE: executable }, timeout: 8_000 });
  return JSON.parse(stdout);
}

test('本机发行包启动与站点配置检查', { timeout: 100_000 }, async (t) => {
  await access(executable);
  await mkdir(cache, { recursive: true });
  await t.test('空配置启动五次，主页可交互且无预加载网页', async () => {
    const times = [];
    for (let run = 0; run < 5; run += 1) {
      await openPackage(null, async (shell, elapsed) => {
        assert.equal(await shell.title(), 'SMSW');
        assert.equal(await shell.locator('#mode').count(), 0); // 配置模式不再显示「本机站点」
        for (const name of ['OA', 'GitLab', '工时', '禅道']) {
          assert.equal(await shell.getByRole('button', { name: `打开 ${name}`, exact: true }).isDisabled(), true);
        }
        assert.equal(await shell.locator('#address').textContent(), '尚未打开页面');
        assert.ok(Number.isFinite(elapsed) && elapsed >= 0);
        times.push(elapsed);
        if (run === 4 && process.platform === 'win32') {
          await delay(3_000);
          const memory = await windowsPrivateMemory();
          assert.ok(memory.processCount > 0 && memory.privateBytes > 0);
          t.diagnostic(`空壳空闲内存 ${JSON.stringify(memory)}`);
        }
      });
    }
    const ordered = [...times].sort((a, b) => a - b);
    t.diagnostic(`启动耗时 ms ${times.join(', ')}，中位数 ${ordered[2]}`);
  });

  await t.test('拒绝非网页入口，继续支持旧的 HTTPS 配置', async () => {
    await openPackage({ oa: { entryUrl: 'file:///site.html' } }, async (shell) => {
      assert.match(await shell.locator('#configuration').textContent(), /配置无效/);
      assert.equal(await shell.getByRole('button', { name: '打开 OA', exact: true }).isDisabled(), true);
    });
    await openPackage({
      oa: { entryUrl: 'https://oa.example.test/' },
      code: { entryUrl: 'https://gitlab.example.test/' },
    }, async (shell) => {
      assert.equal(await shell.getByRole('button', { name: '打开 OA', exact: true }).isEnabled(), true);
      assert.equal(await shell.getByRole('button', { name: '打开 GitLab', exact: true }).isEnabled(), true);
      assert.equal(await shell.getByRole('button', { name: '打开 禅道', exact: true }).isDisabled(), true);
      assert.equal(await shell.getByRole('button', { name: '打开 工时', exact: true }).isEnabled(), true);
    });
  });

  await t.test('本机 HTTP 配置加载应用并保留原站登录跳转', async () => {
    const fixtures = await startMockSites();
    try {
      const { siteOrigin, frameOrigin } = fixtures;
      await openPackage({
        oa: { entryUrl: `${siteOrigin}/seeyon/index.jsp`, frameOrigins: [frameOrigin] },
        gitlab: { entryUrl: `${siteOrigin}/`, frameOrigins: [frameOrigin] },
        zentao: { entryUrl: `${frameOrigin}/my.html`, frameOrigins: [siteOrigin] },
      }, async (shell) => {
        const open = (name) => shell.getByRole('button', { name: `打开 ${name}`, exact: true }).click();
        const tab = (name) => shell.getByRole('button', { name: `切换到 ${name}`, exact: true });
        await open('工时');
        await shell.locator('#notice').filter({ hasText: '请在 OA 原页点击工时入口' }).waitFor();
        await tab('OA').and(shell.locator('[title="OA 模拟登录"]')).waitFor();
        assert.equal(await shell.locator('#address').textContent(), `${siteOrigin}/seeyon/index.jsp`);
        await open('OA');
        assert.equal(await tab('OA').count(), 1);
        await open('GitLab');
        await tab('GitLab').and(shell.locator('[title="GitLab 模拟首页"]')).waitFor();
        assert.equal(await tab('OA').count(), 0);
        assert.equal(await shell.locator('#address').textContent(), `${siteOrigin}/`);
        await open('禅道');
        await tab('禅道').and(shell.locator('[title="禅道 模拟登录"]')).waitFor();
        assert.equal(await tab('GitLab').count(), 0);
        await shell.locator('#notice').filter({ hasText: '使用企业微信扫码登录' }).waitFor();
        assert.equal(await shell.locator('#address').textContent(), `${frameOrigin}/user-login-L215Lmh0bWw=.html`);
      });
    } finally {
      fixtures.close();
    }
  });
});
