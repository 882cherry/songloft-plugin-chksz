# ChKSz 音源插件 (songloft-plugin-chksz)

通过 [api.chksz.com](https://api.chksz.com) 搜索并解析 **网易云 / QQ音乐 / 酷狗** 播放链接的 [Songloft](https://github.com/songloft-org/songloft) JS 插件。

> ⚠️ 使用本插件需要 api.chksz.com 的 API Key（登录 [api.chksz.com/login](https://api.chksz.com/login) 获取）。Key 保存在插件设置中，**不写入代码 / 仓库**。

## 功能

- **宿主音源插件契约**：实现 `POST /api/search` + `POST /api/music/url`，接入 Songloft 音源编排（SourceResolver / SourceFetcher），支持 L1 自搜 fallback
- **小爱音箱语音点歌**：实现 miot 外部搜索源规范（`POST /api/search/topone`），安装后自动注册到 miot 插件配置页「外部搜索」下拉
- **三平台合并搜索**：网易云 `163_search`、QQ `qq_music`、酷狗 `kugou_music` 并发搜索，单平台失败不影响整体
- **严格音质映射**：按 ChKSz 官方参数表映射（`128k / 320k / flac` 三档，可配置），非法值不会被发出

## 安装

1. 下载最新 [Release](https://github.com/882cherry/songloft-plugin-chksz/releases/latest) 中的 `chksz.jsplugin.zip`
2. Songloft 后台 →「JS 插件」→ 安装 → 上传 zip
3. 打开插件 → 设置 → 填入 API Key（可选调整默认音质）

## 接口

| 路由 | 说明 |
|------|------|
| `POST /api/search` | 音源插件契约：`{keyword, page?, page_size?}` → `{results: [{title, artist, album, duration, cover_url, source_data}]}` |
| `POST /api/music/url` | 音源插件契约：`{source_data, fallback?}` → `{url}` |
| `POST /api/search/topone` | miot 外部搜索源规范：`{keyword, hint?, quality?}` → `{code, data}` |
| `GET/POST /api/settings` | 插件设置（api_key / quality） |

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
