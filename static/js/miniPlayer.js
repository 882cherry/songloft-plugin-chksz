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
// 展示规则 : 宿主队列非空或存在当前歌曲时显示,队列清空后自动隐藏。
//
// 宿主推送节流只含关键字段(stateSignature 不含 currentTime),本地用 1s 定时器
// 自行走秒渲染进度条,宿主 any 事件到达时以 current_time 校准。

import { snackbar } from './util.js'

export function initMiniPlayer() {
  const root = document.getElementById('miniPlayer')
  if (!root) return
  const cover = document.getElementById('mpCover')
  const titleEl = document.getElementById('mpTitle')
  const subEl = document.getElementById('mpArtist')
  const fill = document.getElementById('mpProgressFill')
  const progress = document.getElementById('mpProgress')
  const playBtn = document.getElementById('mpPlayBtn')
  const prevBtn = document.getElementById('mpPrevBtn')
  const nextBtn = document.getElementById('mpNextBtn')

  let state = null
  let pos = 0 // 本地播放进度(秒),每 1s 自走
  let timer = null

  function getPlayer() {
    try {
      const p = window.SongloftPlugin && window.SongloftPlugin.player
      return p || null
    } catch (e) { return null }
  }

  function show() {
    if (root.style.display !== 'flex') root.style.display = 'flex'
    document.body.classList.add('has-mini-player')
  }
  function hide() {
    root.style.display = 'none'
    document.body.classList.remove('has-mini-player')
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

  function render() {
    if (!state) return
    const song = state.current_song
    if (song) {
      titleEl.textContent = song.title || '未知歌曲'
      subEl.textContent = [song.artist, song.album].filter(Boolean).join(' · ')
      if (song.cover_url) {
        cover.src = song.cover_url
        cover.style.display = ''
      } else if (cover.src === '') {
        cover.style.display = 'none'
      }
    } else {
      titleEl.textContent = '未播放'
      subEl.textContent = ''
      cover.style.display = 'none'
    }
    const ic = playBtn.querySelector('.material-symbols-outlined')
    if (ic) ic.textContent = state.is_playing ? 'pause' : 'play_arrow'
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

  // 控制按钮(点击后 blur,避免复现「按钮焦点圆环残留」)
  function bind(btn, fn) {
    if (!btn) return
    btn.addEventListener('click', function () {
      try { btn.blur() } catch (_) { /* ignore */ }
      fn()
    })
  }
  bind(playBtn, () => call('togglePlay'))
  bind(prevBtn, () => call('prev'))
  bind(nextBtn, () => call('next'))

  // 进度条点击跳转
  if (progress) {
    progress.addEventListener('click', function (e) {
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
