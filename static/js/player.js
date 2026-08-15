// player.js — 播放控制(网易云风格):
//   搜索页 + 底部迷你播放条 + 全屏播放界面(覆盖层,可折叠收起)
//   播放界面/歌词界面点击切换;支持收藏到歌单
// 播放器宿主: SongloftPlugin.player(Web UI / 客户端异步注入,需轮询等待)

import { fmtTime, snackbar, platformName, bindSheet } from './util.js'
import { hasClientPlayer } from './api.js'
import { setLyricFor } from './lyrics.js'
import { openPlaylistPicker } from './playlists.js'

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
let lastSongKey = ''

const LS_KEY = 'chksz_player_state_v1'

function el(id) { return document.getElementById(id) }

// ===== 宿主播放器获取(Web UI 的 SongloftPlugin 在页面加载后才注入,需轮询) =====
function getPlayer() {
  if (player) return player
  if (window.SongloftPlugin && window.SongloftPlugin.player) {
    player = window.SongloftPlugin.player
    bindPlayerEvents()
  }
  return player
}

function hasPlayer() { return !!getPlayer() }

// ===== 状态订阅与同步 =====
let autoOpened = false // 仅首次自动展开播放界面
let pendingPlay = false // setQueue 后等待真实播放的窗口期
let pendingStart = 0 // pendingPlay 开始时刻

function bindPlayerEvents() {
  if (unsub) return
  if (player && typeof player.onStateChange === 'function') {
    unsub = player.onStateChange((s) => {
      try {
        applyHostState(s)
      } catch (e) {
        console.error('[chksz] state render failed:', e)
      }
    })
  }
  if (player && typeof player.getState === 'function') {
    player.getState().then((s) => {
      if (!s) return
      applyHostState(s)
      // 需求:进入页面时若已有播放列表(当前歌曲),直接显示播放界面(仅首次)
      if (state.current_song && !autoOpened) {
        autoOpened = true
        openPlayerScreen()
      }
    }).catch(() => {})
  }
}

// 采纳宿主状态:
// - pendingPlay 窗口期(setQueue 后、真正开始播放前):宿主可能残留上一首的
//   时长/进度(实测会返回旧歌 duration + 旧 current_time),只更新歌曲信息,
//   进度保持加载态(0:00 / --:--),等 is_playing 且 duration>0 再采纳完整状态
// - 切歌(歌曲 id 变化)且未播放时:同样只更新歌曲信息,避免短暂显示旧时长
// - 其余情况:按字段差异决定是否重渲染
function applyHostState(s) {
  if (!s) return
  if (pendingPlay) {
    // 等宿主音频流切换稳定(至少 2 秒)再采纳完整状态,避免采纳
    // setQueue 后旧流仍在播放的残留进度(current_time 是上一首的位置)
    if (s.is_playing && s.duration > 0 && Date.now() - pendingStart >= 2000) {
      pendingPlay = false
      Object.assign(state, s)
      render()
      persist()
      return
    }
    // 窗口期内只更新歌曲信息与真实时长,进度保持 0(加载态)
    if (s.current_song && (!state.current_song || state.current_song.id !== s.current_song.id)) {
      state.current_song = s.current_song
      state.queue = s.queue || state.queue
      state.current_index = s.current_index
      state.is_playing = false
      state.current_time = 0
      state.duration = s.duration || 0
      render()
      persist()
    }
    return
  }
  const songChanged = !!s.current_song && !!state.current_song && s.current_song.id !== state.current_song.id
  if (songChanged && !s.is_playing) {
    // 切歌未播放:更新歌曲信息,进度重置为加载态
    state.current_song = s.current_song
    state.queue = s.queue || state.queue
    state.current_index = s.current_index
    state.is_playing = false
    state.current_time = 0
    state.duration = 0
    render()
    persist()
    return
  }
  const changed =
    s.duration !== state.duration ||
    s.is_playing !== state.is_playing ||
    s.current_index !== state.current_index ||
    Math.abs((s.current_time || 0) - (state.current_time || 0)) > 1.5 ||
    !!s.current_song !== !!state.current_song ||
    songChanged
  if (changed) {
    Object.assign(state, s)
    render()
    persist()
  }
}

// 定时拉取宿主状态兜底(宿主 onStateChange 推送不可靠:setQueue 后/播放中
// 经常不推送,导致进度条/时长停留在旧值,必须主动轮询校正)
function syncState() {
  if (!player || typeof player.getState !== 'function') return
  player.getState().then((s) => applyHostState(s)).catch(() => {})
}

