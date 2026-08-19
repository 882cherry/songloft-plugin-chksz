// miniPlayer.js — Songloft 宿主播放器的插件内「遥控镜像」
//
// 为什么存在:宿主界面(WebUI 与客户端)在「插件 Tab」和「设置」页会隐藏底部播放条
// (songloft-player shell_layout.dart: bottomPlayer: (isPluginTab || isSettings) ? null : …),
// 用户在插件内点播放后页面底部没有任何控制,必须切回首页/曲库才能暂停或停止。
// 本模块在插件页底部渲染一条轻量浮层,镜像宿主播放器状态并把控制转发回宿主:
//   状态源  : document 上的 songloft-player-state-change 事件(宿主 common.js 注入;
//            Web/iframe 与 native/WebF 三条渲染路径都会推)+ 初始化时 getState() 兜底。
//   控制    : 仅调 window.SongloftPlugin.player 的 getState/togglePlay/prev/next/seek。
//            实际播放、解码、队列仍全部由宿主承担 —— 本模块不是第二套播放引擎。
//   展示规则 : 宿主队列非空或存在当前歌曲时显示,队列清空后自动隐藏。
//   封面    : 宿主 current_song.cover_url 常为空,优先用它,否则回退到 localstorage
//            里插件导入时的封面(chksz_covers_v1,见 util.js)。
//   完整播放器 : 点击封面/标题区,在 Web/iframe 下设置 parent.location.hash='#/player'
//            跳到宿主完整播放界面(仅当自身被 iframe 嵌入时;客户端无父窗口则忽略)。
//
// 宿主推送节流只含关键字段(stateSignature 不含 currentTime),本地用 1s 定时器
// 自行走秒渲染进度条,宿主事件到达时以 current_time 校准。

import { snackbar, getCover } from './util.js'

