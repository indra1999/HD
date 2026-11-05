/**
 * HDHub4u Provider for Nuvio (Refactored)
 * - HTML search fallback (Typesense API is currently Cloudflare-blocked)
 * - Updated mirrors + auto failover
 * - Better logging & link extraction
 * Exports: getStreams(tmdbId, mediaType, season, episode)
 */

var __async = (thisArg, args, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try { step(generator.next(value)); } catch (e) { reject(e); }
    };
    var rejected = (value) => {
      try { step(generator.throw(value)); } catch (e) { reject(e); }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(thisArg, args)).next());
  });
};

// ─── Config ──────────────────────────────────────────────────────────────────
var MIRRORS = [
  "https://new11.hdhub4u.cl",
  "https://new10.hdhub4u.cl",
  "https://new9.hdhub4u.cl",
  "https://new8.hdhub4u.cl",
  "https://new6.hdhub4u.fo",
  "https://new5.hdhub4u.fo",
  "https://hdhub4u.fo",
  "https://hdhub4u13.com"
];

// Typesense is currently 403'd by Cloudflare – kept only as optional primary
var SEARCH_API = "https://search.hdhub4u.glass/collections/post/documents/search";
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var TMDB_BASE = "https://api.themoviedb.org/3";

var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cookie": "xla=s4t",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1"
};

var currentBase = MIRRORS[0];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizeTitle(t) {
  if (!t) return "";
  return t.toLowerCase()
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/[:\-_']/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function titleSimilarity(a, b) {
  var n1 = normalizeTitle(a);
  var n2 = normalizeTitle(b);
  if (n1 === n2) return 1;
  var w1 = n1.split(/\s+/).filter(Boolean);
  var w2 = n2.split(/\s+/).filter(Boolean);
  if (!w1.length || !w2.length) return 0;
  var set2 = {};
  for (var i = 0; i < w2.length; i++) set2[w2[i]] = true;
  var inter = 0;
  for (var j = 0; j < w1.length; j++) if (set2[w1[j]]) inter++;
  var union = {};
  for (var k = 0; k < w1.length; k++) union[w1[k]] = true;
  for (var m = 0; m < w2.length; m++) union[w2[m]] = true;
  var unionSize = 0;
  for (var _ in union) unionSize++;
  return inter / unionSize;
}

function qualityFromText(text) {
  if (!text) return "Unknown";
  var t = text.toUpperCase();
  if (t.indexOf("2160") !== -1 || t.indexOf("4K") !== -1) return "4K";
  if (t.indexOf("1080") !== -1) return "1080p";
  if (t.indexOf("720") !== -1) return "720p";
  if (t.indexOf("480") !== -1) return "480p";
  return "Unknown";
}

function sizeFromText(text) {
  if (!text) return null;
  var m = text.match(/(\d+(?:\.\d+)?)\s*(GB|MB|TB)/i);
  if (!m) return null;
  return m[1] + " " + m[2].toUpperCase();
}

// ─── TMDB ────────────────────────────────────────────────────────────────────
function getTMDBDetails(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var endpoint = mediaType === "tv" || mediaType === "series" ? "tv" : "movie";
    var url = TMDB_BASE + "/" + endpoint + "/" + tmdbId + "?api_key=" + TMDB_API_KEY + "&append_to_response=external_ids";
    var res = yield fetch(url, {
      headers: { Accept: "application/json", "User-Agent": HEADERS["User-Agent"] }
    });
    if (!res.ok) throw new Error("TMDB " + res.status);
    var data = yield res.json();
    var title = endpoint === "tv" ? data.name : data.title;
    var date = endpoint === "tv" ? data.first_air_date : data.release_date;
    var year = date ? parseInt(date.split("-")[0], 10) : null;
    var imdbId = (data.external_ids && data.external_ids.imdb_id) || null;
    return { title: title, year: year, imdbId: imdbId };
  });
}

// ─── Search ──────────────────────────────────────────────────────────────────
/**
 * Primary: try Typesense (may 403)
 * Fallback: HTML search page on current / working mirror
 */
