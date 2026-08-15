// app.js — 入口:初始化各模块、绑定面板
// 每个模块独立 try/catch 隔离:单个模块失败不影响其他(尤其保证搜索可用)

import { snackbar } from './util.js'
import { initPlayer } from './player.js'
import { initSearch } from './search.js'
import { initConfig } from './config.js'
import { initPlaylists } from './playlists.js'
import { initBrowse } from './browse.js'
import { initImportPlaylist } from './importPlaylist.js'

function el(id) { return document.getElementById(id) }

function safe(fn, name) {
  try {
    fn()
  } catch (e) {
    console.error('[chksz] init ' + name + ' failed:', e)
    try { snackbar('初始化 ' + name + ' 失败') } catch (_) { /* ignore */ }
  }
}

function init() {
  // 播放器(仅等待宿主播放器注入,播放界面由宿主承担)
  safe(initPlayer, 'player')

  // 搜索(最高优先级:即使其他全挂也要保证可用)
  safe(initSearch, 'search')

  // 配置弹窗(搜索栏设置按钮)
  safe(() => initConfig(null), 'config')

  // 收藏歌单
  safe(initPlaylists, 'playlists')

  // 首页浏览(平台标签 + 推荐/排行榜模块)
  safe(initBrowse, 'browse')

  // 导入平台歌单到宿主歌单
  safe(initImportPlaylist, 'importPlaylist')
}

// 等 DOM 就绪(module 脚本默认 defer,直接跑)
init()
