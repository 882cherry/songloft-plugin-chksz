// app.js — 入口:初始化各模块、绑定面板

import { bindSheet, snackbar } from './util.js'
import { hasClientPlayer } from './api.js'
import { initPlayer, getState } from './player.js'
import { initSearch } from './search.js'
import { initConfig, openConfig, checkKeyStatus } from './config.js'
import { initLyrics } from './lyrics.js'

function el(id) { return document.getElementById(id) }

function init() {
  // 播放器(核心)
  initPlayer()

  // 搜索
  initSearch()

  // 配置弹窗(左上角图标)
  initConfig(checkKeyStatus)

  // 底部面板:队列 / 歌词 / 音量
  bindSheet('queueBackdrop', 'queueSheet', el('queueBtn'), [])
  bindSheet('lyricBackdrop', 'lyricSheet', el('lyricBtn'), [])
  bindSheet('volumeBackdrop', 'volumeSheet', el('volumeBtn'), [])

  // 歌词同步(读播放器当前进度)
  initLyrics(() => getState().current_time)

  // 首次加载静默检查 Key
  checkKeyStatus()

  // 宿主不可用时提示
  if (!hasClientPlayer()) {
    snackbar('当前环境无宿主播放器,仅可搜索/导入')
  }
}

// 等 DOM 就绪(module 脚本默认 defer,直接跑)
init()
