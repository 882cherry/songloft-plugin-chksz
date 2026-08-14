// lyrics.js — 歌词解析与滚动同步

import { parseLrc, setStatus } from './util.js'
import { fetchLyric } from './api.js'

const state = { id: null, lines: [], url: '', el: null, activeIdx: -1, timer: null }

function el(id) { return document.getElementById(id) }

let currentTimeGetter = () => 0

export function setLyricFor(songId, lyricUrl) {
  if (songId === state.id && state.url === lyricUrl) return
  state.id = songId
  state.url = lyricUrl
  state.lines = []
  state.activeIdx = -1
  el('lyricList').innerHTML = '<div class="lyric-empty">加载中…</div>'

  fetchLyric(lyricUrl).then((text) => {
    if (songId !== state.id) return // 已切歌
    const lines = parseLrc(text)
    if (!lines.length) {
      el('lyricList').innerHTML = '<div class="lyric-empty">暂无歌词</div>'
      return
    }
    state.lines = lines
    const wrap = el('lyricList')
    wrap.innerHTML = ''
    lines.forEach(() => {
      const div = document.createElement('div')
      div.className = 'lyric-line'
      wrap.appendChild(div)
    })
    syncScroll(true)
  })
}

export function initLyrics(getter) {
  currentTimeGetter = getter
  const wrap = el('lyricList')
  wrap.addEventListener('scroll', () => { state.scrollingByUser = true }, { passive: true })
  setInterval(() => syncScroll(false), 1000)
}

function syncScroll(force) {
  const lines = state.lines
  if (!lines.length) return
  const t = currentTimeGetter()
  let idx = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (t >= lines[i].time) { idx = i; break }
  }
  if (idx === state.activeIdx && !force) return
  state.activeIdx = idx
  const wrap = el('lyricList')
  Array.from(wrap.children).forEach((node, i) => {
    node.textContent = lines[i].text
    node.classList.toggle('active', i === idx)
  })
  const active = wrap.children[idx]
  if (active && active.scrollIntoView) {
    try { active.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch { /* ignore */ }
  }
}
