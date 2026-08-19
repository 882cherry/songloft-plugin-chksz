// app.js — 入口:初始化各模块、绑定面板
// 每个模块独立 try/catch 隔离:单个模块失败不影响其他(尤其保证搜索可用)

import { snackbar } from './util.js'
import { initPlayer } from './player.js'
import { initSearch } from './search.js'
import { initConfig } from './config.js'
import { initPlaylists } from './playlists.js'
import { initBrowse } from './browse.js'
import { initImportPlaylist } from './importPlaylist.js'
import { initNeteaseLogin, refreshNeteaseStatus } from './neteaseLogin.js'
import { initLyric } from './lyric.js'
import { initMiniPlayer } from './miniPlayer.js'

function el(id) { return document.getElementById(id) }

function safe(fn, name) {
  try {
    fn()
  } catch (e) {
    console.error('[chksz] init ' + name + ' failed:', e)
    try { snackbar('初始化 ' + name + ' 失败') } catch (_) { /* ignore */ }
  }
}

// 手机端:搜索行随滚动方向自动隐藏/显示(向上滑隐藏,向下滑显示,带动画)
function initSearchBarAutoHide() {
  const bar = document.querySelector('.search-bar')
  if (!bar) return
  const scrollEls = [el('browse'), el('searchContainer')].filter(Boolean)
  const lastTops = new WeakMap()
  let lastToggleAt = 0
  scrollEls.forEach((scrollEl) => {
    lastTops.set(scrollEl, 0)
    let ticking = false
    scrollEl.addEventListener('scroll', () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        const st = scrollEl.scrollTop
        const last = lastTops.get(scrollEl) || 0
        const diff = st - last
        lastTops.set(scrollEl, st)
        const now = Date.now()
        // 冷却窗 > 动画时长(0.28s):避免「隐藏→高度变化→scrollTop 回调→再显示」抖动回路
        if (now - lastToggleAt < 320) {
          ticking = false
          return
        }
        if (st <= 0) {
          if (bar.classList.contains('hide-search')) {
            bar.classList.remove('hide-search')
            lastToggleAt = now
          }
        } else if (diff > 4) {
          if (!bar.classList.contains('hide-search')) {
            bar.classList.add('hide-search')
            lastToggleAt = now
          }
        } else if (diff < -4) {
          if (bar.classList.contains('hide-search')) {
            bar.classList.remove('hide-search')
            lastToggleAt = now
          }
        }
        ticking = false
      })
    }, { passive: true })
  })
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

  // 网易云登录(扫码 + 网页 Cookie)
  safe(initNeteaseLogin, 'neteaseLogin')

  // 歌词搜索 / 重新获取
  safe(initLyric, 'lyric')

  // 播放器遥控镜像(宿主在插件 Tab 隐藏底部播放条时的暂停/停止控制)
  safe(initMiniPlayer, 'miniPlayer')

  // 手机端搜索行自动隐藏/显示
  safe(initSearchBarAutoHide, 'searchBarAutoHide')
}

// 等 DOM 就绪(module 脚本默认 defer,直接跑)
init()
