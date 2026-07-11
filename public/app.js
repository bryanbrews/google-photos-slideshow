// ─── Slideshow ───
// Full-screen photo slideshow with a Ken Burns zoom and a random background
// track (chosen fresh on every reload) from a pool of YouTube tracks. Photos
// come from the shared /api/photos backend and advance continuously through
// previously-unshown photos before ever looping.

"use strict";

// ─── Config ───
var SLIDE_MS = 7000;        // dwell per slide (Ken Burns runs ~1s longer)
var URL_KEY = "slideshow_url";        // last-used share link (prefilled on load)
var SHOWN_PREFIX = "slideshow_shown_"; // + albumId — tracked per album
var BATCH = 30;             // photos queued per refill
var REFILL_THRESHOLD = 5;   // refill when fewer than this remain in the queue

// Random music pool — one is picked per page load.
var MUSIC_POOL = [
  { type: "yt", id: "VqaTXraTu3Y" },
  { type: "yt", id: "rLhrfCZROlQ" },
  { type: "yt", id: "3h2Icu41e1k" }
];
var CHOSEN_TRACK = MUSIC_POOL[Math.floor(Math.random() * MUSIC_POOL.length)];

// ─── State ───
var currentAlbum = null;  // { albumId, authKey } for the loaded album
var allPhotos = [];      // full list from the server
var queue = [];          // upcoming photos (shift from the front)
var history = [];        // photos already shown this session, in order
var histPos = -1;        // index in `history` of the current slide
var shownSet = new Set();

var layers = [];         // the two <img> elements
var activeLayer = 0;

var paused = false;
var slideTimer = null;
var started = false;

// ─── Boot ───
document.addEventListener("DOMContentLoaded", function () {
  layers = [document.getElementById("slide-a"), document.getElementById("slide-b")];

  setupControls();
  setupKeyboard();
  setupStartGate();
  bumpControls();

  // Prefill the last-used share link so returning visitors just press play.
  var input = document.getElementById("album-url");
  try {
    var saved = localStorage.getItem(URL_KEY);
    if (saved && input) input.value = saved;
  } catch (e) {}
});

// Parse a Google Photos share URL into its album id + auth key.
//   https://photos.google.com/share/<albumId>?key=<authKey>
function parseShareUrl(input) {
  try {
    var u = new URL((input || "").trim());
    var m = u.pathname.match(/\/share\/([^\/?]+)/);
    var key = u.searchParams.get("key");
    if (m && key) return { albumId: m[1], authKey: key };
  } catch (e) {}
  return null;
}

// ─── Photo fetch ───
function fetchPhotos() {
  // Reset per-load so retries / new albums start clean.
  allPhotos = [];
  queue = [];
  history = [];
  histPos = -1;
  var endpoint = "/api/photos?album=" + encodeURIComponent(currentAlbum.albumId) +
                 "&key=" + encodeURIComponent(currentAlbum.authKey);
  return fetch(endpoint)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      allPhotos = (data && data.photos) ? data.photos : [];
    })
    .catch(function () {
      allPhotos = [];
    });
}

// ─── "New photos" tracking (keyed per album) ───
function shownKey() {
  return SHOWN_PREFIX + (currentAlbum ? currentAlbum.albumId : "");
}
function loadShown() {
  try { return new Set(JSON.parse(localStorage.getItem(shownKey()) || "[]")); }
  catch (e) { return new Set(); }
}
function saveShown() {
  try { localStorage.setItem(shownKey(), JSON.stringify(Array.from(shownSet))); }
  catch (e) {}
}
function getUnseen() {
  return allPhotos.filter(function (p) { return !shownSet.has(p.id); });
}
function shuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Append a shuffled batch of unseen photos to the queue, marking them shown.
// When nothing is unseen, reset the shown set and reshuffle the whole album so
// the show keeps going — continuous, but always prefers unshown photos first.
function refillQueue() {
  if (allPhotos.length === 0) return;
  var unseen = getUnseen();
  if (unseen.length === 0) {
    shownSet = new Set();
    saveShown();
    unseen = allPhotos.slice();
  }
  var batch = shuffle(unseen.slice()).slice(0, BATCH);
  for (var i = 0; i < batch.length; i++) shownSet.add(batch[i].id);
  saveShown();
  queue.push.apply(queue, batch);
}

