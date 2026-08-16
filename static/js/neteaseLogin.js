// neteaseLogin.js — 网易云登录(扫码 + 网页登录/Cookie 导入)

import { api } from './api.js'
import { snackbar } from './util.js'
import { refreshWyAfterLogin } from './browse.js'

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
      stopQrPoll()
      if (d.logged_in) {
        setQrStatus('登录成功 ✓')
        setTimeout(() => {
          closeQrSheet()
          refreshNeteaseStatus()
          refreshWyAfterLogin()
          snackbar('网易云登录成功')
        }, 400)
      } else {
        setQrStatus('扫码已确认，但未获取到 Cookie，请改用网页登录或 Cookie 导入', 'err')
        setTimeout(closeQrSheet, 1500)
      }
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

// ===== 网页登录:官方 URS 组件(手机验证码 + 手机密码,自带滑块/易盾验证) =====
let ursInstance = null
let ursLoading = null
let ursCreating = false

function openWebSheet() {
  el('wyWebBackdrop').style.display = 'block'
  requestAnimationFrame(() => el('wyWebSheet').classList.add('show'))
  setTimeout(() => el('wyWebSheet').classList.add('show'), 60)
  setWebStatus('正在加载网易云官方登录组件…')
  initOfficialWebLogin()
}

function closeWebSheet() {
  el('wyWebBackdrop').style.display = 'none'
  el('wyWebSheet').classList.remove('show')
}

function setWebStatus(msg, kind) {
  const st = el('wyWebStatus')
  if (st) {
    st.textContent = msg || ''
    st.className = 'dialog-status' + (kind === 'err' ? ' err' : '') + (kind === 'ok' ? ' ok' : '')
  }
}

function loadUrsSdk() {
  if (!ursLoading) {
    ursLoading = new Promise((resolve, reject) => {
      if (window.URS) { resolve(window.URS); return }
      const script = document.createElement('script')
      script.src = 'https://urswebzj.nosdn.127.net/webzj_cdn101/message.js'
      script.onload = () => window.URS ? resolve(window.URS) : reject(new Error('网易云登录组件加载失败'))
      script.onerror = () => reject(new Error('网易云登录组件加载失败'))
      document.head.appendChild(script)
    })
  }
  return ursLoading
}

async function submitOfficialWebLogin(msg) {
  setWebStatus('官方登录成功，正在同步登录状态…')
  try {
    const d = await api('api/netease/login/urs', {
      method: 'POST',
      body: JSON.stringify({ urls: (msg && msg.nextUrls) || [] }),
    })
    if (!d || !d.ok) throw new Error((d && d.error) || '登录回写失败')
    setWebStatus('登录成功 ✓', 'ok')
    refreshNeteaseStatus()
    refreshWyAfterLogin()
    snackbar('网易云登录成功')
    setTimeout(closeWebSheet, 500)
  } catch (e) {
    setWebStatus('登录组件已通过，但同步 Cookie 失败：' + (e.message || e) + '；请改用 Cookie 导入粘贴 MUSIC_U', 'err')
  }
}

function initOfficialWebLogin() {
  const box = el('wyWebUrsBox')
  if (!box) return
  if (ursInstance || ursCreating) {
    setWebStatus('请使用手机验证码登录，或切换到密码登录')
    return
  }
  ursCreating = true
  box.innerHTML = ''
  loadUrsSdk()
    .then((URS) => {
      if (!el('wyWebUrsBox')) return
      setWebStatus('请使用手机验证码登录，或切换到密码登录')
      ursCreating = false
      ursInstance = new URS({
        newCDN: 1,
        version: 4,
        product: 'music',
        promark: 'KGxdbOk',
        host: 'music.163.com',
        page: 'login',
        single: 1,
        needMobileLogin: 1,
        mobileFirst: 1,
        uniteLogin: { isItl: 1, loginTxt: '登录' },
        includeBox: box,
        aiCapBarHeight: 40,
        aiCapPadding: 10,
        mobilePlaceholder: { mobile: '请输入手机号', sms2: '请输入验证码' },
        smsLoginFirst: 1,
        uniteLoginTermsList: [],
        logincb: (username, isOther, msg) => submitOfficialWebLogin(msg),
        renderOk: () => setWebStatus('请使用手机验证码登录，或切换到密码登录'),
        initError: (err) => setWebStatus('官方登录组件初始化失败：' + ((err && (err.errMsg || err.msg)) || '未知错误') + '；请改用扫码或 Cookie 导入', 'err'),
        chromeCookieError: () => setWebStatus('浏览器阻止了第三方 Cookie：组件仍可登录，登录后插件会从服务端同步 Cookie'),
      })
    })
    .catch((e) => {
      ursCreating = false
      setWebStatus((e.message || '网易云登录组件加载失败') + '；请改用扫码或 Cookie 导入', 'err')
    })
}

function reloadWebLogin() {
  if (!el('wyWebUrsBox')) return
  setWebStatus('正在重新加载网易云官方登录组件…')
  if (ursInstance && typeof ursInstance.closeIframe === 'function') {
    try { ursInstance.closeIframe() } catch (e) { /* ignore */ }
  }
  ursInstance = null
  const box = el('wyWebUrsBox')
  box.innerHTML = ''
  initOfficialWebLogin()
}

// ===== Cookie 导入(独立于网页登录) =====
function openCookieSheet() {
  el('wyCookieBackdrop').style.display = 'block'
  requestAnimationFrame(() => el('wyCookieSheet').classList.add('show'))
  setTimeout(() => el('wyCookieSheet').classList.add('show'), 60)
  el('wyCookieStatus').textContent = ''
  el('wyCookieStatus').className = 'dialog-status'
  el('wyCookieInput').value = ''
  el('wyCookieSaveBtn').disabled = false
}

function closeCookieSheet() {
  el('wyCookieBackdrop').style.display = 'none'
  el('wyCookieSheet').classList.remove('show')
}

async function saveCookieImport() {
  const cookie = el('wyCookieInput').value.trim()
  const st = el('wyCookieStatus')
  const btn = el('wyCookieSaveBtn')
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
    closeCookieSheet()
    refreshNeteaseStatus()
    refreshWyAfterLogin()
    snackbar('网易云 Cookie 登录成功')
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
    refreshWyAfterLogin()
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
  el('wyWebReloadBtn').addEventListener('click', reloadWebLogin)

  el('wyCookieLoginBtn').addEventListener('click', openCookieSheet)
  el('wyCookieCancelBtn').addEventListener('click', closeCookieSheet)
  el('wyCookieBackdrop').addEventListener('click', closeCookieSheet)
  el('wyCookieSaveBtn').addEventListener('click', saveCookieImport)

  el('wyLogoutBtn').addEventListener('click', logoutNetease)
  refreshNeteaseStatus()
}
