// util.js — 通用工具

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m + ':' + String(s).padStart(2, '0')
}

let snackbarTimer = null
export function snackbar(msg) {
  const el = document.getElementById('snackbar')
  if (!el) return
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(snackbarTimer)
  snackbarTimer = setTimeout(() => el.classList.remove('show'), 2400)
}

export function setStatus(el, msg, kind) {
  if (!el) return
  el.textContent = msg
  el.className = 'status ' + (kind || 'muted')
}

/** 解析 LRC:返回 [{time(秒), text}] */
export function parseLrc(text) {
  if (!text) return []
  const lines = []
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let lastIndex = 0
    let m
    const tags = []
    while ((m = re.exec(line)) !== null) {
      tags.push(m)
      lastIndex = m.index + m[0].length
    }
    if (!tags.length) continue
    const content = line.slice(lastIndex).trim()
    for (const t of tags) {
      const sec = parseInt(t[1], 10) * 60 + parseInt(t[2], 10) + (t[3] ? parseInt(t[3], 10) / Math.pow(10, t[3].length) : 0)
      lines.push({ time: sec, text: content })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

export function platformName(p) {
  return PLATFORM_NAME[p] || p || '未知'
}

/** 简易 sheet 开关 */
export function bindSheet(backdropId, sheetId, openBtn, closeBtns) {
  const backdrop = document.getElementById(backdropId)
  const sheet = document.getElementById(sheetId)
  const show = () => {
    backdrop.style.display = 'block'
    requestAnimationFrame(() => sheet.classList.add('show'))
  }
  const hide = () => {
    backdrop.style.display = 'none'
    sheet.classList.remove('show')
  }
  if (openBtn) openBtn.addEventListener('click', show)
  if (backdrop) backdrop.addEventListener('click', hide)
  ;(closeBtns || []).forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.addEventListener('click', hide)
  })
  return { show, hide }
}
