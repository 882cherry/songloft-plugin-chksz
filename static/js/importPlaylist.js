// importPlaylist.js — 把平台歌单/榜单导入为 Songloft 歌单
//   布局:平台浏览标签(网易云/QQ/酷狗)→ 歌单详情 →「导入为 Songloft 歌单」
//   后端 POST /api/playlist/import 负责抓取详情、逐首入库(去重)、创建宿主歌单并批量加入。

import { api } from './api.js'
import { snackbar, platformName } from './util.js'

function el(id) { return document.getElementById(id) }

let pendingSource = null

function openSheet() {
  el('importBackdrop').style.display = 'block'
  requestAnimationFrame(() => el('importSheet').classList.add('show'))
  setTimeout(() => el('importSheet').classList.add('show'), 60)
}

function closeSheet() {
  el('importBackdrop').style.display = 'none'
  el('importSheet').classList.remove('show')
}

export function openImportPlaylist(source) {
  if (!source || !source.platform || !source.id) {
    snackbar('无效的歌单来源')
    return
  }
  pendingSource = source
  el('importSourceInfo').textContent =
    '来源：' + platformName(source.platform) + ' · ' + (source.title || '未命名歌单') +
    ' · ' + (source.songCount || '?') + ' 首'
  el('importPlaylistName').value = source.title || ''
  el('importStatus').textContent = ''
  el('importStatus').className = 'dialog-status'
  el('importConfirmBtn').disabled = false
  openSheet()
  setTimeout(() => el('importPlaylistName').focus(), 150)
}

function confirmImport() {
  if (!pendingSource) return
  const name = el('importPlaylistName').value.trim()
  const st = el('importStatus')
  const btn = el('importConfirmBtn')
  if (!name) {
    st.textContent = '请输入歌单名称'
    st.className = 'dialog-status err'
    return
  }
  btn.disabled = true
  st.textContent = '正在导入（抓取 + 入库 + 创建歌单）…'
  st.className = 'dialog-status'
  api('api/playlist/import', {
    method: 'POST',
    body: JSON.stringify({
      platform: pendingSource.platform,
      id: pendingSource.id,
      name,
      cover_url: pendingSource.cover || '',
    }),
  })
    .then((data) => {
      if (!data || !data.ok) throw new Error((data && data.error) || '导入失败')
      closeSheet()
      snackbar('已导入歌单「' + data.playlist.name + '」（' + data.imported + ' 首）')
    })
    .catch((e) => {
      btn.disabled = false
      st.textContent = '导入失败：' + (e.message || e)
      st.className = 'dialog-status err'
    })
}

export function initImportPlaylist() {
  el('importBackdrop').addEventListener('click', closeSheet)
  el('importCancelBtn').addEventListener('click', closeSheet)
  el('importConfirmBtn').addEventListener('click', confirmImport)
  el('importPlaylistName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmImport()
  })
}
