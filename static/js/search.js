// search.js — 搜索视图(平台多选)

import { api, hasClientPlayer } from './api.js'
import { setStatus, snackbar, platformName } from './util.js'
import { playSongs, addToQueue, openPlayerScreen } from './player.js'
import { openPlaylistPicker } from './playlists.js'
import { hideBrowse } from './browse.js'

function el(id) { return document.getElementById(id) }

// 平台选项(与后端 src/main.ts 的 ALL_PLATFORMS 对应)
const PLATFORM_OPTIONS = [
  { code: 'wy', name: '网易云' },
  { code: 'tx', name: 'QQ' },
  { code: 'kg', name: '酷狗' },
]
const ALL_CODES = PLATFORM_OPTIONS.map((p) => p.code)
let selectedPlatforms = [...ALL_CODES]

// 渲染平台 chips(多选)
function renderPlatforms() {
  const bar = el('platformBar')
  if (!bar) return
  bar.innerHTML = ''
  PLATFORM_OPTIONS.forEach((p) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip' + (selectedPlatforms.includes(p.code) ? ' on' : '')
    b.title = '搜索' + p.name
    b.innerHTML = '<span class="material-symbols-outlined">check</span>' + p.name
    b.addEventListener('click', () => {
      const on = selectedPlatforms.includes(p.code)
      if (on && selectedPlatforms.length === 1) {
        snackbar('至少保留一个搜索平台')
        return
      }
      selectedPlatforms = on
        ? selectedPlatforms.filter((c) => c !== p.code)
        : [...selectedPlatforms, p.code]
      renderPlatforms()
      persistPlatforms()
    })
    bar.appendChild(b)
  })
}

// 平台选择持久化到插件设置(后端 /api/settings)
function persistPlatforms() {
  api('api/settings', { method: 'POST', body: JSON.stringify({ platforms: selectedPlatforms }) })
    .catch(() => {})
}

// 加载已保存的平台选择
function loadPlatforms() {
  api('api/settings')
    .then((data) => {
      if (data && Array.isArray(data.platforms) && data.platforms.length) {
        const clean = data.platforms.filter((c) => ALL_CODES.includes(c))
        if (clean.length) {
          selectedPlatforms = clean
          renderPlatforms()
        }
      }
    })
    .catch(() => {})
}

function platformNames() {
  return selectedPlatforms
    .map((c) => (PLATFORM_OPTIONS.find((p) => p.code === c) || {}).name || c)
    .join(' / ')
}

// 搜索入口定义为模块顶层全局:即使 initSearch 未执行,按钮/回车也能触发
window.searchGo = function () {
  const kw = el('searchInput').value.trim()
  const st = el('searchStatus')
  const btn = el('searchGoBtn')
  if (!kw) {
    setStatus(st, '请输入关键词', 'err')
    el('searchInput').focus()
    return
  }
  if (!selectedPlatforms.length) {
    setStatus(st, '请至少选择一个搜索平台', 'err')
    return
  }
  btn.disabled = true
  setStatus(st, '搜索中(' + platformNames() + ')…')
  hideBrowse()
  api('api/search/select', { method: 'POST', body: JSON.stringify({ keyword: kw, platforms: selectedPlatforms }) })
    .then((data) => {
      btn.disabled = false
      const results = (data && data.results) || []
      if (!results.length) {
        setStatus(st, '未找到结果(检查 API Key 是否有效)', 'err')
        renderResults([])
        return
      }
      setStatus(st, '找到 ' + results.length + ' 首,点击播放或加入队列', 'ok')
      renderResults(results)
    })
    .catch((e) => {
      btn.disabled = false
      setStatus(st, '搜索失败:' + (e.message || e), 'err')
    })
}

export function initSearch() {
  // 平台 chips:渲染 + 加载已保存选择
  renderPlatforms()
  loadPlatforms()
  // searchGoBtn 用 onclick 属性直连 window.searchGo(双保险),此处不重复绑定
}

function renderResults(results) {
  const box = el('results')
  box.innerHTML = ''
  if (!results.length) {
    box.innerHTML = '<div class="empty-state">未找到结果</div>'
    return
  }
  results.forEach((item) => {
    const platform = item.source_data ? item.source_data.platform : ''
    const row = document.createElement('div')
    row.className = 'song-row'

    // 封面(JS 构建,加载失败自动换占位,避免内联 onerror 隐患)
    if (item.cover_url) {
      const img = document.createElement('img')
      img.className = 'song-cover'
      img.referrerPolicy = 'no-referrer'
      img.alt = ''
      img.src = item.cover_url
      img.addEventListener('error', () => {
        const ph = document.createElement('span')
        ph.className = 'song-cover-ph'
        ph.innerHTML = '<span class="material-symbols-outlined">music_note</span>'
        img.replaceWith(ph)
      })
      row.appendChild(img)
    } else {
      const ph = document.createElement('span')
      ph.className = 'song-cover-ph'
      ph.innerHTML = '<span class="material-symbols-outlined">music_note</span>'
      row.appendChild(ph)
    }

    const meta = document.createElement('div')
    meta.className = 'song-meta'
    meta.innerHTML = '<div class="song-title2"></div><div class="song-sub2"></div>'
    meta.querySelector('.song-title2').textContent = item.title
    meta.querySelector('.song-sub2').textContent = platformName(platform) + ' · ' + [item.artist, item.album].filter(Boolean).join(' · ')
    row.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'song-actions'
    actions.style.cssText = 'display:flex;gap:2px'
    const mkBtn = (icon, title) => {
      const b = document.createElement('button')
      b.className = 'btn-icon'
      b.title = title
      b.innerHTML = '<span class="material-symbols-outlined">' + icon + '</span>'
      actions.appendChild(b)
      return b
    }
    mkBtn('play_arrow', '播放').addEventListener('click', () => handle(item, 'play'))
    mkBtn('playlist_add', '加入队列').addEventListener('click', () => handle(item, 'queue'))
    mkBtn('favorite_border', '收藏到歌单').addEventListener('click', () => handle(item, 'fav'))
    mkBtn('library_add', '导入曲库').addEventListener('click', () => handle(item, 'import'))
    row.appendChild(actions)
    box.appendChild(row)
  })
}

/** 先导入曲库拿到 song id,再按动作处理 */
function handle(item, action) {
  const st = el('searchStatus')
  setStatus(st, '处理中…')
  api('api/import', { method: 'POST', body: JSON.stringify({ song: item }) })
    .then(async (data) => {
      if (!data || !data.ok || !data.id) {
        setStatus(st, '导入失败:' + JSON.stringify(data), 'err')
        return
      }
      const song = { id: data.id, title: data.title || item.title, artist: item.artist, album: item.album, cover_url: item.cover_url }
      if (action === 'play') {
        try {
          await playSongs([song])
          setStatus(st, '正在播放:' + song.title, 'ok')
        } catch (e) {
          setStatus(st, '已导入曲库,宿主播放器不可用:' + (e.message || e), 'err')
        }
      } else if (action === 'queue') {
        try {
          await addToQueue([song])
          setStatus(st, '已加入播放队列:' + song.title, 'ok')
          snackbar('已加入队列')
        } catch (e) {
          setStatus(st, '已导入曲库,宿主播放器不可用:' + (e.message || e), 'err')
        }
      } else if (action === 'fav') {
        openPlaylistPicker(song)
        setStatus(st, '选择要收藏到的歌单', 'ok')
      } else {
        setStatus(st, '已导入曲库:' + song.title, 'ok')
        snackbar('已导入曲库')
      }
    })
    .catch((e) => setStatus(st, '导入失败:' + (e.message || e), 'err'))
}
