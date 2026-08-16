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

// ===== 歌词接口定义(前端排序/勾选用,与 static/js/lyric.js 的 LYRIC_SOURCES 对应)=====
const ALL_LYRIC_SOURCES = ['lrclib', 'wy', 'tx', 'kg']; // lrclib=LRCLIB 网易云 QQ 酷狗
const DEFAULT_LYRIC_SOURCES = ['lrclib', 'wy', 'tx', 'kg'];

function cleanLyricSources(arr: unknown[]): string[] {
  const clean = (Array.isArray(arr) ? arr : []).map(String).filter((s) => ALL_LYRIC_SOURCES.includes(s));
  // 去重保持顺序
  return [...new Set(clean)];
}

// ===== 配置 =====
async function getConfig(): Promise<{ apiKey: string; quality: string; platforms: string[]; lyricSources: string[]; lyricsEnabled: boolean }> {
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
  let lyricSources: string[] = [...DEFAULT_LYRIC_SOURCES];
  try {
    const raw = (await songloft.storage.get('lyric_sources')) as string;
    if (raw) {
      const arr = JSON.parse(raw);
      const clean = cleanLyricSources(arr);
      if (clean.length) lyricSources = clean;
    }
  } catch {
    /* 非法配置回退全部 */
  }
  const lyricsEnabled = (await songloft.storage.get('lyrics_enabled')) !== false; // 默认开启
  return { apiKey, quality, platforms, lyricSources, lyricsEnabled };
}

// ===== 网易云登录(扫码 / Cookie 导入) =====
const WY_LOGIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154';
const WY_BASE_COOKIE = 'os=pc; appver=2.10.2.200154';
const WY_COOKIE_KEY = 'netease_cookie';
const WY_PROFILE_KEY = 'netease_profile';

async function getNeteaseCookie(): Promise<string> {
  return String((await songloft.storage.get(WY_COOKIE_KEY)) || '').trim();
}

async function getNeteaseProfile(): Promise<any> {
  try {
    const raw = (await songloft.storage.get(WY_PROFILE_KEY)) as string;
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return null;
}

async function saveNeteaseLogin(cookie: string, profile: any): Promise<void> {
  await songloft.storage.set(WY_COOKIE_KEY, cookie.trim());
  if (profile) await songloft.storage.set(WY_PROFILE_KEY, JSON.stringify(profile));
}

function extractNeteaseUserId(profile: any): string {
  const v = profile?.profile?.userId ?? profile?.profile?.account?.id ?? profile?.account?.id ?? profile?.userId ?? profile?.id;
  return v ? String(v) : '';
}

/** 用 Cookie 调账号接口获取 userId / nickname / avatarUrl */
async function fetchNeteaseAccountProfile(cookie: string): Promise<any> {
  const d = await neteaseApiFetch('https://music.163.com/api/nuser/account/get', { cookie });
  return d?.profile || d?.account || null;
}

/** 获取当前登录用户 id;旧版本扫码登录只存了昵称时,这里会兜底补齐 profile */
async function getNeteaseUserId(): Promise<string> {
  const cached = await getNeteaseProfile();
  const cachedId = extractNeteaseUserId(cached);
  if (cachedId) return cachedId;

  const cookie = await getNeteaseCookie();
  if (!cookie) return '';
  try {
    const profile = await fetchNeteaseAccountProfile(cookie);
    if (!profile) return '';
    await saveNeteaseLogin(cookie, {
      profile,
      nickname: profile?.nickname || cached?.nickname || cached?.profile?.nickname || '',
      avatarUrl: profile?.avatarUrl || cached?.avatarUrl || cached?.profile?.avatarUrl || '',
    });
    return extractNeteaseUserId(profile);
  } catch (e: any) {
    songloft.log.warn(`[chksz] 补齐网易云登录用户信息失败: ${e?.message || e}`);
  }
  return '';
}

/** 从 Cookie / Set-Cookie 字符串中提取指定键值(兼容 set-cookie 数组被 join 成逗号分隔串的情况) */
function extractCookieValue(cookie: string, name: string): string {
  if (!cookie) return '';
  const key = name + '=';
  let idx = 0;
  while (idx < cookie.length) {
    idx = cookie.indexOf(key, idx);
    if (idx < 0) return '';
    const before = idx === 0 ? '' : cookie[idx - 1];
    const validBoundary = before === '' || before === ';' || before === ',' || before === ' ' || before === '\t' || before === '\n';
    if (validBoundary) {
      let end = idx + key.length;
      let value = '';
      while (end < cookie.length && cookie[end] !== ';' && cookie[end] !== ',') {
        value += cookie[end];
        end++;
      }
      return value.trim();
    }
    idx += key.length;
  }
  return '';
}

function neteaseCookieHeader(cookie: string): string {
  const parts = [WY_BASE_COOKIE];
  // 登录接口返回的 set-cookie 串会混入 Max-Age/Expires/Domain 以及逗号分隔的重复项,
  // 整串直接作为 Cookie 发送会让网易云判定未登录;这里只保留有效键值。
  const musicU = extractCookieValue(cookie, 'MUSIC_U');
  if (musicU) parts.push('MUSIC_U=' + musicU);
  const csrf = extractCookieValue(cookie, '__csrf');
  if (csrf) parts.push('__csrf=' + csrf);
  return parts.join('; ');
}

function extractSetCookie(resp: any): string {
  try {
    const h = resp.headers;
    if (!h) return '';
    if (typeof h.get === 'function') {
      const v = h.get('set-cookie');
      if (Array.isArray(v)) return v.join('; ');
      return String(v || '');
    }
    const v = h['set-cookie'] || h['Set-Cookie'] || h.set_cookie;
    if (Array.isArray(v)) return v.join('; ');
    if (typeof v === 'string') return v;
  } catch {
    /* ignore */
  }
  return '';
}

/** 网易云登录/账号接口请求(带桌面端 UA,支持自定义 Cookie) */
async function neteaseApiFetchFull(url: string, opts?: { method?: string; body?: string; cookie?: string; exactCookie?: boolean; userAgent?: string }): Promise<{ body: any; setCookie: string }> {
  const headers: Record<string, string> = {
    'User-Agent': opts?.userAgent || WY_LOGIN_UA,
    'Referer': 'https://music.163.com/',
    'Origin': 'https://music.163.com',
    'Accept': 'application/json, text/plain, */*',
    'Cookie': opts?.exactCookie ? (opts.cookie || '') : neteaseCookieHeader(opts?.cookie || ''),
  };
  if (opts?.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('网易云登录请求超时')), REQ_TIMEOUT_MS),
  );
  const resp: any = await Promise.race([
    fetch(url, { method: opts?.method || 'GET', headers, body: opts?.body }),
    timeoutPromise,
  ]);
  if (!resp.ok) throw new Error(`网易云 HTTP ${resp.status}`);
  const setCookie = extractSetCookie(resp);
  return { body: await resp.json(), setCookie };
}