function searchPosts(query) {
  return __async(this, null, function* () {
    // 1) Try Typesense first (fast when it works)
    try {
      var today = new Date().toISOString().split("T")[0];
      var apiUrl = SEARCH_API +
        "?q=" + encodeURIComponent(query) +
        "&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=20&highlight_fields=none&use_cache=true&page=1&analytics_tag=" + today;

      var apiRes = yield fetch(apiUrl, { headers: HEADERS });
      if (apiRes.ok) {
        var data = yield apiRes.json();
        if (data && data.hits && data.hits.length) {
          console.log("[HDHub4u] Typesense hit:", data.hits.length);
          return data.hits.map(function (hit) {
            var doc = hit.document;
            var title = doc.post_title || "";
            var yearMatch = title.match(/\((\d{4})\)|\b(20\d{2}|19\d{2})\b/);
            var year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2], 10) : null;
            var link = doc.permalink || "";
            if (link && link.charAt(0) === "/") link = currentBase + link;
            return {
              title: title,
              url: link,
              poster: doc.post_thumbnail || null,
              year: year
            };
          });
        }
      } else {
        console.log("[HDHub4u] Typesense status:", apiRes.status, "→ falling back to HTML search");
      }
    } catch (e) {
      console.log("[HDHub4u] Typesense error:", e && e.message ? e.message : e);
    }

    // 2) HTML search fallback across mirrors
    return yield searchPostsHtml(query);
  });
}

function searchPostsHtml(query) {
  return __async(this, null, function* () {
    var cheerio = getCheerio();
    if (!cheerio) {
      console.log("[HDHub4u] No cheerio available for HTML search");
      return [];
    }

    for (var mi = 0; mi < MIRRORS.length; mi++) {
      var base = MIRRORS[mi];
      var searchUrl = base + "/?s=" + encodeURIComponent(query);
      console.log("[HDHub4u] HTML search:", searchUrl);

      try {
        var res = yield fetch(searchUrl, {
          headers: Object.assign({}, HEADERS, { Referer: base + "/" }),
          redirect: "follow"
        });

        if (!res.ok) {
          console.log("[HDHub4u] Mirror", base, "status", res.status);
          continue;
        }

        var html = yield res.text();

        // Cloudflare / challenge page detection
        if (
          html.indexOf("cf-browser-verification") !== -1 ||
          html.indexOf("challenge-platform") !== -1 ||
          html.indexOf("Just a moment") !== -1 ||
          html.length < 2000
        ) {
          console.log("[HDHub4u] Challenge / blocked page on", base);
          continue;
        }

        var $ = cheerio.load(html);
        var results = [];
        var seen = {};

        // Multiple selector strategies (site layout changes often)
        var selectors = [
          "article h2 a, article h3 a",
          ".post-title a, .entry-title a",
          "h2.entry-title a, h3.entry-title a",
          ".thumb a, .thumbnail a, figure a",
          "a[href*='/']"
        ];

        for (var s = 0; s < selectors.length && results.length < 15; s++) {
          $(selectors[s]).each(function (i, el) {
            if (results.length >= 15) return;
            var href = $(el).attr("href");
            var text = ($(el).text() || $(el).attr("title") || "").trim();
            if (!href || !text || text.length < 4) return;
            if (href.indexOf("javascript:") === 0) return;
            if (seen[href]) return;

            // Filter obvious non-content links
            var lowerHref = href.toLowerCase();
            if (
              lowerHref.indexOf("/category/") !== -1 ||
              lowerHref.indexOf("/tag/") !== -1 ||
              lowerHref.indexOf("/page/") !== -1 ||
              lowerHref.indexOf("wp-") !== -1 ||
              lowerHref === base + "/" ||
              lowerHref === base
            ) return;

            // Prefer links that look like movie/series posts
            var lowerText = text.toLowerCase();
            var looksLikeContent =
              /\b(20\d{2}|19\d{2})\b/.test(text) ||
              /season|s\d{1,2}|episode|dual|audio|web-dl|bluray|hdrip|1080|720|480|4k/i.test(text) ||
              lowerHref.indexOf(base.replace("https://", "").split(".")[0]) !== -1;

            if (!looksLikeContent && s < selectors.length - 1) return;

            seen[href] = true;
            var absUrl = href.indexOf("http") === 0 ? href : (base + (href.charAt(0) === "/" ? href : "/" + href));
            var yearMatch = text.match(/\((\d{4})\)|\b(20\d{2}|19\d{2})\b/);
            var year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2], 10) : null;

            results.push({
              title: text,
              url: absUrl,
              poster: null,
              year: year
            });
          });
        }

        if (results.length) {
          currentBase = base; // remember working mirror
          console.log("[HDHub4u] HTML search found", results.length, "on", base);
          return results;
        }
      } catch (err) {
        console.log("[HDHub4u] HTML search error on", base, ":", err && err.message ? err.message : err);
      }
    }

    console.log("[HDHub4u] All HTML search attempts failed");
    return [];
  });
}

