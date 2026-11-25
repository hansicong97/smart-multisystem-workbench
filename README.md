# Smart Multi-System Workbench（SMSW）

SMSW 是一个桌面工作台，在同一窗口打开 OA、GitLab、工时和禅道原网页。顶部只显示当前站点来源的标签，切换应用时保留网页和草稿。OA、工时和从 OA 打开的子页共用一组标签。

工作台使用 Electron、TypeScript、Vue 3.5、Vite、Reka UI 和原生 CSS，通过 Electron Forge 打包。Windows 和 macOS 共用布局与组件，Windows 实窗验收已记录。OA 提供差旅申请单的出发地与目的地互换、误餐补贴批量填写，以及差旅报销助手。

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

## OA 助手

打开可编辑的误餐补贴单或差旅报销单后，点击工作台命令栏最右侧的「助手」。误餐补贴支持从原单读取人员，按日期、补贴类型和编制预览，再确认填写。已有匹配明细自动跳过。

在差旅报销单中，可以选择独立 PDF、含 PDF 的 ZIP 或 SM-ISA 的 `可填写清单.csv`。开发版可在合成 OA 登录后打开「差旅报销」体验整条流程。

1. PDF 与 ZIP 可混选。普通未加密 ZIP 支持子目录和 UTF-8 中文文件名。工作台显示包内位置，按 PDF 内容指纹识别重复材料，并列出跳过和读取失败的文件。
2. 在当前单据内容区查看原件，再在同一窗口逐张复核。完成后回到原单和助手。高铁票和网约车电子票提供字段建议，扫描件和缺少可读取文字的 PDF 可预览并手工补录。行程单作为支持附件关联到费用明细。
3. 从 SM-ISA 导入时，`可填写清单.csv` 和 `附件清单.csv` 放在同一目录。按提示选择原件根目录，工作台核对附件位置、页码和文件指纹。
4. 在可识别的报销单中预览目标账号、单据、金额和待新增明细。确认后逐行填入并回读，遇到差异时保留现场供核对。ZIP 中的 PDF 可保存到选定位置，再由用户在原页挂载。保存报销单、送审和提交均由用户在 OA 完成。

发票读取、识别和临时材料存储在本机完成。报销页面适配已覆盖合成站，真实 OA 报销模板和 macOS arm64 实机的验收状态按项目记录为准。

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
