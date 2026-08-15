/// <reference types="@songloft/plugin-sdk" />
// ChKSz 音源插件:通过 api.chksz.com 搜索并解析 网易云/QQ音乐/酷狗 播放链接。
//
// 接口实现:
//   POST /api/search        — 音源插件契约(宿主 SourceResolver fan-out 调用)
//   POST /api/music/url     — 用 source_data 解析真实播放 URL(宿主 SourceFetcher 调用)
//   POST /api/search/topone — miot 外部搜索源规范(小爱音箱语音搜歌)
//   GET/POST /api/settings  — 插件设置(API Key / 默认音质)
//
// 配置(songloft.storage):
//   api_key  — api.chksz.com 登录后获取的个人密钥(必填)
//   quality  — 'flac'(默认) | '320k' | '128k'

import {
  jsonResponse,
  createRouter,
  createSearchHandler,
  createMusicUrlHandler,
  parseQuery,
} from '@songloft/plugin-sdk';
import type {
  HTTPRequest,
  HTTPResponse,
  SearchResultItem,
  ResolvedMusicUrl,
  MusicUrlFallbackHint,
  FallbackMatch,
} from '@songloft/plugin-sdk';

const API_BASE = 'https://api.chksz.com/api';
const REQ_TIMEOUT_MS = 6000;

// ===== 音质映射(实测:服务端严格校验,非法值直接 400,无别名/降级)=====
// 网易云 level: standard / exhigh / lossless / hires / jymaster / sky / jyeffect
// QQ/酷狗 size: 128k / 320k / flac / hires / master
const WY_LEVEL: Record<string, string> = { '128k': 'standard', '320k': 'exhigh', flac: 'lossless' };
const QK_SIZE: Record<string, string> = { '128k': '128k', '320k': '320k', flac: 'flac' };

// ===== 平台定义(前端搜索多选,与 static/js/search.js 的 PLATFORM_OPTIONS 对应)=====
const ALL_PLATFORMS = ['wy', 'tx', 'kg']; // wy=网易云 tx=QQ kg=酷狗

// ===== 配置 =====
async function getConfig(): Promise<{ apiKey: string; quality: string; platforms: string[] }> {
  const apiKey = ((await songloft.storage.get('api_key')) as string) || '';
  const quality = ((await songloft.storage.get('quality')) as string) || 'flac';
  let platforms: string[] = [...ALL_PLATFORMS];
  try {
    const raw = (await songloft.storage.get('platforms')) as string;
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const clean = arr.map(String).filter((p) => ALL_PLATFORMS.includes(p));
        if (clean.length) platforms = clean;
      }
    }
  } catch {
    /* 非法配置回退全选 */
  }
  return { apiKey, quality, platforms };
}