export function initMiniPlayer() {
  const root = document.getElementById('miniPlayer')
  if (!root) return
  const cover = document.getElementById('mpCover')
  const open = document.getElementById('mpOpen')
  const titleEl = document.getElementById('mpTitle')
  const subEl = document.getElementById('mpArtist')
  const fill = document.getElementById('mpProgressFill')
  const progress = document.getElementById('mpProgress')
  const playBtn = document.getElementById('mpPlayBtn')
  const prevBtn = document.getElementById('mpPrevBtn')
  const nextBtn = document.getElementById('mpNextBtn')
  if (!playBtn) return

  let state = null
  let pos = 0 // 本地播放进度(秒),每 1s 自走
  let timer = null
  // 乐观播放态:点击时先翻转图标让按钮立即有反馈,宿主推送到达后再以权威值校正
  let optimisticPlaying = null

  function getPlayer() {
    try {
      const p = window.SongloftPlugin && window.SongloftPlugin.player
      return p || null
    } catch (e) { return null }
  }

  function show() {
    if (root.style.display !== 'flex') root.style.display = 'flex'
  }
  function hide() {
    root.style.display = 'none'
  }

  /** 转发控制到宿主(失败提示一次,不抛断) */
  function call(name, args) {
    const p = getPlayer()
    if (!p || typeof p[name] !== 'function') {
      snackbar('宿主播放器不可用')
      return
    }
    try {
      const ret = p[name].apply(p, args || [])
      if (ret && typeof ret.catch === 'function') ret.catch(() => {})
    } catch (e) { snackbar('播放器控制失败:' + (e.message || e)) }
  }

  /** 打开宿主完整播放器(仅 Web/iframe 嵌入态) */
  function openFullPlayer() {
    try {
      if (window.parent && window.parent !== window && window.parent.location) {
        window.parent.location.hash = '#/player'
      }
    } catch (e) { /* 跨域或非嵌入时忽略 */ }
  }

  function render() {
    if (!state) return
    const song = state.current_song
    if (song) {
      titleEl.textContent = song.title || '未知歌曲'
      subEl.textContent = [song.artist, song.album].filter(Boolean).join(' · ')
      // 优先用插件导入时记忆的封面(宿主 current_song.cover_url 常为空;非空也往往是
      // 同一个 URL,但记忆的地址在搜索结果里已经成功加载过,更可靠)
      const src = getCover(song.id) || song.cover_url
      if (src) {
        if (cover.getAttribute('src') !== src) cover.src = src
        cover.style.display = ''
      } else {
        cover.removeAttribute('src')
        cover.style.display = 'none'
      }
    } else {
      titleEl.textContent = '未播放'
      subEl.textContent = ''
      cover.removeAttribute('src')
      cover.style.display = 'none'
    }
    const ic = playBtn.querySelector('.material-symbols-outlined')
    if (ic) {
      const playing = optimisticPlaying !== null ? optimisticPlaying : !!state.is_playing
      ic.textContent = playing ? 'pause' : 'play_arrow'
    }
    const dur = Number(state.duration) || 0
    if (dur > 0) {
      const pct = Math.min(100, Math.max(0, (pos / dur) * 100))
      fill.style.width = pct + '%'
    } else {
      fill.style.width = '0%'
    }
  }

  function syncTimer() {
    if (state && state.is_playing && !timer) {
      timer = setInterval(() => { pos += 1; render() }, 1000)
    } else if (timer && !(state && state.is_playing)) {
      clearInterval(timer)
      timer = null
    }
  }

  function onState(s) {
    if (!s) return
    state = s
    pos = typeof s.current_time === 'number' ? s.current_time : 0
    // 权威状态到达即放弃乐观值(除非暂停/播放本身还在等宿主确认——这里以权威为准)
    optimisticPlaying = null
    const hasContent = !!s.current_song || (Array.isArray(s.queue) && s.queue.length > 0)
    if (hasContent) show()
    else { hide(); if (timer) { clearInterval(timer); timer = null } }
    syncTimer()
    render()
  }

  // 宿主播放状态推送(common.js 统一派发该 CustomEvent,三路渲染路径皆可达)
  document.addEventListener('songloft-player-state-change', function (e) {
    onState(e && e.detail)
  })

  // 封面加载失败时隐藏占位,避免破图
  if (cover) {
    cover.addEventListener('error', function () {
      cover.removeAttribute('src')
      cover.style.display = 'none'
    })
  }

  // 控制按钮(点击后 blur,避免复现「按钮焦点圆环残留」)
  function bind(btn, fn) {
    if (!btn) return
    btn.addEventListener('click', function () {
      try { btn.blur() } catch (_) { /* ignore */ }
      fn()
    })
  }
  // 播放/暂停:点击立即翻转图标(乐观),再转发宿主;宿主推送回来会以权威值校正
  bind(playBtn, () => {
    const isPlay = optimisticPlaying !== null ? optimisticPlaying : !!state.is_playing
    optimisticPlaying = !isPlay
    render()
    call('togglePlay')
  })
  bind(prevBtn, () => call('prev'))
  bind(nextBtn, () => call('next'))

  // 点击封面/标题区 → 打开宿主完整播放器(Web/iframe 嵌入态)
  if (open) {
    open.addEventListener('click', function (e) {
      if (e.target === progress) return // 进度跳转单独处理
      openFullPlayer()
    })
  }
  if (cover) {
    cover.addEventListener('click', openFullPlayer)
  }

  // 进度条点击跳转(阻止冒泡,别触发 open)
  if (progress) {
    progress.addEventListener('click', function (e) {
      e.stopPropagation()
      const rect = progress.getBoundingClientRect()
      if (!rect.width) return
      const dur = state ? (Number(state.duration) || 0) : 0
      if (dur <= 0) return
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      call('seek', [ratio * dur])
    })
  }

  // 初始化兜底:切入插件页时宿主可能已在播放,主动拉一次状态
  const p0 = getPlayer()
  if (p0 && typeof p0.getState === 'function') {
    try {
      const ret = p0.getState()
      if (ret && typeof ret.then === 'function') ret.then(onState).catch(() => {})
    } catch (e) { /* 宿主未就绪,等推送即可 */ }
  }
}
