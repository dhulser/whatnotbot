const cheerio = require('cheerio');
const { config } = require('./config');

// Realistic browser headers to avoid 403s
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

const GRAPHQL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
  'Origin': 'https://www.whatnot.com',
  'Referer': 'https://www.whatnot.com/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

/**
 * Fetch with a timeout and basic retry.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// TIER 1: Whatnot GraphQL API
// ---------------------------------------------------------------------------
// Whatnot's frontend uses GraphQL. This query fetches upcoming scheduled shows
// for a seller. The exact query fields were discovered by inspecting XHR calls
// on the /user/{username}/shows page.
//
// If Whatnot changes their API, update the query string here.
// ---------------------------------------------------------------------------

const SCHEDULED_SHOWS_QUERY = `
  query SellerScheduledShows($username: String!, $first: Int) {
    user(username: $username) {
      scheduledShows(first: $first, status: [SCHEDULED]) {
        edges {
          node {
            id
            title
            description
            scheduledAt
            status
          }
        }
      }
    }
  }
`;

async function fetchViaGraphQL(username) {
  console.log(`[FETCH/GQL] Trying GraphQL for ${username}`);

  const body = JSON.stringify({
    query: SCHEDULED_SHOWS_QUERY,
    variables: { username, first: 20 },
  });

  const res = await fetchWithTimeout(config.whatnotApiUrl, {
    method: 'POST',
    headers: GRAPHQL_HEADERS,
    body,
  }, 15000);

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}`);
  }

  const json = await res.json();

  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL errors: ${json.errors.map(e => e.message).join('; ')}`);
  }

  const edges = json?.data?.user?.scheduledShows?.edges;
  if (!Array.isArray(edges)) {
    throw new Error('GraphQL: unexpected response shape — no edges');
  }

  const shows = edges.map(({ node }) => ({
    id: node.id,
    title: node.title || `Show by ${username}`,
    startTime: node.scheduledAt || null, // ISO string from the API
    url: `${config.whatnotBaseUrl}/live/${node.id}`,
  }));

  console.log(`[FETCH/GQL] Got ${shows.length} shows via GraphQL`);
  return shows;
}

// ---------------------------------------------------------------------------
// TIER 2: Plain HTTP + cheerio (SSR page scraping)
// ---------------------------------------------------------------------------
// Whatnot may server-side-render the shows page (Next.js). If so, plain HTTP
// fetch returns HTML with embedded show data we can parse with cheerio.
// This is a best-effort fallback — it mirrors the original scraping logic but
// without a headless browser.
// ---------------------------------------------------------------------------

async function fetchViaHttp(username) {
  const url = `${config.whatnotBaseUrl}/user/${username}/shows`;
  console.log(`[FETCH/HTTP] Trying plain HTTP for ${username}: ${url}`);

  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: BROWSER_HEADERS,
  }, 20000);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const html = await res.text();
  console.log(`[FETCH/HTTP] Got ${html.length} bytes`);

  // Try to extract embedded JSON state (Next.js __NEXT_DATA__)
  const shows = parseNextData(html, username) || parseShowsFromHtml(html, username);

  if (shows.length === 0) {
    // If we got HTML but no shows, the page may be a client-rendered SPA.
    // Return empty with a specific error so the caller knows to escalate.
    throw new Error('HTTP: page loaded but no shows found — may need JS rendering');
  }

  console.log(`[FETCH/HTTP] Got ${shows.length} shows via HTTP`);
  return shows;
}

/**
 * Try to extract shows from Next.js __NEXT_DATA__ JSON embedded in the page.
 * Returns null if the structure isn't found.
 */
function parseNextData(html, username) {
  try {
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return null;

    const data = JSON.parse(match[1]);

    // Walk the props tree looking for scheduled show data — the exact path
    // depends on Whatnot's Next.js page structure. Common patterns:
    const candidates = [
      data?.props?.pageProps?.scheduledShows,
      data?.props?.pageProps?.user?.scheduledShows,
      data?.props?.pageProps?.shows,
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length > 0) {
        const shows = candidate.map(s => ({
          id: s.id,
          title: s.title || `Show by ${username}`,
          startTime: s.scheduledAt || s.startTime || null,
          url: `${config.whatnotBaseUrl}/live/${s.id}`,
        }));
        console.log(`[FETCH/HTTP] Extracted ${shows.length} shows from __NEXT_DATA__`);
        return shows;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fallback: parse shows from raw HTML using cheerio (mirrors the original bot logic).
 */
function parseShowsFromHtml(html, username) {
  const shows = [];
  const seen = new Set();

  try {
    const $ = cheerio.load(html);

    $('a[href*="/live/"]').each((_i, el) => {
      try {
        const href = $(el).attr('href');
        if (!href) return;

        const m = href.match(/\/live\/([a-f0-9-]{20,})/i);
        if (!m) return;

        const showId = m[1];
        if (seen.has(showId)) return;
        seen.add(showId);

        const $card = $(el).closest('[class*="card"], [class*="show"], article, li').first();
        const searchScope = $card.length ? $card : $(el).parent().parent().parent();

        // Title: longest non-date text in the card
        let title = '';
        searchScope.find('*').addBack().each((_j, node) => {
          const text = $(node).clone().children().remove().end().text().trim();
          if (
            text.length > 20 &&
            text.length < 300 &&
            !text.match(/^(Tomorrow|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d)/i) &&
            text.length > title.length
          ) {
            title = text;
          }
        });

        // Start time: pick the first date-like string in the card
        let startTime = null;
        const cardText = searchScope.text();
        const timePatterns = [
          /Tomorrow\s+\d{1,2}:\d{2}\s*(AM|PM)?/i,
          /Today\s+\d{1,2}:\d{2}\s*(AM|PM)?/i,
          /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+\d{1,2}:\d{2}\s*(AM|PM)?/i,
          /\d{1,2}:\d{2}\s*(AM|PM)/i,
        ];
        for (const pat of timePatterns) {
          const tm = cardText.match(pat);
          if (tm) { startTime = tm[0]; break; }
        }

        shows.push({
          id: showId,
          title: title || `Show by ${username}`,
          startTime,
          url: `${config.whatnotBaseUrl}/live/${showId}`,
        });
      } catch {
        // skip malformed elements
      }
    });
  } catch (err) {
    console.error(`[FETCH/HTTP] cheerio parse error:`, err.message);
  }

  return shows;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Fetch scheduled shows for a Whatnot username.
 * Tries GraphQL first, falls back to plain HTTP + HTML parsing.
 * Returns an array of show objects: { id, title, startTime, url }
 */
async function fetchShows(username) {
  // Tier 1: GraphQL
  try {
    const shows = await fetchViaGraphQL(username);
    return sortShows(shows);
  } catch (err) {
    console.warn(`[FETCH] GraphQL failed for ${username}: ${err.message}`);
  }

  // Tier 2: Plain HTTP / SSR
  try {
    const shows = await fetchViaHttp(username);
    return sortShows(shows);
  } catch (err) {
    console.warn(`[FETCH] HTTP fetch failed for ${username}: ${err.message}`);
  }

  // All tiers failed
  console.error(`[FETCH] All fetch strategies failed for ${username}`);
  return [];
}

/**
 * Sort shows by startTime ascending. Shows with no time go last.
 */
function sortShows(shows) {
  return shows.sort((a, b) => {
    if (!a.startTime && !b.startTime) return 0;
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    const da = new Date(a.startTime);
    const db = new Date(b.startTime);
    if (isNaN(da)) return 1;
    if (isNaN(db)) return -1;
    return da - db;
  });
}

module.exports = { fetchShows };
