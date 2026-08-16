// lyric.js — 歌词搜索 / 重新获取(K 多接口 + 优先级)
// 功能:
//   - 按关键词搜索歌词(跨所有已启用的歌词接口)
//   - 为某首歌按指定接口重新获取歌词
//   - 为「当前播放歌曲」按指定接口重新获取歌词(尽力从宿主播放器读取当前歌曲)
// 歌词数据流:前端调用插件后端 /api/lyric/search 与 /api/lyric/fetch,由后端代理各公开接口。

import { api } from './api.js'
import { snackbar, parseLrc } from './util.js'

// 歌词接口(与后端 src/main.ts 的 ALL_LYRIC_SOURCES 对应)
export const LYRIC_SOURCES = [
  { code: 'lrclib', name: 'LRCLIB' },
  { code: 'wy', name: '网易云' },
  { code: 'tx', name: 'QQ音乐' },
  { code: 'kg', name: '酷狗' },
]

function el(id) { return document.getElementById(id) }

let currentSong = null // { title, artist, album?, duration?, source_data? }

// ===== 底部面板开关 =====
function openSheet() {
  el('lyricBackdrop').style.display = 'block'
  const sh = el('lyricSheet')
  requestAnimationFrame(() => sh.classList.add('show'))
  setTimeout(() => sh.classList.add('show'), 60)
}

function closeSheet() {
  el('lyricBackdrop').style.display = 'none'
  el('lyricSheet').classList.remove('show')
}

// ===== 渲染歌词展示 =====
function renderLyricView(result) {
  const box = el('lyricContent')
  if (!result) {
    box.innerHTML = '<div class="empty-state">未找到歌词</div>'
    return
  }
  const srcName = (LYRIC_SOURCES.find((s) => s.code === result.source) || {}).name || result.source || ''
  box.innerHTML = ''
  // 元信息
  const meta = document.createElement('div')
  meta.className = 'lyric-meta'
  meta.textContent = (srcName ? srcName + ' · ' : '') + [result.title, result.artist, result.album].filter(Boolean).join(' · ')
  box.appendChild(meta)

  const pre = document.createElement('pre')
  pre.className = 'lyric-pre'
  pre.textContent = result.lyric || ''
  box.appendChild(pre)
}

// ===== 加载歌词接口优先级(后端设置) =====
async function loadSourceOptions() {
  const sel = el('lyricSource')
  if (!sel) return
  sel.innerHTML = ''
  try {
    const data = await api('api/settings')
    const order = (data && data.lyric_sources) || LYRIC_SOURCES.map((s) => s.code)
    const ordered = order.map((c) => LYRIC_SOURCES.find((s) => s.code === c)).filter(Boolean)
    // 补充可能有但未启用的接口
    LYRIC_SOURCES.forEach((s) => { if (!ordered.some((o) => o.code === s.code)) ordered.push(s) })
    ordered.forEach((s) => {
      const opt = document.createElement('option')
      opt.value = s.code
      opt.textContent = s.name
      sel.appendChild(opt)
    })
    sel.value = (order[0] && LYRIC_SOURCES.some((s) => s.code === order[0])) ? order[0] : 'lrclib'
  } catch (e) {
    // 失败时用默认
    LYRIC_SOURCES.forEach((s) => {
      const opt = document.createElement('option')
      opt.value = s.code
      opt.textContent = s.name
      sel.appendChild(opt)
    })
    sel.value = 'lrclib'
  }
}

// ===== 搜索歌词(关键词) =====
export function openLyricSearch() {
  currentSong = null
  el('lyricSearchInput').value = ''
  el('lyricStatus').textContent = '输入歌名或「歌手 歌名」搜索歌词'
  el('lyricContent').innerHTML = ''
  el('lyricSearchBar').style.display = ''
  el('lyricResultBar').style.display = 'none'
  loadSourceOptions()
  openSheet()
}

