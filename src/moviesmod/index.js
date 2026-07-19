/**
 * moviesmod provider — full chain
 *
 *   Nuvio -> getCatalog()       (list of feeds)
 *         -> getPosts()         (scrape feed, base64-url = postId)
 *         -> getMeta()          (post page -> metadata)
 *         -> getStreams()       (post page -> file host links
 *                                -> resolver chain -> playable url)
 *
 * Resolver chain (resolvers/index.js):
 *   direct file -> pixeldrain -> gdrive -> streamtape
 *   -> hubcloud -> gdflix/gdtot -> modlinks/unblockedgames
 */

const cheerio = require('cheerio-without-node-native');
const crypto = require('crypto-js');
const { resolveAny, HEADERS } = require('./resolvers');

const BASE = 'https://moviesmod.bond';

const cache = {
  posts:   new Map(),
  meta:    new Map(),
  streams: new Map(),
  ttl: 5 * 60 * 1000,
};
const set = (m, k, v) => m.set(k, { v, t: Date.now() });
const get = (m, k) => {
  const e = m.get(k);
  if (!e) return null;
  if (Date.now() - e.t > cache.ttl) { m.delete(k); return null; }
  return e.v;
};

const decodeId = (postId) => {
  try { return crypto.enc.Utf8.stringify(crypto.enc.Base64.parse(postId)); }
  catch { return null; }
};
const encodeUrl = (url) =>
  crypto.enc.Base64.stringify(crypto.enc.Utf8.parse(url)).replace(/=+$/, '');

const inferType = (text = '') =>
  /\bseason\b|\bepisode\b|\bs\d{1,2}\b|\bseries\b|\btv\b/i.test(text) ? 'series' : 'movie';

async function getHTML(url) {
  const r = await fetch(url, { headers: HEADERS(url), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return { html: await r.text(), finalUrl: r.url };
}

// ---------- Catalog ----------

async function getCatalog() {
  const cached = get(cache.posts, 'catalog');
  if (cached) return cached;

  const fallback = [
    { id: 'moviesmod-trending', title: 'Trending', filter: 'trending', type: 'movie' },
    { id: 'moviesmod-latest', title: 'Latest', filter: 'latest', type: 'movie' },
    { id: 'moviesmod-hollywood', title: 'Hollywood Movies', filter: '/category/hollywood-movies/', type: 'movie' },
    { id: 'moviesmod-bollywood', title: 'Bollywood Movies', filter: '/category/bollywood-movies/', type: 'movie' },
  ];

  try {
    const { html } = await getHTML(BASE);
    const $ = cheerio.load(html);
    const seen = new Set();
    const dynamic = [];

    $('a[href*="/category/"]').each((_, el) => {
      const rawHref = $(el).attr('href');
      const rawTitle = $(el).text().replace(/\s+/g, ' ').trim();
      if (!rawHref || !rawTitle) return;

      let u;
      try { u = new URL(rawHref, BASE); }
      catch { return; }

      if (!u.pathname.includes('/category/')) return;
      const filter = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
      if (seen.has(filter)) return;
      seen.add(filter);

      const slug = (u.pathname.split('/').filter(Boolean).pop() || 'category')
        .replace(/[^a-z0-9-]/gi, '-')
        .toLowerCase();

      dynamic.push({
        id: `moviesmod-${slug}`,
        title: rawTitle,
        filter,
        type: inferType(rawTitle),
      });
    });

    const catalog = [
      { id: 'moviesmod-trending', title: 'Trending', filter: 'trending', type: 'movie' },
      { id: 'moviesmod-latest', title: 'Latest', filter: 'latest', type: 'movie' },
      ...dynamic,
    ];

    if (dynamic.length > 0) {
      set(cache.posts, 'catalog', catalog);
      return catalog;
    }
  } catch (_) {}

  set(cache.posts, 'catalog', fallback);
  return fallback;
}

function buildFeedUrl(filter, page) {
  if (!filter || filter === 'trending') {
    return page > 1 ? `${BASE}/?paged=${page}` : `${BASE}/`;
  }
  if (filter === 'latest') {
    return page > 1 ? `${BASE}/?order=latest&paged=${page}` : `${BASE}/?order=latest`;
  }

  let u;
  try { u = new URL(filter, BASE); }
  catch { return page > 1 ? `${BASE}/?paged=${page}` : `${BASE}/`; }

  if (u.pathname.includes('/category/')) {
    const normalized = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
    return page > 1 ? `${u.origin}${normalized}page/${page}/` : `${u.origin}${normalized}`;
  }

  if (page > 1) u.searchParams.set('paged', String(page));
  return u.toString();
}

async function getPosts(filter, page = 1) {
  const url = buildFeedUrl(filter || 'trending', page);
  const { html } = await getHTML(url);
  const $ = cheerio.load(html);
  const posts = [];

  $('article').each((_, el) => {
    const a = $(el).find('a').first();
    const href = a.attr('href');
    if (!href) return;
    let postUrl;
    try { postUrl = new URL(href, BASE).toString(); }
    catch { return; }
    const title = $(el).find('.entry-title').text().trim()
               || a.attr('title')?.trim()
               || a.text().trim();
    const poster = $(el).find('img').attr('src')
                || $(el).find('img').attr('data-src');
    if (!title) return;
    posts.push({
      id: encodeUrl(postUrl),
      type: inferType(title),
      title,
      poster: poster || undefined,
    });
  });

  const hasNext = $('.pagination .next, .nav-links a.next, a[rel="next"]').length > 0;
  return { posts, nextPage: posts.length > 0 && hasNext ? page + 1 : undefined };
}

// ---------- Meta ----------

async function getMeta(postId) {
  const cached = get(cache.meta, postId);
  if (cached) return cached;

  const url = decodeId(postId);
  if (!url) throw new Error('bad postId');

  const { html } = await getHTML(url);
  const $ = cheerio.load(html);

  const title = $('h1.entry-title, h1').first().text().trim()
             || $('title').text().split('—')[0].trim();
  const poster = $('meta[property="og:image"]').attr('content')
              || $('.entry-content img').first().attr('src');
  const desc  = $('meta[property="og:description"]').attr('content')
              || $('.entry-content p').first().text().trim();
  const year  = parseInt(
    (($('.entry-meta, .date, .entry-date').text() || '').match(/\b(19|20)\d{2}\b/) || [])[0] || '',
    10,
  ) || undefined;

  // detect series vs movie — if post has a "Season" section or "Episode" links
  const isSeries = /\bseason\b|\bepisode\b/i.test($('.entry-content').text() || '');
  const type = isSeries ? 'series' : 'movie';

  const meta = {
    id: postId,
    type,
    title,
    poster: poster || undefined,
    description: desc || undefined,
    year,
  };
  set(cache.meta, postId, meta);
  return meta;
}

// ---------- Streams ----------

function extractQuality(label) {
  const m = label && label.match(/\b(2160p|1080p|720p|480p|360p|4K)\b/i);
  return m ? m[1].toLowerCase() : 'Auto';
}

function detectHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('drive.google')) return 'Gdrive';
    if (h.includes('pixeldrain'))  return 'PixelDrain';
    if (h.includes('streamtape'))  return 'Streamtape';
    if (h.includes('hubcloud'))    return 'HubCloud';
    if (h.includes('hubcdn'))      return 'HubCDN';
    if (h.includes('hubdrive'))    return 'HubDrive';
    if (h.includes('gdflix'))      return 'GDFlix';
    if (h.includes('gdtot'))       return 'GDTot';
    if (h.includes('modlinks'))    return 'Modlinks';
    if (/\.(mp4|m3u8|mkv)/.test(url)) return 'Direct';
    return h.split('.').slice(-2, -1)[0];
  } catch { return 'Unknown'; }
}

