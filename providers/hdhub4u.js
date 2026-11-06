/**
 * HDHub4u Provider for Nuvio (v1.2.1)
 * - HTML search fallback
 * - HubCloud / intermediate link resolver
 * - Updated mirrors + auto failover
 * - Fixes: normalizeTitle order/Unicode, season boundary match, episode filter,
 *   fetch timeout, parallel resolve, quality word-boundary, score threshold config,
 *   mediaType normalize, safer TMDB key handling
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

var SEARCH_API = "https://search.hdhub4u.glass/collections/post/documents/search";
// Do not hardcode API keys. Prefer environment variable when available.
var TMDB_API_KEY = (typeof process !== "undefined" && process.env && process.env.TMDB_API_KEY) || "";
var TMDB_BASE = "https://api.themoviedb.org/3";

var MATCH_SCORE_THRESHOLD = 0.35;
var FETCH_TIMEOUT_MS = 10000;
var RESOLVE_CONCURRENCY = 4;

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
  // Order: strip articles → punctuation → collapse whitespace last
  // Avoid [^\w\s] which drops non-Latin scripts (Bengali, Hindi, etc.)
  return t.toLowerCase()
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/[:\-_'`~!@#$%^&*()+=\[\]{};:"\\|,.<>\/?]+/g, " ")
    .replace(/\s+/g, " ")
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
  var unionSize = Object.keys(union).length;
  return inter / unionSize;
}

function qualityFromText(text) {
  if (!text) return "Unknown";
  var t = String(text);
  // Word boundaries avoid false positives (e.g. "4Kids", digits inside larger numbers)
  if (/\b2160\b|\b4K\b/i.test(t)) return "4K";
  if (/\b1080\b/i.test(t)) return "1080p";
  if (/\b720\b/i.test(t)) return "720p";
  if (/\b480\b/i.test(t)) return "480p";
  return "Unknown";
}

function sizeFromText(text) {
  if (!text) return null;
  var m = text.match(/(\d+(?:\.\d+)?)\s*(GB|MB|TB)/i);
  if (!m) return null;
  return m[1] + " " + m[2].toUpperCase();
}

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

function normalizeMediaType(mediaType) {
  if (mediaType === "series" || mediaType === "tv") return "tv";
  return "movie";
}

/** fetch with AbortController timeout so one hung mirror does not block everything */
function fetchWithTimeout(url, options, timeoutMs) {
  timeoutMs = timeoutMs || FETCH_TIMEOUT_MS;
  var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  var timer = null;
  var opts = Object.assign({}, options || {});
  if (controller) {
    opts.signal = controller.signal;
    timer = setTimeout(function () {
      try { controller.abort(); } catch (e) {}
    }, timeoutMs);
  }
  return fetch(url, opts).then(
    function (res) {
      if (timer) clearTimeout(timer);
      return res;
    },
    function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    }
  );
}

/** simple concurrency-limited map */
function mapLimit(items, limit, iterator) {
  return __async(this, null, function* () {
    var results = new Array(items.length);
    var idx = 0;
    function worker() {
      return __async(this, null, function* () {
        while (idx < items.length) {
          var i = idx++;
          try {
            results[i] = yield iterator(items[i], i);
          } catch (e) {
            results[i] = e;
          }
        }
      });
    }
    var workers = [];
    var n = Math.min(limit, items.length) || 1;
    for (var w = 0; w < n; w++) workers.push(worker());
    yield Promise.all(workers);
    return results;
  });
}

function matchesEpisode(text, episode) {
  if (!episode && episode !== 0) return true;
  if (!text) return false;
  var lower = String(text).toLowerCase();
  var ep = String(episode);
  var epPad = ep.padStart(2, "0");
  // e01, e1, episode 1, ep 01, x01 style
  var re = new RegExp(
    "\\b(?:e|ep|episode)\\s*0*" + ep + "\\b|\\be0*" + epPad + "\\b|\\bx0*" + ep + "\\b",
    "i"
  );
  return re.test(lower);
}

function matchesSeason(text, season) {
  if (!season && season !== 0) return true;
  if (!text) return false;
  var lower = String(text).toLowerCase();
  var s = String(season);
  // word-boundary so s1 does not match s10 / s12 / boss1
  var re = new RegExp(
    "\\b(?:season\\s*0*" + s + "|s\\s*0*" + s + ")\\b",
    "i"
  );
  return re.test(lower);
}