async function neteaseApiFetch(url: string, opts?: { method?: string; body?: string; cookie?: string; exactCookie?: boolean; userAgent?: string }): Promise<any> {
  return (await neteaseApiFetchFull(url, opts)).body;
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

// ===== 搜索排序:topone 是单结果契约,不能依赖平台返回顺序,按关键词/hint 选最匹配 =====
function norm(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[《》〈〉「」『』【】()（）\[\]{}<>.,，。!！?？:：;；"'“”‘’\s\-–—_/\\|~`@#$%^&*+=]+/g, '');
}

const COVER_MARKERS = [
  'dj', 'live', 'demo', 'cover', '翻唱', '童声', '女声', '男声', '钢琴',
  '吉他', '伴奏', '正式版', '治愈版', '柔情版', '网友改编', '清新版', '深情版',
  '改编', '小提琴', '古筝', '现场',
];

function hasCoverMarker(title: string): boolean {
  const t = String(title || '').toLowerCase();
  return COVER_MARKERS.some((m) => t.includes(m));
}

function scoreTrack(item: SearchResultItem, keyword: string, hint?: { title?: string; artist?: string }): number {
  const kw = norm(keyword);
  const title = norm(item.title);
  const artist = norm(item.artist);
  const hintTitle = norm(hint?.title || '');
  const hintArtist = norm(hint?.artist || '');
  const q = hintTitle || kw;
  let score = 0;
  if (!q || !title) return score;

  // 1) 标题完全命中
  if (title === q || title === kw) score += 120;

  // 2) 标题与查询互相包含(例如查询「周杰伦的稻香」命中标题「稻香」)
  if (title.includes(q) || q.includes(title)) score += 70;

  // 3) 歌手命中
  if (artist) {
    if (q.includes(artist)) score += 40;
    if (hintArtist && (artist.includes(hintArtist) || hintArtist.includes(artist))) score += 50;
  }

  // 4) 组合式查询「歌手 歌名」「歌名 歌手」「歌手的歌名」:标题+歌手双命中
  if (artist && kw) {
    if (
      kw === artist + '的' + title ||
      kw === artist + ' ' + title ||
      kw === title + ' ' + artist ||
      kw === artist + title ||
      kw === title + artist
    ) {
      score += 100;
    } else if (kw.includes(title) && kw.includes(artist)) {
      score += 50;
    }
  }

  // 5) 标题带翻唱/现场/童声等标记降权,让原唱优先
  if (hasCoverMarker(item.title)) score -= 30;

  return score;
}

function rankResults(items: SearchResultItem[], keyword: string, hint?: { title?: string; artist?: string }): SearchResultItem[] {
  return [...items].sort((a, b) => scoreTrack(b, keyword, hint) - scoreTrack(a, keyword, hint));
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
  return rankResults(items, keyword);
}

// ===== 解析:source_data → 真实播放 URL =====
const WY_BR: Record<string, number> = { '128k': 128000, '320k': 320000, flac: 999000 };

/** 已登录时优先走网易云官方播放接口(可解析 VIP/付费歌曲),失败再回退 ChKSz */
async function neteaseOfficialUrl(songId: string, quality: string, cookie: string): Promise<string> {
  const br = WY_BR[quality] || 999000;
  const ids = '[' + songId + ']';
  const d = await neteaseApiFetch(
    'https://music.163.com/api/song/enhance/player/url?ids=' + encodeURIComponent(ids) + '&br=' + br,
    { cookie },
  );
  const entry = d?.data?.[0];
  const url = entry?.url;
  if (typeof url !== 'string' || !/^https?:/i.test(url)) throw new Error('网易云官方接口未返回有效播放链接');
  // VIP/付费歌曲官方接口只回 30s 试听(freeTrialInfo 非空 或 fee>0 且 payed=0),
  // 试听链接也是合法 http URL,必须显式识别,否则不会回退 ChKSz → 播放 30 秒试听
  const isTrial = entry?.freeTrialInfo != null || (Number(entry?.fee) > 0 && !entry?.payed);
  if (isTrial) throw new Error('网易云官方接口仅返回试听(VIP 歌曲),回退 ChKSz 解析');
  return url;
}

async function resolveUrl(sourceData: Record<string, unknown>): Promise<ResolvedMusicUrl> {
  const platform = String(sourceData.platform || '');
  const { quality } = await getConfig();

  if (platform === 'wy') {
    const wyCookie = await getNeteaseCookie();
    if (wyCookie) {
      try {
        return { url: await neteaseOfficialUrl(String(sourceData.id), quality, wyCookie) };
      } catch (e: any) {
        songloft.log.warn(`[chksz] 网易云官方解析失败,回退 ChKSz: ${e?.message || e}`);
      }
    }
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

// 插件设置(API Key / 音质 / 歌词接口优先级 / 歌词开关)
router.get('/api/settings', async () => {
  const { apiKey, quality, platforms, lyricSources, lyricsEnabled } = await getConfig();
  const wyProfile = await getNeteaseProfile();
  return jsonResponse({
    api_key_set: !!apiKey,
    api_key_mask: apiKey ? `***${apiKey.slice(-4)}` : '',
    quality,
    platforms,
    lyric_sources: lyricSources,
    lyrics_enabled: lyricsEnabled,
    netease_login: {
      logged_in: !!(await getNeteaseCookie()),
      nickname: wyProfile?.nickname || wyProfile?.profile?.nickname || '',
      avatar_url: wyProfile?.avatarUrl || wyProfile?.profile?.avatarUrl || '',
    },
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
  if (Array.isArray(body.lyric_sources)) {
    const clean = cleanLyricSources(body.lyric_sources);
    if (clean.length) await songloft.storage.set('lyric_sources', JSON.stringify(clean));
  }
  if (typeof body.lyrics_enabled === 'boolean') {
    await songloft.storage.set('lyrics_enabled', body.lyrics_enabled);
  }
  return jsonResponse({ ok: true });
});

// ===== 网易云登录:扫码 / Cookie 导入 =====
router.get('/api/netease/login/status', async () => {
  const profile = await getNeteaseProfile();
  return jsonResponse({
    logged_in: !!(await getNeteaseCookie()),
    nickname: profile?.nickname || profile?.profile?.nickname || '',
    avatar_url: profile?.avatarUrl || profile?.profile?.avatarUrl || '',
  });
});

// 获取扫码登录 key(前端用 key 生成二维码 / 打开网易云登录页)
router.get('/api/netease/login/qr', async () => {
  try {
    const d = await neteaseApiFetch('https://music.163.com/api/login/qrcode/unikey?type=1');
    const key = String(d?.unikey || d?.data?.unikey || '');
    if (!key) throw new Error('网易云未返回 unikey');
    return jsonResponse({ ok: true, key, url: 'https://music.163.com/login?codekey=' + encodeURIComponent(key) });
  } catch (e: any) {
    return jsonResponse({ error: String(e?.message || e) }, 502);
  }
});

// 轮询扫码结果;code=803 时自动保存 Cookie 和用户信息
router.get('/api/netease/login/qr/check', async (req) => {
  const q = parseQuery(req.query || '');
  const key = String(q.key || '').trim();
  if (!key) return jsonResponse({ code: 1, msg: 'key required', data: null });
  try {
    const full = await neteaseApiFetchFull(
      'https://music.163.com/api/login/qrcode/client/login?key=' + encodeURIComponent(key) + '&type=1',
    );
    const d = full.body;
    const cookie = (typeof d?.cookie === 'string' && d.cookie.trim()) ? d.cookie : full.setCookie;
    const code = Number(d?.code) || 0;
    if (code === 803 && cookie) {
      // 扫码接口通常只返回 MUSIC_U 与昵称,不返回 userId;这里补调账号接口,
      // 否则 /api/browse 无法展示「我喜欢的音乐 / 创建的歌单 / 收藏的歌单」。
      let profile = d?.profile || null;
      if (!extractNeteaseUserId(profile)) {
        try {
          profile = await fetchNeteaseAccountProfile(cookie);
        } catch (e: any) {
          songloft.log.warn(`[chksz] 扫码登录后获取用户信息失败: ${e?.message || e}`);
        }
      }
      await saveNeteaseLogin(cookie, {
        ...(profile && typeof profile === 'object' ? { profile } : {}),
        nickname: profile?.nickname || d?.nickname || '',
        avatarUrl: profile?.avatarUrl || d?.avatarUrl || '',
      });
    }
    return jsonResponse({
      code,
      msg: String(d?.message || ''),
      logged_in: code === 803 && !!cookie,
      nickname: d?.nickname || d?.profile?.nickname || '',
      avatar_url: d?.avatarUrl || d?.profile?.avatarUrl || '',
    });
  } catch (e: any) {
    return jsonResponse({ code: 1, msg: String(e?.message || e), data: null });
  }
});

// ===== 网易云 EAPI(网页/手机号登录用) =====
const WY_EAPI_KEY = 'e82ckenh8dichen8';

function wyAesEcb(text: string): string {
  return __go_crypto_aes_encrypt(__go_buffer_from(text, 'utf8'), 'ecb', __go_buffer_from(WY_EAPI_KEY, 'utf8'), '');
}

function wyEapi(uri: string, data: Record<string, unknown>): string {
  const text = JSON.stringify(data);
  const digest = __go_crypto_md5('nobody' + uri + 'use' + text + 'md5forencrypt');
  const raw = uri + '-36cd479b6b5-' + text + '-36cd479b6b5-' + digest;
  return wyAesEcb(raw).toUpperCase();
}

function buildWyEapiHeader(): Record<string, string> {
  const now = Date.now();
  const deviceId = __go_crypto_md5('chksz-' + now + '-' + Math.random());
  return {
    osver: 'Microsoft-Windows-10-Professional-build-22631-64bit',
    deviceId,
    os: 'pc',
    appver: '3.0.18.203152',
    versioncode: '140',
    mobilename: '',
    buildver: String(Math.floor(now / 1000)).slice(0, 10),
    resolution: '1920x1080',
    __csrf: '',
    channel: 'netease',
    requestId: now + '_' + String(Math.floor(Math.random() * 1000)).padStart(4, '0'),
  };
}

function wyEapiCookie(header: Record<string, string>): string {
  return Object.keys(header).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(header[k])).join('; ');
}

// 网页登录:手机号 + 密码(NetEase EAPI,登录成功后从响应头自动取 Cookie)
async function neteaseCellphoneLogin(phone: string, countrycode: string, password: string): Promise<{ body: any; setCookie: string }> {
  const header = buildWyEapiHeader();
  const data: Record<string, unknown> = {
    type: '1',
    https: 'true',
    phone,
    countrycode: countrycode || '86',
    password: __go_crypto_md5(password),
    rememberLogin: 'true',
    header,
  };
  const uri = '/api/w/login/cellphone';
  const params = wyEapi(uri, data);
  return await neteaseApiFetchFull('https://interface.music.163.com/eapi/w/login/cellphone', {
    method: 'POST',
    body: 'params=' + encodeURIComponent(params),
    cookie: wyEapiCookie(header),
    exactCookie: true,
    userAgent: 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)',
  });
}

// 网页登录:手机号 + 密码(登录成功后自动保存响应 Cookie)
router.post('/api/netease/login/cellphone', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const phone = String(body.phone || '').trim();
  const countrycode = String(body.countrycode || '86').trim();
  const password = String(body.password || '');
  if (!phone || !password) return jsonResponse({ error: 'phone and password required' }, 400);
  try {
    const { body: d, setCookie } = await neteaseCellphoneLogin(phone, countrycode, password);
    const code = Number(d?.code) || 0;
    if (code === 200 && setCookie) {
      let profile = d?.profile || d?.account || null;
      if (!extractNeteaseUserId(profile)) {
        try {
          profile = await fetchNeteaseAccountProfile(setCookie);
        } catch (e: any) {
          songloft.log.warn(`[chksz] 网页登录后获取用户信息失败: ${e?.message || e}`);
        }
      }
      await saveNeteaseLogin(setCookie, {
        ...(profile && typeof profile === 'object' ? { profile } : {}),
        nickname: profile?.nickname || d?.nickname || '',
        avatarUrl: profile?.avatarUrl || d?.avatarUrl || '',
      });
      return jsonResponse({ ok: true, logged_in: true, profile: profile || null });
    }
    if (code === 200) {
      return jsonResponse({ error: '登录接口未返回 Cookie,请改用扫码或 Cookie 导入' }, 502);
    }
    return jsonResponse({ error: String(d?.message || d?.msg || `登录失败(${code || 'unknown'})`) }, 400);
  } catch (e: any) {
    return jsonResponse({ error: String(e?.message || e) }, 502);
  }
});

// 官方网页登录(URS SDK)成功后,nextUrls 会在浏览器侧种 Cookie;
// 插件后端没有浏览器 Cookie,这里服务端再请求一遍 nextUrls 并抓取 set-cookie。
function isAllowedWyLoginUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'music.163.com' || h.endsWith('.music.163.com') ||
      h === 'interface.music.163.com' || h === 'dl.reg.163.com' || h.endsWith('.reg.163.com');
  } catch {
    return false;
  }
}

async function fetchWyNextUrl(url: string): Promise<string> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('网易云登录回写请求超时')), REQ_TIMEOUT_MS),
  );
  const resp: any = await Promise.race([
    fetch(url, {
      headers: {
        'User-Agent': BROWSE_UA,
        'Referer': 'https://music.163.com/',
        'Accept': '*/*',
      },
      redirect: 'follow',
    }),
    timeoutPromise,
  ]);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const setCookie = extractSetCookie(resp);
  try { await resp.text(); } catch { /* 忽略 body 读取错误 */ }
  return setCookie;
}

