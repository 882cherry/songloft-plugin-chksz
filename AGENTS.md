# AGENTS.md

本文件为 AI 编程助手提供 ChKSz 音源插件仓库的**入口信息**：项目结构、常用命令、铁律与踩坑总结。代码本身就是真实来源的内容（目录树、依赖、路由表）请直接看代码。

---

## 项目概述

ChKSz 是运行在 **Songloft 宿主**（QuickJS 沙箱）里的 JS 音源插件：通过 [api.chksz.com](https://api.chksz.com) 搜索并解析 **网易云 / QQ音乐 / 酷狗** 播放链接。宿主版本要求 ≥ 2.9.5。

| 目录/文件 | 说明 |
|-----------|------|
| `src/main.ts` | 插件后端（TypeScript → QuickJS 字节码 `main.jsc`）：全部路由与平台接口代理 |
| `static/index.html` | 插件前端页面（搜索 + 平台浏览 + 设置 + 收藏歌单） |
| `static/js/*.js` | 前端 ES module（构建时 esbuild 打包为单 bundle + hash 文件名） |
| `dist/` | 构建产物（`chksz.jsplugin.zip`，上传到宿主安装） |
| `.github/workflows/release.yml` | 发布流水线（push 自动触发 / 手动 dispatch） |
| `plugin.json` | 插件清单（版本 / 权限 / 更新地址 / entryHash / zipHash） |

**插件数据流**：搜索/浏览（发现资源）→ `api/import` 导入宿主曲库 / `api/playlist/import` 导入为宿主歌单 → **播放完全由宿主播放器承担**（宿主经插件 `/api/music/url` 静默解析真实链接）。

---

## 常用命令

```bash
npm install              # 安装依赖
npm run build            # 构建 → dist/chksz.jsplugin.zip（同时打印 entryHash/zipHash）
npm run validate         # 校验 plugin.json
npm run dev              # 开发模式
```

构建产出后**必须**把打印的 `entryHash` / `zipHash` 回写到 `plugin.json`（与产物保持一致，供宿主更新校验）。

---

## 版本与发布（铁律）

1. **语义化版本号** `X.Y.Z`（如 0.1.5），不使用日期版本。
2. **每轮功能/修复提交后 bump patch 版本**（0.1.5 → 0.1.6）：同步更新 `package.json`、`plugin.json` 的 `version`，以及 `plugin.json` 的 `download_url`（`.../releases/download/vX.Y.Z/chksz.jsplugin.zip`）。
3. **发布自动化**：push 到 `main` 自动触发 `release.yml`（读取 `plugin.json` 版本构建发布；该版本已打过 tag 则自动跳过）。手动触发 `workflow_dispatch` 可指定版本号（允许重发）。
4. **提交信息格式**：`<type>: <中文描述>;bump to vX.Y.Z`。type 用 `feat` / `fix` / `style` / `refactor` / `chore` / `docs`。
5. 发布后如 workflow 自动提交了 version bump（`github-actions[bot]`），保持即可。

---

## 后端路由（src/main.ts）

| 路由 | 说明 |
|------|------|
| `POST /api/search` | **宿主音源契约**（SourceResolver fan-out 用）：`{keyword, page?, page_size?}` → `{results}`，按插件设置默认平台搜索 |
| `POST /api/music/url` | **宿主音源契约**：`{source_data, fallback?}` → `{url}`，支持 L1 自搜 fallback |
| `POST /api/search/select` | 插件前端搜索：`{keyword, platforms:[wy,tx,kg]}`（平台多选） |
| `GET /api/browse` | 首页模块：`?platform=wy|tx|kg` → 推荐歌单 / 排行榜 |
| `GET /api/browse/playlist` | 歌单/榜单详情：`?platform=..&id=..` → 歌曲列表（带 source_data） |
| `GET/POST /api/settings` | 插件设置：api_key / quality(128k/320k/flac) / platforms |
| `POST /api/import` | 导入宿主曲库（去重键 `chksz_{platform}_{id/mid}`，返回歌曲 id） |
| `POST /api/playlist/import` | 抓取源歌单/榜单 → 逐首入库（去重）→ 创建宿主歌单并批量加入；支持 `{platform, id, ...}` 或直接粘贴分享链接 `{url, name?}`（自动识别网易云/QQ/酷狗） |
| `POST /api/search/topone` | miot 外部搜索源规范（小爱音箱语音点歌） |
| `GET /api/health` | 健康检查 |

**平台标识**：`wy`=网易云 `tx`=QQ `kg`=酷狗（source_data.platform）。

**音质映射（严格）**：网易云 `standard/exhigh/lossless`，QQ/酷狗 `128k/320k/flac`；非法值不发请求。

---

## 关键架构决策与踩坑（铁律）

### 1. 播放界面由宿主承担，插件不做播放 UI
播放/进度/歌词/队列全部交给宿主播放器（Songloft web UI 底部播放条 / 客户端播放器原生支持 remote 歌曲）。**不要新增插件内播放界面**（playerScreen / miniPlayer / 歌词页等已移除）。插件只负责：发现资源 → 导入 → `setQueue` 交给宿主 → snackbar 提示。播放器对象 `window.SongloftPlugin.player` 是**延迟注入**的，使用前需轮询等待（`player.js` 已有实现）。

### 2. 宿主 embed 模式会隐藏 `.app-bar` 类
宿主注入的 `components.css` 含 `html.embed .app-bar { display: none !important; }`（插件页以 iframe + `?embed` 方式嵌入宿主）。**页面顶部栏必须用 `.search-bar` 等自有类名，禁止 `.app-bar`**（历史教训：搜索框整行被宿主隐藏）。

### 3. 插件请求对象用 `req.query` 拿参数
插件 `HTTPRequest` 有独立 `query` 字段（query string，无 `?`），**不要用 `req.url`**（该字段不存在，会导致平台参数全部失效——历史 bug）。解析用 SDK 的 `parseQuery`。

### 4. QuickJS 环境限制
- 无 DOM；TS 编译为字节码 `main.jsc`（builder 自动处理）
- `fetch` 可用但**无 AbortController**，超时用 `Promise.race`（`chkszGet` / `browseFetch` 已有模式，超时 6s/9s）
- 外部接口统一走服务端代理（插件后端 fetch，无 CORS 问题），前端只调插件自身路由

### 5. 平台内容接口是网页逆向接口，随时可能变化
网易云/QQ/酷狗**无官方开放 API**（与开源播放器一致，用网页端公开接口）：
- 网易云：`music.163.com/api/personalized/playlist`（推荐歌单）、`/api/toplist`（排行榜）、`/api/v6/playlist/detail?id=&n=1000`（完整 trackIds）+ `/api/v3/song/detail?c=[...]`（按 100 首/批补齐歌曲元数据；老 `/api/playlist/detail` 大歌单只返回 10 首完整 tracks，勿再使用）
- QQ：`c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg`（歌单，未登录仅 1 条）、`fcg_myqq_toplist.fcg`（榜单列表，字段 `topTitle`）、`POST u.y.qq.com/cgi-bin/musicu.fcg`（歌单详情）、`fcg_v8_toplist_cp.fcg?topid=`（榜单详情，`songlist[].data.songmid`）
- 酷狗：`mobilecdn.kugou.com/api/v3/rank/list`（榜单列表）、`m.kugou.com/rank/info/{id}?json=true`（榜单歌曲，`songs.list[].sqhash` 即解析 id）；**推荐歌单公开接口不可用**（Access Deny），酷狗模块只有排行榜
- 接口变化时：先 curl 验证新结构再改 `browse*` 系列函数；`browseFetch` 带浏览器 UA + 必要 Referer

### 6. 前端构建与资源
- `static/js/` 为 ES module，esbuild 打包成单一 `app.bundle.<hash>.js` 并自动改写 `index.html` 引用；静态资源（icon 等）会被 hash 重命名
- `index.html` 内引用资源用相对路径（`static/...`），构建器会重写
- 宿主 `SongloftPlugin` 桥（getAuthToken/apiGet/apiPost/...）在 iframe 加载后注入，前端初始化需容错（模块 try/catch 隔离，见 `app.js`）

### 7. 前端模块约定
- `app.js` 入口（safe 隔离各模块）；`search.js` 搜索+平台 chips；`browse.js` 首页平台标签+歌单详情操作；`importPlaylist.js` 平台歌单导入宿主（确认弹窗）；`playlists.js` 收藏歌单（调宿主 `/api/v1/playlists` API，走用户 token）；`config.js` 设置弹窗；`player.js` 仅播放操作（setQueue/addToQueue）；`api.js` 请求封装；`util.js` 工具
- 收藏歌单走宿主 API：`GET/POST /api/v1/playlists`（创建需 `{name, type:"normal"}`）、`POST /api/v1/playlists/{id}/songs`（`{song_ids:[..]}`，服务端去重）、`GET /api/v1/playlists/{id}/song-ids`
- 未配置 API Key 时点击搜索 → 自动打开配置弹窗（`openConfig`）

### 8. 兼容性
- 宿主注入的 `theme.css` / `components.css` / `webf-shims.js` 会进插件页：WebF 客户端不支持 `backdrop-filter`（如需毛玻璃必须 `@supports` 降级，当前已无播放界面，未使用）
- `data-theme` 暗色模式由宿主 postMessage 下发

---

## 验证流程

1. **后端路由**：本地 Songloft（`http://localhost:58091`，admin/admin）上传 `dist/chksz.jsplugin.zip` 后，用 curl 调 `/api/v1/jsplugin/chksz/api/...` 验证（需登录 token）。
2. **前端**：插件页以 iframe 嵌入宿主 `/#/plugin-tab/chksz`；浏览器控制台（agent-browser-cli）验证交互；注意后台 iframe 的 `getBoundingClientRect` 会失真（视口 0），以 computed style 为准。
3. **外部接口**：改动 `browse*` / 解析逻辑后，先 curl 平台接口确认字段，再经插件路由联调。
4. 完成后按「版本与发布」铁律 bump + 提交 + push（自动发版）。

