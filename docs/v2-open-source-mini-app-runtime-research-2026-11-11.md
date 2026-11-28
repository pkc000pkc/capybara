# V2 开源 Mini App Runtime 调研

日期：2026-11-11

## 结论

目前没有发现一个可以直接作为 Capybara 完整底座的开源项目。原因是目标组合比较特殊：

- Windows 本地 Electron 宿主；
- React/TypeScript 生成的应用；
- 小程序式受控页面和能力桥接；
- 本地 Agent 能力、项目数据和应用 Worker；
- `turnId / stepId / callId` 过程追踪；
- Receipt、Evidence、版本、回滚和可回放运行记录。

现有项目通常只覆盖其中一部分：小程序运行时、微前端隔离、WebView 桥接、JavaScript 沙箱，或者 Docker 应用预览。

建议采用“复用协议和宿主模式，保留 Capybara 自己的 Runtime/证据层”的路线：

```text
Electron iframe / WebContentsView
  + Mini App manifest / package / permission model
  + typed App SDK bridge
  + Capybara Runtime capability adapters
  + 现有 Application Manifest / Receipt / Evidence
  + 可选 App Worker Supervisor
```

这样可以避免从零实现完整的小程序编译器和跨平台运行时，同时保留 Capybara 的本地项目、Agent、上下文和证据模型。

## 候选项目比较

