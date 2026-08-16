# ChKSz 音源插件 (songloft-plugin-chksz)

通过 [api.chksz.com](https://api.chksz.com) 搜索并解析 **网易云 / QQ音乐 / 酷狗** 播放链接的 [Songloft](https://github.com/songloft-org/songloft) JS 插件。

> ⚠️ 使用本插件需要 api.chksz.com 的 API Key（登录 [api.chksz.com/login](https://api.chksz.com/login) 获取）。Key 保存在插件设置中，**不写入代码 / 仓库**。

## 功能

- **宿主音源插件契约**：实现 `POST /api/search` + `POST /api/music/url`，接入 Songloft 音源编排（SourceResolver / SourceFetcher），支持 L1 自搜 fallback
- **小爱音箱语音点歌**：实现 miot 外部搜索源规范（`POST /api/search/topone`），安装后自动注册到 miot 插件配置页「外部搜索」下拉
- **三平台合并搜索**：网易云 `163_search`、QQ `qq_music`、酷狗 `kugou_music` 并发搜索，单平台失败不影响整体
- **严格音质映射**：按 ChKSz 官方参数表映射（`128k / 320k / flac` 三档，可配置），非法值不会被发出
- **歌词搜索（多接口 + 优先级）**：支持 **LRCLIB / 网易云 / QQ音乐 / 酷狗** 四种歌词接口，页面顶部有「歌词」入口，设置中可开关自动搜索、勾选启用的接口并调整优先级；宿主在歌曲无歌词时通过 `/lyric-search` 自动调用本插件获取；每首歌/当前播放歌曲均可点「歌词」按钮按指定接口重新获取

## 安装

### 订阅源地址（推荐）

Songloft 的「JS 插件」页面支持添加订阅源，填入以下地址后即可一键安装/更新本插件：

```
https://raw.githubusercontent.com/882cherry/songloft-plugin-chksz/main/registry.json
```

手动安装：

1. 下载最新 [Release](https://github.com/882cherry/songloft-plugin-chksz/releases/latest) 中的 `chksz.jsplugin.zip`
2. Songloft 后台 →「JS 插件」→ 安装 → 上传 zip
3. 打开插件 → 设置 → 填入 API Key（可选调整默认音质）

## 接口

| 路由 | 说明 |
|------|------|
| `POST /api/search` | 音源插件契约：`{keyword, page?, page_size?}` → `{results: [{title, artist, album, duration, cover_url, source_data}]}` |
| `POST /api/music/url` | 音源插件契约：`{source_data, fallback?}` → `{url}` |
| `POST /api/search/topone` | miot 外部搜索源规范：`{keyword, hint?, quality?}` → `{code, data}` |
| `POST /api/playlist/import` | 导入平台歌单/榜单：`{platform, id, name?}` 或 `{url, name?}`（支持网易云/QQ/酷狗分享链接） → 自动入库并创建 Songloft 歌单 |
| `GET /api/netease/login/qr` 等 | 网易云扫码 / 网页 Cookie 登录；登录后网易云优先走官方播放接口 |
| `GET/POST /api/settings` | 插件设置（api_key / quality / lyric_sources 歌词接口优先级） |
| `POST /lyric-search` | 宿主歌词提供者契约：`{title, artist?, album?, duration?, source?}` → `{lyric, lyric_source, title, artist}`；宿主在歌曲无歌词时自动调用 |
| `POST /api/lyric/search` | 前端歌词搜索：`{keyword}` → `{results: [{source, title, artist, album, preview, lyric}]}`（跨所有已启用接口） |
| `POST /api/lyric/fetch` | 为指定歌曲按指定接口/优先级获取歌词：`{song: {title, artist?, album?, duration?, source_data?}, source?}` → `{lyric, source, title, artist}` |

## 开发

```bash
npm install
npm run build     # → dist/chksz.jsplugin.zip
npm run validate  # 校验 plugin.json
```

## 发版

GitHub Actions 手动触发 `Release Plugin`（workflow_dispatch），自动生成日期版本（`Y.M.D`）、构建并发布 Release；也支持传入自定义版本号。

## 许可证

Apache-2.0