// ===== HTTP(QuickJS 真异步 fetch + Promise.race 超时,兼容无 AbortController)=====
async function chkszGet(path: string, params: Record<string, string>): Promise<any> {
  const { apiKey } = await getConfig();
  if (!apiKey) throw new Error('未配置 ChKSz API Key(请在插件设置页填写)');

  const qs = Object.entries({ apikey: apiKey, ...params })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${API_BASE}/${path}?${qs}`;

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`ChKSz 请求超时(${path})`)), REQ_TIMEOUT_MS),
  );

  let resp: any;
  try {
    resp = await Promise.race([fetch(url), timeoutPromise]);
  } catch (e: any) {
    throw new Error(`ChKSz 网络请求失败(${path}): ${e?.message || e}`);
  }
  if (!resp.ok) throw new Error(`ChKSz HTTP ${resp.status}(${path})`);

  let body: any;
  try {
    body = await resp.json();
  } catch (e: any) {
    throw new Error(`ChKSz 响应不是 JSON(${path}): ${e?.message || e}`);
  }
  if (!body || body.code !== 200) {
    throw new Error(`ChKSz ${path} 失败 (${body?.code}/${body?.msg || ''})`);
  }
  return body;
}

// ===== 搜索:所选平台并发,单平台失败不影响整体;全失败时报聚合错误 =====
// platforms 为空时使用插件设置的默认平台(默认全选)
async function searchChksz(keyword: string, platforms?: string[]): Promise<SearchResultItem[]> {
  const { platforms: cfgPlatforms } = await getConfig();
  const targets = (platforms && platforms.length ? platforms : cfgPlatforms).filter((p) => ALL_PLATFORMS.includes(p));
  const targetSet = new Set(targets);
  const items: SearchResultItem[] = [];
  const errors: string[] = [];
  const tasks: Promise<void>[] = [];

  // 网易云: data.songs[] = {id, name, artists, album, picUrl, duration(毫秒)}
  if (targetSet.has('wy')) {
    tasks.push((async () => {
    try {
      const wy = await chkszGet('163_search', { keyword, limit: '5' });
      for (const s of wy.data?.songs || []) {
        items.push({
          title: s.name,
          artist: s.artists,
          album: s.album || '',
          duration: Math.round((Number(s.duration) || 0) / 1000),
          cover_url: s.picUrl || undefined,
          source_data: { platform: 'wy', id: String(s.id) },
        });
      }
    } catch (e: any) {
      errors.push(`网易云: ${e?.message || e}`);
      songloft.log.warn(`[chksz] 网易云搜索失败: ${e?.message || e}`);
    }
  })());
  }

  // QQ: list[] = {n, name, singer, album, pay, mid}
  if (targetSet.has('tx')) {
    tasks.push((async () => {
    try {
      const qq = await chkszGet('qq_music', { msg: keyword, num: '5' });
      for (const s of qq.list || []) {
        items.push({
          title: s.name,
          artist: s.singer,
          album: s.album || '',
          duration: 0, // QQ 搜索不返回时长
          source_data: { platform: 'tx', mid: String(s.mid) },
        });
      }
    } catch (e: any) {
      errors.push(`QQ: ${e?.message || e}`);
      songloft.log.warn(`[chksz] QQ搜索失败: ${e?.message || e}`);
    }
  })());
  }

  // 酷狗: list[] = {n, id, name, singer, album, duration(秒)}
  if (targetSet.has('kg')) {
    tasks.push((async () => {
    try {
      const kg = await chkszGet('kugou_music', { msg: keyword, num: '5' });
      for (const s of kg.list || []) {
        items.push({
          title: s.name,
          artist: s.singer,
          album: s.album || '',
          duration: Number(s.duration) || 0,
          source_data: { platform: 'kg', id: String(s.id) },
        });
      }
    } catch (e: any) {
      errors.push(`酷狗: ${e?.message || e}`);
      songloft.log.warn(`[chksz] 酷狗搜索失败: ${e?.message || e}`);
    }
  })());
  }

  await Promise.all(tasks);
  if (!items.length && errors.length) {
    // 所选平台全部失败:透传首个错误,避免前端误判为「无结果」
    throw new Error(`ChKSz 搜索失败(${errors.length}/${targets.length || 1}): ${errors[0]}`);
  }
  return items;
}

// ===== 解析:source_data → 真实播放 URL =====
async function resolveUrl(sourceData: Record<string, unknown>): Promise<ResolvedMusicUrl> {
  const platform = String(sourceData.platform || '');
  const { quality } = await getConfig();

  if (platform === 'wy') {
    const r = await chkszGet('163_music', {
      id: String(sourceData.id),
      level: WY_LEVEL[quality] || 'lossless',
    });
    const url = r.data?.url;
    if (typeof url !== 'string' || !/^https?:/i.test(url)) throw new Error('网易云未返回有效播放链接');
    return { url };
  }
  if (platform === 'tx') {
    const r = await chkszGet('qq_music', {
      mid: String(sourceData.mid),
      size: QK_SIZE[quality] || 'flac',
    });
    if (typeof r.url !== 'string' || !/^https?:/i.test(r.url)) throw new Error(`QQ未返回有效播放链接(mid=${sourceData.mid}): ${JSON.stringify(r).slice(0, 200)}`);
    return { url: r.url };
  }
  if (platform === 'kg') {
    const r = await chkszGet('kugou_music', {
      id: String(sourceData.id),
      size: QK_SIZE[quality] || 'flac',
    });
    if (typeof r.url !== 'string' || !/^https?:/i.test(r.url)) throw new Error(`酷狗未返回有效播放链接(id=${sourceData.id}): ${JSON.stringify(r).slice(0, 200)}`);
    return { url: r.url };
  }
  throw new Error('未知平台: ' + platform);
}

// ===== L1 自搜 fallback:主源解析失败时按 hint 重搜 =====
async function fallbackSearch(hint: MusicUrlFallbackHint): Promise<FallbackMatch | null> {
  const keyword = `${hint.title}${hint.artist ? ' ' + hint.artist : ''}`;
  const results = await searchChksz(keyword);
  if (!results.length) return null;
  const first = results[0];
  return { source_data: first.source_data, title: first.title, artist: first.artist };
}

// ===== 路由 =====
const router = createRouter();

// 音源插件契约(宿主 SourceResolver / SourceFetcher)
// host 音源契约:按插件设置的默认平台搜索(createSearchHandler 只透传 keyword/page/pageSize,
// 因此包一层,避免把 page 误当作 platforms)
router.post('/api/search', createSearchHandler({ search: (keyword) => searchChksz(keyword) }));

// 插件前端搜索:支持平台多选(wy/tx/kg);platforms 为空时用默认配置
router.post('/api/search/select', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const keyword = String(body.keyword || '').trim();
  if (!keyword) return jsonResponse({ error: 'keyword required' }, 400);
  const reqPlatforms = Array.isArray(body.platforms)
    ? body.platforms.map(String).filter((p) => ALL_PLATFORMS.includes(p))
    : [];
  try {
    const results = await searchChksz(keyword, reqPlatforms.length ? reqPlatforms : undefined);
    return jsonResponse({ results });
  } catch (e: any) {
    return jsonResponse({ error: String(e?.message || e) }, 500);
  }
});
router.post('/api/music/url', createMusicUrlHandler({ resolveUrl, fallbackSearch }));

// 插件设置(API Key / 音质)
router.get('/api/settings', async () => {
  const { apiKey, quality, platforms } = await getConfig();
  return jsonResponse({
    api_key_set: !!apiKey,
    api_key_mask: apiKey ? `***${apiKey.slice(-4)}` : '',
    quality,
    platforms,
  });
});

router.post('/api/settings', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  if (typeof body.api_key === 'string') {
    await songloft.storage.set('api_key', body.api_key.trim());
  }
  if (typeof body.quality === 'string' && ['128k', '320k', 'flac'].includes(body.quality)) {
    await songloft.storage.set('quality', body.quality);
  }
  if (Array.isArray(body.platforms)) {
    const clean = body.platforms.map(String).filter((p) => ALL_PLATFORMS.includes(p));
    if (clean.length) await songloft.storage.set('platforms', JSON.stringify(clean));
  }
  return jsonResponse({ ok: true });
});

// 导入搜索结果到曲库(remote 歌曲,自动关联本插件,播放时宿主经 /api/music/url 解析)。
// 供插件前端「搜索→播放」使用;也可被其他插件/脚本调用。
router.post('/api/import', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const item = body.song || body;
  if (!item || !item.title || !item.source_data) {
    return jsonResponse({ error: 'invalid song: title and source_data required' }, 400);
  }
  try {
    const created = await songloft.songs.create([{
      title: item.title,
      artist: item.artist || '',
      album: item.album || '',
      coverUrl: item.cover_url || undefined,
      duration: item.duration || 0,
      sourceData: JSON.stringify(item.source_data),
      dedupKey: `chksz_${item.source_data.platform}_${item.source_data.id || item.source_data.mid}`,
    }]);
    const s = created && created[0];
    if (!s || !s.id) throw new Error('创建歌曲失败,宿主未返回 id');
    return jsonResponse({ ok: true, id: s.id, title: s.title });
  } catch (e: any) {
    songloft.log.error(`[chksz] 导入歌曲失败: ${e?.message || e}`);
    return jsonResponse({ error: String(e?.message || e) }, 500);
  }
});

// ===== 平台内容浏览(网页公开接口,无需 API Key,服务端代理避免 CORS) =====
// 说明:网易云/QQ/酷狗均无官方开放 API,与常见开源播放器一致,这里对接各平台
// 网页端公开接口获取 推荐歌单/排行榜 等资源,仅供个人学习研究使用。
const BROWSE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSE_TIMEOUT_MS = 9000;

async function browseFetch(url: string, opts?: { method?: string; body?: string; referer?: string }): Promise<any> {
  const headers: Record<string, string> = { 'User-Agent': BROWSE_UA };
  if (opts?.referer) headers['Referer'] = opts.referer;
  if (opts?.body) headers['Content-Type'] = 'application/json';
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('资源请求超时')), BROWSE_TIMEOUT_MS),
  );
  let resp: any;
  try {
    resp = await Promise.race([
      fetch(url, { method: opts?.method || 'GET', headers, body: opts?.body }),
      timeoutPromise,
    ]);
  } catch (e: any) {
    throw new Error('网络请求失败: ' + (e?.message || e));
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  try {
    return await resp.json();
  } catch (e: any) {
    throw new Error('响应不是 JSON: ' + (e?.message || e));
  }
}

// ---- 网易云:推荐歌单 + 排行榜 ----
async function browseWy(): Promise<any> {
  const [pl, tl] = await Promise.all([
    browseFetch('https://music.163.com/api/personalized/playlist?limit=9', { referer: 'https://music.163.com/' }),
    browseFetch('https://music.163.com/api/toplist', { referer: 'https://music.163.com/' }),
  ]);
  const playlists = ((pl as any).result || []).map((p: any) => ({
    id: String(p.id),
    name: p.name || '',
    cover: p.picUrl || '',
    play_count: p.playCount || 0,
    track_count: p.trackCount || 0,
  }));
  const toplists = ((tl as any).list || []).slice(0, 10).map((t: any) => ({
    id: String(t.id),
    name: t.name || '',
    cover: t.coverImgUrl || '',
    desc: t.description || '',
  }));
  return {
    modules: [
      { type: 'playlists', title: '猜你喜欢 · 推荐歌单', items: playlists },
      { type: 'toplists', title: '排行榜', items: toplists },
    ],
  };
}

async function browseWyPlaylist(id: string): Promise<any> {
  const d = await browseFetch(
    'https://music.163.com/api/playlist/detail?id=' + encodeURIComponent(id),
    { referer: 'https://music.163.com/' },
  );
  const r = (d as any).result || {};
  const songs = (r.tracks || []).map((t: any) => ({
    title: t.name || '',
    artist: (t.artists || []).map((a: any) => a.name).join('/'),
    album: t.album?.name || '',
    duration: Math.round((Number(t.duration) || 0) / 1000),
    cover_url: t.album?.picUrl || t.picUrl || undefined,
    source_data: { platform: 'wy', id: String(t.id) },
  }));
  return { title: r.name || '', cover: r.coverImgUrl || '', songs };
}

// ---- QQ 音乐:推荐歌单 + 排行榜(musicu.fcg 聚合接口) ----
async function browseTx(): Promise<any> {
  const [pl, tl] = await Promise.all([
    browseFetch(
      'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?format=json&inCharset=utf-8&outCharset=utf-8&categoryId=10000000&sin=0&size=9',
      { referer: 'https://y.qq.com/' },
    ),
    browseFetch('https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?format=json&outCharset=utf-8', {
      referer: 'https://y.qq.com/',
    }),
  ]);
  const playlists = (((pl as any).data || {}).list || []).map((p: any) => ({
    id: String(p.dissid),
    name: p.dissname || '',
    cover: p.imgurl || '',
    play_count: p.listen_count || 0,
    track_count: p.song_count || 0,
  }));
  const toplists = (((tl as any).data || {}).topList || []).slice(0, 10).map((t: any) => ({
    id: String(t.id),
    name: t.topTitle || '',
    cover: t.picUrl || '',
    desc: '',
  }));
  return {
    modules: [
      { type: 'playlists', title: '猜你喜欢 · 推荐歌单', items: playlists },
      { type: 'toplists', title: '排行榜', items: toplists },
    ],
  };
}

async function browseTxPlaylist(id: string): Promise<any> {
  const req = {
    comm: { ct: 24, cv: 0 },
    req_1: {
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: { disstid: Number(id) || 0, enc_host_uin: '', tag: 1, userinfo: 1, song_begin: 0, song_num: 100 },
    },
  };
  const d = await browseFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    body: JSON.stringify(req),
    referer: 'https://y.qq.com/',
  });
  const data = (d as any).req_1?.data || {};
  const info = data.dirinfo || {};
  const songs = (data.songlist || [])
    .map((s: any) => ({
      title: s.name || s.title || '',
      artist: (s.singer || []).map((x: any) => x.name).join('/'),
      album: s.album?.name || s.albumname || '',
      duration: Math.round(Number(s.interval) || 0),
      source_data: { platform: 'tx', mid: String(s.mid || '') },
    }))
    .filter((s: any) => s.source_data.mid);
  if (songs.length) return { title: info.title || '', cover: info.picurl || '', songs };
  // 排行榜 id 不是歌单 id:回退到榜单接口(fcg_v8_toplist_cp)
  const t = await browseFetch(
    'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?format=json&topid=' + encodeURIComponent(id) + '&page=1&num=50',
    { referer: 'https://y.qq.com/' },
  );
  const topSongs = (((t as any).songlist || [])
    .map((s: any) => {
      const dt = s.data || s;
      return {
        title: dt.songname || dt.name || '',
        artist: (dt.singer || []).map((x: any) => x.name).join('/'),
        album: dt.albumname || (dt.album && dt.album.name) || '',
        duration: Math.round(Number(dt.interval) || 0),
        cover_url: dt.albummid
          ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + dt.albummid + '.jpg'
          : undefined,
        source_data: { platform: 'tx', mid: String(dt.songmid || dt.mid || '') },
      };
    }))
    .filter((s: any) => s.source_data.mid);
  return {
    title: String((t as any).topinfo?.ListName || info.title || ''),
    cover: String((t as any).topinfo?.pic || info.picurl || '').replace('T003', 'T002'),
    songs: topSongs,
  };
}

// ---- 酷狗:排行榜(推荐歌单公开接口不可用,仅提供排行榜) ----
async function browseKg(): Promise<any> {
  const d = await browseFetch('http://mobilecdn.kugou.com/api/v3/rank/list?page=1&pagesize=30');
  const toplists = (((d as any).data || {}).info || []).slice(0, 10).map((t: any) => ({
    id: String(t.rankid),
    name: t.rankname || '',
    cover: String(t.imgurl || '').replace('{size}', '400'),
    desc: t.intro || '',
  }));
  return { modules: [{ type: 'toplists', title: '排行榜', items: toplists }] };
}

async function browseKgPlaylist(id: string): Promise<any> {
  const d = await browseFetch(
    'http://m.kugou.com/rank/info/' + encodeURIComponent(id) + '?json=true&page=1&pagesize=50',
  );
  const info = (d as any).info || {};
  const songs = (((d as any).songs || {}).list || [])
    .map((s: any) => ({
      title: s.songname || '',
      artist: (s.authors || []).map((a: any) => a.author_name).join('/'),
      album: s.album_name || s.albumname || '',
      duration: Math.round(Number(s.duration) || 0),
      cover_url: undefined,
      source_data: { platform: 'kg', id: String(s.sqhash || s.hash || '') },
    }))
    .filter((s: any) => s.source_data.id);
  return { title: info.rankname || '', cover: String(info.imgurl || '').replace('{size}', '400'), songs };
}

// 首页模块数据(猜你喜欢/推荐歌单 + 排行榜)
router.get('/api/browse', async (req) => {
  const q = parseQuery(req.query || '');
  const platform = String(q.platform || 'wy');
  try {
    if (platform === 'tx') return jsonResponse(await browseTx());
    if (platform === 'kg') return jsonResponse(await browseKg());
    return jsonResponse(await browseWy());
  } catch (e: any) {
    return jsonResponse({ error: String(e?.message || e) }, 502);
  }
});

// 歌单/榜单详情歌曲列表
router.get('/api/browse/playlist', async (req) => {
  const q = parseQuery(req.query || '');
  const platform = String(q.platform || 'wy');
  const id = String(q.id || '');
  if (!id) return jsonResponse({ error: 'id required' }, 400);
  try {
    if (platform === 'tx') return jsonResponse(await browseTxPlaylist(id));
    if (platform === 'kg') return jsonResponse(await browseKgPlaylist(id));
    return jsonResponse(await browseWyPlaylist(id));
  } catch (e: any) {
    return jsonResponse({ error: String(e?.message || e) }, 502);
  }
});

// 健康检查(宿主健康检查兜底)
router.get('/api/health', async () => jsonResponse({ ok: true }));

// miot 外部搜索源(topone 规范:6 秒超时由 miot 侧 Promise.race 保证)
router.post('/api/search/topone', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const keyword = String(body.keyword || '').trim();
  if (!keyword) return jsonResponse({ code: 1, msg: 'keyword required', data: null });

  try {
    const results = await searchChksz(keyword);
    if (!results.length) return jsonResponse({ code: 1, msg: 'not found', data: null });

    const first = results[0];
    let url = '';
    try {
      const resolved = await resolveUrl(first.source_data);
      url = typeof resolved === 'string' ? resolved : resolved.url;
    } catch (e: any) {
      songloft.log.warn(`[chksz] topone 预解析失败(将走解析型): ${e?.message || e}`);
    }

    return jsonResponse({
      code: 0,
      msg: 'ok',
      data: {
        title: first.title,
        artist: first.artist,
        album: first.album,
        duration: first.duration,
        cover_url: first.cover_url,
        url, // 直链型;为空时 miot 走「入库 + plugin_entry_path 解析型」链路
        plugin_entry_path: 'chksz',
        source_data: first.source_data,
        dedup_key: `chksz_${first.source_data.platform}_${first.source_data.id || first.source_data.mid}`,
      },
    });
  } catch (e: any) {
    return jsonResponse({ code: 1, msg: String(e?.message || e), data: null });
  }
});

// ===== 生命周期 =====
async function onInit(): Promise<void> {
  songloft.log.info('[chksz] ChKSz 音源插件已加载');

  // 向 miot 注册为外部搜索源候选(延迟 + 重试,规避启动竞态;miot 未安装时静默跳过)
  setTimeout(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        if (!songloft.comm || typeof songloft.comm.call !== 'function') return;
        await songloft.comm.call('miot', 'register-search-provider', {
          name: 'ChKSz',
          searchPath: '/api/search/topone',
        });
        songloft.log.info('[chksz] 已向 miot 注册搜索源候选');
        return;
      } catch (e) {
        if (i < 4) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    songloft.log.info('[chksz] miot 未安装/未就绪,放弃注册搜索源');
  }, 2000);
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}

globalThis.onInit = onInit;
globalThis.onHTTPRequest = onHTTPRequest;