// ─── TMDB ────────────────────────────────────────────────────────────────────
function getTMDBDetails(tmdbId, mediaType) {
  return __async(this, null, function* () {
    if (!TMDB_API_KEY) {
      throw new Error("TMDB_API_KEY not set (use process.env.TMDB_API_KEY)");
    }
    var endpoint = normalizeMediaType(mediaType) === "tv" ? "tv" : "movie";
    var url = TMDB_BASE + "/" + endpoint + "/" + tmdbId + "?api_key=" + TMDB_API_KEY + "&append_to_response=external_ids";
    var res = yield fetchWithTimeout(url, {
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
function searchPosts(query) {
  return __async(this, null, function* () {
    try {
      var today = new Date().toISOString().split("T")[0];
      var apiUrl = SEARCH_API +
        "?q=" + encodeURIComponent(query) +
        "&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=20&highlight_fields=none&use_cache=true&page=1&analytics_tag=" + today;

      var apiRes = yield fetchWithTimeout(apiUrl, { headers: HEADERS });
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
            return { title: title, url: link, poster: doc.post_thumbnail || null, year: year };
          });
        }
      } else {
        console.log("[HDHub4u] Typesense status:", apiRes.status, "→ HTML fallback");
      }
    } catch (e) {
      console.log("[HDHub4u] Typesense error:", e && e.message ? e.message : e);
    }
    return yield searchPostsHtml(query);
  });
}

function searchPostsHtml(query) {
  return __async(this, null, function* () {
    var cheerio = getCheerio();
    if (!cheerio) {
      console.log("[HDHub4u] No cheerio available");
      return [];
    }

    for (var mi = 0; mi < MIRRORS.length; mi++) {
      var base = MIRRORS[mi];
      var searchUrl = base + "/?s=" + encodeURIComponent(query);
      console.log("[HDHub4u] HTML search:", searchUrl);

      try {
        var res = yield fetchWithTimeout(searchUrl, {
          headers: Object.assign({}, HEADERS, { Referer: base + "/" }),
          redirect: "follow"
        });
        if (!res.ok) continue;

        var html = yield res.text();
        if (
          html.indexOf("cf-browser-verification") !== -1 ||
          html.indexOf("challenge-platform") !== -1 ||
          html.indexOf("Just a moment") !== -1 ||
          html.length < 2000
        ) {
          console.log("[HDHub4u] Challenge page on", base);
          continue;
        }

        var $ = cheerio.load(html);
        var results = [];
        var seen = {};
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

            var lowerHref = href.toLowerCase();
            if (
              lowerHref.indexOf("/category/") !== -1 ||
              lowerHref.indexOf("/tag/") !== -1 ||
              lowerHref.indexOf("/page/") !== -1 ||
              lowerHref.indexOf("wp-") !== -1 ||
              lowerHref === base + "/" ||
              lowerHref === base
            ) return;

            var looksLikeContent =
              /\b(20\d{2}|19\d{2})\b/.test(text) ||
              /season|s\d{1,2}|episode|dual|audio|web-dl|bluray|hdrip|1080|720|480|4k/i.test(text);

            if (!looksLikeContent && s < selectors.length - 1) return;

            seen[href] = true;
            var absUrl = href.indexOf("http") === 0 ? href : (base + (href.charAt(0) === "/" ? href : "/" + href));
            var yearMatch = text.match(/\((\d{4})\)|\b(20\d{2}|19\d{2})\b/);
            var year = yearMatch ? parseInt(yearMatch[1] || yearMatch[2], 10) : null;
            results.push({ title: text, url: absUrl, poster: null, year: year });
          });
        }

        if (results.length) {
          currentBase = base;
          console.log("[HDHub4u] HTML search found", results.length, "on", base);
          return results;
        }
      } catch (err) {
        console.log("[HDHub4u] HTML search error on", base, ":", err && err.message ? err.message : err);
      }
    }
    return [];
  });
}

