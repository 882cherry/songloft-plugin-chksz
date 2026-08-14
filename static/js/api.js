// api.js — 插件 API 请求(自动带宿主 token)

const PLATFORM_NAME = { wy: '网易云', tx: 'QQ', kg: '酷狗' }
export const API_BASE = window.location.pathname.replace(/\/+$/, '') + '/'

export function getToken() {
  try {
    const raw = localStorage.getItem('songloft-auth')
    if (!raw) return ''
    const obj = JSON.parse(raw)
    return obj && obj.accessToken ? obj.accessToken : ''
  } catch (e) { return '' }
}

export function api(path, opts = {}) {
  const headers = opts.headers || {}
  const token = getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (opts.body) headers['Content-Type'] = 'application/json'
  return fetch(API_BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body || undefined,
  }).then((r) => r.json().catch(() => null))
}

/** 是否运行在支持 client-sdk 的宿主内 */
export function hasClientPlayer() {
  return !!(window.SongloftPlugin && window.SongloftPlugin.player)
}

/** 拉取歌词文本(经宿主认证端点) */
export function fetchLyric(lyricUrl) {
  if (!lyricUrl) return Promise.resolve('')
  const url = /^https?:/i.test(lyricUrl) ? lyricUrl : new URL(lyricUrl, window.location.origin).href
  const headers = {}
  const token = getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token
  return fetch(url, { headers })
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '')
}
