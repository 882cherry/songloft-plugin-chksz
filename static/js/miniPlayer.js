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
//   封面    : 宿主 current_song.cover_url 常为空,优先用插件导入时记忆的封面
//            (localStorage chksz_covers_v1,见 util.js),失败则隐藏(不显示破图)。
//   点封面/标题 :
//     · 嵌入态(Web/iframe,PC 浏览器或手机浏览器):parent.location.hash='#/player'
//       跳到宿主完整播放界面。
//     · 非嵌入态(原生 App / WebF,无父窗口):展开 #mpSheet 大面板(更大封面+进度+控制)。
//
// 宿主推送节流只含关键字段(stateSignature 不含 currentTime),本地用 1s 定时器
// 自行走秒渲染进度条,宿主事件到达时以 current_time 校准。

import { snackbar, getCover } from './util.js'

function el(id) { return document.getElementById(id) }

/** 是否被宿主 iframe 嵌入(Web) */
function isEmbedded() {
  try {
    return !!window.parent && window.parent !== window
  } catch (e) { return true } // 跨域访问抛错 → 视为嵌入
}

/** 秒 → m:ss */
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m + ':' + String(s).padStart(2, '0')
}

export function initMiniPlayer() {
  const root = el('miniPlayer')
  if (!root) return
  // 迷你条
  const cover = el('mpCover')
  const open = el('mpOpen')
  const titleEl = el('mpTitle')
  const subEl = el('mpArtist')
  const fill = el('mpProgressFill')
  const progress = el('mpProgress')
  const playBtn = el('mpPlayBtn')
  const prevBtn = el('mpPrevBtn')
  const nextBtn = el('mpNextBtn')
  if (!playBtn) return
  // 展开面板(非嵌入态使用)
  const sheet = el('mpSheet')
  const sheetBackdrop = el('mpSheetBackdrop')
  const p2Cover = el('mp2Cover')
  const p2Title = el('mp2Title')
  const p2Sub = el('mp2Sub')
  const p2Time = el('mp2Time')
  const p2Fill = el('mp2ProgressFill')
  const p2Progress = el('mp2Progress')
  const p2PlayBtn = el('mp2PlayBtn')
  const p2PrevBtn = el('mp2PrevBtn')
  const p2NextBtn = el('mp2NextBtn')

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

  // ===== 展开面板(非嵌入态)开关 =====
  function showSheet() {
    if (!sheet) return
    if (sheetBackdrop) sheetBackdrop.style.display = 'block'
    // rAF 保证先绘制初始态再上移(有滑动过渡);被后台标签/WebF 节流时用定时器兜底
    const addShow = () => sheet.classList.add('show')
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(addShow)
    setTimeout(addShow, 50)
    render()
  }
  function hideSheet() {
    if (!sheet) return
    if (sheetBackdrop) sheetBackdrop.style.display = 'none'
    sheet.classList.remove('show')
  }

  /** 打开宿主完整播放器:嵌入态跳父窗口 /player,否则展开插件侧大面板 */
  function openFullPlayer() {
    if (isEmbedded()) {
      try {
        window.parent.location.hash = '#/player'
        return
      } catch (e) { /* 跨域失败落回展开面板 */ }
    }
    showSheet()
  }

  function setCover(img, song, onlyIfEmpty) {
    if (!img) return
    const src = getCover(song ? song.id : null) || (song && song.cover_url) || ''
    const cur = img.getAttribute('src')
    if (src) {
      if (onlyIfEmpty && cur) return
      if (cur !== src) img.src = src
      img.style.display = ''
    } else {
      img.removeAttribute('src')
      img.style.display = 'none'
    }
  }

  function render() {
    if (!state) return
    const song = state.current_song
    if (song) {
      const titleText = song.title || '未知歌曲'
      const subText = [song.artist, song.album].filter(Boolean).join(' · ')
      titleEl.textContent = titleText
      subEl.textContent = subText
      if (p2Title) p2Title.textContent = titleText
      if (p2Sub) p2Sub.textContent = subText
      setCover(cover, song, false)
      if (p2Cover) setCover(p2Cover, song, false)
    } else {
      titleEl.textContent = '未播放'
      subEl.textContent = ''
      cover.removeAttribute('src')
      cover.style.display = 'none'
      if (p2Title) p2Title.textContent = '未播放'
      if (p2Sub) p2Sub.textContent = ''
      if (p2Cover) { p2Cover.removeAttribute('src'); p2Cover.style.display = 'none' }
    }
    const playing = optimisticPlaying !== null ? optimisticPlaying : !!state.is_playing
    if (playBtn) {
      const ic = playBtn.querySelector('.material-symbols-outlined')
      if (ic) ic.textContent = playing ? 'pause' : 'play_arrow'
    }
    if (p2PlayBtn) {
      const ic = p2PlayBtn.querySelector('.material-symbols-outlined')
      if (ic) ic.textContent = playing ? 'pause' : 'play_arrow'
    }
    const dur = Number(state.duration) || 0
    const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0
    fill.style.width = pct + '%'
    if (p2Fill) p2Fill.style.width = pct + '%'
    if (p2Time) p2Time.textContent = fmt(pos) + ' / ' + fmt(dur)
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
    optimisticPlaying = null // 权威状态到达即放弃乐观值
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
  function degrace(img) {
    if (img) img.addEventListener('error', function () {
      img.removeAttribute('src')
      img.style.display = 'none'
    })
  }
  degrace(cover)
  degrace(p2Cover)

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

  // 控制按钮(点击后 blur,避免复现「按钮焦点圆环残留」);播放/暂停乐观翻转
  function bind(btn2, fn) {
    if (!btn2) return
    btn2.addEventListener('click', function () {
      try { btn2.blur() } catch (_) { /* ignore */ }
      fn()
    })
  }
  function togglePlayIcon() {
    const isPlay = optimisticPlaying !== null ? optimisticPlaying : !!state.is_playing
    optimisticPlaying = !isPlay
    render()
    call('togglePlay')
  }
  bind(playBtn, togglePlayIcon)
  bind(prevBtn, () => call('prev'))
  bind(nextBtn, () => call('next'))
  bind(p2PlayBtn, togglePlayIcon)
  bind(p2PrevBtn, () => call('prev'))
  bind(p2NextBtn, () => call('next'))

  // 点击封面/标题区 → 打开完整播放器(嵌入态跳父窗口 /player;非嵌入态展开面板)
  if (open) {
    open.addEventListener('click', function (e) {
      if (e.target === progress || e.target === p2Progress) return
      openFullPlayer()
    })
  }
  if (cover) {
    cover.addEventListener('click', function (e) {
      e.stopPropagation()
      openFullPlayer()
    })
  }

  // 进度条点击跳转
  function wireSeek(bar) {
    if (!bar) return
    bar.addEventListener('click', function (e) {
      e.stopPropagation()
      const rect = bar.getBoundingClientRect()
      if (!rect.width) return
      const dur = state ? (Number(state.duration) || 0) : 0
      if (dur <= 0) return
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      call('seek', [ratio * dur])
    })
  }
  wireSeek(progress)
  wireSeek(p2Progress)

  // 展开面板关闭
  if (sheetBackdrop) sheetBackdrop.addEventListener('click', hideSheet)

  // 初始化兜底:切入插件页时宿主可能已在播放,主动拉一次状态
  const p0 = getPlayer()
  if (p0 && typeof p0.getState === 'function') {
    try {
      const ret = p0.getState()
      if (ret && typeof ret.then === 'function') ret.then(onState).catch(() => {})
    } catch (e) { /* 宿主未就绪,等推送即可 */ }
  }
}