// ===== 为指定歌曲打开歌词面板(默认按优先级,可换接口重新获取) =====
export function openLyricForSong(song) {
  if (!song) return
  currentSong = {
    title: song.title || '',
    artist: song.artist || '',
    album: song.album || '',
    duration: song.duration || 0,
    source_data: song.source_data || undefined,
  }
  el('lyricSearchInput').value = [currentSong.title, currentSong.artist].filter(Boolean).join(' ')
  // 搜索歌词输入框不再展示,直接显示「重新获取」操作区
  el('lyricSearchBar').style.display = 'none'
  el('lyricResultBar').style.display = ''
  el('lyricStatus').textContent = ''
  el('lyricContent').innerHTML = '<div class="empty-state">加载中…</div>'
  loadSourceOptions().then(() => {
    fetchForCurrentSong('')
  })
  openSheet()
}

// ===== 为「当前播放歌曲」打开歌词面板(尽力从宿主播放器读取) =====
export async function openLyricForCurrent() {
  const song = await readCurrentSong()
  if (!song || !song.title) {
    // 读不到当前歌曲就退化为关键词搜索
    openLyricSearch()
    return
  }
  openLyricForSong(song)
}

/** 尝试从宿主播放器读取当前歌曲(优先 getState,再回退常见字段/方法) */
async function readCurrentSong() {
  try {
    const p = window.SongloftPlugin && window.SongloftPlugin.player
    if (!p) return null

    // 宿主播放器标准接口:getState() 返回 { currentSong / current_song / queue ... }
    if (typeof p.getState === 'function') {
      try {
        const state = await p.getState()
        const raw = (state && (state.currentSong || state.current_song || state.current)) || null
        if (raw && (raw.title || raw.name)) {
          return {
            title: raw.title || raw.name || '',
            artist: raw.artist || raw.artists || raw.singer || '',
            album: raw.album || '',
            duration: raw.duration || 0,
            source_data: raw.source_data || raw.sourceData || undefined,
          }
        }
      } catch (e) { /* 继续尝试其他方式 */ }
    }

    const raw =
      (typeof p.getCurrentSong === 'function' ? p.getCurrentSong() : null) ||
      (typeof p.getCurrent === 'function' ? p.getCurrent() : null) ||
      (typeof p.currentSong === 'function' ? p.currentSong() : null) ||
      p.currentSong ||
      p.current ||
      null
    if (!raw) return null
    return {
      title: raw.title || raw.name || '',
      artist: raw.artist || raw.artists || raw.singer || '',
      album: raw.album || '',
      duration: raw.duration || 0,
      source_data: raw.source_data || raw.sourceData || undefined,
    }
  } catch (e) {
    return null
  }
}

// ===== 输入框搜索 =====
function doSearchInput() {
  const kw = el('lyricSearchInput').value.trim()
  if (!kw) {
    el('lyricStatus').textContent = '请输入歌名或歌手'
    return
  }
  doKeywordSearch(kw)
}

function doKeywordSearch(kw) {
  const st = el('lyricStatus')
  const box = el('lyricContent')
  st.textContent = '搜索中…'
  box.innerHTML = '<div class="empty-state">加载中…</div>'
  el('lyricResultBar').style.display = 'none'
  api('api/lyric/search', { method: 'POST', body: JSON.stringify({ keyword: kw }) })
    .then((data) => {
      const results = (data && data.results) || []
      if (!results.length) {
        st.textContent = '未找到歌词'
        box.innerHTML = '<div class="empty-state">未找到歌词</div>'
        return
      }
      st.textContent = '找到 ' + results.length + ' 个结果'
      renderSearchResults(results)
    })
    .catch((e) => {
      st.textContent = '搜索失败:' + (e.message || e)
      box.innerHTML = '<div class="empty-state">搜索失败</div>'
    })
}

