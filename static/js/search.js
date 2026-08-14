// search.js — 搜索视图

import { api, hasClientPlayer } from './api.js'
import { setStatus, snackbar, platformName } from './util.js'
import { playSongs, addToQueue, showPlayerView } from './player.js'

function el(id) { return document.getElementById(id) }

export function initSearch() {
  el('searchBtn').addEventListener('click', () => {
    el('playerView').classList.add('hidden')
    el('searchView').classList.remove('hidden')
    el('searchInput').focus()
  })
  el('backToPlayerBtn').addEventListener('click', showPlayerView)
  el('searchGoBtn').addEventListener('click', searchGo)
}

window.searchGo = function () {
  const kw = el('searchInput').value.trim()
  const st = el('searchStatus')
  const btn = el('searchGoBtn')
  if (!kw) { setStatus(st, '请输入关键词', 'err'); return }
  btn.disabled = true
  setStatus(st, '搜索中…')
  api('api/search', { method: 'POST', body: JSON.stringify({ keyword: kw }) })
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

function renderResults(results) {
  const box = el('results')
  box.innerHTML = ''
  if (!results.length) {
    box.innerHTML = '<div class="empty-state">未找到结果</div>'
    return
  }
  const canPlay = hasClientPlayer()
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
    if (canPlay) {
      mkBtn('play_arrow', '播放').addEventListener('click', () => handle(item, 'play'))
      mkBtn('playlist_add', '加入队列').addEventListener('click', () => handle(item, 'queue'))
    }
    mkBtn('library_add', '导入曲库').addEventListener('click', () => handle(item, 'import'))
    row.appendChild(actions)
    box.appendChild(row)
  })
}

function handle(item, action) {
  const st = el('searchStatus')
  setStatus(st, '处理中…')
  api('api/import', { method: 'POST', body: JSON.stringify({ song: item }) })
    .then(async (data) => {
      if (!data || !data.ok || !data.id) {
        setStatus(st, '导入失败:' + JSON.stringify(data), 'err')
        return
      }
      if (action === 'play' && hasClientPlayer()) {
        await playSongs([{ id: data.id, title: data.title }])
        showPlayerView()
        setStatus(st, '已播放:' + data.title, 'ok')
      } else if (action === 'queue' && hasClientPlayer()) {
        await addToQueue([{ id: data.id, title: data.title }])
        setStatus(st, '已加入播放队列:' + data.title, 'ok')
        snackbar('已加入队列')
      } else {
        setStatus(st, '已导入曲库:' + data.title, 'ok')
        snackbar('已导入曲库')
      }
    })
    .catch((e) => setStatus(st, '导入失败:' + (e.message || e), 'err'))
}
