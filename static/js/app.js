// app.js — 入口:初始化各模块、绑定面板
// 每个模块独立 try/catch 隔离:单个模块失败不影响其他(尤其保证搜索可用)

import { snackbar } from './util.js'
import { initPlayer, getState } from './player.js'
import { initSearch } from './search.js'
import { initConfig, checkKeyStatus } from './config.js'
import { initLyrics } from './lyrics.js'
import { initPlaylists } from './playlists.js'

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
  // 播放器(迷你条 + 全屏播放界面)
  safe(initPlayer, 'player')

  // 搜索(最高优先级:即使其他全挂也要保证可用)
  safe(initSearch, 'search')

  // 配置弹窗(搜索栏设置按钮)
  safe(() => initConfig(checkKeyStatus), 'config')

  // 歌词同步(读播放器当前进度)
  safe(() => initLyrics(() => getState().current_time), 'lyrics')

  // 收藏歌单
  safe(initPlaylists, 'playlists')

  // 首次加载静默检查 Key
  safe(checkKeyStatus, 'keyStatus')
}

// 等 DOM 就绪(module 脚本默认 defer,直接跑)
init()
