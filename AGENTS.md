# SMSW 开发约定

本文件适用于整个项目。以本轮用户需求确定改动范围，用现有源码确认当前行为，用验收记录确认实测结果。四站接入与统一界面（方案 A）已实施（Windows 实窗验收通过，macOS 实机待验收），OA 页面增强已落地首项（差旅表单出发地↔目的地互换）。OA 报销填写、跨系统关联与统计、执行历史及 AI 工具按后续阶段推进。真实站点地址、私有设计稿与本地文档索引见 `AGENTS.local.md`（已 git 忽略，不随仓库发布）。

## 工程入口

- 使用现有 Electron、TypeScript、Vue 3.5、Vite 8、Reka UI、原生 CSS 和 npm 锁文件。TypeScript 编译主进程、预加载和共享模块，Vite 构建 Vue 界面，Electron Forge 生成运行目录与 ZIP。
- 项目要求 Node.js 22.18.0 或更新版本。首次安装运行 `npm ci` 和 `npx install-electron`。平台命令和站点配置示例见使用说明。 [README.md](README.md)
- 普通 `npm start` 与发行版读取同一份默认 `sites.json`。开发版使用独立的 `SMSW-Local` 浏览器数据目录。指定 `--user-data-dir` 时使用该目录的数据与配置。
- `npm start -- --mock-sites` 显式启动合成站。开发启动遇到缺失配置时进入模拟模式，遇到无效配置时显示错误。定向测试使用合成站和独立用户目录。

## 源码定位

| 文件 | 职责 |
| --- | --- |
| `src/main/index.ts` | 应用启动、用户目录、配置、主窗口、偏好路由和 IPC 入口 |
| `src/main/sites.ts` | 站点清单解析、来源策略和地址栏格式 |
| `src/main/site-flow.ts` | 工时落点和 OA、禅道登录提示 |
| `src/main/pages.ts` | `WebContentsView`、标签、会话、弹窗、导航、下载、实测边界、OA 表单帧注入与释放 |
| `src/main/oa-enhance.ts` | OA 表单帧匹配与城市互换注入脚本（帧主世界执行，不新增网页 IPC） |
| `src/main/preferences.ts`、`src/main/materials.ts` | 偏好原子持久化、原生材质与窗口配色解析 |
| `src/shared/workbench.ts` | 应用和来源标识、状态类型、Zod 命令校验 |
| `src/shared/preferences.ts`、`src/shared/layout.ts` | 偏好类型与校验、侧栏两态布局和边界夹取 |
| `src/preload/bridge.cts` | 工作台界面的窄范围 IPC 桥接 |
| `src/renderer/App.vue`、`src/renderer/theme.css`、`src/renderer/style.css` | 工作台编排、统一设计 token 与布局样式 |
| `src/renderer/store.ts`、`sidebar.ts`、`bounds.ts`、`accessibility.ts` | 共享状态、侧栏两态、网页矩形回报、无障碍旗标回报 |
| `src/renderer/components/` | 标题栏、侧栏、标签、命令栏、首页与设置对话框 |
| `tests/unit/`、`tests/e2e/`、`tests/fixtures/` | 策略、偏好与 OA 增强单测、开发版及发行版实窗验证、双来源合成站与 CAP4 表单夹具 |

## 保持的行为

- 用 `AppId` 标识界面应用，用 `SiteId` 标识来源和会话。工时从 OA 原页进入。到达工时路径后应用显示为工时，来源仍为 OA。OA 子页继承发起页的来源和会话。
- 顶部只显示当前来源的标签。切换应用时保留后台视图和草稿。关闭活动子页优先回到仍打开的来源标签，其次选择同组页面。关闭当前组最后一页回首页。关闭网页时释放其视图，保留持久会话。
- 页面按需创建。正在编辑、下载中及恢复条件不明的页面保持可用。GitLab 和禅道使用各自的会话，旧 `code` 配置映射到 GitLab，并兼容原 `persist:smsw-code` 会话分区。
- OA 发起的新窗口放在工作台内的新标签，保持 Chromium 的 `window.opener` 与网页主动关闭行为。OA 可以从允许的发起页先开空白子页，随后导航仍校验目标来源。

## 统一界面实现

