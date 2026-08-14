// player.js — 播放器:状态同步 / 控制 / 进度 / 队列 / 音量 / 播放模式

import { fmtTime, snackbar, platformName } from './util.js'
import { hasClientPlayer, fetchLyric } from './api.js'
import { setLyricFor } from './lyrics.js'

const MODES = ['order', 'loop', 'single', 'random', 'singlePlay']
const MODE_ICON = {
  order: 'format_list_numbered',
  loop: 'repeat',
  single: 'repeat_one',
  random: 'shuffle',
  singlePlay: 'replay',
}
const MODE_NAME = {
  order: '顺序播放',
  loop: '列表循环',
  single: '单曲循环',
  random: '随机播放',
  singlePlay: '单曲播放',
}

const state = {
  queue: [],
  current_index: -1,
  current_song: null,
  is_playing: false,
  current_time: 0,
  duration: 0,
  volume: 70,
  play_mode: 'order',
}

let player = null
let tickTimer = null
let dragging = false
let dragPreviewSec = -1
let unsub = null

function el(id) { return document.getElementById(id) }

function init() {
  if (!hasClientPlayer()) return
  player = window.SongloftPlugin.player

  el('playBtn').addEventListener('click', () => player.togglePlay())
  el('prevBtn').addEventListener('click', () => player.prev())
  el('nextBtn').addEventListener('click', () => player.next())
  el('modeBtn').addEventListener('click', () => {
    const idx = MODES.indexOf(state.play_mode)
    const next = MODES[(idx + 1) % MODES.length]
    player.setPlayMode(next).then(() => snackbar('播放模式: ' + MODE_NAME[next]))
  })

  // 进度条拖动
  const track = el('progressTrack')
  const posFromEvent = (e) => {
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    return ratio * (state.duration || 0)
  }
  track.addEventListener('pointerdown', (e) => {
    dragging = true
    track.classList.add('dragging')
    track.setPointerCapture(e.pointerId)
    dragPreviewSec = posFromEvent(e)
    renderProgress()
  })
  track.addEventListener('pointermove', (e) => {
    if (!dragging) return
    dragPreviewSec = posFromEvent(e)
    renderProgress()
  })
  const endDrag = () => {
    if (!dragging) return
    dragging = false
    track.classList.remove('dragging')
    if (dragPreviewSec >= 0 && player) player.seek(dragPreviewSec)
    dragPreviewSec = -1
  }
  track.addEventListener('pointerup', endDrag)
  track.addEventListener('pointercancel', endDrag)

  // 音量
  const slider = el('volumeSlider')
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10)
    state.volume = v
    player.setVolume(v)
  })

  // 状态订阅(节流,current_time 可能不实时,用本地 tick 平滑推进)
  unsub = player.onStateChange((s) => {
    Object.assign(state, s)
    render()
  })

  player.getState().then((s) => {
    if (!s) return
    Object.assign(state, s)
    render()
  })

  tickTimer = setInterval(() => {
    if (!dragging && state.is_playing && state.duration > 0 && player) {
      state.current_time = Math.min(state.current_time + 0.5, state.duration)
      renderProgress()
      updateLyricScroll()
    }
  }, 500)
}