async function getStreams(postId) {
  const cached = get(cache.streams, postId);
  if (cached) return cached;

  const url = decodeId(postId);
  if (!url) return [];
  const { html } = await getHTML(url);
  const $ = cheerio.load(html);

  // Gather every candidate link inside the post body
  const candidateMap = new Map();
  const addCandidate = (href, label) => {
    if (!href) return;
    let absolute;
    try { absolute = new URL(href, url).toString(); }
    catch { return; }
    if (!/^https?:\/\//i.test(absolute)) return;
    const normalized = absolute.replace(/\/+$/, '');
    if (!candidateMap.has(normalized)) {
      candidateMap.set(normalized, { href: normalized, label: (label || '').trim() });
    }
  };

  $('.entry-content a[href], .entry-content [data-href], .entry-content [data-url], .entry-content [onclick]').each((_, el) => {
    const node = $(el);
    const text = node.text().trim();
    addCandidate(node.attr('href'), text);
    addCandidate(node.attr('data-href'), text);
    addCandidate(node.attr('data-url'), text);

    const onClick = node.attr('onclick') || '';
    const clickUrl = onClick.match(/https?:\/\/[^\s"'`<>]+/i)
      || onClick.match(/(?:window\.open|location(?:\.href)?\s*=)\s*['"]([^'"]+)['"]/i);
    if (clickUrl) addCandidate(clickUrl[1] || clickUrl[0], text);
  });
  const candidates = Array.from(candidateMap.values());

  // Resolve in parallel with a small concurrency cap
  const results = [];
  const queue = candidates.slice();
  const workers = 6;
  async function run() {
    while (queue.length) {
      const c = queue.shift();
      try {
        const r = await resolveAny(c.href);
        if (r) {
          const host = detectHost(r.url);
          const q = extractQuality(c.label);
          results.push({
            title: `${c.label || host} — ${host} [${q}]`.replace(/\s+/g, ' ').trim(),
            url: r.url,
            quality: q,
            headers: r.headers || HEADERS(r.url),
            host,
          });
        }
      } catch (_) { /* dead link, ignore */ }
    }
  }
  await Promise.all(Array.from({ length: workers }, run));

  // Dedup by url
  const seen = new Set();
  const streams = results.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  set(cache.streams, postId, streams);
  return streams;
}

module.exports = { getCatalog, getPosts, getMeta, getStreams };