| 项目 | 主要能力 | 与 Capybara 的匹配度 | 适合直接使用的部分 |
| --- | --- | --- | --- |
| [Mini-App-Runtime](https://github.com/Zulranty/Mini-App-Runtime) | Windows/Android 本地 HTML Mini App、权限、私有/公共/安全存储、受控网络、文件和独立窗口 | 产品形态最接近，但项目规模和生态较小 | manifest、`mini.*` API、权限、存储隔离、导入/更新/回滚思路 |
| [Dimina](https://github.com/didi/dimina) | 小程序编译器、逻辑/视图双线程、Worker、WebView/Browser 容器、原生能力 Bridge | 架构匹配度最高，但目标平台和编译体系不同 | 逻辑/视图分离、宿主 Bridge、离线资源包、页面生命周期、Worker 通信 |
| [OpenMini](https://github.com/BoumouzounaBrahimVall/openmini) | React Mini App、Hash 校验包、CSP、typed bridge、manifest 权限和域名白名单 | React/typed bridge 很匹配，但宿主主要是 React Native | package/index、hash 校验、CSP、manifest、bridge API、conformance 测试思想 |
| [JD micro-app](https://github.com/jd-opensource/micro-app) | 微前端、JS sandbox、样式隔离、元素隔离、插件和数据通信 | 适合 UI 嵌入，不是完整 Mini App 能力平台 | 页面装载、样式/元素隔离、子应用通信和预加载 |
| [SES](https://github.com/endojs/endo/tree/master/packages/ses) | Hardened JavaScript、Compartment、无环境权限、显式 endowment | 适合隔离 App 逻辑，不负责 UI、进程和应用生命周期 | App Worker 逻辑沙箱、能力对象注入、最小权限模型 |
| [WebContainer API](https://github.com/stackblitz/webcontainer-api-starter) | 浏览器内 Node.js 和命令运行时 | 适合浏览器 IDE，不适合作为 Windows 本地默认宿主 | 参考内存文件系统、预览端口和前端开发环境 |
| [sandboxd](https://github.com/tastyeffectco/sandboxd) | Agent 生成应用、Docker 隔离沙箱、预览 URL、API-first 控制面 | 适合服务端 Agent App Builder，不适合本地 Electron 直接嵌入 | 构建沙箱、预览、版本和控制面设计 |

## 重点判断

### 1. Mini-App-Runtime：最像产品，但不建议直接作为唯一底座

它明确面向 Android 和 Windows 本地 HTML 应用，提供 manifest、SDK 能力、权限、私有/公共/安全存储、受控 HTTP、文件选择、剪贴板、系统打开和独立窗口等能力。[官方 README](https://github.com/Zulranty/Mini-App-Runtime)

它的设计思想非常适合 Capybara：应用包和用户数据分离、能力按权限开放、可检测可选能力、应用通过统一 `mini.*` API 访问宿主。

但它的应用模型偏单文件 HTML/ZIP，当前生态和成熟度有限。更适合作为 Mini App 合约和宿主功能的参考，或者单独评估是否 fork；不宜未经审计就成为 Capybara 的核心安全边界。

### 2. Dimina：最适合参考“微信小程序式”的运行架构

Dimina 将逻辑与视图分开运行，逻辑层可以使用独立 JS 引擎或 Worker，视图层由 WebView/Browser 渲染，并通过统一 Bridge 接入宿主能力；资源包可以离线存储，已有小程序可以嵌入宿主 App。[官方架构说明](https://github.com/didi/dimina#%E8%AE%A9%E5%B0%8F%E7%A8%8B%E5%BA%8F%E6%88%90%E4%B8%BA%E5%8F%AF%E5%B5%8C%E5%85%A5%E7%9A%84%E8%B7%A8%E7%AB%AF%E6%A8%A1%E5%9D%97)

这与 Capybara 的“受控前端 + 系统能力 + Worker”模型最接近。不过它的编译器和小程序语义是自己的体系，且官方明确说明能力仍在持续补齐、没有覆盖全部小程序 API。[能力边界说明](https://github.com/didi/dimina#%E8%83%BD%E5%8A%9B%E8%BE%B9%E7%95%8C%E4%B8%8E%E5%BB%B6%E4%BC%B8%E9%98%85%E8%AF%BB)

因此更适合借鉴双线程、Bridge、资源包和生命周期，不建议把 Capybara 应用源码改写成 Dimina DSL。

### 3. OpenMini：最适合借鉴 React typed bridge 和包协议

OpenMini 使用普通 React/TypeScript Mini App、Hash 校验包、CSP、权限声明和 typed host bridge。它的宿主流程是：解析版本、下载、校验 SHA-256、缓存、在受限 WebView 中加载，再通过 JSON bridge 调用 Host API。[官方 README](https://github.com/BoumouzounaBrahimVall/openmini#how-it-works)

它明确提供 `mini.host.invoke(...)` 形式的宿主 API，也有 manifest、allowed domains 和 conformance 测试。[官方能力说明](https://github.com/BoumouzounaBrahimVall/openmini#how-it-works)

它当前定位是 React Native 宿主，而且官方把 v0.1 的安全边界描述为“trusted code”：包做 Hash 校验但没有签名隔离，多个应用共享 WebView 数据存储。[官方 scope 说明](https://github.com/BoumouzounaBrahimVall/openmini#how-it-works)

所以它适合复用协议思想和 SDK 结构，Capybara 仍需把权限、Evidence、项目数据范围和进程/Worker 生命周期接入自己的 Runtime。

### 4. Electron 原生能力：优先 iframe 或 WebContentsView

Electron 官方提供 iframe、`webview` 和 `WebContentsView` 三种嵌入方式，并建议使用 iframe 的 `sandbox` 属性限制能力；官方同时明确不推荐继续使用 `webview`，因为其架构变化会影响稳定性。[Electron Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)

因此 Capybara 的 Mini App Host 应优先采用：

- 受控 `iframe sandbox`，适合普通 Mini App UI；
- `WebContentsView`，适合需要独立 Chromium 内容视图和更强宿主管理的场景；
- 预加载脚本只暴露一组版本化、schema 校验的 App SDK bridge。

应用不直接拿到 `ipcRenderer`、Node API、Electron API 或系统路径。

### 5. SES：用于逻辑能力，不替代 OS 进程隔离

SES Compartment 默认不提供 `fetch` 等环境能力，Host 通过显式 endowment 注入能力对象；这很适合实现 App SDK 的最小权限对象。[SES README](https://github.com/endojs/endo/tree/master/packages/ses)

但 SES 在同一 JavaScript 进程/Realm 内运行，不能单独解决 CPU、内存耗尽和宿主进程崩溃问题。它应当与 iframe、Worker 或系统子进程组合使用，而不是替代进程级 Supervisor。

## 推荐组合

### 第一阶段：直接降低 Capybara 的开发量

1. 采用 OpenMini 的 manifest、package、Hash、CSP、typed bridge 和 conformance 思路；
2. 采用 Electron 官方 iframe sandbox 或 `WebContentsView` 作为 Mini App Host；
3. 采用 Mini-App-Runtime 的 `mini.*` 能力命名和权限/存储分区思路；
4. 复用 Capybara 现有 Application Manifest、版本生命周期、Receipt、Evidence 和 Application Runtime；
5. 让现有生成的 React CRUD 应用先转换为 Mini App UI + App Worker；
6. 复杂逻辑使用 App Worker，由现有进程 Supervisor 托管。

### 第二阶段：按需求增加能力

- 页面能力：路由、组件、主题、表单、图表、数据绑定；
- 项目能力：文件、SQLite、上下文文档、会话和 Agent 任务；
- 外部能力：浏览器、市场数据、HTTP allowlist；
- 计算能力：Python/Node Worker、超时、取消、进程输出和结果 Artifact；
- 生产能力：版本切换、健康检查、灰度实例和回滚。

### 暂不建议直接引入的项目

- `micro-app` 可以解决微前端装载和样式隔离，但它不提供 Capybara 所需的权限、Receipt、Evidence 和应用 Worker 生命周期；
- WebContainer 需要浏览器跨源隔离，适合在线代码 IDE，不适合作为 Windows 本地应用默认运行层；
- sandboxd 依赖 Docker/服务器控制面，适合服务端预览沙箱，不能直接替代本地 Electron Host；
- tinyjs 一类框架强调后端 JavaScript 的完整系统访问，与 Capybara 的能力收敛方向相反。

## 最终建议

不建议继续从零开发完整“小程序平台”。建议开发 Capybara 自己的 **Mini App Contract + App SDK + Capability Bridge**，同时复用以下成熟思路：

```text
OpenMini：包协议、typed bridge、CSP、Hash、权限声明
Dimina：逻辑 / 视图分离、Worker、生命周期、宿主 Bridge
Mini-App-Runtime：本地 HTML 应用、存储分区、Windows 能力模型
Electron：iframe sandbox / WebContentsView
SES：同进程逻辑的显式能力注入
Capybara：RuntimeLoop、Context、Receipt、Evidence、版本与回滚
```

这条路线能把最大的重复建设从“编译器、完整小程序运行时、宿主能力、版本系统和 Agent 证据链”缩小为“统一 Mini App 合约、宿主适配、App SDK 和能力适配器”。

