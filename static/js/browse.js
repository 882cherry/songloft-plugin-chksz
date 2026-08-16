// browse.js — 首页内容浏览(平台标签 + 猜你喜欢/推荐歌单/排行榜)

import { api } from './api.js'
import { snackbar, platformName, fmtTime } from './util.js'
import { playSongs } from './player.js'
import { openPlaylistPicker } from './playlists.js'
import { openImportPlaylist } from './importPlaylist.js'

const TABS = [
  { code: 'wy', name: '网易云' },
  { code: 'tx', name: 'QQ' },
  { code: 'kg', name: '酷狗' },
]
const cache = {} // platform -> modules data(内存缓存,切换标签不重复请求)

function el(id) { return document.getElementById(id) }

let currentTab = 'wy'

export function initBrowse() {
  renderTabs()
  loadModules(currentTab)
}

function renderTabs() {
  const bar = el('browseTabs')
  if (!bar) return
  bar.innerHTML = ''
  TABS.forEach((t) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'browse-tab' + (t.code === currentTab ? ' on' : '')
    b.textContent = t.name
    b.addEventListener('click', () => {
      if (currentTab === t.code) return
      currentTab = t.code
      renderTabs()
      loadModules(currentTab)
    })
    bar.appendChild(b)
  })
}

/** 回到浏览首页(清空搜索结果,隐藏结果容器) */
function showHome() {
  el('results').innerHTML = ''
  el('searchStatus').textContent = ''
  el('searchInput').value = ''
  const c = el('searchContainer')
  if (c) c.style.display = 'none'
  el('browse').style.display = ''
  loadModules(currentTab)
}

/** 搜索结果出现时隐藏浏览区(供 search.js 调用) */
export function hideBrowse() {
  el('browse').style.display = 'none'
}

/** 网易云登录状态变化后刷新首页(个人歌单需要登录 Cookie) */
export function refreshWyAfterLogin() {
  delete cache['wy']
  if (currentTab === 'wy') loadModules('wy')
}

function loadModules(platform) {
  const box = el('browse')
  box.style.display = ''
  if (cache[platform]) {
    renderModules(cache[platform])
    return
  }
  box.innerHTML = '<div class="browse-loading">加载中…</div>'
  api('api/browse?platform=' + platform)
    .then((data) => {
      if (!data || data.error) throw new Error((data && data.error) || '加载失败')
      cache[platform] = data
      renderModules(data)
    })
    .catch((e) => {
      box.innerHTML = '<div class="browse-error">加载失败:' + (e.message || e) + '</div>'
    })
}

function renderModules(data) {
  const box = el('browse')
  box.innerHTML = ''
  const modules = (data && data.modules) || []
  if (!modules.length) {
    box.innerHTML = '<div class="browse-loading">暂无内容</div>'
    return
  }
  modules.forEach((m) => {
    const sec = document.createElement('div')
    sec.className = 'browse-module'
    const title = document.createElement('div')
    title.className = 'browse-module-title'
    title.innerHTML = '<span class="material-symbols-outlined">' + (m.type === 'playlists' ? 'queue_music' : 'leaderboard') + '</span>' + (m.title || '')
    sec.appendChild(title)
    if (m.type === 'playlists') {
      const grid = document.createElement('div')
      grid.className = 'browse-cards'
      ;(m.items || []).forEach((it) => {
        const card = document.createElement('div')
        card.className = 'browse-card'
        card.innerHTML =
          (it.cover ? '<img class="bc-cover" loading="lazy" referrerpolicy="no-referrer" src="' + it.cover + '">' : '<div class="bc-cover"></div>') +
          '<div class="bc-name"></div>' +
          '<div class="bc-meta"></div>'
        card.querySelector('.bc-name').textContent = it.name
        card.querySelector('.bc-meta').textContent = fmtCount(it.play_count) + ' 播放 · ' + (it.track_count || '?') + ' 首'
        card.addEventListener('click', () => loadPlaylist(currentTab, it))
        grid.appendChild(card)
      })
      sec.appendChild(grid)
    } else {
      const list = document.createElement('div')
      list.className = 'browse-rank'
      ;(m.items || []).forEach((it, i) => {
        const row = document.createElement('div')
        row.className = 'browse-rank-row'
        row.innerHTML =
          '<div class="browse-rank-idx' + (i < 3 ? ' top' : '') + '">' + (i + 1) + '</div>' +
          (it.cover ? '<img class="browse-rank-cover" loading="lazy" referrerpolicy="no-referrer" src="' + it.cover + '">' : '<div class="browse-rank-cover"></div>') +
          '<div class="browse-rank-meta"><div class="browse-rank-name"></div><div class="browse-rank-sub"></div></div>'
        row.querySelector('.browse-rank-name').textContent = it.name
        row.querySelector('.browse-rank-sub').textContent = it.desc || ''
        row.addEventListener('click', () => loadPlaylist(currentTab, it))
        list.appendChild(row)
      })
      sec.appendChild(list)
    }
    box.appendChild(sec)
  })
}

function fmtCount(n) {
  n = Number(n) || 0
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return String(n)
}

