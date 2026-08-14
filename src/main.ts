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

// ===== 配置 =====
async function getConfig(): Promise<{ apiKey: string; quality: string }> {
  const apiKey = ((await songloft.storage.get('api_key')) as string) || '';
  const quality = ((await songloft.storage.get('quality')) as string) || 'flac';
  return { apiKey, quality };
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

// ===== 搜索:三平台并发,单平台失败不影响整体;全失败时报聚合错误 =====
async function searchChksz(keyword: string): Promise<SearchResultItem[]> {
  const items: SearchResultItem[] = [];
  const errors: string[] = [];
  const tasks: Promise<void>[] = [];

  // 网易云: data.songs[] = {id, name, artists, album, picUrl, duration(毫秒)}
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

  // QQ: list[] = {n, name, singer, album, pay, mid}
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

  // 酷狗: list[] = {n, id, name, singer, album, duration(秒)}
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

  await Promise.all(tasks);
  if (!items.length && errors.length) {
    // 全平台失败:透传首个错误,避免前端误判为「无结果」
    throw new Error(`ChKSz 搜索失败(${errors.length}/3): ${errors[0]}`);
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
router.post('/api/search', createSearchHandler({ search: searchChksz }));
router.post('/api/music/url', createMusicUrlHandler({ resolveUrl, fallbackSearch }));

// 插件设置(API Key / 音质)
router.get('/api/settings', async () => {
  const { apiKey, quality } = await getConfig();
  return jsonResponse({
    api_key_set: !!apiKey,
    api_key_mask: apiKey ? `***${apiKey.slice(-4)}` : '',
    quality,
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
