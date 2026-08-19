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
| `GET /api/browse` | 首页模块：`?platform=wy|tx|kg` → 推荐歌单 / 排行榜；网易云登录后额外返回「我喜欢的音乐 / 创建的歌单 / 收藏的歌单」 |
| `GET /api/browse/playlist` | 歌单/榜单详情：`?platform=..&id=..` → 歌曲列表（带 source_data） |
| `GET/POST /api/settings` | 插件设置：api_key / quality(128k/320k/flac) / platforms / 网易云登录状态 |
| `GET /api/netease/login/qr` | 获取网易云扫码登录 key 与登录 URL |
| `GET /api/netease/login/qr/check` | 轮询扫码状态；803 成功后自动保存 MUSIC_U Cookie |
| `POST /api/netease/login/cellphone` | 备用手机号+密码登录 API（EAPI，易触发风控；新版前端不再使用） |
| `POST /api/netease/login/urs` | 官方 URS 网页登录成功回写：服务端请求 `nextUrls` 抓取 MUSIC_U 并保存 |
| `POST /api/netease/login/cookie` | Cookie 导入：验证 MUSIC_U 并保存（独立于网页登录） |
| `POST /api/netease/logout` | 退出网易云登录 |
| `POST /api/import` | 导入宿主曲库（去重键 `chksz_{platform}_{id/mid}`，返回歌曲 id） |
| `POST /api/playlist/import` | 抓取源歌单/榜单 → 逐首入库（去重）→ 创建宿主歌单并批量加入；支持 `{platform, id, ...}` 或直接粘贴分享链接 `{url, name?}`（自动识别网易云/QQ/酷狗）；重复导入返回 `exists`，`overwrite:true` 时保留原歌单 id 覆盖歌曲 |
| `POST /api/search/topone` | miot 外部搜索源规范（小爱音箱语音点歌） |
| `POST /api/miot/register` | 手动触发向 miot 注册为外部搜索源候选（miot 后装/重装后补注册用） |
| `GET /api/miot/status` | 查询 ChKSz 是否已向 miot 注册 |
| `GET /api/health` | 健康检查 |

**平台标识**：`wy`=网易云 `tx`=QQ `kg`=酷狗（source_data.platform）。

**音质映射（严格）**：网易云 `standard/exhigh/lossless`，QQ/酷狗 `128k/320k/flac`；非法值不发请求。

---

## 关键架构决策与踩坑（铁律）

### 1. 播放界面由宿主承担，插件做「遥控镜像」而非第二套播放器
播放/解码/歌词/队列全部交给宿主播放器（Songloft web UI 底部播放条 / 客户端播放器原生支持 remote 歌曲）。插件在后端只负责：发现资源 → 导入 → `setQueue` 交给宿主 → snackbar 提示。播放器对象 `window.SongloftPlugin.player` 是**延迟注入**的，使用前需轮询等待（`player.js` 已有实现）。
**例外（唯一允许的播放 UI）：`miniPlayer.js` 底部遥控镜像。** 宿主在插件 Tab / 设置页会隐藏其底部播放条（宿主 `shell_layout.dart`：`bottomPlayer: (isPluginTab || isSettings) ? null : …`，且桥接没有"显示播放条"的方法），导致插件内播放后无法暂停/停止。因此 v0.1.39 起在插件页底部渲染一条轻量浮层：监听宿主注入的 `songloft-player-state-change` 事件（三路渲染路径都会推）+ 初始化 `getState()` 兜底，仅镜像状态并转发 `togglePlay/prev/next/seek` 回宿主——不是第二套播放引擎。不要新增除它以外的播放界面（歌词页、队列页等继续留在宿主）。实现要点（踩坑积累）：
- **用 `.view` 内页脚（`flex: 0 0 auto`）而非 `position: fixed`**：fixed 元素与 embed 滚动容器交叠会诱发滚动抖动/重排回路（宿主 theme.css #278 同类问题），且无法被内容顶起。
- **播放/暂停按钮做「乐观翻转 + 宿主权威校正」**：点击立即切换图标（动效），宿主推送到达后按 `is_playing` 校正；宿主在部分客户端可能推送不及时。
- **封面**：宿主 `current_song.cover_url` 常为空，导入时用 `rememberCover(id, url)` 写入 localStorage（`chksz_covers_v1`），镜像优先用记忆封面、失败则隐藏（不显示破图）。歌曲行「正在播放」态同理（`onPlaybackState` 总线，见铁律 1 player.js）。
- **跳完整播放器**：Web/iframe 嵌入态下点击镜像封面/标题区设置 `parent.location.hash='#/player'`（同源 iframe 可驱动宿主 go_router）。**非嵌入态（原生 App / WebF，无父窗口）点击则展开 `#mpSheet` 大面板**（更大封面+进度时间+控制），`.show` 用 rAF + 50ms 定时器双保险触发（后台标签/WebF 会节流 rAF）。
- **歌单内播放**：歌单详情里点任一行的播放，先把整张歌单全部 `api/import` 入库、再 `playSongs(全部, startIndex=行号)` 整单替换队列并从该行开始（不要只导入单曲）。
- 手机端搜索行自动隐藏（`initSearchBarAutoHide`）对两次切换加了 ≥320ms 冷却，避免「隐藏→布局高度变化→scrollTop 回弹→再显示」的抖动回路。

### 2. 宿主 embed 模式会隐藏 `.app-bar` 类
宿主注入的 `components.css` 含 `html.embed .app-bar { display: none !important; }`（插件页以 iframe + `?embed` 方式嵌入宿主）。**页面顶部栏必须用 `.search-bar` 等自有类名，禁止 `.app-bar`**（历史教训：搜索框整行被宿主隐藏）。

### 3. 插件请求对象用 `req.query` 拿参数
插件 `HTTPRequest` 有独立 `query` 字段（query string，无 `?`），**不要用 `req.url`**（该字段不存在，会导致平台参数全部失效——历史 bug）。解析用 SDK 的 `parseQuery`。

### 4. QuickJS 环境限制
- 无 DOM；TS 编译为字节码 `main.jsc`（builder 自动处理）
- `fetch` 可用但**无 AbortController**，超时用 `Promise.race`（`chkszGet` / `browseFetch` 已有模式，超时 6s/9s）
- `fetch` 响应头里的 `set-cookie` 可能被合并成逗号分隔长串；不要整串当 Cookie 回传（网易云会判定未登录）。`neteaseCookieHeader` 只提取 `MUSIC_U` / `__csrf` 后发送
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
- `app.js` 入口（safe 隔离各模块）；`search.js` 搜索+平台多选下拉框；`browse.js` 首页平台标签+歌单详情操作（网易云登录后含个人歌单模块）；`importPlaylist.js` 平台歌单导入宿主（确认弹窗）；`neteaseLogin.js` 网易云扫码/官方 URS 网页组件（手机验证码+手机密码）/Cookie 登录；`playlists.js` 收藏歌单（调宿主 `/api/v1/playlists` API，走用户 token）；`config.js` 设置弹窗；`player.js` 仅播放操作（setQueue/addToQueue）；`miniPlayer.js` 底部遥控镜像（见铁律 1）；`api.js` 请求封装；`util.js` 工具
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