// 官方网页登录(手机验证码 / 手机密码)成功回调:回写 MUSIC_U 并保存 profile
router.post('/api/netease/login/urs', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const urls: string[] = (Array.isArray(body.urls) ? body.urls : [])
    .map(String)
    .map((u) => (/^\/\//.test(u) ? 'https:' + u : u))
    .filter((u) => /^https?:/i.test(u) && isAllowedWyLoginUrl(u));
  if (!urls.length) return jsonResponse({ error: '官方登录成功,但未返回登录回写地址,请改用扫码或 Cookie 导入' }, 502);

  const cookieParts: string[] = [];
  try {
    for (const url of urls) {
      const setCookie = await fetchWyNextUrl(url);
      if (setCookie) cookieParts.push(setCookie);
    }
  } catch (e: any) {
    return jsonResponse({ error: '网易云登录回写失败: ' + String(e?.message || e) }, 502);
  }

  const combined = cookieParts.join('; ');
  const cleanCookie = neteaseCookieHeader(combined);
  if (!extractCookieValue(cleanCookie, 'MUSIC_U')) {
    return jsonResponse({ error: '官方登录未返回 MUSIC_U,请改用扫码或 Cookie 导入' }, 502);
  }
  try {
    const profile = await fetchNeteaseAccountProfile(cleanCookie);
    if (!profile) return jsonResponse({ error: '官方登录 Cookie 无法验证,请改用扫码或 Cookie 导入' }, 502);
    await saveNeteaseLogin(cleanCookie, {
      profile,
      nickname: profile?.nickname || '',
      avatarUrl: profile?.avatarUrl || '',
    });
    return jsonResponse({ ok: true, logged_in: true, profile });
  } catch (e: any) {
    return jsonResponse({ error: '网易云登录验证失败: ' + String(e?.message || e) }, 502);
  }
});

// 网页登录 / Cookie 导入:验证 MUSIC_U 并保存
function normalizeWYCookie(input: string): string {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.replace(/^["']|["']$/g, '');
  if (s.includes('MUSIC_U=')) return s;
  return 'MUSIC_U=' + s;
}

router.post('/api/netease/login/cookie', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const cookie = normalizeWYCookie(body.cookie);
  if (!cookie) return jsonResponse({ error: 'cookie required' }, 400);
  try {
    const profile = await fetchNeteaseAccountProfile(cookie);
    if (!profile) {
      return jsonResponse({ error: 'Cookie 无效或已过期' }, 400);
    }
    await saveNeteaseLogin(cookie, { profile, nickname: profile?.nickname || '', avatarUrl: profile?.avatarUrl || '' });
    return jsonResponse({ ok: true, logged_in: true, profile });
  } catch (e: any) {
    return jsonResponse({ error: String(e?.message || e) }, 502);
  }
});

router.post('/api/netease/logout', async () => {
  await songloft.storage.set(WY_COOKIE_KEY, '');
  await songloft.storage.set(WY_PROFILE_KEY, '');
  return jsonResponse({ ok: true });
});

// ===== 歌曲入库(remote 歌曲,自动关联本插件,播放时宿主经 /api/music/url 解析) =====
function buildCreateSongInput(item: any) {
  return {
    title: String(item.title || '').trim(),
    artist: item.artist || '',
    album: item.album || '',
    coverUrl: item.cover_url || undefined,
    duration: item.duration || 0,
    sourceData: JSON.stringify(item.source_data),
    dedupKey: `chksz_${item.source_data.platform}_${item.source_data.id || item.source_data.mid}`,
  };
}

async function importSongToLibrary(item: any): Promise<number> {
  const created = await songloft.songs.create([buildCreateSongInput(item)]);
  const s = created && created[0];
  if (!s || !s.id) throw new Error('创建歌曲失败,宿主未返回 id');
  return s.id;
}

// 批量入库:逐首导入(保留 source_data,宿主按 dedup_key 去重,重复导入返回原 id)
async function importSongsToLibrary(songs: any[]): Promise<{ songIds: number[]; failed: number; errors: string[] }> {
  const songIds: number[] = [];
  const errors: string[] = [];
  for (let i = 0; i < songs.length; i++) {
    try {
      songIds.push(await importSongToLibrary(songs[i]));
    } catch (e: any) {
      errors.push(`[${i + 1}] ${e?.message || e}`);
      songloft.log.warn(`[chksz] 歌单歌曲入库失败 ${i + 1}/${songs.length}: ${e?.message || e}`);
    }
  }
  return { songIds, failed: errors.length, errors };
}

// 导入搜索结果到曲库。
// 供插件前端「搜索→播放」使用;也可被其他插件/脚本调用。
router.post('/api/import', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const item = body.song || body;
  if (!item || !item.title || !item.source_data) {
    return jsonResponse({ error: 'invalid song: title and source_data required' }, 400);
  }
  try {
    const id = await importSongToLibrary(item);
    return jsonResponse({ ok: true, id, title: item.title });
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

async function browseFetch(url: string, opts?: { method?: string; body?: string; referer?: string; headers?: Record<string, string> }): Promise<any> {
  const headers: Record<string, string> = { 'User-Agent': BROWSE_UA };
  if (opts?.headers) Object.assign(headers, opts.headers);
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

/** 同 browseFetch,但按纯文本读取(用于酷狗 krc 等纯文本接口) */
async function browseFetchText(url: string, opts?: { referer?: string; headers?: Record<string, string> }): Promise<string> {
  const headers: Record<string, string> = { 'User-Agent': BROWSE_UA };
  if (opts?.headers) Object.assign(headers, opts.headers);
  if (opts?.referer) headers['Referer'] = opts.referer;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('资源请求超时')), BROWSE_TIMEOUT_MS),
  );
  let resp: any;
  try {
    resp = await Promise.race([
      fetch(url, { headers }),
      timeoutPromise,
    ]);
  } catch (e: any) {
    throw new Error('网络请求失败: ' + (e?.message || e));
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}


// ===== 歌词搜索与获取(多接口 + 优先级) =====
// 参考 https://github.com/Ryderwe/Sollin-Music-Desktop 的多源歌词思路:
//   - lrclib: https://lrclib.net (聚合公开 LRC / 纯文本歌词,按歌名+歌手搜索)
//   - wy:  网易云网页公开接口(搜索歌曲 → 取歌词)
//   - tx:  QQ音乐网页公开接口(搜索歌曲 → 取歌词)
//   - kg:  酷狗网页公开接口(搜索歌曲 → 取歌词)
// 插件通过 songloft.lyrics.registerProvider() 注册为宿主歌词提供者,
// 宿主在歌曲无歌词时调用本插件 /lyric-search 端点自动获取。
const LYRIC_SOURCE_NAMES: Record<string, string> = {
  lrclib: 'LRCLIB',
  wy: '网易云',
  tx: 'QQ音乐',
  kg: '酷狗',
};

type LyricQuery = {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  platform?: string;
  source_data?: Record<string, unknown>;
};

type LyricResult = {
  lyric: string;
  source: string;
  title?: string;
  artist?: string;
  album?: string;
  matched?: boolean;
};

/** 判断一段文本是不是「有效歌词」——太短(<20字符)或只有元信息时视为无效 */
function isValidLyric(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  // 只过滤元信息标签(如 [ar:]/[ti:]/[id:$...]),不要过滤 [00:12.34] 这类时间轴行
  const contentLines = t.split('\n').filter((l) => {
    const line = l.trim();
    if (!line) return false;
    if (/^\[(ar|ti|al|by|offset|total|hash|sign|qq|id):/i.test(line)) return false;
    if (/^\[id:\$/.test(line)) return false;
    return true;
  });
  return contentLines.length >= 2;
}

function lrcOrPlain(plain: string, synced: string): string {
  if (synced && isValidLyric(synced)) return synced;
  if (plain && isValidLyric(plain)) return plain;
  return synced || plain || '';
}

function combineLyric(primary: string, translation?: string): string {
  const a = String(primary || '').trim();
  const b = String(translation || '').trim();
  if (!a) return b;
  if (!b || b === a) return a;
  return a + '\n' + b;
}

// ---- lrclib:无需歌曲 id,按歌名/歌手搜索 ----
async function lyricFromLrclib(q: LyricQuery): Promise<LyricResult> {
  const title = String(q.title || '').trim();
  const artist = String(q.artist || '').trim();
  const keyword = [title, artist].filter(Boolean).join(' ');
  if (!keyword) throw new Error('缺少歌名/歌手');

  const params = new URLSearchParams();
  if (title) params.set('track_name', title);
  if (artist) params.set('artist_name', artist);
  params.set('q', keyword);
  const d = await browseFetch('https://lrclib.net/api/search?' + params.toString(), {
    referer: 'https://lrclib.net/',
  });
  const list: any[] = Array.isArray(d) ? d : [];
  if (!list.length) throw new Error('LRCLIB 未找到歌词');

  // 优先挑同步歌词(syncedLyrics),其次纯文本
  const exact = list.find((it) =>
    (!title || (it.trackName || '').toLowerCase() === title.toLowerCase()) &&
    (!artist || (it.artistName || '').toLowerCase() === artist.toLowerCase())
  ) || list[0];

  const text = lrcOrPlain(exact.plainLyrics, exact.syncedLyrics);
  if (!text) throw new Error('LRCLIB 无有效歌词');
  return {
    lyric: text,
    source: 'lrclib',
    title: exact.trackName || exact.name || title,
    artist: exact.artistName || artist,
    album: exact.albumName || q.album || '',
    matched: !!exact,
  };
}

// ---- 网易云:搜索歌曲 → 取歌词(公开接口,无需 API Key) ----
async function lyricFromWy(q: LyricQuery): Promise<LyricResult> {
  const keyword = [q.title, q.artist].filter(Boolean).join(' ');
  if (!keyword) throw new Error('缺少歌名/歌手');

  // 若已具备网易云 id,直接取歌词,跳过搜索
  let songId = q.source_data?.id ? String(q.source_data.id) : '';
  let matchedTitle = q.title || '';
  let matchedArtist = q.artist || '';
  if (!songId) {
    const search = await browseFetch(
      'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(keyword) + '&type=1&limit=5',
      { referer: 'https://music.163.com/' },
    );
    const songs: any[] = search?.result?.songs || [];
    if (!songs.length) throw new Error('网易云未找到歌曲');
    const hit = q.source_data?.platform === 'wy' ? songs[0] : rankSongByTitle(songs, q);
    songId = String(hit.id || '');
    matchedTitle = hit.name || q.title || '';
    matchedArtist = (hit.artists || []).map((a: any) => a.name).join('/') || q.artist || '';
  }

  const d = await browseFetch(
    'https://music.163.com/api/song/lyric?id=' + encodeURIComponent(songId) + '&lv=-1&kv=-1&tv=-1',
    { referer: 'https://music.163.com/' },
  );
  const text = combineLyric(d?.lrc?.lyric || '', d?.tlyric?.lyric || '');
  if (!isValidLyric(text)) throw new Error('网易云歌词为空');
  return { lyric: text, source: 'wy', title: matchedTitle, artist: matchedArtist, matched: true };
}

/** 按标题精确度给搜索结果打分,优先原唱/标题完全一致 */
function rankSongByTitle(songs: any[], q: LyricQuery): any {
  const t = String(q.title || '').trim().toLowerCase();
  return [...songs].sort((a, b) => {
    const at = String(a.name || '').toLowerCase();
    const bt = String(b.name || '').toLowerCase();
    const ac = at === t ? 1 : at.includes(t) || t.includes(at) ? 0 : -1;
    const bc = bt === t ? 1 : bt.includes(t) || t.includes(bt) ? 0 : -1;
    return bc - ac;
  })[0];
}

// ---- QQ音乐:搜索歌曲 → 取歌词(公开接口) ----
async function lyricFromTx(q: LyricQuery): Promise<LyricResult> {
  const keyword = [q.title, q.artist].filter(Boolean).join(' ');
  if (!keyword) throw new Error('缺少歌名/歌手');

  let mid = q.source_data?.mid ? String(q.source_data.mid) : '';
  let matchedTitle = q.title || '';
  let matchedArtist = q.artist || '';
  if (!mid) {
    const search = await browseFetch(
      'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=5&w=' + encodeURIComponent(keyword),
      { referer: 'https://y.qq.com/' },
    );
    const songs: any[] = search?.data?.song?.list || [];
    if (!songs.length) throw new Error('QQ音乐未找到歌曲');
    const hit = rankTxSongs(songs, q);
    mid = String(hit.songmid || '');
    matchedTitle = hit.songname || hit.name || q.title || '';
    matchedArtist = (hit.singer || []).map((s: any) => s.name).join('/') || q.artist || '';
  }

  const d = await browseFetch(
    'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + encodeURIComponent(mid) + '&format=json&nobase64=1',
    { referer: 'https://y.qq.com/' },
  );
  // nobase64=1 时 lyric 已是明文 LRC;部分接口仍返回 base64(旧接口),兜底解码
  let text = String(d?.lyric || '');
  if (!text && d?.lyric) {
    try { text = new TextDecoder('utf-8').decode(base64ToBytes(d.lyric)); } catch { /* ignore */ }
  }
  if (!isValidLyric(text)) throw new Error('QQ音乐歌词为空');
  return { lyric: text, source: 'tx', title: matchedTitle, artist: matchedArtist, matched: true };
}

function rankTxSongs(songs: any[], q: LyricQuery): any {
  const t = String(q.title || '').trim().toLowerCase();
  return [...songs].sort((a, b) => {
    const at = String(a.songname || a.name || '').toLowerCase();
    const bt = String(b.songname || b.name || '').toLowerCase();
    const ac = at === t ? 1 : at.includes(t) || t.includes(at) ? 0 : -1;
    const bc = bt === t ? 1 : bt.includes(t) || t.includes(bt) ? 0 : -1;
    return bc - ac;
  })[0];
}

// ---- 酷狗:搜索歌曲 → 取歌词(公开接口) ----
async function lyricFromKg(q: LyricQuery): Promise<LyricResult> {
  const keyword = [q.title, q.artist].filter(Boolean).join(' ');
  if (!keyword) throw new Error('缺少歌名/歌手');

  let hash = q.source_data?.id ? String(q.source_data.id) : '';
  let matchedTitle = q.title || '';
  let matchedArtist = q.artist || '';
  let durationMs = Number(q.duration) * 1000 || 0;
  if (!hash) {
    const search = await browseFetch(
      'http://mobilecdn.kugou.com/api/v3/search/song?format=json&page=1&pagesize=5&keyword=' + encodeURIComponent(keyword),
      { referer: 'http://m.kugou.com/' },
    );
    const songs: any[] = search?.data?.info || [];
    if (!songs.length) throw new Error('酷狗未找到歌曲');
    const hit = rankKgSongs(songs, q);
    hash = String(hit.hash || '');
    matchedTitle = hit.songname || q.title || '';
    matchedArtist = (hit.singername || '').replace(/独立|独立音乐人/g, '') || q.artist || '';
    if (!durationMs) durationMs = Number(hit.duration) * 1000 || 0;
  }

  // 酷狗 krc 接口需要 timelength 才会返回内容;没有时长时给一个合理兜底
  const timelength = durationMs > 0 ? String(durationMs) : '300000';
  const lyric = await browseFetchText(
    'http://m.kugou.com/app/i/krc.php?cmd=100&hash=' + encodeURIComponent(hash) + '&timelength=' + encodeURIComponent(timelength),
    { referer: 'http://m.kugou.com/', headers: { 'Accept': 'text/plain, */*' } },
  ).catch(() => '');

  if (!isValidLyric(lyric)) throw new Error('酷狗歌词为空');
  return { lyric, source: 'kg', title: matchedTitle, artist: matchedArtist, matched: true };
}

function rankKgSongs(songs: any[], q: LyricQuery): any {
  const t = String(q.title || '').trim().toLowerCase();
  return [...songs].sort((a, b) => {
    const at = String(a.songname || a.name || '').toLowerCase();
    const bt = String(b.songname || b.name || '').toLowerCase();
    const ac = at === t ? 1 : at.includes(t) || t.includes(at) ? 0 : -1;
    const bc = bt === t ? 1 : bt.includes(t) || t.includes(bt) ? 0 : -1;
    return bc - ac;
  })[0];
}

/** 粗略判断是否为带时间轴的 LRC(宿主播放器优先展示同步歌词) */
function isLrcText(text: string): boolean {
  return /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(String(text || ''));
}

// ---- 统一获取:按指定接口或优先级顺序尝试 ----
// 说明:宿主播放器对 LRC 同步歌词支持最好,因此多接口时优先返回带时间轴的 LRC;
// 若前面接口只返回纯文本,先记为兜底,继续尝试后续接口找 LRC,最后才用纯文本。
async function fetchLyric(q: LyricQuery, source?: string): Promise<LyricResult> {
  const { lyricSources } = await getConfig();
  // 指定了 source 则只试该接口;否则按配置优先级依次尝试
  const tries = source
    ? [source]
    : (lyricSources.length ? lyricSources : DEFAULT_LYRIC_SOURCES);

  let lastErr = '';
  let plainFallback: LyricResult | null = null;
  for (const s of tries) {
    try {
      const r = await (async () => {
        if (s === 'lrclib') return await lyricFromLrclib(q);
        if (s === 'wy') return await lyricFromWy(q);
        if (s === 'tx') return await lyricFromTx(q);
        if (s === 'kg') return await lyricFromKg(q);
        throw new Error('未知歌词接口: ' + s);
      })();
      if (r && r.lyric) {
        if (isLrcText(r.lyric)) return r;
        if (!plainFallback) plainFallback = r;
      }
    } catch (e: any) {
      lastErr = (lastErr ? lastErr + '; ' : '') + `${LYRIC_SOURCE_NAMES[s] || s}: ${e?.message || e}`;
      songloft.log.warn(`[chksz] 歌词接口 ${s} 获取失败: ${e?.message || e}`);
    }
  }
  if (plainFallback) return plainFallback;
  throw new Error(lastErr || '所有歌词接口均未找到歌词');
}

/** 按歌名/歌手搜索多接口歌词,用于前端「搜索歌词」面板 */
async function searchLyricsMulti(keyword: string): Promise<{ source: string; title: string; artist: string; album: string; preview: string; lyric: string }[]> {
  const { lyricSources } = await getConfig();
  const sources = lyricSources.length ? lyricSources : DEFAULT_LYRIC_SOURCES;
  const results: { source: string; title: string; artist: string; album: string; preview: string; lyric: string }[] = [];
  const tasks: Promise<void>[] = [];

  for (const s of sources) {
    tasks.push((async () => {
      try {
        const r = await fetchLyric({ title: keyword }, s);
        if (r.lyric) {
          results.push({
            source: r.source || s,
            title: r.title || '',
            artist: r.artist || '',
            album: r.album || '',
            preview: r.lyric.slice(0, 150),
            lyric: r.lyric,
          });
        }
      } catch (e: any) {
        songloft.log.warn(`[chksz] 歌词搜索 ${s} 失败: ${e?.message || e}`);
      }
    })());
  }
  await Promise.all(tasks);
  return results;
}

/** base64 → bytes(用于 QQ 歌词旧接口返回 base64 的情况) */
function base64ToBytes(b64: string): Uint8Array {
  // QuickJS 环境没有 atob,用纯 JS 解码(兼容 SDK 提供的 Buffer)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let str = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (str.length % 4 === 1) str = str.slice(0, -1);
  let out: number[] = [];
  let buffer = 0, bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = chars.indexOf(str[i]);
    if (c < 0) continue;
    buffer = (buffer << 6) | c;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ===== 歌词路由 =====

// 宿主歌词提供者契约:歌曲无歌词时宿主 InvokeHTTP 调用本端点。
// 支持 GET(query) 或 POST(JSON),字段:title/artist/album/duration/source_data(可选 JSON 字符串)。
router.post('/lyric-search', async (req) => {
  return await handleLyricSearch(req, false);
});
router.get('/lyric-search', async (req) => {
  return await handleLyricSearch(req, true);
});

async function handleLyricSearch(req: HTTPRequest, isGet: boolean): Promise<HTTPResponse> {
  const { lyricsEnabled } = await getConfig();
  if (!lyricsEnabled) {
    return jsonResponse({ error: 'lyrics search disabled' }, 503);
  }

  let body: any = {};
  if (isGet) {
    const q = parseQuery(req.query || '');
    body = { ...q };
    if (body.source_data) {
      try { body.source_data = JSON.parse(body.source_data); } catch { /* ignore */ }
    }
  } else {
    try { body = JSON.parse((req.body as string) || '{}'); } catch { /* ignore */ }
  }
  const title = String(body.title || body.track_name || body.trackName || '').trim();
  const artist = String(body.artist || body.artist_name || body.artistName || '').trim();
  const album = String(body.album || body.album_name || body.albumName || '').trim();
  const duration = Number(body.duration || 0) || 0;
  const sourceData = (body.source_data && typeof body.source_data === 'object') ? body.source_data : undefined;
  const specificSource = String(body.source || body.lyric_source || '').trim();
  if (!title && !artist) {
    return jsonResponse({ error: 'title or artist required' }, 400);
  }

  try {
    const result = await fetchLyric({ title, artist, album, duration, source_data: sourceData }, specificSource || undefined);
    return jsonResponse({
      lyric: result.lyric,
      lrc: result.lyric, // 兼容宿主可能期望的字段名
      lyric_source: result.source,
      lyricSource: result.source,
      title: result.title || title,
      artist: result.artist || artist,
      album: result.album || album,
      ok: true,
    });
  } catch (e: any) {
    return jsonResponse({ error: String(e?.message || e) }, 404);
  }
}

// 前端「搜索歌词」:按关键词跨所有已启用接口搜索
router.post('/api/lyric/search', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const keyword = String(body.keyword || '').trim();
  if (!keyword) return jsonResponse({ error: 'keyword required' }, 400);
  try {
    const results = await searchLyricsMulti(keyword);
    return jsonResponse({ results });
  } catch (e: any) {
    return jsonResponse({ error: String(e?.message || e) }, 500);
  }
});

// 前端:为指定歌曲按指定接口(或按优先级)重新获取歌词
router.post('/api/lyric/fetch', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const item = body.song || body;
  const title = String(item.title || body.title || '').trim();
  const artist = String(item.artist || body.artist || '').trim();
  if (!title && !artist) return jsonResponse({ error: 'title or artist required' }, 400);
  const specificSource = String(body.source || body.lyric_source || '').trim();
  let sourceData: Record<string, unknown> | undefined;
  if (item.source_data && typeof item.source_data === 'object') sourceData = item.source_data as Record<string, unknown>;
  try {
    const result = await fetchLyric({
      title,
      artist,
      album: String(item.album || body.album || '').trim(),
      duration: Number(item.duration || body.duration || 0) || 0,
      source_data: sourceData,
    }, specificSource || undefined);
    return jsonResponse({ ...result, ok: true });
  } catch (e: any) {
    return jsonResponse({ error: String(e?.message || e) }, 404);
  }
});

// 兼容官方歌词插件的配置/测试接口(便于前端与外部工具使用)
router.get('/config', async () => {
  const { lyricsEnabled, lyricSources } = await getConfig();
  return jsonResponse({
    enabled: lyricsEnabled,
    provider: lyricSources[0] || 'lrclib',
    customUrl: '',
    lyric_sources: lyricSources,
  });
});

router.put('/config', async (req) => {
  let body: any = {};
  try { body = JSON.parse((req.body as string) || '{}'); } catch { /* ignore */ }
  if (typeof body.enabled === 'boolean') {
    await songloft.storage.set('lyrics_enabled', body.enabled);
  }
  if (Array.isArray(body.lyric_sources)) {
    const clean = cleanLyricSources(body.lyric_sources);
    if (clean.length) await songloft.storage.set('lyric_sources', JSON.stringify(clean));
  }
  const { lyricsEnabled, lyricSources } = await getConfig();
  return jsonResponse({
    status: 'ok',
    config: { enabled: lyricsEnabled, provider: lyricSources[0] || 'lrclib', customUrl: '', lyric_sources: lyricSources },
  });
});

router.get('/test-search', async (req) => {
  const q = parseQuery(req.query || '');
  const title = String(q.title || '').trim();
  const artist = String(q.artist || '').trim();
  if (!title && !artist) return jsonResponse({ error: 'title or artist required' }, 400);
  try {
    const result = await fetchLyric({ title, artist });
    return jsonResponse({ success: true, preview: result.lyric.slice(0, 300), source: result.source });
  } catch (e: any) {
    return jsonResponse({ success: false, error: String(e?.message || e) }, 404);
  }
});



// ---- 网易云:个人歌单(登录后) + 推荐歌单 + 排行榜 ----
function mapWyBrowsePlaylist(p: any) {
  return {
    id: String(p.id),
    name: p.name || '',
    cover: p.coverImgUrl || p.picUrl || '',
    play_count: p.playCount || 0,
    track_count: p.trackCount || 0,
    subscribed: !!p.subscribed,
  };
}

async function browseWyPersonal(): Promise<any[]> {
  const modules: any[] = [];
  const cookie = await getNeteaseCookie();
  const userId = await getNeteaseUserId();
  if (!cookie || !userId) return modules;

  try {
    const headers = { Cookie: neteaseCookieHeader(cookie) };
    const d = await browseFetch(
      'https://music.163.com/api/user/playlist?uid=' + encodeURIComponent(userId) + '&limit=1000&offset=0',
      { referer: 'https://music.163.com/', headers },
    );
    const list: any[] = (d as any).playlist || [];
    const liked = list
      .filter((p) => (String(p.id) === userId || p.specialType === 5) && String(p.userId) === userId)
      .map(mapWyBrowsePlaylist);
    const created = list
      .filter((p) => String(p.id) !== userId && p.specialType !== 5 && String(p.userId) === userId && !p.subscribed)
      .map(mapWyBrowsePlaylist)
      .slice(0, 50);
    const collected = list.filter((p) => p.subscribed).map(mapWyBrowsePlaylist).slice(0, 50);

    if (liked.length) modules.push({ type: 'playlists', title: '我喜欢的音乐', items: liked });
    if (created.length) modules.push({ type: 'playlists', title: '创建的歌单', items: created });
    if (collected.length) modules.push({ type: 'playlists', title: '收藏的歌单', items: collected });
  } catch (e: any) {
    songloft.log.warn(`[chksz] 获取网易云个人歌单失败: ${e?.message || e}`);
  }
  return modules;
}

async function browseWy(): Promise<any> {
  const [pl, tl, personal] = await Promise.all([
    browseFetch('https://music.163.com/api/personalized/playlist?limit=9', { referer: 'https://music.163.com/' }),
    browseFetch('https://music.163.com/api/toplist', { referer: 'https://music.163.com/' }),
    browseWyPersonal(),
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
  const modules: any[] = [];
  modules.push(...personal);
  modules.push({ type: 'playlists', title: '猜你喜欢 · 推荐歌单', items: playlists });
  modules.push({ type: 'toplists', title: '排行榜', items: toplists });
  return { modules };
}

// 网易云歌单详情:
// /api/playlist/detail 老接口对大歌单只回传前 10 首完整 tracks;
// 这里改用 /api/v6/playlist/detail 拿完整 trackIds,再按 100 个/批调 /api/v3/song/detail 补齐元数据。
function mapWySong(t: any): any {
  return {
    title: t.name || '',
    artist: (t.ar || t.artists || []).map((a: any) => a.name).join('/'),
    album: t.al?.name || t.album?.name || '',
    duration: Math.round((Number(t.dt ?? t.duration) || 0) / 1000),
    cover_url: t.al?.picUrl || t.album?.picUrl || t.picUrl || undefined,
    source_data: { platform: 'wy', id: String(t.id) },
  };
}

async function browseWyPlaylist(id: string): Promise<any> {
  const wyCookie = await getNeteaseCookie();
  const headers = wyCookie ? { Cookie: neteaseCookieHeader(wyCookie) } : undefined;
  const d = await browseFetch(
    'https://music.163.com/api/v6/playlist/detail?id=' + encodeURIComponent(id) + '&n=1000&s=0&t=0',
    { referer: 'https://music.163.com/', headers },
  );
  const r = (d as any).playlist || (d as any).result || {};
  const trackIds: string[] = (r.trackIds || []).map((x: any) => String(x.id)).filter(Boolean);
  const details = [...(r.tracks || [])];
  const known = new Set(details.map((t: any) => String(t.id)));

  // 补齐 v6 接口未返回完整 tracks 的歌曲(典型:推荐歌单 trackIds=64,但 tracks 只有 10)
  const missing = trackIds.filter((sid) => !known.has(sid));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const c = JSON.stringify(chunk.map((sid) => ({ id: Number(sid) })));
    const resp = await browseFetch(
      'https://music.163.com/api/v3/song/detail?c=' + encodeURIComponent(c),
      { referer: 'https://music.163.com/', headers },
    );
    for (const s of (resp as any).songs || []) details.push(s);
  }

  const byId = new Map(details.map((t: any) => [String(t.id), t]));
  const ordered = trackIds.length
    ? trackIds.map((sid) => byId.get(sid)).filter(Boolean)
    : details;
  return {
    title: r.name || '',
    cover: r.coverImgUrl || '',
    songs: ordered.map(mapWySong).filter((s: any) => s.source_data.id),
  };
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

// ===== 分享链接解析(网易云/QQ/酷狗) =====
type ParsedPlaylistLink = { platform: string; id: string };

function parsePlaylistLink(input: string): ParsedPlaylistLink | null {
  const s = String(input || '').trim();
  if (!s) return null;

  // 网易云: https://music.163.com/m/playlist?id=xxx 或 #/playlist?id=xxx
  if (/music\.163\.com/.test(s)) {
    const m = s.match(/[?&#]id=(\d+)/) || s.match(/playlist\/(\d+)/);
    if (m) return { platform: 'wy', id: m[1] };
  }

  // QQ音乐: taoge.html?id=xxx、playlist/xxx、share/details/taoge.html?id=xxx
  if (/y\.qq\.com/.test(s)) {
    const m = s.match(/[?&#]id=(\d+)/) || s.match(/playlist\/(\d+)/) || s.match(/taoge\/(\d+)/);
    if (m) return { platform: 'tx', id: m[1] };
  }

  // 酷狗: 优先取 global_collection_id;兼容 gcid_xxx(需分享链接同时带 collection id)
  if (/kugou\.com/.test(s)) {
    const coll = s.match(/global_collection_id=(collection_\d+_\d+_\d+_\d+)/)
      || s.match(/[?&#]global_collection_id=(collection_\d+_\d+_\d+_\d+)/);
    if (coll) return { platform: 'kg', id: coll[1] };
    const gcid = s.match(/gcid_([a-z0-9]+)/i);
    if (gcid) return { platform: 'kg', id: 'gcid_' + gcid[1].toLowerCase() };
    const special = s.match(/special\/single\/(\d+)/);
    if (special) return { platform: 'kg', id: 'special:' + special[1] };
  }
  return null;
}

// ===== 酷狗 collection 歌单(分享链接里的 global_collection_id) =====
const KG_DFID = '-';
const KG_APPID = '1005';
const KG_CLIENTVER = '20489';
const KG_SIGNKEY = 'OIlwieks28dk2k092lksi2UIkp';
const KG_MAX_PAGES = 10; // 每页 100,最多导入 1000 首,避免路由器/低配设备被超大歌单击穿

function md5Hex(s: string): string {
  return __go_crypto_md5(s);
}

function kgSignedParams(params: Record<string, string | number>): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const base: Record<string, string | number> = {
    token: '', userid: '0', appid: KG_APPID, clientver: KG_CLIENTVER,
    dfid: KG_DFID, mid: md5Hex(KG_DFID), uuid: md5Hex(KG_DFID), clienttime: String(now),
  };
  Object.assign(base, params);
  const keys = Object.keys(base).sort();
  const raw = keys.map((k) => k + '=' + base[k]).join('');
  const out: Record<string, string> = {};
  keys.forEach((k) => { out[k] = String(base[k]); });
  out.signature = md5Hex(KG_SIGNKEY + raw + KG_SIGNKEY);
  return out;
}

function kgQueryString(params: Record<string, string | number>): string {
  return Object.entries(kgSignedParams(params)).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

async function browseKgCollection(collectionId: string): Promise<{ title: string; cover: string; songs: any[] }> {
  const songs: any[] = [];
  let title = '酷狗歌单';
  let cover = '';
  for (let page = 0; page < KG_MAX_PAGES; page++) {
    const qs = kgQueryString({
      global_collection_id: collectionId,
      pagesize: 100,
      plat: 1,
      type: 1,
      mode: 1,
      area_code: 1,
      begin_idx: page * 100,
    });
    const resp = await browseFetch('https://gateway.kugou.com/pubsongs/v2/get_other_list_file_nofilt?' + qs, {
      referer: 'https://m.kugou.com/',
    });
    const data = (resp as any).data || {};
    const listInfo = data.list_info || {};
    if (page === 0) {
      title = listInfo.name || title;
      cover = String(listInfo.pic || '').replace('{size}', '400');
    }
    for (const item of data.songs || []) {
      songs.push({
        title: item.remark || item.name || '',
        artist: (item.singerinfo || []).map((x: any) => x.name).filter(Boolean).join('/'),
        album: item.albuminfo?.name || '',
        duration: Math.round((Number(item.timelen) || 0) / 1000),
        cover_url: String(item.cover || cover).replace('{size}', '400'),
        source_data: { platform: 'kg', id: String(item.hash || '') },
      });
    }
    const count = Number(data.count) || songs.length;
    if (songs.length >= count || (data.songs || []).length < 100) break;
  }
  return { title, cover, songs: songs.filter((s) => s.source_data.id) };
}

// ===== 歌单导入到宿主 =====
async function fetchPlaylistDetail(platform: string, id: string): Promise<{ title: string; cover: string; songs: any[] }> {
  if (platform === 'tx') return await browseTxPlaylist(id);
  if (platform === 'kg') {
    if (id.startsWith('collection_')) return await browseKgCollection(id);
    if (id.startsWith('gcid_')) throw new Error('酷狗链接缺少 global_collection_id,请重新分享并粘贴包含 global_collection_id 的链接');
    if (id.startsWith('special:')) throw new Error('暂不支持旧版 special 酷狗链接,请使用带 global_collection_id 的新版分享链接');
    return await browseKgPlaylist(id);
  }
  return await browseWyPlaylist(id);
}

function platformLabel(platform: string): string {
  if (platform === 'tx') return 'QQ音乐';
  if (platform === 'kg') return '酷狗';
  return '网易云';
}

// ===== 导入映射:记录「平台歌单」→「宿主歌单」,用于重复导入检测/覆盖 =====
const IMPORT_MAP_KEY = 'playlist_import_map';

async function getImportMap(): Promise<Record<string, number>> {
  try {
    const raw = (await songloft.storage.get(IMPORT_MAP_KEY)) as string;
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') return obj as Record<string, number>;
    }
  } catch {
    /* 损坏则重建 */
  }
  return {};
}

async function saveImportMap(map: Record<string, number>): Promise<void> {
  await songloft.storage.set(IMPORT_MAP_KEY, JSON.stringify(map));
}

async function replacePlaylistSongs(playlistId: number, songIds: number[]): Promise<AddSongsResult> {
  let removed = 0;
  try {
    const oldSongs = await songloft.playlists.getSongs(playlistId);
    const oldIds = (oldSongs || []).map((s) => s.id).filter((n) => n != null);
    if (oldIds.length) {
      await songloft.playlists.removeSongs(playlistId, oldIds);
      removed = oldIds.length;
    }
  } catch (e: any) {
    songloft.log.warn(`[chksz] 清空旧歌单失败(继续追加导入): ${e?.message || e}`);
  }
  const added = await songloft.playlists.addSongs(playlistId, songIds);
  return { added: added.added, skipped: added.skipped + removed };
}

// 导入歌单:抓取源歌单/榜单歌曲 → 逐首入库(去重)→ 创建宿主歌单 → 批量加入
router.post('/api/playlist/import', async (req) => {
  const body = JSON.parse((req.body as string) || '{}');
  const rawLink = String(body.url || body.link || body.text || '').trim();
  let platform = String(body.platform || '');
  let id = String(body.id || '');

  // 支持直接粘贴分享链接/分享文本(网易云/QQ/酷狗),自动识别平台和歌单 id
  if (rawLink) {
    const parsed = parsePlaylistLink(rawLink);
    if (!parsed) return jsonResponse({ error: '无法识别分享链接,请粘贴包含歌单 id 的网易云/QQ/酷狗分享链接' }, 400);
    platform = parsed.platform;
    id = parsed.id;
  }
  if (!ALL_PLATFORMS.includes(platform)) return jsonResponse({ error: 'platform must be wy/tx/kg' }, 400);
  if (!id) return jsonResponse({ error: 'id required' }, 400);

  try {
    const overwrite = body.overwrite === true;
    const sourceKey = platform + ':' + id;
    const importMap = await getImportMap();
    const existingId = Number(importMap[sourceKey]) || 0;

    // 重复导入且未显式要求覆盖:先返回 exists,由前端询问用户
    if (existingId && !overwrite) {
      const existing = await songloft.playlists.getById(existingId);
      if (existing) {
        return jsonResponse({
          exists: true,
          message: '该歌单已经导入过,是否覆盖原歌单中的歌曲?',
          playlist: { id: existing.id, name: existing.name },
          source: { platform, id },
        });
      }
    }

    const detail = await fetchPlaylistDetail(platform, id);
    const songs = (detail.songs || []).filter((s) => s && s.title && s.source_data);
    if (!songs.length) return jsonResponse({ error: 'playlist is empty or not playable' }, 502);

    const name = String(body.name || detail.title || '').trim() || `${platformLabel(platform)}歌单 ${id}`;
    const description = String(body.description || `从 ${platformLabel(platform)} 导入 · ${name}`).slice(0, 200);
    const coverUrl = body.cover_url || detail.cover || undefined;
    const imported = await importSongsToLibrary(songs);
    if (!imported.songIds.length) {
      return jsonResponse({ error: `歌曲入库全部失败: ${imported.errors[0] || 'unknown'}` }, 500);
    }

    let playlist: any = null;
    let overwritten = false;
    if (existingId) {
      const existing = await songloft.playlists.getById(existingId);
      if (existing) {
        await songloft.playlists.update(existing.id, { name, description, coverUrl });
        const added = await replacePlaylistSongs(existing.id, imported.songIds);
        playlist = existing;
        overwritten = true;
        songloft.log.info(`[chksz] 歌单覆盖导入完成: ${name} source=${sourceKey} songs=${added.added} failed=${imported.failed}`);
        return jsonResponse({
          ok: true,
          overwritten: true,
          playlist: { id: playlist.id, name: playlist.name },
          imported: imported.songIds.length,
          failed: imported.failed,
          added: added.added,
          skipped: added.skipped,
        });
      }
    }

    playlist = await songloft.playlists.create({
      name,
      type: 'normal',
      description,
      coverUrl,
    });
    const added = await songloft.playlists.addSongs(playlist.id, imported.songIds);
    importMap[sourceKey] = playlist.id;
    await saveImportMap(importMap);

    songloft.log.info(`[chksz] 歌单导入完成: ${name} source=${sourceKey} songs=${added.added + added.skipped} failed=${imported.failed}`);
    return jsonResponse({
      ok: true,
      overwritten,
      playlist: { id: playlist.id, name: playlist.name },
      imported: imported.songIds.length,
      failed: imported.failed,
      added: added.added,
      skipped: added.skipped,
    });
  } catch (e: any) {
    songloft.log.error(`[chksz] 导入歌单失败: ${e?.message || e}`);
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
    const hint: { title?: string; artist?: string } | undefined = body.hint || undefined;
    const results = rankResults(await searchChksz(keyword), keyword, hint);
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

  // 注册为宿主歌词提供者:歌曲无歌词时宿主自动调 /lyric-search(受 lyrics_enabled 控制)
  try {
    const { lyricsEnabled } = await getConfig();
    if (lyricsEnabled && songloft.lyrics && typeof songloft.lyrics.registerProvider === 'function') {
      songloft.lyrics.registerProvider();
      songloft.log.info('[chksz] 已注册为歌词提供者');
    }
  } catch (e: any) {
    songloft.log.warn(`[chksz] 注册歌词提供者失败: ${e?.message || e}`);
  }

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

async function onDeinit(): Promise<void> {
  try {
    if (songloft.lyrics && typeof songloft.lyrics.unregisterProvider === 'function') {
      songloft.lyrics.unregisterProvider();
      songloft.log.info('[chksz] 已取消注册歌词提供者');
    }
  } catch (e: any) {
    songloft.log.warn(`[chksz] 取消注册歌词提供者失败: ${e?.message || e}`);
  }
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
