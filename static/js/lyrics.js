// lyrics.js — 歌词解析与滚动同步

import { parseLrc } from './util.js'
import { fetchLyric } from './api.js'

const state = { id: null, lines: [], url: '', activeIdx: -1 }

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
    lines.forEach((line, i) => {
      const div = document.createElement('div')
      div.className = 'lyric-line'
      div.textContent = line.text
      // 点击歌词行跳转到对应时间
      div.addEventListener('click', () => {
        const p = window.SongloftPlugin && window.SongloftPlugin.player
        if (p) p.seek(line.time).catch(() => {})
      })
      wrap.appendChild(div)
    })
    syncScroll(true)
  })
}

export function initLyrics(getter) {
  currentTimeGetter = getter
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
  // 手动滚动歌词页容器(避免 scrollIntoView 误动横向 swiper)
  const page = el('lyricPage')
  const active = wrap.children[idx]
  if (page && active) {
    const top = active.offsetTop - page.clientHeight / 2 + active.clientHeight / 2
    page.scrollTo({ top: Math.max(0, top), behavior: force ? 'auto' : 'smooth' })
  }
}
