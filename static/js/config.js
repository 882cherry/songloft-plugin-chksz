// config.js — 配置弹窗(左上角图标)

import { api } from './api.js'
import { snackbar } from './util.js'

function el(id) { return document.getElementById(id) }

let onSaved = null

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
}

export function openConfig() {
  el('configBackdrop').style.display = 'block'
  requestAnimationFrame(() => el('configSheet').classList.add('show'))
  // 兜底:后台/隐藏 iframe 中 rAF 可能不触发,用定时器再补一次(幂等)
  setTimeout(() => el('configSheet').classList.add('show'), 60)
  el('configStatus').textContent = ''
  api('api/settings').then((data) => {
    if (!data) return
    const keyEl = el('apiKey')
    const qEl = el('quality')
    if (data.api_key_set) {
      keyEl.placeholder = '已配置(' + data.api_key_mask + '),留空不修改'
      el('apiKeyHint').textContent = '已配置,留空保存则不修改'
    }
    if (data.quality) qEl.value = data.quality
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
