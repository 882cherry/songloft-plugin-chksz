// importPlaylist.js — 把平台歌单/榜单导入为 Songloft 歌单
//   布局:平台浏览标签(网易云/QQ/酷狗)→ 歌单详情 →「导入为 Songloft 歌单」
//   后端 POST /api/playlist/import 负责抓取详情、逐首入库(去重)、创建宿主歌单并批量加入。

import { api } from './api.js'
import { snackbar, platformName } from './util.js'

function el(id) { return document.getElementById(id) }

let pendingSource = null
let pendingOverwrite = false
let pendingLinkOverwrite = false

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
  pendingOverwrite = false
  el('importPlaylistName').value = source.title || ''
  el('importStatus').textContent = ''
  el('importStatus').className = 'dialog-status'
  el('importConfirmBtn').disabled = false
  el('importConfirmBtn').textContent = '开始导入'
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
      overwrite: pendingOverwrite,
    }),
  })
    .then((data) => {
      if (!data || (!data.ok && !data.exists)) throw new Error((data && data.error) || '导入失败')
      if (data.exists) {
        pendingOverwrite = true
        btn.disabled = false
        btn.textContent = '覆盖导入'
        st.textContent = '该歌单已导入过「' + data.playlist.name + '」，是否覆盖其中的歌曲？'
        st.className = 'dialog-status'
        return
      }
      pendingOverwrite = false
      closeSheet()
      snackbar((data.overwritten ? '已覆盖导入歌单「' : '已导入歌单「') + data.playlist.name + '」（' + data.imported + ' 首）')
    })
    .catch((e) => {
      btn.disabled = false
      st.textContent = '导入失败：' + (e.message || e)
      st.className = 'dialog-status err'
    })
}


// ===== 分享链接导入(自动识别 网易云/QQ/酷狗) =====
function openLinkSheet() {
  el('linkImportBackdrop').style.display = 'block'
  requestAnimationFrame(() => el('linkImportSheet').classList.add('show'))
  setTimeout(() => el('linkImportSheet').classList.add('show'), 60)
}

function closeLinkSheet() {
  el('linkImportBackdrop').style.display = 'none'
  el('linkImportSheet').classList.remove('show')
}

export function openLinkImport() {
  pendingLinkOverwrite = false
  el('linkImportUrl').value = ''
  el('linkImportName').value = ''
  el('linkImportStatus').textContent = ''
  el('linkImportStatus').className = 'dialog-status'
  el('linkImportConfirmBtn').disabled = false
  el('linkImportConfirmBtn').textContent = '解析并导入'
  openLinkSheet()
  setTimeout(() => el('linkImportUrl').focus(), 150)
}

function confirmLinkImport() {
  const url = el('linkImportUrl').value.trim()
  const name = el('linkImportName').value.trim()
  const st = el('linkImportStatus')
  const btn = el('linkImportConfirmBtn')
  if (!url) {
    st.textContent = '请粘贴分享链接或分享文本'
    st.className = 'dialog-status err'
    return
  }
  btn.disabled = true
  st.textContent = '正在解析链接并导入…'
  st.className = 'dialog-status'
  api('api/playlist/import', {
    method: 'POST',
    body: JSON.stringify({ url, name: name || '', overwrite: pendingLinkOverwrite }),
  })
    .then((data) => {
      if (!data || (!data.ok && !data.exists)) throw new Error((data && data.error) || '导入失败')
      if (data.exists) {
        pendingLinkOverwrite = true
        btn.disabled = false
        btn.textContent = '覆盖导入'
        st.textContent = '该歌单已导入过「' + data.playlist.name + '」，是否覆盖其中的歌曲？'
        st.className = 'dialog-status'
        return
      }
      pendingLinkOverwrite = false
      closeLinkSheet()
      snackbar((data.overwritten ? '已覆盖导入歌单「' : '已导入歌单「') + data.playlist.name + '」（' + data.imported + ' 首）')
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

  el('linkImportBackdrop').addEventListener('click', closeLinkSheet)
  el('linkImportCancelBtn').addEventListener('click', closeLinkSheet)
  el('linkImportConfirmBtn').addEventListener('click', confirmLinkImport)
  el('linkImportUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) confirmLinkImport()
  })
  el('linkImportName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmLinkImport()
  })
}
