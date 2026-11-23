import type { AppId, SiteId } from '../shared/workbench.js';
import type { SitePolicy } from './sites.js';

const WORKTIME_PATH = '/ws/pages/worksheet/my-work.html';
const ZENTAO_LOGIN_PATH = /^\/user-login(?:-[^/]+)?\.html$/u;

export const WORKTIME_GUIDANCE = '请在 OA 原页点击工时入口';

export function describeSitePage(siteId: SiteId, site: SitePolicy, address: string): {
  appId: AppId;
  loginHint: string;
} {
  const url = URL.parse(address);
  if (url?.origin === site.entryOrigin) {
    if (siteId === 'oa' && url.pathname === WORKTIME_PATH) {
      return { appId: 'worktime', loginHint: '' };
    }
    if (siteId === 'oa' && url.pathname === '/seeyon/index.jsp') {
      return { appId: siteId, loginHint: '请在 OA 原页登录' };
    }
    if (siteId === 'zentao' && ZENTAO_LOGIN_PATH.test(url.pathname)) {
      return { appId: siteId, loginHint: '请在禅道原页使用企业微信扫码登录。会话过期后请重新扫码。' };
    }
  }
  return { appId: siteId, loginHint: '' };
}
