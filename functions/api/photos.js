// GET /api/photos?album=<albumId>&key=<authKey> — Fetch ALL photos from a
// Google Photos shared album. The album id and auth key come from the
// shared album URL: https://photos.google.com/share/<albumId>?key=<authKey>
//
// The shared album HTML only embeds the first ~300 photos (newest-first).
// To get the full album (older photos behind pagination) we call the same
// `snAcKc` batchexecute RPC the web UI uses, paging via a continuation token:
//   request:  [albumId, pageToken, null, authKey]   (token in index 1)
//   response: payload[1] = media items, payload[2] = next token (null at end)

var DEFAULT_BL = "boq_photosuiserver_20260617.03_p0";
var DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
var CACHE_TTL = 15 * 60; // 15 minutes
var MAX_PAGES = 20;

export async function onRequestGet(context) {
  var url = new URL(context.request.url);

  var albumId, authKey;
  var qAlbum = (url.searchParams.get("album") || "").trim();
  var qKey = (url.searchParams.get("key") || "").trim();
  if (!qAlbum || !qKey) {
    return json({ error: "Missing required params: ?album=<albumId>&key=<authKey>" }, 400);
  }
  albumId = qAlbum;
  authKey = qKey;

  var shareUrl = "https://photos.google.com/share/" + albumId + "?key=" + authKey;

  // Per-album cache
  var cache = caches.default;
  var cacheKey = new Request("https://slideshow.local/api/photos-cache-custom-" + albumId);
  var cached = await cache.match(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  }

  try {
    // Fetch the share page once to read the current "bl" build label and to
    // have an HTML fallback if the RPC pagination ever stops working.
    var html = "";
    var bl = DEFAULT_BL;
    try {
      var res = await fetch(shareUrl, { headers: { "User-Agent": DESKTOP_UA } });
      if (res.ok) {
        html = await res.text();
        var blm = /"cfb2h":"([^"]+)"/.exec(html);
        if (blm) bl = blm[1];
      }
    } catch (e) { /* fall through with default bl */ }

    // Primary: page through the whole album via snAcKc.
    var photos = await fetchAllPhotos(albumId, authKey, shareUrl, bl);

    // Fallback 1: parse the first page out of the embedded HTML data array.
    if (photos.length === 0 && html) {
      photos = parseDataArrayPhotos(albumId, html);
    }

    // Fallback 2: raw /pw/ URL scrape (no dates).
    if (photos.length === 0 && html) {
      var regex = /https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-\/]+/g;
      var matches = html.match(regex) || [];
      var seen = {};
      for (var i = 0; i < matches.length; i++) {
        if (seen[matches[i]]) continue;
        seen[matches[i]] = true;
        photos.push({
          id: albumId + "-" + photos.length,
          baseUrl: matches[i] + "=w800",
          timestamp: null,
          filename: null
        });
      }
    }

    var responseBody = JSON.stringify({ photos: photos, count: photos.length });

    // Cache for 15 minutes
    var cacheResponse = new Response(responseBody, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=" + CACHE_TTL
      }
    });
    context.waitUntil(cache.put(cacheKey, cacheResponse));

    return new Response(responseBody, {
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders()
      }
    });
  } catch (err) {
    console.error("photos error:", err);
    return json({ error: "Internal error fetching photos." }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

// Page through the entire album using the snAcKc RPC.
async function fetchAllPhotos(albumId, authKey, shareUrl, bl) {
  var photos = [];
  var seen = {};
  var token = null;
  var reqid = 100000;
  var endpoint = "https://photos.google.com/_/PhotosUi/data/batchexecute?rpcids=snAcKc" +
    "&source-path=%2Fshare%2F" + albumId +
    "&bl=" + encodeURIComponent(bl) + "&hl=en&rt=c";

  for (var page = 0; page < MAX_PAGES; page++) {
    reqid++;
    var inner = JSON.stringify([albumId, token, null, authKey]);
    var freq = JSON.stringify([[["snAcKc", inner, null, "generic"]]]);

    var res = await fetch(endpoint + "&_reqid=" + reqid, {
      method: "POST",
      headers: {
        "User-Agent": DESKTOP_UA,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
        "Referer": shareUrl
      },
      body: "f.req=" + encodeURIComponent(freq)
    });
    if (!res.ok) break;

    var text = await res.text();
    var payload = parseBatchPayload(text);
    if (!payload || !payload[1] || payload[1].length === 0) break;

    var items = payload[1];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || !item[1] || !item[1][0]) continue;
      var photoUrl = item[1][0];
      if (typeof photoUrl !== "string" || photoUrl.indexOf("/pw/") === -1) continue;
      if (seen[photoUrl]) continue;
      seen[photoUrl] = true;
      var ts = (typeof item[2] === "number") ? item[2] : null;
      photos.push({
        id: albumId + "-" + photos.length,
        baseUrl: photoUrl + "=w800",
        timestamp: ts,
        filename: null
      });
    }

    token = payload[2];
    if (!token) break; // null token => album exhausted
  }

  return photos;
}

// Extract the snAcKc JSON payload from a batchexecute response.
// Response contains a line like: [["wrb.fr","snAcKc","<json string>",...]]
function parseBatchPayload(text) {
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();
    if (ln.indexOf('[["wrb.fr"') !== 0) continue;
    var arr;
    try { arr = JSON.parse(ln); } catch (e) { continue; }
    for (var j = 0; j < arr.length; j++) {
      var it = arr[j];
      if (it && it[0] === "wrb.fr" && it[1] === "snAcKc" && it[2]) {
        try { return JSON.parse(it[2]); } catch (e) { return null; }
      }
    }
  }
  return null;
}

// Parse photo entries from the embedded HTML data array (first-page fallback).
// Entry shape: ["AF1Qip<id>",["<pwUrl>",W,H,...nested arrays...],<timestampMs>,...
function parseDataArrayPhotos(albumId, html) {
  var photos = [];
  var seen = {};
  var startRe = /\["(AF1Qip[A-Za-z0-9_\-]+)",(\[)"(https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-]+)"/g;
  var m;
  while ((m = startRe.exec(html)) !== null) {
    var url = m[3];
    if (seen[url]) continue;

    var i = m.index + m[0].lastIndexOf("[");
    var depth = 0;
    var n = html.length;
    var j = i;
    for (; j < n; j++) {
      var c = html.charAt(j);
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) break;
      }
    }

    var tail = html.substr(j + 1, 16);
    var tm = /^,(\d{13}),/.exec(tail);
    var ts = tm ? parseInt(tm[1], 10) : null;

    seen[url] = true;
    photos.push({
      id: albumId + "-" + photos.length,
      baseUrl: url + "=w800",
      timestamp: ts,
      filename: null
    });
  }
  return photos;
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