function renderSearchResults(results) {
  const box = el('lyricContent')
  box.innerHTML = ''
  el('lyricResultBar').style.display = ''
  results.forEach((r) => {
    const row = document.createElement('div')
    row.className = 'lyric-result-row'
    const name = (LYRIC_SOURCES.find((s) => s.code === r.source) || {}).name || r.source
    row.innerHTML = '<div class="lyric-result-meta"><div class="lyric-result-title"></div><div class="lyric-result-sub"></div></div>' +
      '<button type="button" class="btn-text">查看歌词</button>'
    row.querySelector('.lyric-result-title').textContent = [r.title || '未知', name].filter(Boolean).join(' · ')
    row.querySelector('.lyric-result-sub').textContent = (r.artist || '') + (r.album ? ' · ' + r.album : '')
    row.querySelector('button').addEventListener('click', () => {
      // 选中搜索结果后可继续用「用此接口获取」换接口重新获取
      currentSong = {
        title: r.title || '',
        artist: r.artist || '',
        album: r.album || '',
      }
      renderLyricView(r)
      el('lyricStatus').textContent = '来自 ' + name + '，可切换接口重新获取'
    })
    box.appendChild(row)
  })
}

// ===== 为当前歌曲(或面板内输入)按指定接口重新获取 =====
function fetchForCurrentSong(source) {
  const st = el('lyricStatus')
  const box = el('lyricContent')
  const src = source || el('lyricSource').value || ''
  if (!currentSong || !currentSong.title) {
    st.textContent = '请先选择歌曲'
    return
  }
  st.textContent = '正在通过 ' + srcName(src) + ' 获取…'
  box.innerHTML = '<div class="empty-state">加载中…</div>'
  api('api/lyric/fetch', {
    method: 'POST',
    body: JSON.stringify({
      song: {
        title: currentSong.title,
        artist: currentSong.artist || '',
        album: currentSong.album || '',
        duration: currentSong.duration || 0,
        source_data: currentSong.source_data || undefined,
      },
      source: src || undefined,
    }),
  })
    .then((data) => {
      if (!data || !data.ok || !data.lyric) {
        st.textContent = '未获取到歌词:' + ((data && data.error) || '')
        box.innerHTML = '<div class="empty-state">未获取到歌词</div>'
        return
      }
      currentSong.title = data.title || currentSong.title
      currentSong.artist = data.artist || currentSong.artist
      currentSong.album = data.album || currentSong.album
      st.textContent = '已通过 ' + srcName(data.source || src) + ' 获取歌词(' + parseLrc(data.lyric).length + ' 行)'
      renderLyricView(data)
      snackbar('已获取歌词')
    })
    .catch((e) => {
      st.textContent = '获取失败:' + (e.message || e)
      box.innerHTML = '<div class="empty-state">获取失败</div>'
    })
}

function srcName(code) {
  return (LYRIC_SOURCES.find((s) => s.code === code) || {}).name || code
}

// ===== 初始化 =====
export function initLyric() {
  const backdrop = el('lyricBackdrop')
  const closeBtn = el('lyricCloseBtn')
  const searchBar = el('lyricSearchBar')
  if (backdrop) backdrop.addEventListener('click', closeSheet)
  if (closeBtn) closeBtn.addEventListener('click', closeSheet)

  const searchBtn = el('lyricSearchBtn')
  if (searchBtn) searchBtn.addEventListener('click', doSearchInput)
  const searchInput = el('lyricSearchInput')
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearchInput() })
  }

  const refetchBtn = el('lyricRefetchBtn')
  if (refetchBtn) refetchBtn.addEventListener('click', () => fetchForCurrentSong(el('lyricSource').value))

  // 顶部「搜索歌词」按钮(搜索栏)
  const searchLyricBtn = el('searchLyricBtn')
  if (searchLyricBtn) searchLyricBtn.addEventListener('click', openLyricSearch)

  // 顶部「当前播放歌词」按钮(搜索栏)
  const currentLyricBtn = el('currentLyricBtn')
  if (currentLyricBtn) currentLyricBtn.addEventListener('click', openLyricForCurrent)
}