function findBestMatch(mediaInfo, results, mediaType, season) {
  if (!results || !results.length) return null;
  var best = null;
  var bestScore = 0;

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var score = titleSimilarity(mediaInfo.title, r.title);

    if (mediaInfo.year && r.year) {
      var diff = Math.abs(mediaInfo.year - r.year);
      if (diff === 0) score += 0.25;
      else if (diff === 1) score += 0.1;
      else if (diff > 3) score -= 0.3;
    }

    if ((mediaType === "tv" || mediaType === "series") && season) {
      var lower = (r.title || "").toLowerCase();
      var hasSeason =
        lower.indexOf("season " + season) !== -1 ||
        lower.indexOf("s" + season) !== -1 ||
        lower.indexOf("season " + String(season).padStart(2, "0")) !== -1 ||
        lower.indexOf("s" + String(season).padStart(2, "0")) !== -1;
      if (hasSeason) score += 0.4;
      else score -= 0.25;
    }

    if (score > bestScore && score > 0.35) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

// ─── Page parsing & extractors ───────────────────────────────────────────────
function getCheerio() {
  try {
    return require("cheerio-without-node-native");
  } catch (e) {
    try {
      return require("cheerio");
    } catch (e2) {
      return null;
    }
  }
}

function extractPageLinks(html, pageUrl) {
  var cheerio = getCheerio();
  if (!cheerio) {
    console.log("[HDHub4u] cheerio unavailable – cannot extract links");
    return [];
  }

  var $ = cheerio.load(html);
  var links = [];
  var seen = {};

  // Quality heading links + body download links
  $("h3 a, h4 a, h2 a, .page-body a, .entry-content a, .post-content a, a").each(function (i, el) {
    var href = $(el).attr("href");
    var text = ($(el).text() || "").trim();
    if (!href) return;
    if (href.indexOf("javascript:") === 0) return;

    var lower = href.toLowerCase();
    var isCandidate =
      lower.indexOf("hdstream") !== -1 ||
      lower.indexOf("hubcloud") !== -1 ||
      lower.indexOf("hubstream") !== -1 ||
      lower.indexOf("hblinks") !== -1 ||
      lower.indexOf("hubcdn") !== -1 ||
      lower.indexOf("pixeldrain") !== -1 ||
      lower.indexOf("gofile") !== -1 ||
      lower.indexOf("drive") !== -1 ||
      lower.indexOf("workers.dev") !== -1 ||
      lower.indexOf("r2.dev") !== -1 ||
      /480|720|1080|2160|4k/i.test(text);

    if (!isCandidate) return;
    if (seen[href]) return;
    seen[href] = true;

    // Make absolute if needed
    var abs = href;
    if (href.indexOf("http") !== 0) {
      try {
        abs = new URL(href, pageUrl).href;
      } catch (e) {
        abs = currentBase + (href.charAt(0) === "/" ? href : "/" + href);
      }
    }

    links.push({
      url: abs,
      name: text || "Download",
      quality: qualityFromText(text),
      size: sizeFromText(text)
    });
  });

  console.log("[HDHub4u] extractPageLinks found:", links.length);
  return links;
}

function resolveRedirect(url) {
  return __async(this, null, function* () {
    try {
      var res = yield fetch(url, {
        headers: Object.assign({}, HEADERS, { Referer: currentBase + "/" }),
        redirect: "follow"
      });
      return res.url || url;
    } catch (e) {
      return url;
    }
  });
}

function buildStreamObject(link, mediaInfo) {
  var nameParts = ["HDHub4u"];
  if (link.quality && link.quality !== "Unknown") nameParts.push(link.quality);
  if (link.size) nameParts.push(link.size);
  if (link.name && link.name.length < 50) nameParts.push(link.name);

  return {
    name: nameParts.join(" • "),
    title: mediaInfo.title + (mediaInfo.year ? " (" + mediaInfo.year + ")" : ""),
    url: link.url,
    quality: link.quality || "Unknown",
    size: link.size || null,
    type: "direct",
    behaviorHints: {
      bingeGroup: "hdhub4u",
      notWebReady: false
    }
  };
}

// ─── Main entry ──────────────────────────────────────────────────────────────
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      if (!tmdbId) return [];

      var type = mediaType === "series" ? "tv" : (mediaType || "movie");
      var mediaInfo = yield getTMDBDetails(tmdbId, type);

      console.log("[HDHub4u] TMDB:", mediaInfo.title, mediaInfo.year || "?", "type:", type, "S" + (season || "-") + "E" + (episode || "-"));

      var query = mediaInfo.title;
      if (type === "tv" && season) {
        query = mediaInfo.title + " Season " + season;
      }

      var results = yield searchPosts(query);
      if (!results.length) {
        // fallback: title only
        results = yield searchPosts(mediaInfo.title);
      }
      console.log("[HDHub4u] Search results:", results.length);
      if (!results.length) return [];

      var match = findBestMatch(mediaInfo, results, type, season);
      if (!match || !match.url) {
        console.log("[HDHub4u] No good match found");
        return [];
      }
      console.log("[HDHub4u] Best match:", match.title, "→", match.url);

      // Ensure absolute URL on current base
      var pageUrl = match.url;
      if (pageUrl.indexOf("http") !== 0) {
        pageUrl = currentBase + (pageUrl.charAt(0) === "/" ? pageUrl : "/" + pageUrl);
      }

      var pageRes = yield fetch(pageUrl, {
        headers: Object.assign({}, HEADERS, { Referer: currentBase + "/" })
      });

      if (!pageRes.ok) {
        // try next mirrors quickly
        for (var mi = 0; mi < Math.min(MIRRORS.length, 5); mi++) {
          var tryBase = MIRRORS[mi];
          var altUrl = pageUrl.replace(/https?:\/\/[^/]+/, tryBase);
          console.log("[HDHub4u] Trying mirror page:", altUrl);
          pageRes = yield fetch(altUrl, {
            headers: Object.assign({}, HEADERS, { Referer: tryBase + "/" })
          });
          if (pageRes.ok) {
            pageUrl = altUrl;
            currentBase = tryBase;
            break;
          }
        }
      }
      if (!pageRes.ok) {
        console.log("[HDHub4u] Page fetch failed on all mirrors");
        return [];
      }

      var html = yield pageRes.text();
      var rawLinks = extractPageLinks(html, pageUrl);
      if (!rawLinks.length) {
        console.log("[HDHub4u] No download links found on page");
        return [];
      }

      var streams = [];
      var seenFinal = {};

      for (var i = 0; i < rawLinks.length; i++) {
        var L = rawLinks[i];
        var finalUrl = L.url;

        // light resolve for intermediate short links
        if (
          finalUrl.indexOf("hdhub4u") !== -1 ||
          finalUrl.indexOf("hubcloud") !== -1 ||
          finalUrl.indexOf("hdstream") !== -1 ||
          finalUrl.indexOf("hblinks") !== -1
        ) {
          try {
            finalUrl = yield resolveRedirect(finalUrl);
          } catch (e) {}
        }

        if (seenFinal[finalUrl]) continue;
        seenFinal[finalUrl] = true;

        streams.push(buildStreamObject({
          url: finalUrl,
          name: L.name,
          quality: L.quality,
          size: L.size
        }, mediaInfo));
      }

      // Prefer higher quality first
      streams.sort(function (a, b) {
        var order = { "4K": 4, "1080p": 3, "720p": 2, "480p": 1, "Unknown": 0 };
        return (order[b.quality] || 0) - (order[a.quality] || 0);
      });

      console.log("[HDHub4u] Returning", streams.length, "streams");
      return streams;
    } catch (err) {
      console.log("[HDHub4u] error: " + (err && err.message ? err.message : err));
      return [];
    }
  });
}

module.exports = { getStreams };