// ===== 歌单/榜单详情 =====
function loadPlaylist(platform, item) {
  const box = el('browse')
  box.innerHTML = '<div class="browse-loading">加载中…</div>'
  api('api/browse/playlist?platform=' + platform + '&id=' + encodeURIComponent(item.id))
    .then((data) => {
      if (!data || data.error) throw new Error((data && data.error) || '加载失败')
      renderPlaylist(data, item)
    })
    .catch((e) => {
      box.innerHTML = '<div class="browse-error">加载失败:' + (e.message || e) + '</div>'
    })
}

function renderPlaylist(data, item) {
  const box = el('browse')
  box.innerHTML = ''
  const back = document.createElement('div')
  back.className = 'browse-detail-back'
  back.innerHTML = '<span class="material-symbols-outlined">arrow_back</span> 返回'
  back.addEventListener('click', () => {
    renderModules(cache[currentTab])
  })
  box.appendChild(back)

  const head = document.createElement('div')
  head.className = 'browse-detail-head'
  head.innerHTML =
    (data.cover ? '<img class="browse-detail-cover" referrerpolicy="no-referrer" src="' + data.cover + '">' : '<div class="browse-detail-cover"></div>') +
    '<div><div class="browse-detail-title"></div><div class="browse-detail-sub"></div></div>'
  head.querySelector('.browse-detail-title').textContent = data.title || item.name
  head.querySelector('.browse-detail-sub').textContent = (data.songs || []).length + ' 首'
  box.appendChild(head)
  // 歌单操作:主操作「导入为 Songloft 歌单」,次操作「仅导入曲库」
  const allSongs = data.songs || []
  if (allSongs.length) {
    const bar = document.createElement('div')
    bar.className = 'batch-bar'
    bar.innerHTML =
      '<div class="batch-actions">' +
      '<button type="button" class="btn-filled" id="importPlaylistBtn"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px">playlist_add</span> 导入为 Songloft 歌单</button>' +
      '<button type="button" class="btn-outlined" id="batchImportBtn">仅导入曲库(' + allSongs.length + ')</button>' +
      '</div>'
    box.appendChild(bar)
    bar.querySelector('#importPlaylistBtn').addEventListener('click', () => {
      openImportPlaylist({
        platform: currentTab,
        id: item.id,
        title: data.title || item.name,
        cover: data.cover,
        songCount: allSongs.length,
      })
    })
    bar.querySelector('#batchImportBtn').addEventListener('click', () => {
      const btn = bar.querySelector('#batchImportBtn')
      btn.disabled = true
      let done = 0, failed = 0
      const chain = allSongs.reduce((p, s) => p.then(() =>
        api('api/import', { method: 'POST', body: JSON.stringify({ song: s }) })
          .then(() => done++)
          .catch(() => failed++)
      ), Promise.resolve())
      chain.then(() => {
        btn.disabled = false
        if (failed) snackbar('导入完成:' + done + ' 成功,' + failed + ' 失败')
        else snackbar('已全部导入曲库(' + done + ' 首)')
      })
    })
  }

  ;(data.songs || []).forEach((s) => {
    const row = document.createElement('div')
    row.className = 'song-row'
    if (s.cover_url) {
      const img = document.createElement('img')
      img.className = 'song-cover'
      img.referrerPolicy = 'no-referrer'
      img.src = s.cover_url
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
    meta.querySelector('.song-title2').textContent = s.title
    meta.querySelector('.song-sub2').textContent = platformName(s.source_data.platform) + ' · ' +
      [s.artist, s.album].filter(Boolean).join(' · ') +
      (s.duration ? ' · ' + fmtTime(s.duration) : '')
    row.appendChild(meta)
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:2px'
    const mkBtn = (icon, title) => {
      const b = document.createElement('button')
      b.className = 'btn-icon'
      b.title = title
      b.innerHTML = '<span class="material-symbols-outlined">' + icon + '</span>'
      actions.appendChild(b)
      return b
    }
    mkBtn('play_arrow', '播放').addEventListener('click', () => playBrowseSong(s))
    mkBtn('favorite_border', '收藏到歌单').addEventListener('click', () => importThen(s, 'fav'))
    row.appendChild(actions)
    box.appendChild(row)
  })
}

function importThen(s, action) {
  api('api/import', { method: 'POST', body: JSON.stringify({ song: s }) })
    .then((data) => {
      if (!data || !data.ok || !data.id) {
        snackbar('导入失败:' + JSON.stringify(data))
        return
      }
      if (action === 'fav') {
        openPlaylistPicker({ id: data.id, title: data.title || s.title, artist: s.artist, album: s.album, cover_url: s.cover_url })
      }
    })
    .catch((e) => snackbar('导入失败:' + (e.message || e)))
}

function playBrowseSong(s) {
  api('api/import', { method: 'POST', body: JSON.stringify({ song: s }) })
    .then((data) => {
      if (!data || !data.ok || !data.id) {
        snackbar('导入失败:' + JSON.stringify(data))
        return
      }
      return playSongs([{ id: data.id, title: data.title || s.title }])
        .then(() => snackbar('已开始播放: ' + (data.title || s.title)))
        .catch((e) => snackbar('播放失败:' + (e.message || e)))
    })
    .catch((e) => snackbar('导入失败:' + (e.message || e)))
}
