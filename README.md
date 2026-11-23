# Smart Multi-System Workbench（SMSW）

SMSW 是一个桌面工作台，在同一窗口打开 OA、GitLab、工时和禅道原网页。顶部只显示当前站点来源的标签，切换应用时保留网页和草稿。OA、工时和从 OA 打开的子页共用一组标签。

当前可运行的是四站接入版，使用 Electron、TypeScript、Vue 3.5、Vite、Reka UI 和原生 CSS，通过 Electron Forge 打包。界面采用统一设计语言（方案 A），以 Windows 11 风格为唯一基准，两平台共用组件与布局，已实施并通过 Windows 实窗验收（macOS 实机待验收）。OA 页面增强已落地首项：差旅申请单「出发地 ↔ 目的地」一键互换。OA 报销填写、跨系统关联、统计和 AI 辅助属于后续阶段。

## 快速开始

需要 Node.js 22.18.0 或更新版本及 npm。在项目根目录运行以下命令安装依赖并启动。Windows PowerShell 也可用 `npm.cmd` 和 `npx.cmd`。

```sh
npm ci
npx install-electron
npm start
```

`npm start` 会先构建主进程、预加载和 Vue 界面，再启动工作台，窗口默认最大化打开。模拟模式下左下角显示「本地模拟站」提示。缺少站点配置时，开发版进入模拟模式。配置无效时，首页会提示检查配置文件。可用下面的命令显式启动合成站，体验登录、弹窗、工时和禅道回跳流程。

```sh
npm start -- --mock-sites
```

## 配置公司站点

普通开发启动与发行版读取同一份默认 `sites.json`。按系统在对应目录创建文件。

| 系统 | 默认配置路径 |
| --- | --- |
| Windows | `%APPDATA%\SMSW\sites.json` |
| macOS | `~/Library/Application Support/SMSW/sites.json` |

将示例中的三个 `entryUrl` 替换为公司入口，然后退出并重新启动 SMSW。

```json
{
  "oa": { "entryUrl": "http://oa.example.test/seeyon/index.jsp" },
  "gitlab": { "entryUrl": "http://sc.example.test/" },
  "zentao": { "entryUrl": "http://sc.example.test:9909/my.html" }
}
```

- `entryUrl` 接受无凭据的 HTTP 或 HTTPS 网址。GitLab 和禅道分别填写各自的入口和端口。
- 入口来源自动允许顶层页面和 iframe。额外登录或跳转来源填入 `pageOrigins`，仅供 iframe 使用的来源填入 `frameOrigins`。两个字段都接受来源数组，按协议、主机和端口精确匹配。示例值为 `["https://login.example.test"]`。
- 工时随 OA 启用。指定 `--user-data-dir` 时，SMSW 从指定目录读取站点配置。

| 应用 | 使用方式 |
| --- | --- |
| OA | 在 OA 原网页登录。原页发起的新窗口在工作台中打开为子标签，关闭子页会优先返回来源标签。差旅申请单往返行程的可编辑行提供 ⇄ 按钮，一键互换出发地与目的地，提交仍在原页完成。 |
| GitLab | 在公司 GitLab 原网页登录，查看账号有权访问的项目与合并请求。 |
| 工时 | 点击工作台工时入口打开或复用 OA，再点击 OA 原页的工时入口。到达 `/ws/pages/worksheet/my-work.html` 后显示工时标签。 |
| 禅道 | 按原站提示用企业微信扫码。登录后由站点回到 `/my.html`，会话过期时可在原页重新扫码。 |

## 检查和打包

```sh
npm run typecheck
npm test
npm run test:e2e
```

实窗测试通过 Playwright 启动 Electron，使用本地合成站和独立用户目录。Windows x64 的打包命令如下。

```sh
npm run package -- --platform=win32 --arch=x64
npm run make -- --platform=win32 --arch=x64 --from-package
npm run test:package
```

在 Apple Silicon Mac 上，用原生 arm64 Node.js 安装依赖后执行以下命令。

```sh
node -p process.arch
npm run package -- --platform=darwin --arch=arm64
npm run make -- --platform=darwin --arch=arm64 --from-package
npm run test:package
```

运行目录和 ZIP 分别生成在 `out/` 和 `out/make/`。验证 ZIP 时，解压到工作区外或 `.cache/`，并设置环境变量 `SMSW_PACKAGED_EXECUTABLE` 指向解压后的 `SMSW.exe` 或 `SMSW.app/Contents/MacOS/SMSW`。

## 项目导航

| 路径 | 内容 |
| --- | --- |
| `src/main/` | 窗口、站点配置、网页视图、会话、导航和下载 |
| `src/preload/` 与 `src/shared/` | 工作台的 IPC 桥接、命令校验和状态类型 |
| `src/renderer/` | Vue 首页、应用入口、标签栏和网页工具栏 |
| `tests/` | 单元测试、Electron 实窗测试、发行包检查和合成站 |
| [AGENTS.md](AGENTS.md) | 项目开发与验收约定 |

四站接入版已完成 Windows x64 合成站和 ZIP 解压启动验证。公司实站登录与只读访问、macOS arm64 实机和长时间空闲测量待验收。统一界面、深色主题与 OA 城市互换增强的 Windows 实窗结果已记录，macOS arm64 实机待验收。
