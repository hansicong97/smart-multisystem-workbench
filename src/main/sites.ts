import { APP_IDS } from '../shared/workbench.js';
import type { SiteId, WorkbenchApp } from '../shared/workbench.js';

export const APPS = [
  { id: 'oa', name: 'OA', mark: 'OA', description: '办公审批与报销单据' },
  { id: 'gitlab', name: 'GitLab', mark: 'Git', description: '代码仓库与合并请求' },
  { id: 'worktime', name: '工时', mark: '时', description: '从 OA 原页进入，沿用 OA 会话' },
  { id: 'zentao', name: '禅道', mark: '禅', description: '项目、需求与任务' },
] as const satisfies readonly Omit<WorkbenchApp, 'configured'>[];

export interface SitePolicy {
  entryUrl: string;
  entryOrigin: string;
  pageOrigins: ReadonlySet<string>;
  frameOrigins: ReadonlySet<string>;
}

export type SiteRegistry = ReadonlyMap<SiteId, SitePolicy>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSiteId(value: string): value is SiteId {
  return value !== 'worktime' && APP_IDS.some((id) => id === value);
}

function parseWebUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.hostname.includes('*')) return null;
  return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
}

function parseOrigins(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 须为数组`);
  return value.map((entry) => {
    const url = parseWebUrl(entry);
    if (!url || !/^https?:\/\/[^/?#\\]+\/?$/iu.test(entry) || url.href !== `${url.origin}/`) {
      throw new Error(`${field} 须为无凭据的 HTTP 或 HTTPS 来源，可含端口`);
    }
    return url.origin;
  });
}

export function parseSites(value: unknown): SiteRegistry {
  const entries = readRecord(value);
  if (!entries) throw new Error('sites.json 须为 JSON 对象');
  const sites = new Map<SiteId, SitePolicy>();
  for (const [key, candidate] of Object.entries(entries)) {
    // Older profiles could configure a standalone worktime site.
    if (key === 'worktime') continue;
    const id = key === 'code' ? 'gitlab' : key;
    if (!isSiteId(id)) throw new Error('包含未知应用标识');
    if (sites.has(id)) throw new Error(`包含重复应用标识 ${id}`);
    const config = readRecord(candidate);
    if (!config) throw new Error(`${id} 配置须为 JSON 对象`);
    const entry = parseWebUrl(config.entryUrl);
    if (!entry) throw new Error(`${id}.entryUrl 须为无凭据的 HTTP 或 HTTPS 网址`);
    const pageOrigins = new Set([entry.origin, ...parseOrigins(config.pageOrigins, `${id}.pageOrigins`)]);
    const frameOrigins = new Set([...pageOrigins, ...parseOrigins(config.frameOrigins, `${id}.frameOrigins`)]);
    sites.set(id, { entryUrl: entry.href, entryOrigin: entry.origin, pageOrigins, frameOrigins });
  }
  return sites;
}

export function mockSites(siteOrigin: string, frameOrigin: string): SiteRegistry {
  return parseSites({
    oa: { entryUrl: `${siteOrigin}/seeyon/index.jsp`, frameOrigins: [frameOrigin] },
    gitlab: { entryUrl: `${siteOrigin}/`, frameOrigins: [frameOrigin] },
    zentao: { entryUrl: `${frameOrigin}/my.html`, frameOrigins: [siteOrigin] },
  });
}

export function allowsNavigation(site: SitePolicy, target: string, mainFrame: boolean): boolean {
  if (!mainFrame && ['about:blank', 'about:srcdoc'].includes(target)) return true;
  const url = parseWebUrl(target);
  return url !== null && (mainFrame ? site.pageOrigins : site.frameOrigins).has(url.origin);
}

export function displayAddress(target: string): string {
  const url = parseWebUrl(target);
  return url ? `${url.origin}${url.pathname}` : '';
}
