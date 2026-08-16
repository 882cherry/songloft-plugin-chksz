// config.js — 配置弹窗(左上角图标)

import { api } from './api.js'
import { snackbar } from './util.js'
import { refreshNeteaseStatus } from './neteaseLogin.js'
import { openLinkImport } from './importPlaylist.js'
import { LYRIC_SOURCES, openLyricSearch } from './lyric.js'

function el(id) { return document.getElementById(id) }

let onSaved = null

// ===== 歌词接口优先级列表 =====
let lyricOrder = LYRIC_SOURCES.map((s) => s.code) // 当前顺序
const lyricEnabled = {} // code -> bool

function renderLyricSources(order) {
  const box = el('lyricSourcesList')
  if (!box) return
  lyricOrder = order || lyricOrder
  box.innerHTML = ''
  lyricOrder.forEach((code, idx) => {
    const src = LYRIC_SOURCES.find((s) => s.code === code)
    if (!src) return
    const row = document.createElement('div')
    row.className = 'lyric-source-row'
    const enabled = lyricEnabled[code] !== false
    row.innerHTML =
      '<input type="checkbox" ' + (enabled ? 'checked' : '') + '>' +
      '<span class="ls-name">' + src.name + '</span>' +
      '<span class="ls-op">' +
      '<button type="button" class="btn-icon" title="上移" data-op="up"><span class="material-symbols-outlined">arrow_upward</span></button>' +
      '<button type="button" class="btn-icon" title="下移" data-op="down"><span class="material-symbols-outlined">arrow_downward</span></button>' +
      '</span>'
    const cb = row.querySelector('input[type="checkbox"]')
    cb.addEventListener('change', () => {
      lyricEnabled[code] = cb.checked
    })
    row.querySelector('[data-op="up"]').addEventListener('click', () => {
      if (idx === 0) return
      lyricOrder.splice(idx, 1)
      lyricOrder.splice(idx - 1, 0, code)
      renderLyricSources(lyricOrder)
    })
    row.querySelector('[data-op="down"]').addEventListener('click', () => {
      if (idx >= lyricOrder.length - 1) return
      lyricOrder.splice(idx, 1)
      lyricOrder.splice(idx + 1, 0, code)
      renderLyricSources(lyricOrder)
    })
    box.appendChild(row)
  })
}

function collectLyricSources() {
  return lyricOrder.filter((code) => lyricEnabled[code] !== false)
}

// ===== 一级/二级菜单:类似手机设置 =====
function showConfigMenu() {
  const menu = el('configMenu')
  if (menu) menu.style.display = ''
  ;['basic', 'lyric', 'netease'].forEach((p) => {
    const page = el('configPage' + p.charAt(0).toUpperCase() + p.slice(1))
    if (page) page.style.display = 'none'
  })
}

function openConfigSub(name) {
  const menu = el('configMenu')
  if (menu) menu.style.display = 'none'
  ;['basic', 'lyric', 'netease'].forEach((p) => {
    const page = el('configPage' + p.charAt(0).toUpperCase() + p.slice(1))
    if (page) page.style.display = p === name ? '' : 'none'
  })
  if (name === 'netease') refreshNeteaseStatus()
}

export function initConfig(onConfigSaved) {
  onSaved = onConfigSaved || null
  // 旧版播放器栏的设置按钮(可能不存在,需防御)
  const cfg1 = el('configBtn')
  if (cfg1) cfg1.addEventListener('click', openConfig)
  // 搜索栏的设置按钮
  const cfg2 = el('configBtn2')
  if (cfg2) cfg2.addEventListener('click', openConfig)
  el('configCancelBtn').addEventListener('click', closeConfig)
  el('configBackdrop').addEventListener('click', closeConfig)
  el('saveConfigBtn').addEventListener('click', saveConfig)
  document.querySelectorAll('.config-menu-row').forEach((row) => {
    row.addEventListener('click', () => openConfigSub(row.dataset.target))
  })
  document.querySelectorAll('.config-back').forEach((btn) => {
    btn.addEventListener('click', showConfigMenu)
  })
  const importLink = el('importLinkFromConfigBtn')
  if (importLink) importLink.addEventListener('click', () => {
    closeConfig()
    openLinkImport()
  })
  const openLyricBtn = el('openLyricSearchBtn')
  if (openLyricBtn) openLyricBtn.addEventListener('click', () => {
    closeConfig()
    openLyricSearch()
  })
}

export function openConfig() {
  el('configBackdrop').style.display = 'block'
  requestAnimationFrame(() => el('configSheet').classList.add('show'))
  // 兜底:后台/隐藏 iframe 中 rAF 可能不触发,用定时器再补一次(幂等)
  setTimeout(() => el('configSheet').classList.add('show'), 60)
  el('configStatus').textContent = ''
  showConfigMenu()
  api('api/settings').then((data) => {
    if (!data) return
    const keyEl = el('apiKey')
    const qEl = el('quality')
    refreshNeteaseStatus()
    if (data.api_key_set) {
      keyEl.placeholder = '已配置(' + data.api_key_mask + '),留空不修改'
      el('apiKeyHint').textContent = '已配置,留空保存则不修改'
    }
    if (data.quality) qEl.value = data.quality
    // 歌词开关 + 接口优先级
    const enabledEl = el('lyricsEnabled')
    if (enabledEl) enabledEl.checked = data.lyrics_enabled !== false
    const savedOrder = data.lyric_sources || LYRIC_SOURCES.map((s) => s.code)
    const merged = savedOrder.concat(LYRIC_SOURCES.map((s) => s.code).filter((c) => !savedOrder.includes(c)))
    LYRIC_SOURCES.forEach((s) => { if (lyricEnabled[s.code] === undefined) lyricEnabled[s.code] = true })
    renderLyricSources(merged)
  })
}

export function closeConfig() {
  el('configBackdrop').style.display = 'none'
  el('configSheet').classList.remove('show')
}

function saveConfig() {
  const btn = el('saveConfigBtn')
  const st = el('configStatus')
  btn.disabled = true
  st.textContent = '保存中…'
  const body = { quality: el('quality').value }
  const key = el('apiKey').value.trim()
  if (key) body.api_key = key
  body.lyric_sources = collectLyricSources()
  const enabledEl = el('lyricsEnabled')
  if (enabledEl) body.lyrics_enabled = enabledEl.checked
  api('api/settings', { method: 'POST', body: JSON.stringify(body) })
    .then((data) => {
      btn.disabled = false
      if (data && data.ok) {
        st.textContent = '已保存 ✓'
        st.className = 'dialog-status'
        snackbar('配置已保存')
        el('apiKey').value = ''
        if (onSaved) onSaved()
        setTimeout(closeConfig, 650)
      } else {
        st.textContent = '保存失败:' + JSON.stringify(data) + '(若为 401,请重新打开插件页)'
        st.className = 'dialog-status err'
      }
    })
    .catch((e) => {
      btn.disabled = false
      st.textContent = '保存失败:' + (e.message || e)
      st.className = 'dialog-status err'
    })
}

/** 已配置 Key 与否(供搜索流程检查) */
export function hasApiKey() {
  return api('api/settings').then((data) => !!(data && data.api_key_set)).catch(() => true)
}
