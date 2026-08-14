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

/** 拉取歌词文本(经宿主认证端点;自动检测 UTF-8/GBK 编码;兼容宿主 JSON 包装) */
export function fetchLyric(lyricUrl) {
  if (!lyricUrl) return Promise.resolve('')
  const url = /^https?:/i.test(lyricUrl) ? lyricUrl : new URL(lyricUrl, window.location.origin).href
  const headers = {}
  const token = getToken()
  if (token) headers['Authorization'] = 'Bearer ' + token
  return fetch(url, { headers })
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => (buf ? decodeText(buf) : ''))
    .then(unwrapLyric)
    .catch(() => '')
}

/** 宿主歌词端点返回 LyricPayload JSON({"lyric","tlyric","rlyric","lxlyric"}),
 *  解包取主歌词;纯 LRC 文本原样返回。 */
function unwrapLyric(text) {
  const t = (text || '').trim()
  if (!t || t[0] !== '{') return t
  try {
    const obj = JSON.parse(t)
    if (obj && typeof obj.lyric === 'string') {
      const parts = [obj.lyric]
      if (typeof obj.tlyric === 'string' && obj.tlyric.trim()) parts.push(obj.tlyric)
      return parts.join('\n')
    }
  } catch (e) { /* 非 JSON 原样返回 */ }
  return t
}

/** 编码检测:先按 UTF-8 解码,出现替换字符则回退 GBK(中文音乐平台歌词常见 GBK) */
function decodeText(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  // 检测是否存在 U+FFFD(替换字符)或异常成对出现的控制字符
  const suspicious = utf8.indexOf('\uFFFD') >= 0
  if (!suspicious) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch (e) {
    return utf8
  }
}
