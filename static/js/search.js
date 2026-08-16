// search.js — 搜索视图(平台单选下拉:网易云 / QQ / 酷狗 / 聚合搜索)

import { api, hasClientPlayer } from './api.js'
import { setStatus, snackbar, platformName } from './util.js'
import { playSongs, addToQueue } from './player.js'
import { openPlaylistPicker } from './playlists.js'
import { openConfig } from './config.js'
import { hideBrowse } from './browse.js'
import { openLyricForSong } from './lyric.js'

function el(id) { return document.getElementById(id) }

// 平台选项(与后端 src/main.ts 的 ALL_PLATFORMS 对应)
const PLATFORM_OPTIONS = [
  { code: 'wy', name: '网易云音乐' },
  { code: 'tx', name: 'QQ音乐' },
  { code: 'kg', name: '酷狗音乐' },
]
const MODE_OPTIONS = [
  { code: 'wy', name: '网易云音乐', codes: ['wy'] },
  { code: 'tx', name: 'QQ音乐', codes: ['tx'] },
  { code: 'kg', name: '酷狗音乐', codes: ['kg'] },
  { code: 'all', name: '聚合搜索', codes: PLATFORM_OPTIONS.map((p) => p.code) },
]
const ALL_CODES = PLATFORM_OPTIONS.map((p) => p.code)
let searchMode = 'all'
let selectedPlatforms = [...ALL_CODES]

function modeInfo(code) {
  return MODE_OPTIONS.find((m) => m.code === code) || MODE_OPTIONS[MODE_OPTIONS.length - 1]
}

function applyMode(code) {
  const m = modeInfo(code)
  searchMode = m.code
  selectedPlatforms = [...m.codes]
}

// 渲染搜索平台单选下拉框(网易云 / QQ / 酷狗 / 聚合搜索)
function renderPlatformSelect() {
  const sel = el('platformSelect')
  if (!sel) return
  sel.value = searchMode
}

function bindPlatformSelect() {
  const sel = el('platformSelect')
  if (!sel) return
  sel.addEventListener('change', () => {
    const next = sel.value
    if (next !== 'wy' && next !== 'tx' && next !== 'kg' && next !== 'all') {
      renderPlatformSelect()
      return
    }
    applyMode(next)
    persistPlatforms()
  })
}

// 平台选择持久化到插件设置(后端 /api/settings)
function persistPlatforms() {
  api('api/settings', { method: 'POST', body: JSON.stringify({ platforms: selectedPlatforms }) })
    .catch(() => {})
}

// 加载已保存的平台选择(单平台映射为对应模式,多平台回退为聚合搜索)
function loadPlatforms() {
  api('api/settings')
    .then((data) => {
      if (data && Array.isArray(data.platforms) && data.platforms.length) {
        const clean = data.platforms.filter((c) => ALL_CODES.includes(c))
        if (clean.length) {
          applyMode(clean.length === 1 ? clean[0] : 'all')
          renderPlatformSelect()
        }
      }
    })
    .catch(() => {})
}

function platformNames() {
  return modeInfo(searchMode).name
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
  // API Key 检查:未配置则引导到配置弹窗
  api('api/settings')
    .then((data) => {
      if (!data || !data.api_key_set) {
        btn.disabled = false
        setStatus(st, '请先配置 API Key', 'err')
        snackbar('请先配置 API Key')
        openConfig()
        return
      }
      doSearch(kw, st, btn)
    })
    .catch(() => doSearch(kw, st, btn))
}

function doSearch(kw, st, btn) {
  const container = el('searchContainer')
  if (container) container.style.display = 'block'
  setStatus(st, '搜索中(' + platformNames() + ')…')
  hideBrowse()
  api('api/search/select', { method: 'POST', body: JSON.stringify({ keyword: kw, platforms: selectedPlatforms }) })
    .then((data) => {
      btn.disabled = false
      const results = (data && data.results) || []
      if (!results.length) {
        setStatus(st, '未找到结果', 'err')
        renderResults([])
        return
      }
      setStatus(st, '找到 ' + results.length + ' 首', 'ok')
      renderResults(results)
      renderBatchImport(results)
    })
    .catch((e) => {
      btn.disabled = false
      setStatus(st, '搜索失败:' + (e.message || e), 'err')
    })
}

export function initSearch() {
  // 搜索平台多选下拉框:渲染 + 绑定 + 加载已保存选择
  renderPlatformSelect()
  bindPlatformSelect()
  loadPlatforms()
  // searchGoBtn 用 onclick 属性直连 window.searchGo(双保险),此处不重复绑定
}

// 批量导入按钮(把当前搜索结果全部导入宿主曲库,之后可在宿主界面搜索/播放)
function renderBatchImport(results) {
  const bar = document.createElement('div')
  bar.className = 'batch-bar'
  bar.innerHTML = '<button type="button" class="btn-filled" id="batchImportBtn"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px">download</span> 全部导入曲库(' + results.length + ')</button>'
  const box = el('results')
  box.parentNode.insertBefore(bar, box)
  el('batchImportBtn').addEventListener('click', () => {
    const btn = el('batchImportBtn')
    if (!btn) return
    btn.disabled = true
    const st = el('searchStatus')
    let done = 0, failed = 0
    const total = results.length
    setStatus(st, '正在导入 0/' + total + '…')
    const chain = results.reduce((p, item) => p.then(() =>
      api('api/import', { method: 'POST', body: JSON.stringify({ song: item }) })
        .then(() => { done++; setStatus(st, '正在导入 ' + done + '/' + total + '…') })
        .catch(() => { failed++ })
    ), Promise.resolve())
    chain.then(() => {
      btn.disabled = false
      if (failed) setStatus(st, '导入完成:' + done + ' 首成功,' + failed + ' 首失败', 'err')
      else setStatus(st, '已全部导入曲库(' + done + ' 首),可在宿主曲库搜索/播放', 'ok')
      snackbar('已导入 ' + done + ' 首到曲库')
    })
  })
}

function renderResults(results) {
  const oldBar = document.querySelector('.batch-bar')
  if (oldBar) oldBar.remove()
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
    mkBtn('lyrics', '查看/获取歌词').addEventListener('click', () => openLyricForSong(item))
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
          // 播放界面由宿主承担(底部播放条/客户端播放器)
          setStatus(st, '已开始播放:' + song.title, 'ok')
          snackbar('已开始播放: ' + song.title)
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
