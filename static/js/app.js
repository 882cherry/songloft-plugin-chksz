// app.js — 入口:初始化各模块、绑定面板
// 每个模块独立 try/catch 隔离:单个模块失败不影响其他(尤其保证搜索可用)

import { bindSheet, snackbar } from './util.js'
import { hasClientPlayer } from './api.js'
import { initPlayer, getState } from './player.js'
import { initSearch } from './search.js'
import { initConfig, checkKeyStatus } from './config.js'
import { initLyrics } from './lyrics.js'

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
  // 播放器(核心)——失败不影响搜索
  safe(initPlayer, 'player')

  // 搜索(最高优先级:即使其他全挂也要保证可用)
  safe(initSearch, 'search')

  // 配置弹窗(左上角图标)
  safe(() => initConfig(checkKeyStatus), 'config')

  // 底部面板:队列 / 音量
  safe(() => bindSheet('queueBackdrop', 'queueSheet', el('queueBtn'), []), 'queue')
  safe(() => bindSheet('volumeBackdrop', 'volumeSheet', el('volumeBtn'), []), 'volume')

  // 歌词同步(读播放器当前进度)
  safe(() => initLyrics(() => getState().current_time), 'lyrics')

  // 首次加载静默检查 Key
  safe(checkKeyStatus, 'keyStatus')

  // 宿主不可用时提示
  if (!hasClientPlayer()) {
    snackbar('当前环境无宿主播放器,仅可搜索/导入')
  }
}

// 等 DOM 就绪(module 脚本默认 defer,直接跑)
init()