// ===== 本地兜底:宿主状态不可用(加载竞态)时用上次快照渲染 =====
function restoreSnapshot() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return
    const snap = JSON.parse(raw)
    if (snap && snap.current_song) {
      Object.assign(state, {
        queue: snap.queue || [],
        current_index: snap.current_index === undefined ? -1 : snap.current_index,
        current_song: snap.current_song,
        is_playing: false,
        current_time: snap.current_time || 0,
        duration: snap.duration || 0,
        volume: snap.volume || 70,
        play_mode: snap.play_mode || 'order',
      })
      render()
      // 有播放列表时直接进入播放界面(需求:有播放列表在播放则显示播放界面)
      autoOpened = true
      openPlayerScreen()
    }
  } catch (e) { /* ignore */ }
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      queue: state.queue,
      current_index: state.current_index,
      current_song: state.current_song,
      current_time: state.current_time,
      duration: state.duration,
      volume: state.volume,
      play_mode: state.play_mode,
    }))
  } catch (e) { /* ignore */ }
}

// ===== 视图切换 =====
export function openPlayerScreen() {
  el('playerScreen').style.display = 'flex'
  showPlayerPage()
}

export function closePlayerScreen() {
  el('playerScreen').style.display = 'none'
}

export function showPlayerPage() {
  el('playerPage').style.display = ''
  el('lyricPage').style.display = 'none'
  el('playerTopTitle').textContent = '正在播放'
}

export function showLyricPage() {
  el('playerPage').style.display = 'none'
  el('lyricPage').style.display = ''
  el('playerTopTitle').textContent = '歌词'
  // 进入歌词页时重新同步歌词
  const song = state.current_song
  if (song) setLyricFor(song.id, song.lyric_url)
}

// ===== 渲染 =====
function render() {
  try {
    _render()
  } catch (e) {
    console.error('[chksz] render failed:', e)
  }
}

function _render() {
  const song = state.current_song
  const hasSong = !!song

  // 迷你播放条
  const mini = el('miniPlayer')
  mini.style.display = hasSong ? 'flex' : 'none'
  if (hasSong) {
    el('miniTitle').textContent = song.title || '未知歌曲'
    el('miniSub').textContent = [song.artist, song.album].filter(Boolean).join(' · ')
    const mc = el('miniCover')
    const mph = el('miniCoverPh')
    if (song.cover_url) {
      mc.src = song.cover_url
      mc.style.display = 'block'
      mph.style.display = 'none'
    } else {
      mc.style.display = 'none'
      mph.style.display = 'inline-flex'
    }
    el('miniPlayBtn').querySelector('.material-symbols-outlined').textContent = state.is_playing ? 'pause' : 'play_arrow'
  }

  // 播放界面
  el('songTitle').textContent = hasSong ? (song.title || '未知歌曲') : '未在播放'
  el('songArtist').textContent = hasSong
    ? ([song.artist, song.album].filter(Boolean).join(' · ') || '—')
    : '点击搜索结果开始播放'

  const cover = el('cover')
  const coverPh = el('coverPh')
  if (hasSong && song.cover_url) {
    cover.src = song.cover_url
    cover.style.display = 'block'
    coverPh.style.display = 'none'
    el('bgBlur').style.backgroundImage = 'url("' + song.cover_url + '")'
  } else {
    cover.style.display = 'none'
    coverPh.style.display = 'flex'
    el('bgBlur').style.backgroundImage = ''
  }

  const pt = el('platformTag')
  if (hasSong && song.source_data) {
    try {
      const sd = typeof song.source_data === 'string' ? JSON.parse(song.source_data) : song.source_data
      pt.textContent = platformName(sd.platform)
      pt.style.display = 'inline-block'
    } catch { pt.style.display = 'none' }
  } else {
    pt.style.display = 'none'
  }

  el('playBtn').querySelector('.material-symbols-outlined').textContent = state.is_playing ? 'pause' : 'play_arrow'

  const mi = el('modeBtn').querySelector('.material-symbols-outlined')
  mi.textContent = MODE_ICON[state.play_mode] || 'repeat'
  el('modeBtn').title = '播放模式: ' + (MODE_NAME[state.play_mode] || state.play_mode)

  const vi = el('volumeBtn').querySelector('.material-symbols-outlined')
  vi.textContent = state.volume <= 0 ? 'volume_off' : state.volume < 50 ? 'volume_down' : 'volume_up'
  el('volumeSlider').value = state.volume

  renderProgress()
  renderQueue()

  // 切歌时重新拉歌词
  if (hasSong) {
    const key = song.id + '|' + (song.lyric_url || '')
    if (key !== lastSongKey) {
      lastSongKey = key
      setLyricFor(song.id, song.lyric_url)
    }
  } else {
    lastSongKey = ''
  }
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
      if (player && typeof player.removeFromQueue === 'function') {
        player.removeFromQueue(idx).catch(() => {})
      }
    })
    row.addEventListener('click', () => {
      if (idx === state.current_index) return
      if (player && typeof player.play === 'function') {
        player.play(song.id).catch((e) => snackbar('播放失败: ' + (e.message || e)))
      }
    })
    list.appendChild(row)
  })
}