// ─── Slideshow control ───
function beginSlideshow() {
  if (allPhotos.length === 0) return;
  refillQueue();
  goNext(false);
}

function goNext(manual) {
  if (histPos < history.length - 1) {
    // Advancing after having stepped back through history.
    histPos++;
    showPhoto(history[histPos]);
  } else {
    if (queue.length <= REFILL_THRESHOLD) refillQueue();
    var photo = queue.shift();
    if (!photo) return;
    history.push(photo);
    histPos = history.length - 1;
    showPhoto(photo);
  }
  if (!manual) scheduleNext();
  else if (!paused) scheduleNext();
}

function goPrev() {
  if (histPos <= 0) return;
  histPos--;
  showPhoto(history[histPos]);
  if (!paused) scheduleNext();
}

function scheduleNext() {
  clearTimeout(slideTimer);
  if (paused) return;
  slideTimer = setTimeout(function () { goNext(false); }, SLIDE_MS);
}

// ─── Rendering ───
var KB_DIRS = ["kb-tl", "kb-tr", "kb-bl", "kb-br", "kb-c"];

function showPhoto(photo) {
  var url = photo.baseUrl.replace(/=w\d+$/, "=w1600");
  var nextEl = layers[1 - activeLayer];
  var curEl = layers[activeLayer];

  // Preload so the crossfade never flashes a partially-loaded image.
  var pre = new Image();
  pre.onload = function () {
    var portraitViewport = window.innerHeight >= window.innerWidth;
    var photoLandscape = pre.naturalWidth > pre.naturalHeight;
    var photoPortrait = pre.naturalHeight > pre.naturalWidth;
    var mismatch = (portraitViewport && photoLandscape) ||
                   (!portraitViewport && photoPortrait);

    nextEl.src = url;

    // Reset then restart the Ken Burns animation for this slide.
    nextEl.className = "slide";
    void nextEl.offsetWidth; // force reflow so the animation restarts
    nextEl.classList.add("kb");
    if (mismatch) nextEl.classList.add("kb-strong");
    nextEl.classList.add(KB_DIRS[Math.floor(Math.random() * KB_DIRS.length)]);

    // Crossfade.
    nextEl.classList.add("active");
    curEl.classList.remove("active");
    activeLayer = 1 - activeLayer;
  };
  pre.onerror = function () {
    // Skip a broken image and move along.
    if (!paused) goNext(false);
  };
  pre.src = url;
}

// ─── Controls ───
function setupControls() {
  document.getElementById("prev-btn").addEventListener("click", function (e) {
    e.stopPropagation(); goPrev(); bumpControls();
  });
  document.getElementById("next-btn").addEventListener("click", function (e) {
    e.stopPropagation(); goNext(true); bumpControls();
  });
  document.getElementById("play-btn").addEventListener("click", function (e) {
    e.stopPropagation(); togglePause(); bumpControls();
  });
  document.getElementById("music-toggle").addEventListener("click", function (e) {
    e.stopPropagation(); toggleMusic(); bumpControls();
  });

  // Clicking the photo toggles pause.
  document.getElementById("stage").addEventListener("click", function () {
    togglePause(); bumpControls();
  });

  document.addEventListener("mousemove", bumpControls);
}

function setupKeyboard() {
  document.addEventListener("keydown", function (e) {
    if (e.key === " " || e.code === "Space") {
      e.preventDefault(); togglePause(); bumpControls();
    } else if (e.key === "ArrowRight") {
      goNext(true); bumpControls();
    } else if (e.key === "ArrowLeft") {
      goPrev(); bumpControls();
    }
  });
}

function togglePause() {
  paused = !paused;
  var btn = document.getElementById("play-btn");
  if (paused) {
    clearTimeout(slideTimer);
    btn.innerHTML = "&#9654;"; // play glyph
    btn.setAttribute("aria-label", "Play");
  } else {
    btn.innerHTML = "&#10074;&#10074;"; // pause glyph
    btn.setAttribute("aria-label", "Pause");
    scheduleNext();
  }
}