function render() {
  const song = state.current_song
  const cover = el('cover')
  const coverPh = el('coverPh')

  el('songTitle').textContent = song ? song.title : '未在播放'
  el('songArtist').textContent = song
    ? [song.artist, song.album].filter(Boolean).join(' · ')
    : '搜索歌曲开始播放'

  if (song && song.cover_url) {
    cover.src = song.cover_url
    cover.style.display = 'block'
    coverPh.style.display = 'none'
    el('bgBlur').style.backgroundImage = `url("${song.cover_url}")`
  } else {
    cover.style.display = 'none'
    coverPh.style.display = 'flex'
    el('bgBlur').style.backgroundImage = ''
  }

  const pt = el('platformTag')
  if (song && song.source_data) {
    try {
      const sd = typeof song.source_data === 'string' ? JSON.parse(song.source_data) : song.source_data
      pt.textContent = platformName(sd.platform)
      pt.style.display = 'inline-block'
    } catch { pt.style.display = 'none' }
  } else {
    pt.style.display = 'none'
  }
  el('radioTag').style.display = song && song.type === 'radio' ? 'inline-block' : 'none'

  // 播放/暂停
  el('playBtn').querySelector('.material-symbols-outlined').textContent = state.is_playing ? 'pause' : 'play_arrow'

  // 播放模式
  const mi = el('modeBtn').querySelector('.material-symbols-outlined')
  mi.textContent = MODE_ICON[state.play_mode] || 'repeat'
  el('modeBtn').title = '播放模式: ' + (MODE_NAME[state.play_mode] || state.play_mode)

  // 音量图标
  const vi = el('volumeBtn').querySelector('.material-symbols-outlined')
  vi.textContent = state.volume <= 0 ? 'volume_off' : state.volume < 50 ? 'volume_down' : 'volume_up'
  el('volumeSlider').value = state.volume

  renderProgress()
  renderQueue()
  if (song && song.lyric_url) setLyricFor(song.id, song.lyric_url)
}

function renderProgress() {
  const t = dragging && dragPreviewSec >= 0 ? dragPreviewSec : state.current_time
  const dur = state.duration || 0
  el('curTime').textContent = fmtTime(t)
  el('totalTime').textContent = dur > 0 ? fmtTime(dur) : '--:--'
  const pct = dur > 0 ? (t / dur) * 100 : 0
  el('progressFill').style.width = pct + '%'
  el('progressThumb').style.left = pct + '%'
}

function renderQueue() {
  const list = el('queueList')
  if (!state.queue.length) {
    list.innerHTML = '<div class="empty-state">队列为空</div>'
    return
  }
  list.innerHTML = ''
  state.queue.forEach((song, idx) => {
    const row = document.createElement('div')
    row.className = 'queue-row' + (idx === state.current_index ? ' current' : '')
    row.innerHTML =
      '<span class="q-idx">' + (idx + 1) + '</span>' +
      '<div class="q-meta"><div class="q-title"></div><div class="q-sub"></div></div>' +
      '<span class="material-symbols-outlined q-del" style="font-size:18px">close</span>'
    row.querySelector('.q-title').textContent = song.title
    row.querySelector('.q-sub').textContent = [song.artist, song.album].filter(Boolean).join(' · ') || '—'
    row.querySelector('.q-del').addEventListener('click', (e) => {
      e.stopPropagation()
      player.removeFromQueue(idx).catch(() => {})
    })
    row.addEventListener('click', () => {
      if (idx === state.current_index) return
      player.play(song.id).catch((e) => snackbar('播放失败: ' + (e.message || e)))
    })
    list.appendChild(row)
  })
}

/** 播放一组歌(替换队列从第 0 首开始) */
export function playSongs(songs, startIndex = 0) {
  if (!player) return Promise.reject(new Error('宿主播放器不可用'))
  return player.setQueue(songs.map((s) => s.id), { startIndex })
}

/** 加入队列末尾 */
export function addToQueue(songs) {
  if (!player) return Promise.reject(new Error('宿主播放器不可用'))
  return player.addToQueue(songs.map((s) => s.id))
}

export function showPlayerView() {
  el('searchView').classList.add('hidden')
  el('playerView').classList.remove('hidden')
}

function updateLyricScroll() {
  // 歌词滚动由 lyrics.js 提供
}

export function getState() { return state }
export function isReady() { return !!player }

export function initPlayer() {
  if (!hasClientPlayer()) {
    // 宿主不可用(浏览器单独打开):控制区禁用并提示
    ;['playBtn', 'prevBtn', 'nextBtn', 'modeBtn', 'volumeBtn', 'queueBtn', 'lyricBtn'].forEach((id) => {
      const b = document.getElementById(id)
      if (b) b.style.opacity = '.35'
    })
    document.getElementById('songArtist').textContent = '提示:请在 Songloft 客户端内打开插件以获得完整播放器'
    return
  }
  init()
}
