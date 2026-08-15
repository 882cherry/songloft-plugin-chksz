// playlists.js — 收藏到歌单(直接调用宿主 /api/v1/playlists API,走当前登录用户 token)
//   收藏时弹出歌单选择器;无歌单或用户选择时可新建歌单

import { getToken } from './api.js'
import { snackbar } from './util.js'

function el(id) { return document.getElementById(id) }

const HOST_API = window.location.origin + '/api/v1'

// ===== 宿主 API 调用(带登录 token) =====
function hostApi(path, opts = {}) {
  const headers = opts.headers || {}
  const token = getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (opts.body) headers['Content-Type'] = 'application/json'
  return fetch(HOST_API + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body || undefined,
  }).then((r) => r.json().catch(() => null))
}

export function listPlaylists() {
  return hostApi('/playlists').then((d) => (d && d.playlists) || [])
}

export function createPlaylist(name) {
  return hostApi('/playlists', {
    method: 'POST',
    body: JSON.stringify({ name: String(name || '').trim(), type: 'normal' }),
  }).then((d) => {
    if (!d || !d.id) throw new Error('创建歌单失败:' + JSON.stringify(d))
    return d
  })
}

export function addSongToPlaylist(playlistId, songId) {
  return hostApi('/playlists/' + playlistId + '/songs', {
    method: 'POST',
    body: JSON.stringify({ song_ids: [songId] }),
  })
}

// ===== 歌单选择器 =====
let pendingSong = null
let playlistsCache = []

function openSheet(backdropId, sheetId) {
  el(backdropId).style.display = 'block'
  const sh = el(sheetId)
  requestAnimationFrame(() => sh.classList.add('show'))
  // 兜底:后台/隐藏 iframe 中 rAF 可能不触发,用定时器再补一次(幂等)
  setTimeout(() => sh.classList.add('show'), 60)
}

function closeSheet(backdropId, sheetId) {
  el(backdropId).style.display = 'none'
  el(sheetId).classList.remove('show')
}

/** 收藏歌曲:弹出歌单选择器(含「新建歌单」),选择后加入对应歌单 */
export function openPlaylistPicker(song) {
  if (!song || !song.id) {
    snackbar('歌曲尚未导入曲库,请先播放或导入')
    return
  }
  pendingSong = song

  const list = el('playlistList')
  list.innerHTML = '<div class="empty-state">加载歌单中…</div>'
  openSheet('playlistBackdrop', 'playlistSheet')

  listPlaylists()
    .then((pls) => {
      playlistsCache = pls || []
      renderPlaylistList(playlistsCache)
    })
    .catch((e) => {
      list.innerHTML = '<div class="empty-state">加载歌单失败:' + (e.message || e) + '</div>'
    })
}

function renderPlaylistList(pls) {
  const list = el('playlistList')
  list.innerHTML = ''
  if (!pls.length) {
    list.innerHTML = '<div class="empty-state">还没有歌单,新建一个吧</div>'
  }
  // 「新建歌单」入口(置顶)
  list.appendChild(plRow({
    icon: 'add',
    name: '新建歌单',
    sub: '创建新歌单并收藏这首歌',
    onClick: () => {
      closeSheet('playlistBackdrop', 'playlistSheet')
      openCreateSheet()
    },
  }))
  pls.forEach((p) => {
    list.appendChild(plRow({
      icon: 'queue_music',
      name: p.name || '未命名歌单',
      sub: p.song_count != null ? p.song_count + ' 首' : (p.description || ''),
      onClick: () => {
        closeSheet('playlistBackdrop', 'playlistSheet')
        doAddToPlaylist(p.id, p.name)
      },
    }))
  })
}

function plRow({ icon, name, sub, onClick }) {
  const row = document.createElement('div')
  row.className = 'pl-row'
  row.innerHTML =
    '<div class="pl-icon"><span class="material-symbols-outlined">' + icon + '</span></div>' +
    '<div class="pl-meta"><div class="pl-name"></div><div class="pl-sub"></div></div>'
  row.querySelector('.pl-name').textContent = name
  row.querySelector('.pl-sub').textContent = sub
  row.addEventListener('click', onClick)
  return row
}

function doAddToPlaylist(playlistId, playlistName) {
  if (!pendingSong) return
  const song = pendingSong
  pendingSong = null
  addSongToPlaylist(playlistId, song.id)
    .then((d) => {
      if (d && (d.added > 0 || d.skipped > 0)) {
        snackbar('已收藏到「' + playlistName + '」')
      } else {
        snackbar('收藏完成')
      }
    })
    .catch((e) => snackbar('收藏失败:' + (e.message || e)))
}

// ===== 新建歌单 =====
function openCreateSheet() {
  el('createName').value = pendingSong ? pendingSong.title + ' 的歌单' : ''
  el('createStatus').textContent = ''
  openSheet('createBackdrop', 'createSheet')
  setTimeout(() => el('createName').focus(), 150)
}

function closeCreateSheet() {
  closeSheet('createBackdrop', 'createSheet')
}

function confirmCreate() {
  const name = el('createName').value.trim()
  const st = el('createStatus')
  const btn = el('createConfirmBtn')
  if (!name) {
    st.textContent = '请输入歌单名称'
    st.className = 'dialog-status err'
    return
  }
  btn.disabled = true
  st.textContent = '创建中…'
  createPlaylist(name)
    .then((pl) => {
      btn.disabled = false
      st.textContent = '已创建,正在收藏…'
      if (!pendingSong) {
        closeCreateSheet()
        snackbar('已创建歌单「' + pl.name + '」')
        return
      }
      return addSongToPlaylist(pl.id, pendingSong.id).then(() => {
        const s = pendingSong
        pendingSong = null
        closeCreateSheet()
        snackbar('已创建并收藏到「' + pl.name + '」')
      })
    })
    .catch((e) => {
      btn.disabled = false
      st.textContent = '创建失败:' + (e.message || e)
      st.className = 'dialog-status err'
    })
}

// ===== 事件绑定 =====
export function initPlaylists() {
  el('playlistBackdrop').addEventListener('click', () => closeSheet('playlistBackdrop', 'playlistSheet'))
  el('playlistCancelBtn').addEventListener('click', () => closeSheet('playlistBackdrop', 'playlistSheet'))
  el('createBackdrop').addEventListener('click', closeCreateSheet)
  el('createCancelBtn').addEventListener('click', closeCreateSheet)
  el('createConfirmBtn').addEventListener('click', confirmCreate)
  el('createName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmCreate()
  })
}