- 界面采用统一设计语言（方案 A）：以 Windows 11 风格为唯一基准，两平台共用同一套组件、布局与设计 token，平台差异收敛为宿主窗口约定（窗口按钮、标题条垫片、拖拽区、字体回退）。正式界面遵循本文件的 `SiteId` 分组、标签返回和阶段范围。
- 渲染层以 `.web-slot` 实测矩形经 `reportBounds` 命令回报，主进程夹取到内容区后更新 `WebContentsView.setBounds()`。窗口缩放、侧栏折叠、字号变化、外观切换和标签切换时同步更新边界。右侧任务工具区属后续阶段，届时在同一内容格加兄弟面板即可，边界协议不变。原生窗饰跟随宿主系统：两平台共用 43 px 标题条，Windows 宿主用 `titleBarOverlay` 承载右侧系统窗口按钮，macOS 宿主用 `hiddenInset` 红绿灯嵌入标题条左端。
- 菜单或确认层覆盖原网页时，由主进程协调子视图层级和显隐。关闭浮层后按当前活动标签恢复网页视图及其边界，并将焦点交回仍可用的发起控件。
- 侧栏开关统一放在标题条，纯图标。侧栏只有展开与 56 px 图标栏两种形态，由开关手动切换，收起状态随偏好持久化并在重启后恢复；图标栏保留应用图标与设置入口，设置固定在侧栏底部。字号与明暗外观作用于工作台，即时生效并在重启后恢复。外观提供跟随系统、浅色和深色。窗口按钮由宿主系统提供，系统按钮和可交互控件避开拖拽区。 [Electron 标题栏](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- 材质以 Windows 为主：在 Windows 11 22H2 及以上验证标题栏与导航区共用 Mica Base（`setBackgroundMaterial('mica')`）。系统材质不可用或系统启用减少透明度、高对比度时，使用可读的中性实色回退。macOS 恒为实色界面，不接入 vibrancy，只保证可用。实色控件按设计色值实现。 [Electron 窗口材质](https://www.electronjs.org/docs/latest/api/browser-window#winsetbackgroundmaterialmaterial-windows)

## 进程和来源边界

- 主进程只接受本地工作台主框架的 IPC 调用，并通过 Zod 校验命令。新增交互沿用明确的命令与状态类型。远程网页使用独立视图及所属站点会话，保留沙箱、上下文隔离和网页安全检查，保持 Node.js 集成关闭。
- OA 页面增强由主进程注入：表单帧匹配与脚本集中在 `src/main/oa-enhance.ts`，`pages.ts` 在 `did-frame-navigate` 命中后经 `webFrameMain.executeJavaScript()` 注入目标帧主世界。脚本幂等，用 `MutationObserver` 覆盖新增行，点击用文档级捕获委托以覆盖站点客户端克隆的行。不新增来自远程网页的 IPC，沙箱、上下文隔离与来源边界不变。新增增强沿用此模式，并在合成站补表单夹具用例（克隆新增与空白新增两条路径）。
- 站点来源按协议、主机和端口精确匹配。用 `pageOrigins` 配置额外顶层来源，用 `frameOrigins` 配置 iframe 专用来源。导航事件与会话的文档请求共同约束导航、重定向和 iframe，新窗口与下载沿用站点策略。
- 真实站点配置放在用户应用数据目录。测试和示例使用合成数据与占位域名，真实凭据、会话及单据留在受控环境中。涉及实站时按已授权范围验收。OA 表单（含报销与差旅）的最终提交由用户在原网页完成。

## 验证和交付

- 代码变更按影响范围运行 `npm run typecheck`、`npm test` 和 `npm run test:e2e`。更改配置、来源策略、弹窗或页面生命周期时，用双来源合成站覆盖对应流程。
- UI 变更按影响范围在实际 Electron 窗口验收。1130×780 和 860×650 按内容区逻辑尺寸测量，覆盖标准和高 DPI，并记录系统缩放比例。检查侧栏展开和收起、设置入口、网页视图边界、菜单与确认层的键盘焦点、Esc 关闭及偏好重启恢复。Windows x64 以视觉零回归为标准（含 Mica 与实色回退）；macOS arm64 以保证可用为标准（红绿灯不压控件、标题条可拖拽、同一布局），不保证像素级美观。
- 打包变更使用 `npm run package`、`npm run make` 和 `npm run test:package` 检查实际产物。ZIP 验证副本放在工作区外或 Forge 排除的 `.cache/` 内。核对产物架构、`app.asar` 内容及 ZIP 的 SHA-256。
- 记录实际环境和结果，分别说明合成站、发行目录与 ZIP、公司实站、Windows x64 和 macOS arm64 的验证状态。