// ===== 播放操作 =====
/** 播放一组歌(替换队列从第 0 首开始),并展开全屏播放界面 */
export function playSongs(songs, startIndex = 0) {
  if (!hasPlayer()) return Promise.reject(new Error('宿主播放器不可用'))
  // 进入加载窗口:清掉上一首残留进度,避免新歌进度条显示旧值
  pendingPlay = true
  pendingStart = Date.now()
  state.current_time = 0
  state.duration = 0
  state.is_playing = false
  render()
  return player.setQueue(songs.map((s) => s.id), { startIndex }).then(() => {
    openPlayerScreen()
    // setQueue 后宿主不一定推送状态,主动拉取校正
    syncState()
    // 兜底:6 秒后若仍未开始播放,退出加载窗口采纳当前状态
    setTimeout(() => {
      if (pendingPlay) {
        pendingPlay = false
        syncState()
      }
    }, 6000)
  })
}

/** 加入队列末尾 */
export function addToQueue(songs) {
  if (!hasPlayer()) return Promise.reject(new Error('宿主播放器不可用'))
  return player.addToQueue(songs.map((s) => s.id))
}

// ===== UI 绑定 =====
function bindUI() {
  // 迷你播放条
  const mini = el('miniPlayer')
  mini.addEventListener('click', (e) => {
    if (e.target.closest('button')) return
    openPlayerScreen()
  })
  el('miniPlayBtn').addEventListener('click', (e) => {
    e.stopPropagation()
    if (player) player.togglePlay().catch(() => {})
  })
  el('miniNextBtn').addEventListener('click', (e) => {
    e.stopPropagation()
    if (player) player.next().catch(() => {})
  })

  // 全屏播放界面:收起(折叠回搜索页)
  el('collapsePlayerBtn').addEventListener('click', closePlayerScreen)

  // 播放页 → 歌词页(点击封面/歌曲信息/歌词按钮)
  const toggleToLyric = () => { if (state.current_song) showLyricPage() }
  el('coverWrap').addEventListener('click', toggleToLyric)
  const songInfo = el('songTitle').parentElement
  if (songInfo) songInfo.addEventListener('click', toggleToLyric)
  el('lyricToggleBtn').addEventListener('click', toggleToLyric)

  // 歌词页 → 播放页(返回按钮 + 点击歌词空白处)
  el('lyricBackBtn').addEventListener('click', showPlayerPage)
  el('lyricPage').addEventListener('click', (e) => {
    if (e.target.closest('.lyric-line')) return
    showPlayerPage()
  })

  // 控制
  el('playBtn').addEventListener('click', () => { if (player) player.togglePlay().catch(() => {}) })
  el('prevBtn').addEventListener('click', () => { if (player) player.prev().catch(() => {}) })
  el('nextBtn').addEventListener('click', () => { if (player) player.next().catch(() => {}) })
  el('modeBtn').addEventListener('click', () => {
    if (!player) return
    const idx = MODES.indexOf(state.play_mode)
    const next = MODES[(idx + 1) % MODES.length]
    player.setPlayMode(next).then(() => snackbar('播放模式: ' + MODE_NAME[next])).catch(() => {})
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
    if (dragPreviewSec >= 0 && player && typeof player.seek === 'function') player.seek(dragPreviewSec).catch(() => {})
    dragPreviewSec = -1
  }
  track.addEventListener('pointerup', endDrag)
  track.addEventListener('pointercancel', endDrag)

  // 音量
  const slider = el('volumeSlider')
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10)
    state.volume = v
    if (player && typeof player.setVolume === 'function') player.setVolume(v).catch(() => {})
  })

  // 队列面板 / 音量面板
  bindSheet('queueBackdrop', 'queueSheet', el('queueBtn'), [])
  bindSheet('volumeBackdrop', 'volumeSheet', el('volumeBtn'), [])

  // 收藏到歌单
  el('favBtn').addEventListener('click', () => {
    const song = state.current_song
    if (!song) return snackbar('当前没有播放的歌曲')
    openPlaylistPicker({ id: song.id, title: song.title, artist: song.artist, album: song.album, cover_url: song.cover_url })
  })
}

// ===== 初始化 =====
export function initPlayer() {
  bindUI()

  // 进度平滑 tick(宿主 current_time 可能不实时)
  tickTimer = setInterval(() => {
    if (!dragging && state.is_playing && state.duration > 0) {
      state.current_time = Math.min(state.current_time + 0.5, state.duration)
      renderProgress()
    }
  }, 500)

  // 宿主状态兜底同步:每 2 秒校正进度/时长/切歌(宿主推送不可靠时的保险)
  setInterval(syncState, 2000)

  // 宿主播放器可能延迟注入:轮询等待
  let tries = 0
  const tryGet = () => {
    if (getPlayer()) {
      render()
      persist()
      return
    }
    tries++
    if (tries < 20) setTimeout(tryGet, 400)
    else restoreSnapshot()
  }
  tryGet()
}

export function getState() { return state }
export function isReady() { return !!player }
export { hasClientPlayer }