var controlsTimer = null;
function bumpControls() {
  document.body.classList.add("show-controls");
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(function () {
    document.body.classList.remove("show-controls");
  }, 2500);
}

// ─── Start gate ───
var audioUnlocked = false;
function setupStartGate() {
  var form = document.getElementById("start-form");
  var input = document.getElementById("album-url");
  if (!form || !input) return;

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    onPressPlay();
  });
}

function setError(msg) {
  var el = document.getElementById("start-error");
  if (el) el.textContent = msg || "";
}
function setBusy(busy) {
  var btn = document.getElementById("start-btn");
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy ? "Loading\u2026" : "&#9654;&nbsp; PRESS PLAY";
}

function onPressPlay() {
  var input = document.getElementById("album-url");
  var parsed = parseShareUrl(input && input.value);
  if (!parsed) {
    setError("Enter a valid Google Photos share link.");
    return;
  }

  // Unlock audio on the FIRST valid gesture only (must happen in-gesture on iOS).
  if (!audioUnlocked) {
    audioUnlocked = true;
    startMusicInGesture();
  }

  currentAlbum = parsed;
  try { localStorage.setItem(URL_KEY, input.value.trim()); } catch (e) {}
  shownSet = loadShown();
  setError("");
  setBusy(true);

  fetchPhotos().then(function () {
    setBusy(false);
    if (allPhotos.length === 0) {
      setError("No photos found for that link.");
      return;
    }
    dismissOverlay();
    started = true;
    beginSlideshow();
  });
}

function dismissOverlay() {
  var overlay = document.getElementById("start-overlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  setTimeout(function () { overlay.style.display = "none"; }, 600);
}

// ─── Music ───
// A single random track drives the whole session. YouTube tracks use the
// hidden IFrame player (autoplay muted, then unmuted inside the start gesture).

var musicPlaying = false;

// -- YouTube backend --
var YT_VOLUME = 25;
var ytPlayer = null;
var ytReady = false;
var ytUnmuted = false;

window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player("yt-frame", {
    width: "100%",
    height: "100%",
    videoId: CHOSEN_TRACK.id,
    playerVars: {
      autoplay: 1,
      mute: 1,
      controls: 0,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      list: "RD" + CHOSEN_TRACK.id,
      listType: "playlist"
    },
    events: {
      onReady: function (e) {
        ytReady = true;
        e.target.playVideo();
        musicPlaying = true;
        if (audioUnlocked) primeYoutubeAudio();
      },
      onStateChange: function (e) {
        if (e.data === YT.PlayerState.PLAYING) musicPlaying = true;
        else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) musicPlaying = false;
        updateMusicButton();
      }
    }
  });
};

function primeYoutubeAudio() {
  if (!ytPlayer || ytUnmuted) return;
  try {
    if (typeof ytPlayer.unMute === "function") ytPlayer.unMute();
    ytPlayer.setVolume(YT_VOLUME);
    ytPlayer.playVideo();
    ytUnmuted = true;
    musicPlaying = true;
    updateMusicButton();
  } catch (e) {}
}

// -- Unified controls --
function startMusicInGesture() {
  // YouTube: the player may or may not be ready yet; unmute now if it is,
  // otherwise onReady will call primeYoutubeAudio once audioUnlocked is set.
  primeYoutubeAudio();
  updateMusicButton();
}

function toggleMusic() {
  if (!ytReady || !ytPlayer) return;
  if (musicPlaying) { ytPlayer.pauseVideo(); musicPlaying = false; }
  else {
    try {
      if (typeof ytPlayer.unMute === "function") ytPlayer.unMute();
      ytPlayer.setVolume(YT_VOLUME);
    } catch (e) {}
    ytPlayer.playVideo();
    ytUnmuted = true;
    musicPlaying = true;
  }
  updateMusicButton();
}

function updateMusicButton() {
  var btn = document.getElementById("music-toggle");
  if (!btn) return;
  btn.classList.toggle("off", !musicPlaying);
  btn.setAttribute("aria-label", musicPlaying ? "Mute music" : "Play music");
}
