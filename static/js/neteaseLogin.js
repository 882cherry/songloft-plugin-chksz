// neteaseLogin.js — 网易云登录(扫码 + 网页登录/Cookie 导入)

import { api } from './api.js'
import { snackbar } from './util.js'

function el(id) { return document.getElementById(id) }

let qrTimer = null
let qrKey = ''

// ===== 登录状态刷新 =====
export async function refreshNeteaseStatus() {
  try {
    const data = await api('api/netease/login/status')
    if (!data) return
    const st = el('wyLoginStatus')
    const logout = el('wyLogoutBtn')
    if (st) {
      if (data.logged_in && data.nickname) {
        st.textContent = '已登录：' + data.nickname
      } else if (data.logged_in) {
        st.textContent = '已登录'
      } else {
        st.textContent = '未登录'
      }
    }
    if (logout) logout.style.display = data.logged_in ? '' : 'none'
  } catch (e) {
    /* 忽略状态刷新错误 */
  }
}

// ===== 扫码登录 =====
function openQrSheet() {
  el('wyQrBackdrop').style.display = 'block'
  requestAnimationFrame(() => el('wyQrSheet').classList.add('show'))
  setTimeout(() => el('wyQrSheet').classList.add('show'), 60)
}

function closeQrSheet() {
  el('wyQrBackdrop').style.display = 'none'
  el('wyQrSheet').classList.remove('show')
  stopQrPoll()
}

function stopQrPoll() {
  if (qrTimer) {
    clearTimeout(qrTimer)
    qrTimer = null
  }
}

function setQrStatus(msg, kind) {
  const st = el('wyQrStatus')
  st.textContent = msg
  st.className = 'dialog-status' + (kind === 'err' ? ' err' : '')
}

async function startQrLogin() {
  stopQrPoll()
  qrKey = ''
  el('wyQrImg').src = ''
  el('wyQrLink').style.display = 'none'
  setQrStatus('获取二维码中…')
  openQrSheet()
  try {
    const d = await api('api/netease/login/qr')
    if (!d || !d.key) throw new Error((d && d.error) || '获取二维码失败')
    qrKey = d.key
    const qrData = encodeURIComponent(d.url)
    el('wyQrImg').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=' + qrData
    const link = el('wyQrLink')
    link.href = d.url
    link.style.display = ''
    setQrStatus('请使用网易云音乐 App 扫码')
    pollQrStatus()
  } catch (e) {
    setQrStatus('获取二维码失败：' + (e.message || e), 'err')
  }
}

async function pollQrStatus() {
  if (!qrKey) return
  try {
    const d = await api('api/netease/login/qr/check?key=' + encodeURIComponent(qrKey))
    if (!d) throw new Error('轮询失败')
    if (d.code === 801) {
      setQrStatus('等待扫码…')
    } else if (d.code === 802) {
      setQrStatus('已扫码，请在手机上确认登录')
    } else if (d.code === 803) {
      setQrStatus('登录成功 ✓')
      stopQrPoll()
      setTimeout(() => {
        closeQrSheet()
        refreshNeteaseStatus()
        snackbar('网易云登录成功')
      }, 400)
      return
    } else if (d.code === 800) {
      setQrStatus('二维码已过期，请重新打开', 'err')
      stopQrPoll()
      return
    } else {
      setQrStatus('登录失败：' + (d.msg || d.error || '未知错误'), 'err')
      stopQrPoll()
      return
    }
    qrTimer = setTimeout(pollQrStatus, 2000)
  } catch (e) {
    setQrStatus('轮询失败：' + (e.message || e), 'err')
    qrTimer = setTimeout(pollQrStatus, 2500)
  }
}

// ===== 网页登录 / Cookie 导入 =====
function openWebSheet() {
  el('wyWebBackdrop').style.display = 'block'
  requestAnimationFrame(() => el('wyWebSheet').classList.add('show'))
  setTimeout(() => el('wyWebSheet').classList.add('show'), 60)
  el('wyWebStatus').textContent = ''
  el('wyWebStatus').className = 'dialog-status'
  el('wyCookieInput').value = ''
}

function closeWebSheet() {
  el('wyWebBackdrop').style.display = 'none'
  el('wyWebSheet').classList.remove('show')
}

function openOfficialLogin() {
  const a = document.createElement('a')
  a.href = 'https://music.163.com/login'
  a.target = '_blank'
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function saveWebCookie() {
  const cookie = el('wyCookieInput').value.trim()
  const st = el('wyWebStatus')
  const btn = el('wyWebSaveBtn')
  if (!cookie) {
    st.textContent = '请粘贴 MUSIC_U 或 Cookie'
    st.className = 'dialog-status err'
    return
  }
  btn.disabled = true
  st.textContent = '验证并保存中…'
  st.className = 'dialog-status'
  try {
    const d = await api('api/netease/login/cookie', { method: 'POST', body: JSON.stringify({ cookie }) })
    if (!d || !d.ok) throw new Error((d && d.error) || '登录失败')
    closeWebSheet()
    refreshNeteaseStatus()
    snackbar('网易云登录成功')
  } catch (e) {
    btn.disabled = false
    st.textContent = '登录失败：' + (e.message || e)
    st.className = 'dialog-status err'
  }
}

async function logoutNetease() {
  try {
    await api('api/netease/logout', { method: 'POST' })
    refreshNeteaseStatus()
    snackbar('已退出网易云登录')
  } catch (e) {
    snackbar('退出失败：' + (e.message || e))
  }
}

// ===== 初始化 =====
export function initNeteaseLogin() {
  el('wyQrLoginBtn').addEventListener('click', startQrLogin)
  el('wyQrCancelBtn').addEventListener('click', closeQrSheet)
  el('wyQrBackdrop').addEventListener('click', closeQrSheet)
  el('wyWebLoginBtn').addEventListener('click', openWebSheet)
  el('wyWebCancelBtn').addEventListener('click', closeWebSheet)
  el('wyWebBackdrop').addEventListener('click', closeWebSheet)
  el('wyOpenWebBtn').addEventListener('click', openOfficialLogin)
  el('wyWebSaveBtn').addEventListener('click', saveWebCookie)
  el('wyLogoutBtn').addEventListener('click', logoutNetease)
  refreshNeteaseStatus()
}
