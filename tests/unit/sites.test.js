import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSitePage } from '../../dist/main/site-flow.js';
import { allowsNavigation, displayAddress, mockSites, parseSites } from '../../dist/main/sites.js';
import { workbenchCommand } from '../../dist/shared/workbench.js';

test('本机配置接受显式的 HTTP 或 HTTPS 入口，校验凭据与来源格式', () => {
  for (const entryUrl of ['http://oa.example.test/seeyon/index.jsp', 'https://oa.example.test/']) {
    assert.equal(parseSites({ oa: { entryUrl } }).get('oa').entryUrl, entryUrl);
  }
  for (const entryUrl of ['file:///tmp/site.html', 'http://user:pass@oa.example.test/', 'https://*.example.test/']) {
    assert.throws(() => parseSites({ oa: { entryUrl } }), /无凭据的 HTTP 或 HTTPS/);
  }
  assert.throws(() => parseSites({ unknown: {} }), /未知应用/);
  for (const origin of ['http://sso.example.test/login', 'http://sso.example.test/foo/..', 'https://sso.example.test?ticket=1', 'http://*.example.test']) {
    const config = { entryUrl: 'http://oa.example.test/', pageOrigins: [origin] };
    assert.throws(() => parseSites({ oa: config }), /HTTP 或 HTTPS 来源/);
  }
});

test('页和 iframe 分别按协议、主机和端口匹配，GitLab 与禅道互不放行', () => {
  const sites = parseSites({
    oa: {
      entryUrl: 'http://oa.example.test/home',
      pageOrigins: ['https://sso.example.test:8443'],
      frameOrigins: ['http://form.example.test:8080'],
    },
    gitlab: { entryUrl: 'http://sc.example.test/' },
    zentao: { entryUrl: 'http://sc.example.test:9909/my.html' },
  });
  const site = sites.get('oa');
  assert.equal(allowsNavigation(site, 'http://oa.example.test/work', true), true);
  assert.equal(allowsNavigation(site, 'https://sso.example.test:8443/login', true), true);
  assert.equal(allowsNavigation(site, 'https://sso.example.test:8443/frame', false), true);
  assert.equal(allowsNavigation(site, 'http://form.example.test:8080/form', true), false);
  assert.equal(allowsNavigation(site, 'http://form.example.test:8080/form', false), true);
  assert.equal(allowsNavigation(site, 'http://form.example.test/form', false), false);
  assert.equal(allowsNavigation(site, 'https://form.example.test:8080/form', false), false);
  assert.equal(allowsNavigation(site, 'https://oa.example.test/work', true), false);
  assert.equal(allowsNavigation(site, 'http://oa.example.test.fake/work', true), false);
  assert.equal(allowsNavigation(site, 'about:srcdoc', false), true);
  assert.equal(allowsNavigation(site, 'about:blank', true), false);
  assert.equal(allowsNavigation(sites.get('gitlab'), sites.get('zentao').entryUrl, true), false);
  assert.equal(allowsNavigation(sites.get('zentao'), sites.get('gitlab').entryUrl, false), false);
});

test('模拟站使用双来源 HTTP 配置，地址栏省略查询参数与片段', () => {
  const base = 'http://127.0.0.1:4000';
  const frames = 'http://127.0.0.1:4001';
  const sites = mockSites(base, frames);
  assert.deepEqual([...sites.keys()], ['oa', 'gitlab', 'zentao']);
  const site = sites.get('oa');
  assert.equal(site.entryUrl, `${base}/seeyon/index.jsp`);
  assert.equal(sites.get('zentao').entryUrl, `${frames}/my.html`);
  assert.equal(allowsNavigation(site, `${frames}/frame`, true), false);
  assert.equal(allowsNavigation(site, `${frames}/frame`, false), true);
  assert.equal(displayAddress(`${base}/seeyon/main.do?ticket=example#section`), `${base}/seeyon/main.do`);
});

test('工时和禅道只识别各自入口来源下的落点', () => {
  const base = 'http://127.0.0.1:4000';
  const zentao = 'http://127.0.0.1:4001';
  const worktimePath = '/ws/pages/worksheet/my-work.html';
  const loginPath = '/user-login-L215Lmh0bWw=.html';
  const sites = mockSites(base, zentao);
  assert.equal(describeSitePage('oa', sites.get('oa'), base + worktimePath).appId, 'worktime');
  assert.equal(describeSitePage('oa', sites.get('oa'), base + '/ws/entry').appId, 'oa');
  assert.equal(describeSitePage('oa', sites.get('oa'), zentao + worktimePath).appId, 'oa');
  assert.match(describeSitePage('zentao', sites.get('zentao'), zentao + loginPath).loginHint, /企业微信.*重新扫码/);
  assert.equal(describeSitePage('zentao', sites.get('zentao'), base + loginPath).loginHint, '');
  assert.equal(describeSitePage('zentao', sites.get('zentao'), zentao + '/my.html').loginHint, '');
});

test('旧代码平台配置仍映射到 GitLab，旧独立工时配置可随文件保留', () => {
  const sites = parseSites({
    code: { entryUrl: 'https://gitlab.example.test/' },
    worktime: { entryUrl: 'https://time.example.test/' },
  });
  assert.equal(sites.get('gitlab').entryUrl, 'https://gitlab.example.test/');
  assert.equal(sites.has('worktime'), false);
  assert.throws(() => parseSites({
    code: { entryUrl: 'https://gitlab.example.test/' },
    gitlab: { entryUrl: 'https://gitlab.example.test/' },
  }), /重复应用/);
});

test('IPC 合同限定入口与页面编号', () => {
  assert.equal(workbenchCommand.safeParse({ type: 'open', appId: 'gitlab' }).success, true);
  assert.equal(workbenchCommand.safeParse({ type: 'open', appId: 'worktime' }).success, true);
  assert.equal(workbenchCommand.safeParse({ type: 'open', appId: 'unregistered' }).success, false);
  assert.equal(workbenchCommand.safeParse({ type: 'close', id: -1 }).success, false);
  assert.equal(workbenchCommand.safeParse({ type: 'reload', id: null }).success, false);
});
