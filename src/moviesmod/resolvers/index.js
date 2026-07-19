/**
 * Resolver registry — given a URL, return the right resolver module.
 * Each resolver is a function: async (url, ctx) => { url, headers } | null
 */

const cheerio = require('cheerio-without-node-native');
const crypto = require('crypto-js');

const HEADERS = (referer) => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  ...(referer ? { Referer: referer } : {}),
});

async function getHTML(url) {
  const r = await fetch(url, { headers: HEADERS(url), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return { html: await r.text(), finalUrl: r.url };
}

// ---------- Gdrive direct ----------
// Public gdrive links return a confirmation page; auto-confirm.
async function resolveGdrive(url) {
  // Pattern: https://drive.google.com/file/d/ID/view
  const m = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (!m) return null;
  const id = m[1];
  // Direct download endpoint
  return {
    url: `https://drive.google.com/uc?export=download&id=${id}`,
    headers: HEADERS(url),
  };
}

// ---------- PixelDrain ----------
// https://pixeldrain.com/u/<id>  → /api/file/<id>?download
async function resolvePixelDrain(url) {
  const m = url.match(/pixeldrain\.com\/u\/([A-Za-z0-9]+)/);
  if (!m) return null;
  return {
    url: `https://pixeldrain.com/api/file/${m[1]}?download`,
    headers: HEADERS(url),
  };
}

// ---------- Streamtape (regex from response) ----------
async function resolveStreamtape(url) {
  const { html, finalUrl } = await getHTML(url);
  // Streamtape embeds src: https://streamtape.com/get_video?id=...
  // or: /stream/...
  const m = html.match(/get_video\?id=([^'"]+)/)
         || html.match(/src=["'](https?:\/\/streamtape\.com\/[^'"]+)/);
  if (!m) return null;
  return { url: 'https://streamtape.com/get_video?' + (m[1] ? 'id=' + m[1] : ''), headers: HEADERS(finalUrl) };
}

// ---------- HubCloud / HubCDN family ----------
// hubcloud.ink, hubcdn.fans, hubdrive.me, etc.
// They show a "Generate Download Link" form POSTing to the same page.
async function resolveHubCloud(url) {
  try {
    const { html, finalUrl } = await getHTML(url);
    const $ = cheerio.load(html);

    // 1) Sometimes the file is already a direct link
    const direct = $('a[href*=".mkv"], a[href*=".mp4"], a[href*="workers.dev"]')
      .map((_, a) => $(a).attr('href')).get();
    if (direct.length) {
      return { url: direct[0], headers: HEADERS(finalUrl) };
    }

    // 2) POST a "generate" form if present
    const form = $('form#hubcloud, form[action*="hubcloud"]').first();
    if (form.length) {
      const action = form.attr('action') || finalUrl;
      const data = {};
      form.find('input, select, textarea').each((_, el) => {
        const name = $(el).attr('name');
        if (name) data[name] = $(el).attr('value') || '';
      });
      const r = await fetch(action, {
        method: 'POST',
        headers: { ...HEADERS(finalUrl), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(data).toString(),
        redirect: 'follow',
      });
      const h = await r.text();
      const m2 = h.match(/https?:\/\/[^\s'"]*\.(?:mp4|mkv|m3u8)[^\s'"]*/i)
              || h.match(/https?:\/\/[a-z0-9.-]+\.workers\.dev\/[^\s'"]+/i)
              || h.match(/https?:\/\/hubcloud\.[a-z.]+\/api\/file\/[^\s'"]+/i);
      if (m2) return { url: m2[0], headers: HEADERS(r.url) };
    }
  } catch (e) { /* fallthrough */ }
  return null;
}

// ---------- GDFlix / GDTot / Sharer ----------
// Often return a base64 encoded URL in a script tag.
async function resolveGDFlix(url) {
  try {
    const { html, finalUrl } = await getHTML(url);
    // Look for "gdflix.net" / gdtot.ill-formed URL inside window.location or
    // a base64 string in an inline script.
    const b64 = html.match(/atob\("([A-Za-z0-9+/=]+)"\)/)
             || html.match(/base64,([A-Za-z0-9+/=]+)/);
    if (b64) {
      try {
        const decoded = crypto.enc.Utf8.stringify(crypto.enc.Base64.parse(b64[1]));
        if (/^https?:/.test(decoded)) {
          return { url: decoded, headers: HEADERS(finalUrl) };
        }
      } catch (_) {}
    }
    // Plain embedded gdrive link
    const g = html.match(/https?:\/\/drive\.google\.com\/file\/d\/[^'"\s]+/);
    if (g) return { url: g[0], headers: HEADERS(finalUrl) };
  } catch (e) {}
  return null;
}

// ---------- Direct file ----------
// If the URL is already a video file, return as-is.
async function resolveDirectFile(url) {
  if (/\.(mp4|m3u8|mkv|webm)(\?|$)/i.test(url)) {
    return { url, headers: HEADERS(url) };
  }
  // HEAD check
  try {
    const r = await fetch(url, { method: 'HEAD', headers: HEADERS(url), redirect: 'follow' });
    const ct = r.headers.get('content-type') || '';
    if (/video|octet-stream/.test(ct)) {
      return { url: r.url, headers: HEADERS(url) };
    }
  } catch (_) {}
  return null;
}

// ---------- Modlinks / unblockedgames.world ----------
// Multi-step browser-like flow. We do our best in pure HTTP.
// Step 1: fetch modlinks page → find "Continue" form
// Step 2: POST the form → get to unblockedgames.world
// Step 3: unblockedgames expects a JS challenge we can't run →
//         fall back to following the "Continue" link anyway.
async function resolveModlinks(url) {
  try {
    const { html, finalUrl } = await getHTML(url);
    const $ = cheerio.load(html);
    // Collect outbound links that look like real file hosts
    const out = new Set();
    $('a[href]').each((_, a) => {
      const h = $(a).attr('href');
      if (!h) return;
      if (/drive\.google|pixeldrain|hubcloud|hubcdn|streamtape|hubdrive|gdtot|gdflix/i.test(h)) {
        out.add(h);
      }
    });
    for (const candidate of out) {
      const r = await resolveAny(candidate);
      if (r) return r;
    }
  } catch (e) {}
  return null;
}

// ---------- Dispatcher ----------
async function resolveAny(url) {
  if (!url) return null;
  // order matters — most specific first
  const resolvers = [
    resolveDirectFile,
    resolvePixelDrain,
    resolveGdrive,
    resolveStreamtape,
    resolveHubCloud,
    resolveGDFlix,
    resolveModlinks,
  ];
  for (const fn of resolvers) {
    try {
      const r = await fn(url);
      if (r) return r;
    } catch (_) { /* try next */ }
  }
  return null;
}

module.exports = { resolveAny, HEADERS };