function findBestMatch(mediaInfo, results, mediaType, season) {
  if (!results || !results.length) return null;
  var best = null;
  var bestScore = 0;
  var type = normalizeMediaType(mediaType);

  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var score = titleSimilarity(mediaInfo.title, r.title);

    if (mediaInfo.year && r.year) {
      var diff = Math.abs(mediaInfo.year - r.year);
      if (diff === 0) score += 0.25;
      else if (diff === 1) score += 0.1;
      else if (diff > 3) score -= 0.3;
    }

    if (type === "tv" && season) {
      if (matchesSeason(r.title, season)) score += 0.4;
      else score -= 0.25;
    }

    if (score > bestScore && score > MATCH_SCORE_THRESHOLD) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

// ─── Page parsing ────────────────────────────────────────────────────────────
function extractPageLinks(html, pageUrl) {
  var cheerio = getCheerio();
  if (!cheerio) return [];

  var $ = cheerio.load(html);
  var links = [];
  var seen = {};

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

// ─── HubCloud Resolver (core fix) ────────────────────────────────────────────
function resolveHubCloud(url, referer) {
  return __async(this, null, function* () {
    var cheerio = getCheerio();
    if (!cheerio) return [];

    try {
      var currentUrl = url.replace("hubcloud.ink", "hubcloud.dad");
      console.log("[HDHub4u] Resolving HubCloud:", currentUrl);

      var res = yield fetchWithTimeout(currentUrl, {
        headers: Object.assign({}, HEADERS, { Referer: referer || currentBase + "/" }),
        redirect: "follow"
      });
      var html = yield res.text();
      var finalUrl = res.url || currentUrl;

      // Step 1: if not already on hubcloud.php, find next hop
      if (finalUrl.indexOf("hubcloud.php") === -1 && html.indexOf("hubcloud.php") === -1) {
        var $1 = cheerio.load(html);
        var nextHref = "";

        var downloadBtn = $1("#download").attr("href") || $1("a#download").attr("href");
        if (downloadBtn) {
          nextHref = downloadBtn;
        } else {
          var scriptMatch = html.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/);
          if (scriptMatch) nextHref = scriptMatch[1];
        }

        if (nextHref) {
          if (nextHref.indexOf("http") !== 0) {
            try {
              nextHref = new URL(nextHref, finalUrl).href;
            } catch (e) {
              nextHref = finalUrl.replace(/\/[^/]*$/, "/") + nextHref.replace(/^\//, "");
            }
          }
          console.log("[HDHub4u] HubCloud next hop:", nextHref);
          var res2 = yield fetchWithTimeout(nextHref, {
            headers: Object.assign({}, HEADERS, { Referer: finalUrl }),
            redirect: "follow"
          });
          html = yield res2.text();
          finalUrl = res2.url || nextHref;
        }
      }

      var $ = cheerio.load(html);
      var sizeText = ($("i#size").text() || "").trim();
      var headerText = ($("div.card-header").text() || $("title").text() || "").trim();
      var quality = qualityFromText(headerText + " " + sizeText);
      var size = sizeFromText(sizeText) || sizeFromText(headerText);

      var results = [];
      var seen = {};

      $("a.btn, a[href], .btn a").each(function (i, el) {
        var link = $(el).attr("href");
        var text = ($(el).text() || "").toLowerCase().trim();
        if (!link || seen[link]) return;

        // Skip non-useful links
        if (link.indexOf("javascript:") === 0) return;
        if (link === "#" || link.indexOf("telegram") !== -1 || link.indexOf("whatsapp") !== -1) return;

        var isUseful =
          text.indexOf("download") !== -1 ||
          text.indexOf("fsl") !== -1 ||
          text.indexOf("s3") !== -1 ||
          text.indexOf("buzz") !== -1 ||
          text.indexOf("10gbps") !== -1 ||
          text.indexOf("mega") !== -1 ||
          text.indexOf("pixel") !== -1 ||
          text.indexOf("gofile") !== -1 ||
          text.indexOf("zipdisk") !== -1 ||
          link.indexOf("workers.dev") !== -1 ||
          link.indexOf("r2.dev") !== -1 ||
          link.indexOf("pixeldrain") !== -1 ||
          link.indexOf("gofile") !== -1 ||
          link.indexOf("hubcloud") !== -1 ||
          /\.(mkv|mp4|avi|m3u8)(\?|$)/i.test(link);

        if (!isUseful) return;
        seen[link] = true;

        var absLink = link;
        if (link.indexOf("http") !== 0) {
          try {
            absLink = new URL(link, finalUrl).href;
          } catch (e) {
            absLink = link;
          }
        }

        var label = "HubCloud";
        if (text.indexOf("fsl") !== -1) label = "HubCloud FSL";
        else if (text.indexOf("s3") !== -1) label = "HubCloud S3";
        else if (text.indexOf("buzz") !== -1) label = "HubCloud Buzz";
        else if (text.indexOf("10gbps") !== -1) label = "HubCloud 10Gbps";
        else if (text.indexOf("mega") !== -1) label = "HubCloud Mega";
        else if (text.indexOf("pixel") !== -1 || absLink.indexOf("pixeldrain") !== -1) label = "Pixeldrain";
        else if (text.indexOf("gofile") !== -1 || absLink.indexOf("gofile") !== -1) label = "Gofile";
        else if (absLink.indexOf("workers.dev") !== -1) label = "Workers";

        results.push({
          url: absLink,
          name: label + (size ? " • " + size : ""),
          quality: quality,
          size: size
        });
      });

      console.log("[HDHub4u] HubCloud resolved:", results.length, "links");
      return results;
    } catch (err) {
      console.log("[HDHub4u] HubCloud resolve error:", err && err.message ? err.message : err);
      return [];
    }
  });
}

function resolveLink(url, referer) {
  return __async(this, null, function* () {
    var lower = (url || "").toLowerCase();

    // Already looks like direct file
    if (/\.(mkv|mp4|avi|m3u8)(\?|$)/i.test(url) || lower.indexOf("workers.dev") !== -1 || lower.indexOf("r2.dev") !== -1) {
      return [{ url: url, name: "Direct", quality: "Unknown", size: null }];
    }

    // HubCloud family
    if (lower.indexOf("hubcloud") !== -1 || lower.indexOf("hubcdn") !== -1) {
      return yield resolveHubCloud(url, referer);
    }

    // Simple redirect follow for other intermediate hosts
    try {
      var res = yield fetchWithTimeout(url, {
        headers: Object.assign({}, HEADERS, { Referer: referer || currentBase + "/" }),
        redirect: "follow"
      });
      var final = res.url || url;

      // If final is still intermediate, try HubCloud logic
      if (final.toLowerCase().indexOf("hubcloud") !== -1) {
        return yield resolveHubCloud(final, url);
      }

      return [{ url: final, name: "Resolved", quality: "Unknown", size: null }];
    } catch (e) {
      return [{ url: url, name: "Original", quality: "Unknown", size: null }];
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

      var type = normalizeMediaType(mediaType);
      var mediaInfo = yield getTMDBDetails(tmdbId, type);

      console.log("[HDHub4u] TMDB:", mediaInfo.title, mediaInfo.year || "?", "type:", type, "S" + (season || "-") + "E" + (episode || "-"));

      var query = mediaInfo.title;
      if (type === "tv" && season) {
        query = mediaInfo.title + " Season " + season;
      }

      var results = yield searchPosts(query);
      if (!results.length) {
        results = yield searchPosts(mediaInfo.title);
      }
      console.log("[HDHub4u] Search results:", results.length);
      if (!results.length) return [];

      var match = findBestMatch(mediaInfo, results, type, season);
      if (!match || !match.url) {
        console.log("[HDHub4u] No good match");
        return [];
      }
      console.log("[HDHub4u] Best match:", match.title, "→", match.url);

      var pageUrl = match.url;
      if (pageUrl.indexOf("http") !== 0) {
        pageUrl = currentBase + (pageUrl.charAt(0) === "/" ? pageUrl : "/" + pageUrl);
      }

      var pageRes = yield fetchWithTimeout(pageUrl, {
        headers: Object.assign({}, HEADERS, { Referer: currentBase + "/" })
      });

      if (!pageRes.ok) {
        for (var mi = 0; mi < Math.min(MIRRORS.length, 5); mi++) {
          var tryBase = MIRRORS[mi];
          var altUrl = pageUrl.replace(/https?:\/\/[^/]+/, tryBase);
          try {
            pageRes = yield fetchWithTimeout(altUrl, {
              headers: Object.assign({}, HEADERS, { Referer: tryBase + "/" })
            });
          } catch (e) {
            continue;
          }
          if (pageRes.ok) {
            pageUrl = altUrl;
            currentBase = tryBase;
            break;
          }
        }
      }
      if (!pageRes.ok) {
        console.log("[HDHub4u] Page fetch failed");
        return [];
      }

      var html = yield pageRes.text();
      var rawLinks = extractPageLinks(html, pageUrl);
      if (!rawLinks.length) {
        console.log("[HDHub4u] No links on page");
        return [];
      }

      // Prefer links that mention the requested episode (when provided)
      if (type === "tv" && (episode || episode === 0)) {
        var epFiltered = rawLinks.filter(function (L) {
          return matchesEpisode(L.name, episode) || matchesEpisode(L.url, episode);
        });
        if (epFiltered.length) {
          console.log("[HDHub4u] Episode filter kept", epFiltered.length, "of", rawLinks.length);
          rawLinks = epFiltered;
        } else {
          console.log("[HDHub4u] No episode-specific links; using all", rawLinks.length);
        }
      }

      var streams = [];
      var seenFinal = {};

      // Parallel resolve with limited concurrency (avoids sequential slowness)
      var resolvedBatches = yield mapLimit(rawLinks, RESOLVE_CONCURRENCY, function (L) {
        return resolveLink(L.url, pageUrl).then(function (resolved) {
          return { L: L, resolved: resolved };
        }).catch(function (e) {
          console.log("[HDHub4u] resolve error:", e && e.message ? e.message : e);
          return { L: L, resolved: [] };
        });
      });

      for (var bi = 0; bi < resolvedBatches.length; bi++) {
        var batch = resolvedBatches[bi];
        if (!batch || !batch.resolved) continue;
        var L = batch.L;
        var resolved = batch.resolved;
        for (var j = 0; j < resolved.length; j++) {
          var R = resolved[j];
          if (!R.url || seenFinal[R.url]) continue;
          seenFinal[R.url] = true;

          streams.push(buildStreamObject({
            url: R.url,
            name: R.name || L.name,
            quality: R.quality !== "Unknown" ? R.quality : L.quality,
            size: R.size || L.size
          }, mediaInfo));
        }
      }

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
