// player.js — 播放操作(精简版)
// 播放/进度/歌词/队列等界面全部交给宿主 Songloft 播放器承担(宿主 web UI 底部播放条
// 与客户端播放器原生支持 remote 歌曲,播放时经插件 /api/music/url 解析)。
// 插件只负责:把歌曲导入曲库 → setQueue 交给宿主播放。

import { snackbar } from './util.js'

let player = null

// 宿主播放器可能在页面加载后才注入(Web UI 异步桥),轮询等待
function getPlayer() {
  if (player) return player
  if (window.SongloftPlugin && window.SongloftPlugin.player) {
    player = window.SongloftPlugin.player
  }
  return player
}

function hasPlayer() { return !!getPlayer() }

/**
 * 播放一组歌:导入后替换宿主播放器队列并开始播放。
 * 播放界面由宿主承担(Web UI 底部播放条 / 客户端播放器)。
 */
export function playSongs(songs, startIndex = 0) {
  if (!hasPlayer()) return Promise.reject(new Error('宿主播放器不可用'))
  return player.setQueue(songs.map((s) => s.id), { startIndex })
}

/** 加入宿主播放器队列末尾 */
export function addToQueue(songs) {
  if (!hasPlayer()) return Promise.reject(new Error('宿主播放器不可用'))
  return player.addToQueue(songs.map((s) => s.id))
}

/**
 * 将单曲追加到当前播放列表末尾并立即播放。
 * 不会覆盖宿主现有的播放列表(区别于 playSongs 的 setQueue 替换行为)。
 */
export function playSongAppend(song) {
  if (!hasPlayer()) return Promise.reject(new Error('宿主播放器不可用'))
  if (!song || !song.id) return Promise.reject(new Error('缺少歌曲 id'))
  return player.addToQueue([song.id]).then(() => player.play(song.id))
}

/** 播放器是否就绪(宿主已注入) */
export function isReady() { return !!player }

// ===== 初始化:轮询等待宿主播放器注入 =====
export function initPlayer() {
  let tries = 0
  const tryGet = () => {
    if (getPlayer()) return
    tries++
    if (tries < 20) setTimeout(tryGet, 400)
    else console.warn('[chksz] 宿主播放器不可用,仅可搜索/收藏/浏览')
  }
  tryGet()
}
