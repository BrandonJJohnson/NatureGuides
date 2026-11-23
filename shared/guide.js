/* Shared field-guide runtime. Injected after each guide's own script by
   tools/sync_shared.py and replaces/extends the per-guide functions so every
   guide behaves the same:
     - live Louisiana iNaturalist counts (auto, cached) drive the key's likelihoods
     - safe photo loading: broken remote photos fall back to the embedded photo
     - safe audio: one player, cancelled/failed loads never throw or leave junk
     - polite iNaturalist requests: limited concurrency, retries on 429/5xx
   Config comes from window.ND_GUIDE = {id, ancestor, placeId, soundLabel}. */
(function () {
  'use strict';
  var CFG = window.ND_GUIDE || {};
  var PLACE = CFG.placeId || 27;
  var NS = 'nd:' + (CFG.id || location.pathname) + ':';
  var COUNT_TTL = 12 * 60 * 60 * 1000;           // refresh counts twice a day
  var SOUND = CFG.soundLabel || 'Play Sound';
  var USABLE = { 'cc0': 1, 'cc-by': 1, 'cc-by-sa': 1, 'cc-by-nc': 1, 'cc-by-nc-sa': 1 };
  var API = 'https://api.inaturalist.org/v1/';

  /* ── storage that never throws (private mode, blocked storage, quota) ── */
  var store = {
    get: function (k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    raw: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ── connectivity: resolves when the browser is back online, or after maxMs ── */
  function waitOnline(maxMs) {
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (done) return; done = true; window.removeEventListener('online', finish); resolve(); }
      window.addEventListener('online', finish);
      if (maxMs != null) setTimeout(finish, maxMs);
    });
  }
  var REQUEST_TIMEOUT_MS = 20000;
  function fetchWithTimeout(url) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(
      function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; });
  }

  /* ── iNaturalist request queue: max 3 in flight. Retries rate limits (which reach the
     browser as network errors, because iNaturalist's 429 replies carry no CORS headers),
     server errors, timeouts and dropped connections with backoff; while the browser is
     offline it waits for the connection instead of burning retries. ── */
  var queue = [], active = 0, MAX = 3, MAX_ATTEMPTS = 5;
  function inat(path) {
    return new Promise(function (resolve, reject) { queue.push({ url: API + path, resolve: resolve, reject: reject }); pump(); });
  }
  function pump() {
    while (active < MAX && queue.length) {
      var job = queue.shift(); active++;
      run(job).then(function () { active--; pump(); });
    }
  }
  function run(job) {
    var attempt = 0;
    function retry(err) {
      if (navigator.onLine === false) return waitOnline().then(go);          // offline: wait, don't count it
      if (++attempt >= MAX_ATTEMPTS) { job.reject(err); return; }
      return sleep(1500 * Math.pow(2, attempt - 1)).then(go);                 // 1.5s, 3s, 6s, 12s
    }
    function go() {
      return fetchWithTimeout(job.url).then(function (r) {
        if (r.ok) return r.json().then(job.resolve);
        if (r.status === 429 || r.status >= 500) return retry(new Error('HTTP ' + r.status));
        job.reject(new Error('HTTP ' + r.status));
      }, retry);
    }
    return go().catch(job.reject);
  }
  window.ndInat = inat;

  function sciOf(k) { return SPECIES[k] && SPECIES[k].sci; }
  function nameOf(k) { return (SPECIES[k] && SPECIES[k].name) || k; }
  function setStatus(msg) { $$('.refresh-status').forEach(function (s) { s.textContent = msg; }); }

  /* ════════════════ PHOTOS ════════════════ */
  var ORIGINAL = {};
  Object.keys(PHOTOS).forEach(function (k) { ORIGINAL[k] = PHOTOS[k]; });
  var refreshedKey = function (k) { return NS + 'photo:' + k; };

  function chosenPhoto(k) {                    // photo picked by the user
    var p = store.get('pp:' + k);
    return p && p.url ? p : null;
  }
  function effectivePhoto(k) {
    return chosenPhoto(k) || store.get(refreshedKey(k)) || null;
  }
  // Apply saved choices/refreshes so every later render uses them.
  Object.keys(SPECIES).forEach(function (k) {
    var p = effectivePhoto(k);
    if (p) { PHOTOS[k] = p.url; if (p.by) SPECIES[k].by = p.by; }
  });
  // Older Frog-guide cache keys are superseded by the shared cache.
  Object.keys(SPECIES).forEach(function (k) { if (store.raw('frog_photo:' + k)) store.del('frog_photo:' + k); });

  function paint(k) {
    $$('[data-species-photo="' + k + '"]').forEach(function (img) { if (img.getAttribute('src') !== PHOTOS[k]) img.src = PHOTOS[k]; });
  }
  function keyForUrl(url) {
    for (var k in PHOTOS) if (PHOTOS[k] === url) return k;
    return null;
  }
  // Any remote species photo that fails to load falls back to the embedded one.
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    var src = img.getAttribute('src') || '';
    if (!src || src.indexOf('data:') === 0) return;
    var k = img.getAttribute('data-species-photo') || keyForUrl(src);
    if (!k || !ORIGINAL[k] || ORIGINAL[k] === src) return;
    if (PHOTOS[k] === src) { PHOTOS[k] = ORIGINAL[k]; fellBack[k] = src; }   // saved choices stay
    img.src = ORIGINAL[k];
  }, true);

  // Photos that fell back because the connection was down come back by themselves once it
  // returns (or when the tab is shown again) — no reload needed.
  var fellBack = {};
  function restoreRemotePhotos() {
    Object.keys(fellBack).forEach(function (k) {
      var url = fellBack[k];
      delete fellBack[k];
      var probe = new Image();
      probe.onload = function () { if (PHOTOS[k] === ORIGINAL[k]) { PHOTOS[k] = url; paint(k); } };
      probe.onerror = function () { if (navigator.onLine === false) fellBack[k] = url; };   // still offline: try next time
      probe.src = url;
    });
  }
  window.addEventListener('online', restoreRemotePhotos);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') restoreRemotePhotos(); });

  window.applyStoredPhotoOverrides = function () { Object.keys(SPECIES).forEach(paint); };

  if (typeof window.applyPickerChoice === 'function') {
    var origApply = window.applyPickerChoice;
    window.applyPickerChoice = function (key, photo, div) {
      store.set('pp:' + key, { url: photo.url, by: photo.by, license: photo.license });
      PHOTOS[key] = photo.url;
      if (photo.by) SPECIES[key].by = photo.by;
      try { origApply(key, photo, div); } catch (e) {}
      paint(key);
    };
  }
  window.resetPickerPhoto = function () {
    var k = (typeof pickerKey !== 'undefined') ? pickerKey : null;
    if (!k) return;
    store.del('pp:' + k);
    var r = store.get(refreshedKey(k));
    PHOTOS[k] = r ? r.url : ORIGINAL[k];
    if (r && r.by) SPECIES[k].by = r.by;
    paint(k);
    if (typeof closePhotoPicker === 'function') closePhotoPicker();
  };

  // Photo picker: the built-in version shows "No CC-licensed photos found" when iNaturalist
  // can't be reached, which looks like a real (empty) answer. This one keeps trying while the
  // picker stays open for that species, and says it's reconnecting.
  if (typeof window.fetchPickerCandidates === 'function' && typeof PICKER_SORTS !== 'undefined') {
    window.fetchPickerCandidates = function (sciName, sortIdx) {
      var key = (typeof pickerKey !== 'undefined') ? pickerKey : null;
      var q = PICKER_SORTS[sortIdx];
      var licenses = (typeof PP_LICENSES !== 'undefined') ? PP_LICENSES : Object.keys(USABLE);
      function stillOpen() {
        var box = $('#photo-picker');
        return box && !box.classList.contains('hidden') && (typeof pickerKey === 'undefined' || pickerKey === key);
      }
      function attempt(n) {
        return inat('observations?taxon_name=' + encodeURIComponent(sciName) + '&' + q.params + '&photos=true&per_page=50').then(function (data) {
          var found = [], seen = {};
          (data.results || []).some(function (obs) {
            return (obs.photos || []).some(function (photo) {
              if (licenses.indexOf(photo.license_code) < 0) return false;
              var med = photo.url.replace(/\/(square|small|thumb|large|original|medium)\./, '/medium.');
              if (seen[med]) return false;
              seen[med] = true;
              found.push({ url: med, by: obs.user ? obs.user.login : '', license: photo.license_code, obs_id: obs.id });
              return found.length >= 8;
            });
          });
          return found;
        }, function () {
          if (!stillOpen()) return [];
          var grid = $('#picker-grid');
          if (grid) grid.innerHTML = '<div class="picker-loading">Can’t reach iNaturalist right now — reconnecting automatically…</div>';
          return waitOnline(Math.min(30000, 5000 * (n + 1))).then(function () { return stillOpen() ? attempt(n + 1) : []; });
        });
      }
      return attempt(0);
    };
  }

  // Species iNaturalist couldn't be reached for are retried automatically (when the connection
  // returns, or after a pause), so a flaky connection doesn't leave the refresh half done.
  window.refreshPhotos = function (btn) {
    var sel = btn && btn.parentElement && btn.parentElement.querySelector('.photo-sort-select');
    var sort = sel ? sel.value : FEATURED;
    if (sort === FEATURED) return refreshFeaturedPhotos();
    var all = Object.keys(SPECIES), updated = 0, noPhoto = 0;
    $$('.refresh-photo-btn').forEach(function (b) { b.disabled = true; });
    setStatus('Fetching photos…');
    function pass(keys, round) {
      var unreachable = [], done = 0;
      return Promise.all(keys.map(function (k) {
        return inat('observations?taxon_name=' + encodeURIComponent(sciOf(k)) + '&' + sort + '&per_page=20&photos=true')
          .then(function (d) {
            var res = d.results || [];
            for (var i = 0; i < res.length; i++) {
              var ph = (res[i].photos || []).filter(function (p) { return USABLE[p.license_code]; })[0];
              if (ph) {
                var url = ph.url.replace(/\/(square|small|thumb|large|original)\./, '/medium.');
                var by = res[i].user ? res[i].user.login : '';
                store.set(refreshedKey(k), { url: url, by: by, license: ph.license_code });
                if (!chosenPhoto(k)) { PHOTOS[k] = url; SPECIES[k].by = by; }
                updated++; return;
              }
            }
            noPhoto++;
          }, function () { unreachable.push(k); })
          .then(function () { done++; setStatus((round ? 'Retrying: ' : '') + done + '/' + keys.length + ' photos checked…'); });
      })).then(function () {
        keys.forEach(paint);
        rerender();
        if (unreachable.length && round < 3) {
          setStatus('✓ ' + updated + ' photos updated · ' + unreachable.length + ' couldn’t be reached — retrying automatically…');
          return waitOnline(15000 * (round + 1)).then(function () { return pass(unreachable, round + 1); });
        }
        return unreachable.length;
      });
    }
    return pass(all, 0).then(function (stillUnreachable) {
      $$('.refresh-photo-btn').forEach(function (b) { b.disabled = false; });
      var parts = ['✓ ' + updated + '/' + all.length + ' photos updated'];
      if (noPhoto) parts.push(noPhoto + ' without a usable photo');
      if (stillUnreachable) parts.push(stillUnreachable + ' couldn’t be reached (built-in photos kept)');
      setStatus(updated || noPhoto ? parts.join(' · ') : 'Could not reach iNaturalist — showing built-in photos');
    });
  };

  /* ════════════════ AUDIO ════════════════ */
  if (typeof window.AUDIO === 'undefined' && typeof AUDIO === 'undefined') window.AUDIO = {};
  var SOUNDS = (typeof AUDIO !== 'undefined') ? AUDIO : window.AUDIO;
  var soundBy = {};
  var soundKey = function (k) { return NS + 'sound:' + k; };
  Object.keys(SPECIES).forEach(function (k) {
    var s = store.get(soundKey(k));
    if (s && s.url && !SOUNDS[k]) { SOUNDS[k] = s.url; soundBy[k] = s.by; }
  });
  var token = 0, playingKey = null;
  function player() { return $('#audio-bar audio'); }
  function bar(show, text) {
    var b = $('#audio-bar'), l = $('#audio-label');
    if (b) b.style.display = show ? 'flex' : 'none';
    if (l && text != null) l.textContent = text;
  }
  var badSounds = {};                       // recordings that failed to load this visit
  function findSound(k) {
    return inat('observations?taxon_name=' + encodeURIComponent(sciOf(k)) + '&sounds=true&quality_grade=research&order_by=votes&order=desc&per_page=10')
      .then(function (d) {
        var res = d.results || [];
        for (var i = 0; i < res.length; i++) {
          var snd = (res[i].sounds || []).filter(function (s) { return s.file_url && USABLE[s.license_code] && !badSounds[s.file_url]; })[0];
          if (snd) {
            var by = res[i].user ? res[i].user.login : '';
            SOUNDS[k] = snd.file_url; soundBy[k] = by;
            store.set(soundKey(k), { url: snd.file_url, by: by });
            markSoundButtons(k);
            return snd.file_url;
          }
        }
        return null;
      });
  }
  function markSoundButtons(k) {
    $$('[data-audio-key="' + k + '"] span').forEach(function (s) { s.textContent = SOUND; });
  }
  window.stopAudio = function () {
    token++; playingKey = null;
    var p = player();
    if (p) { p.pause(); p.removeAttribute('src'); try { p.load(); } catch (e) {} }
    bar(false);
  };
  window.playCall = function (k) {
    var t = ++token, p = player();
    if (!p) return;
    p.pause();
    playingKey = k;
    bar(true, (SOUNDS[k] ? 'Loading ' : 'Searching iNaturalist for ') + nameOf(k) + '…');
    var get = SOUNDS[k] ? Promise.resolve(SOUNDS[k]) : findSound(k);
    get.then(function (src) {
      if (t !== token) return;
      if (!src) { bar(true, 'No recording on iNaturalist for ' + nameOf(k)); return; }
      p.src = src;
      var pr = p.play();
      bar(true, nameOf(k) + ' · ' + (soundBy[k] ? soundBy[k] + ' (iNaturalist)' : sciOf(k)));
      if (pr && pr.catch) pr.catch(function (err) {
        if (t !== token || (err && err.name === 'AbortError')) return;
        if (err && err.name === 'NotAllowedError') bar(true, 'Press ▶ to play ' + nameOf(k));
      });
    }, function () {
      if (t !== token) return;
      // Couldn't reach iNaturalist: keep the request alive and play as soon as it can.
      bar(true, 'Can’t reach iNaturalist right now — ' + nameOf(k) + ' will play as soon as the connection is back…');
      waitOnline(15000).then(function () { if (t === token) window.playCall(k); });
    });
  };
  window.fetchAndPlayAudio = window.playCall;
  (function wirePlayer() {
    var p = player();
    if (!p) return;
    p.onended = function () { window.stopAudio(); };
    p.onerror = function () {
      if (!p.getAttribute('src') || !playingKey) return;     // cleared on purpose
      var k = playingKey, bad = p.getAttribute('src');
      if (navigator.onLine === false) {                         // connection dropped mid-load
        bar(true, 'Connection lost — ' + nameOf(k) + ' will play when it’s back…');
        waitOnline().then(function () { if (playingKey === k) window.playCall(k); });
        return;
      }
      badSounds[bad] = true;                                    // dead file: forget it, try the next recording
      delete SOUNDS[k]; store.del(soundKey(k));
      var tried = Object.keys(badSounds).length;
      if (tried <= 20) { bar(true, 'That recording is unavailable — trying another…'); window.playCall(k); }
      else bar(true, 'Recordings aren’t loading right now — try again later');
    };
  })();
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') window.stopAudio(); });

  window.refreshAudio = function (btn) {
    var keys = Object.keys(SPECIES), found = 0, failed = 0, done = 0;
    if (btn) btn.disabled = true;
    setStatus('Fetching sounds…');
    return Promise.all(keys.map(function (k) {
      return findSound(k).then(function (u) { if (u) found++; }, function () { failed++; })
        .then(function () { done++; setStatus(done + '/' + keys.length + ' sounds checked…'); });
    })).then(function () {
      if (btn) btn.disabled = false;
      setStatus(failed === keys.length ? 'Could not reach iNaturalist — sounds will be looked up when you play them'
        : '✓ ' + found + '/' + keys.length + ' species have recordings on iNaturalist' + (failed ? ' · ' + failed + ' couldn\u2019t be checked yet (looked up again when played)' : ''));
    });
  };

  /* ════════════════ LIVE COUNTS / LIKELIHOODS ════════════════ */
  var countsKey = NS + 'counts';
  function fmtDate(t) {
    var d = new Date(t);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function noteText(state, t) {
    var total = Object.keys(OBS).reduce(function (s, k) { return s + (OBS[k] || 0); }, 0);
    var base = 'Likelihoods use ' + total.toLocaleString() + ' research-grade Louisiana iNaturalist records';
    if (state === 'busy') return 'Updating likelihoods from iNaturalist…';
    if (state === 'live') return base + ' · updated ' + fmtDate(t);
    if (state === 'retry') return base + ' · built-in counts — can’t reach iNaturalist right now, will update automatically';
    if (state === 'retry-saved') return base + ' · saved ' + fmtDate(t) + ' — can’t reach iNaturalist right now, will update automatically';
    return base;
  }
  function note(state, t) {
    $$('.nd-counts-note').forEach(function (n) {
      n.textContent = noteText(state, t);
      n.classList.toggle('nd-busy', state === 'busy');
    });
  }
  function applyCounts(counts) {
    Object.keys(counts).forEach(function (k) { if (k in SPECIES && typeof counts[k] === 'number') OBS[k] = counts[k]; });
    TOTAL_OBS = Object.keys(OBS).reduce(function (s, k) { return s + (OBS[k] || 0); }, 0);
    rerender();
  }
  function fetchCounts() {
    var byName = {}, counts = {}, missed = 0;
    function page(n) {
      return inat('observations/species_counts?place_id=' + PLACE + '&quality_grade=research&taxon_id=' + CFG.ancestor + '&per_page=500&page=' + n)
        .then(function (d) {
          (d.results || []).forEach(function (r) { byName[r.taxon.name] = r.count; });
          if ((d.results || []).length === 500 && n < 6) return page(n + 1);
        });
    }
    return (CFG.ancestor ? page(1) : Promise.resolve()).then(function () {
      var missing = Object.keys(SPECIES).filter(function (k) {
        if (sciOf(k) in byName) { counts[k] = byName[sciOf(k)]; return false; }
        return true;
      });
      // Names not matched (taxonomy renames, genus-level entries) are looked up one by one.
      return Promise.all(missing.map(function (k) {
        return inat('observations?taxon_name=' + encodeURIComponent(sciOf(k)) + '&place_id=' + PLACE + '&quality_grade=research&per_page=1')
          .then(function (d) { if (typeof d.total_results === 'number') counts[k] = d.total_results; else missed++; }, function (err) {
            // A 4xx means iNaturalist rejected that name — retrying won't help. Anything else
            // (network, rate limit, timeout) is worth another try later.
            if (!/^HTTP 4/.test(err && err.message || '')) missed++;
          });
      }));
    }).then(function () { return { counts: counts, missed: missed }; });
  }
  // A count of 0 is real data (no research-grade LA records), not a missing value.
  if (typeof window.rarity === 'function') {
    var origRarity = window.rarity;
    window.rarity = function (obs) {
      if (obs === 0) return { label: 'No LA records yet', cls: 'rc-vrare' };
      return origRarity.apply(this, arguments);
    };
  }
  // If an update fails (offline, rate-limited, iNaturalist down) the guide keeps working on the
  // built-in or saved counts and tries again on its own: when the connection comes back, when
  // the tab is shown again, and on a backoff timer — so it never needs a manual reload.
  var PARTIAL_TTL = 30 * 60 * 1000;          // some species missing: try again sooner
  var RETRY_DELAYS = [20000, 60000, 180000, 600000, 1800000];
  var retryCount = 0, retryTimer = null;
  function scheduleCountsRetry() {
    clearTimeout(retryTimer);
    var delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
    retryCount++;
    retryTimer = setTimeout(function () { updateCounts(false); }, delay);
  }
  function retryCountsNow() {
    if (!retryTimer) return;
    clearTimeout(retryTimer); retryTimer = null;
    updateCounts(false);
  }
  window.addEventListener('online', retryCountsNow);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') retryCountsNow(); });

  var inflight = null;
  function updateCounts(force) {
    if (inflight) return inflight;
    var cached = store.get(countsKey);
    if (cached && cached.counts) applyCounts(cached.counts);
    var ttl = cached && cached.partial ? PARTIAL_TTL : COUNT_TTL;
    if (!force && cached && Date.now() - cached.t < ttl) { note('live', cached.t); return Promise.resolve(); }
    clearTimeout(retryTimer); retryTimer = null;
    note('busy');
    $$('.refresh-inat-btn').forEach(function (b) { b.disabled = true; });
    inflight = fetchCounts().then(function (res) {
      if (!Object.keys(res.counts).length) throw new Error('no data');
      // Species that didn't answer this time keep their previously saved count.
      var counts = Object.assign({}, cached && cached.counts, res.counts);
      var t = Date.now();
      store.set(countsKey, { t: t, counts: counts, partial: res.missed > 0 });
      applyCounts(counts);
      note('live', t);
      if (res.missed > 0) scheduleCountsRetry();     // fill in the species that didn't answer (backing off)
      else retryCount = 0;
      if (force) setStatus(res.missed ? '✓ Counts updated (' + res.missed + ' species will be retried automatically)' : '✓ Counts updated from iNaturalist');
    }).catch(function () {
      note(cached ? 'retry-saved' : 'retry', cached && cached.t);
      scheduleCountsRetry();
      if (force) setStatus('Could not reach iNaturalist — using saved counts and retrying automatically');
    }).then(function () {
      inflight = null;
      $$('.refresh-inat-btn').forEach(function (b) { b.disabled = false; });
    });
    return inflight;
  }
  window.refreshInatData = function () { return updateCounts(true); };

  /* ════════════════ RE-RENDER WHATEVER IS ON SCREEN ════════════════ */
  var lastResult = null;
  if (typeof window.showResult === 'function') {
    var origShow = window.showResult;
    window.showResult = function (k) { lastResult = k; return origShow.apply(this, arguments); };
  }
  function visible(id) { var el = document.getElementById(id); return el && el.style.display !== 'none'; }
  function rerender() {
    var grid = $('#gallery-grid');
    if (grid && grid.children.length && typeof buildGallery === 'function') {
      try {
        galleryBuilt = false; grid.innerHTML = ''; buildGallery();
        var active = $('.filter-btn.active');
        if (active) active.click();
      } catch (e) {}
    }
    try {
      if (visible('key-step') && typeof currentNode !== 'undefined' && currentNode && typeof renderStep === 'function') renderStep(currentNode);
      else if (visible('key-result') && lastResult && typeof buildResultHTML === 'function')
        $('#key-result').innerHTML = buildResultHTML(lastResult, true);
    } catch (e) {}
    try { refreshFlowTree(); } catch (e) {}
  }

  /* ════════════════ SAME CONTROLS IN EVERY GUIDE ════════════════ */
  var PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  if (typeof window.buildResultHTML === 'function') {
    var origResult = window.buildResultHTML;
    window.buildResultHTML = function (k) {
      var html = origResult.apply(this, arguments);
      if (html.indexOf('photo-pick-btn') < 0 && $('#photo-picker'))
        html = html.replace('<div class="result-photo-wrap">', '<div class="result-photo-wrap"><button class="photo-pick-btn" onclick="openPhotoPicker(\'' + k + '\', event)">&#x270F; Choose Photo</button>');
      if (html.indexOf('play-call-btn') < 0)
        html = html.replace('<div class="result-actions">', '<div class="result-actions"><button class="play-call-btn" onclick="playCall(\'' + k + '\')">' + PLAY_SVG + SOUND + '</button>');
      return html;
    };
  }
  if (typeof window.buildGallery === 'function') {
    var origGallery = window.buildGallery;
    window.buildGallery = function () {
      var r = origGallery.apply(this, arguments);
      $$('#gallery-grid .sp-card').forEach(function (card) {
        if ($('.sp-audio-btn', card)) return;
        var m = /openModal\('([^']+)'\)/.exec(card.getAttribute('onclick') || '');
        var body = $('.sp-body', card) || card;
        if (!m) return;
        var b = document.createElement('button');
        b.className = 'sp-audio-btn';
        b.setAttribute('data-audio-key', m[1]);
        b.innerHTML = PLAY_SVG + '<span>' + SOUND + '</span>';
        b.addEventListener('click', function (e) { e.stopPropagation(); window.playCall(m[1]); });
        body.appendChild(b);
      });
      return r;
    };
  }

  /* ════════════════ KEY STRUCTURE ════════════════
     Couplet numbers (the same numbering as the printed key), parents and species paths, so
     every view can say where a species sits in the key and link between them. */
  // Guides store their key in one of two shapes: {root:{q,tip,a:{…},b:{…}}, …} or (Frog)
  // {nodes:{n1:{q,hint,choices:[{label:'A',text,next|result}]}}}. NK is the first shape for
  // both, with lower-case choice letters; the h*/doChoose helpers speak each guide's own state.
  var KEY_FMT = typeof KEY === 'undefined' || !KEY ? null : KEY.root ? 'ab' : KEY.nodes ? 'list' : null;
  var NK = {}, ROOT = 'root';
  if (KEY_FMT === 'ab') NK = KEY;
  else if (KEY_FMT === 'list') {
    ROOT = Object.keys(KEY.nodes)[0];
    Object.keys(KEY.nodes).forEach(function (id) {
      var n = KEY.nodes[id], m = { q: n.q, tip: n.tip || n.hint };
      (n.choices || []).forEach(function (ch) { m[String(ch.label).toLowerCase()] = { text: ch.text, next: ch.next, result: ch.result, label: ch.label }; });
      NK[id] = m;
    });
  }
  var HAS_KEY = !!NK[ROOT];
  function hNode(h) { return h.node != null ? h.node : h.nodeId; }
  function hChoice(h) {
    if (h.choice != null) return h.choice;
    var n = NK[hNode(h)] || {};
    return Object.keys(n).filter(function (c) { return /^[a-z]$/.test(c) && n[c] && n[c].text === h.text; })[0] || 'a';
  }
  function mkHist(node, c) { return KEY_FMT === 'list' ? { nodeId: node, text: NK[node][c].text } : { node: node, choice: c }; }
  function doChoose(c) { if (KEY_FMT === 'list') choose(currentNode, NK[currentNode][c].label); else choose(c); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var scratch = document.createElement('div');
  function plain(s) { scratch.innerHTML = String(s == null ? '' : s); return scratch.textContent; }
  function choicesOf(n) { return n ? Object.keys(n).filter(function (c) { return /^[a-z]$/.test(c) && n[c] && n[c].text != null; }) : []; }
  var NUM = {}, PARENT = {}, LEAVES = {};
  if (HAS_KEY) {
    var bfs = [ROOT], nextNum = 1;
    while (bfs.length) {
      var nid = bfs.shift();
      if (NUM[nid] || !NK[nid]) continue;
      NUM[nid] = nextNum++;
      choicesOf(NK[nid]).forEach(function (c) {
        var br = NK[nid][c];
        if (br.next && NK[br.next]) { if (!PARENT[br.next]) PARENT[br.next] = { node: nid, choice: c }; bfs.push(br.next); }
        if (br.result) (LEAVES[br.result] = LEAVES[br.result] || []).push({ node: nid, choice: c });
      });
    }
  }
  function pathToNode(id) { var p = [], guard = 0; while (PARENT[id] && guard++ < 200) { p.unshift(PARENT[id]); id = PARENT[id].node; } return p; }
  function pathToSpecies(k) { var leaf = (LEAVES[k] || [])[0]; return leaf ? pathToNode(leaf.node).concat([leaf]) : []; }
  function speciesUnder(id) {
    var out = [], seen = {};
    (function walk(n, d) {
      if (!NK[n] || d > 60) return;
      choicesOf(NK[n]).forEach(function (c) {
        var br = NK[n][c];
        if (br.result) { if (!seen[br.result]) { seen[br.result] = 1; out.push(br.result); } }
        else if (br.next) walk(br.next, d + 1);
      });
    })(id, 0);
    return out;
  }
  function branchSpp(id, c) { var br = NK[id][c]; return br.result ? [br.result] : speciesUnder(br.next); }
  function byCommon(a, b) { return (OBS[b] || 0) - (OBS[a] || 0); }
  function keyHist() { try { return (typeof history !== 'undefined' && Array.isArray(history)) ? history : null; } catch (e) { return null; } }
  function goToTab(t) { var b = $('.tab-btn[data-tab="' + t + '"]'); if (b && !b.classList.contains('active')) b.click(); }
  function overlayOpen() {
    return ['#modal', '#photo-lb', '#photo-picker'].some(function (s) { var el = $(s); return el && !el.classList.contains('hidden'); });
  }
  window.ndOpenSpecies = function (k) { if (SPECIES[k] && typeof openModal === 'function') openModal(k); };
  function rarityChip(k) {
    if (typeof rarity !== 'function') return '';
    var r = rarity(OBS[k]), n = OBS[k] || 0;
    return '<span class="choice-rarity ' + r.cls + '">' + esc(r.label) + (n > 0 ? ' · ' + n.toLocaleString() + ' LA records' : '') + '</span>';
  }

  /* ════════════════ INTERACTIVE KEY ════════════════ */
  // Jump straight to any couplet (from the flow chart or the trail), with the history the
  // key would have had if you'd answered your way there.
  function startKeyAt(id) {
    var h = keyHist();
    if (!h || !NK[id] || typeof renderStep !== 'function') return;
    goToTab('key');
    h.length = 0;
    pathToNode(id).forEach(function (s) { h.push(mkHist(s.node, s.choice)); });
    ['key-intro', 'key-result'].forEach(function (x) { var el = document.getElementById(x); if (el) el.style.display = 'none'; });
    var st = document.getElementById('key-step'); if (st) st.style.display = 'block';
    renderStep(id);
    pushKeyState();
    var top = $('#key'); if (top) top.scrollIntoView({ block: 'start' });
  }
  window.ndStartKeyAt = startKeyAt;

  function jumpTo(i) {
    var h = keyHist();
    if (!h || i < 0 || i >= h.length) return;
    var target = hNode(h[i]);
    h.splice(i);
    var res = document.getElementById('key-result'); if (res) res.style.display = 'none';
    var st = document.getElementById('key-step'); if (st) st.style.display = 'block';
    renderStep(target);
    replaceKeyState();
  }

  function enhanceStep(id) {
    var h = keyHist() || [];
    var left = speciesUnder(id).sort(byCommon);
    var num = $('#key-step-num');
    if (num) num.innerHTML = 'Step ' + (h.length + 1) + '<span class="nd-step-meta"> · couplet ' + (NUM[id] || '?') + ' · ' + left.length + ' species still possible</span>';
    var trail = $('#key-trail');
    if (trail) {
      if (!h.length) trail.style.display = 'none';
      else {
        trail.style.display = 'flex';
        trail.innerHTML = '<span class="nd-trail-lead">Your answers (tap to change):</span>' + h.map(function (s, i) {
          var node = hNode(s), c = hChoice(s), full = plain((NK[node] && NK[node][c] || {}).text), t = full.length > 48 ? full.slice(0, 46) + '…' : full;
          return (i ? '<span class="trail-sep">›</span>' : '') + '<button type="button" class="nd-trail-btn" data-jump="' + i + '" title="Back to this question: ' + esc(full) + '"><b>' + (NUM[node] || '') + c + '</b> ' + esc(t) + '</button>';
        }).join('');
      }
    }
    var choices = choicesOf(NK[id]);
    $$('#choices-wrap .choice-item').forEach(function (item, idx) {
      var c = choices[idx];
      if (!c || $('.nd-leads', item)) return;
      var spp = branchSpp(id, c).slice().sort(byCommon);
      var div = document.createElement('div');
      div.className = 'nd-leads';
      div.innerHTML = spp.length === 1
        ? 'Identifies: <b>' + esc(nameOf(spp[0])) + '</b>'
        : 'Leads to ' + spp.length + ' species: ' + spp.slice(0, 3).map(function (k) { return esc(nameOf(k)); }).join(', ') + (spp.length > 3 ? ', +' + (spp.length - 3) + ' more' : '');
      item.appendChild(div);
    });
    // The species still in play, most frequently recorded first.
    var card = $('#key-step .question-card');
    if (!card) return;
    var strip = $('#nd-possible');
    if (!strip) {
      strip = document.createElement('details');
      strip.id = 'nd-possible';
      strip.className = 'nd-possible';
      if (store.get(NS + 'possibleOpen')) strip.open = true;
      strip.addEventListener('toggle', function () { store.set(NS + 'possibleOpen', strip.open); });
      card.parentNode.insertBefore(strip, card.nextSibling);
    }
    strip.innerHTML = '<summary>' + left.length + ' species still possible — tap to compare them</summary><div class="nd-mini-grid">' +
      left.map(function (k) {
        return '<button type="button" class="nd-mini" data-sp="' + k + '">' + (PHOTOS[k] ? '<img src="' + esc(PHOTOS[k]) + '" data-species-photo="' + k + '" alt="" loading="lazy">' : '<span class="nd-mini-noimg"></span>') +
          '<span>' + esc(nameOf(k)) + '</span></button>';
      }).join('') + '</div>';
    if (!$('#nd-key-hint')) {
      var hint = document.createElement('div');
      hint.id = 'nd-key-hint';
      hint.className = 'nd-key-hint';
      hint.textContent = 'Keyboard: A / B to answer · ← or Backspace to go back';
      strip.parentNode.insertBefore(hint, strip.nextSibling);
    }
  }
  if (HAS_KEY && typeof window.renderStep === 'function') {
    var origRender = window.renderStep;
    window.renderStep = function (id) {
      var r = origRender.apply(this, arguments);
      try { enhanceStep(id); } catch (e) {}
      return r;
    };
  }

  // The phone / browser Back button steps back through the key instead of leaving the page.
  function keyDepth() { var h = keyHist(); return h ? h.length : 0; }
  function keyState() { return { ndKey: keyDepth(), ndRes: visible('key-result') }; }
  function pushKeyState() { try { window.history.pushState(keyState(), ''); } catch (e) {} }
  function replaceKeyState() { try { window.history.replaceState(keyState(), ''); } catch (e) {} }
  var origGoBack = typeof window.goBack === 'function' ? window.goBack : null;
  if (HAS_KEY && origGoBack) {
    ['startKey', 'choose'].forEach(function (fn) {
      var orig = window[fn];
      if (typeof orig !== 'function') return;
      window[fn] = function () {
        var r = orig.apply(this, arguments);
        var st = window.history.state;
        if (fn === 'startKey' && st && st.ndKey != null) replaceKeyState(); else pushKeyState();
        return r;
      };
    });
    window.goBack = function () {
      var st = window.history.state;
      if (st && st.ndKey != null) { window.history.back(); return; }   // popstate does the work
      return origGoBack.apply(this, arguments);
    };
    window.addEventListener('popstate', function (e) {
      var st = e.state, target = st && st.ndKey != null ? st.ndKey : -1, guard = 0;
      if (target === -1) {
        if (visible('key-step') || visible('key-result')) {
          var h = keyHist(); if (h) h.length = 0;
          ['key-step', 'key-result'].forEach(function (x) { var el = document.getElementById(x); if (el) el.style.display = 'none'; });
          var intro = document.getElementById('key-intro'); if (intro) intro.style.display = 'block';
        }
        return;
      }
      while (guard++ < 200 && (keyDepth() > target || (keyDepth() === target && visible('key-result') && !st.ndRes))) origGoBack();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || overlayOpen()) return;
    var t = e.target;
    if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
    var key = $('#key');
    if (!key || !key.classList.contains('active')) return;
    if (visible('key-step')) {
      var k = e.key.toLowerCase();
      var choices = choicesOf(NK[currentNode]);
      var idx = k.length === 1 ? (k >= 'a' && k <= 'z' ? choices.indexOf(k) : (k >= '1' && k <= '9' ? +k - 1 : -1)) : -1;
      if (idx >= 0 && choices[idx]) { e.preventDefault(); doChoose(choices[idx]); return; }
    }
    if ((e.key === 'Backspace' || e.key === 'ArrowLeft') && (visible('key-step') || visible('key-result'))) { e.preventDefault(); goBack(); }
  });

  /* ════════════════ SPECIES DETAILS ════════════════ */
  var LICENSE_LABEL = { 'cc0': 'CC0', 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA', 'cc-by-nc': 'CC BY-NC', 'cc-by-nc-sa': 'CC BY-NC-SA' };
  function photoLicense(k) {
    var p = chosenPhoto(k) || store.get(refreshedKey(k));
    return p && p.license && PHOTOS[k] === p.url ? (LICENSE_LABEL[p.license] || p.license.toUpperCase()) : null;
  }
  function lookalikes(k) {
    var leaf = (LEAVES[k] || [])[0], out = [], cur = leaf && leaf.node, guard = 0;
    while (cur && out.length < 4 && guard++ < 8) {
      speciesUnder(cur).sort(byCommon).forEach(function (s) { if (s !== k && out.indexOf(s) < 0 && out.length < 4) out.push(s); });
      cur = PARENT[cur] && PARENT[cur].node;
    }
    return out;
  }
  function speciesExtrasHTML(k) {
    var html = '', path = pathToSpecies(k), sim = lookalikes(k);
    if (sim.length) {
      html += '<div class="nd-similar"><div class="nd-sec-title">Similar species — compare before deciding</div><div class="nd-mini-grid">' +
        sim.map(function (s) {
          return '<button type="button" class="nd-mini" data-sp="' + s + '">' + (PHOTOS[s] ? '<img src="' + esc(PHOTOS[s]) + '" data-species-photo="' + s + '" alt="" loading="lazy">' : '<span class="nd-mini-noimg"></span>') + '<span>' + esc(nameOf(s)) + '</span></button>';
        }).join('') + '</div></div>';
    }
    if (path.length) {
      html += '<details class="nd-keypath"><summary>How the key reaches this species (' + path.length + ' step' + (path.length === 1 ? '' : 's') + ')</summary><ol>' +
        path.map(function (s) { return '<li><span class="nd-kp-num">' + NUM[s.node] + s.choice + '</span> ' + NK[s.node][s.choice].text + '</li>'; }).join('') +
        '</ol></details>';
    }
    html += '<div class="nd-sp-links">' +
      (path.length ? '<button type="button" class="nd-link-btn" data-chart-sp="' + k + '">Show in flow chart</button>' : '') +
      '<a class="nd-link-btn" href="https://www.inaturalist.org/taxa/search?q=' + encodeURIComponent(sciOf(k)) + '" target="_blank" rel="noopener">iNaturalist species page ↗</a>' +
      '<a class="nd-link-btn" href="https://www.inaturalist.org/observations?taxon_name=' + encodeURIComponent(sciOf(k)) + '&place_id=' + PLACE + '&subview=map" target="_blank" rel="noopener">Louisiana map ↗</a></div>';
    return html;
  }
  if (typeof window.buildResultHTML === 'function') {
    var resultWithControls = window.buildResultHTML;
    window.buildResultHTML = function (k) {
      var html = resultWithControls.apply(this, arguments);
      var lic = photoLicense(k);
      if (lic) html = html.replace(/(class="result-credit">[^<]*?)CC BY-NC(-SA)?/, '$1' + lic);
      if (html.indexOf('nd-similar') < 0 && html.indexOf('nd-sp-links') < 0)
        html = html.replace('<div class="result-actions">', speciesExtrasHTML(k) + '<div class="result-actions">');
      return html;
    };
  }

  /* ════════════════ GALLERY: SEARCH, SORT, PHOTO BUTTON ════════════════ */
  function cardKey(card) {
    if (card.dataset.ndkey) return card.dataset.ndkey;
    var m = /openModal\('([^']+)'\)/.exec(card.getAttribute('onclick') || '');
    if (m) card.dataset.ndkey = m[1];
    return m ? m[1] : null;
  }
  var gal = { q: '', sort: store.get(NS + 'galSort') || 'name' };
  function applyGallery() {
    var grid = $('#gallery-grid');
    if (!grid) return;
    var cards = $$('.sp-card', grid);
    var q = gal.q.trim().toLowerCase();
    var cmp = {
      name: function (a, b) { return nameOf(a).localeCompare(nameOf(b)); },
      common: function (a, b) { return byCommon(a, b) || nameOf(a).localeCompare(nameOf(b)); },
      rare: function (a, b) { return (OBS[a] || 0) - (OBS[b] || 0) || nameOf(a).localeCompare(nameOf(b)); },
      sci: function (a, b) { return String(sciOf(a)).localeCompare(String(sciOf(b))); },
      family: function (a, b) { return String(SPECIES[a].fam || '').localeCompare(String(SPECIES[b].fam || '')) || nameOf(a).localeCompare(nameOf(b)); },
    }[gal.sort] || null;
    if (cmp) cards.slice().sort(function (x, y) { return cmp(cardKey(x), cardKey(y)); }).forEach(function (c) { grid.appendChild(c); });
    var shown = 0;
    cards.forEach(function (c) {
      var k = cardKey(c), sp = SPECIES[k] || {};
      var hay = (nameOf(k) + ' ' + sciOf(k) + ' ' + (sp.fam || '')).toLowerCase();
      c.classList.toggle('nd-hide', !!q && hay.indexOf(q) < 0);
      if (!c.classList.contains('hidden') && !c.classList.contains('nd-hide')) shown++;
    });
    var count = $('#nd-gal-count');
    if (count) count.textContent = 'Showing ' + shown + ' of ' + cards.length + ' species';
    var none = $('#nd-gal-none');
    if (none) none.style.display = shown ? 'none' : 'block';
  }
  function galleryTools() {
    var grid = $('#gallery-grid');
    if (!grid || $('#nd-gal-tools')) return;
    var bar = document.createElement('div');
    bar.id = 'nd-gal-tools';
    bar.className = 'nd-gal-tools';
    bar.innerHTML = '<input type="search" id="nd-gal-q" placeholder="Search by name, scientific name or family…" aria-label="Search species">' +
      '<label>Sort <select id="nd-gal-sort"><option value="name">Name A–Z</option><option value="common">Most recorded in Louisiana</option><option value="rare">Least recorded first</option><option value="sci">Scientific name</option><option value="family">Family</option></select></label>' +
      '<span id="nd-gal-count" class="nd-gal-count"></span>';
    grid.parentNode.insertBefore(bar, grid);
    var none = document.createElement('div');
    none.id = 'nd-gal-none';
    none.className = 'nd-gal-none';
    none.textContent = 'No species match. Try fewer letters, or choose "All Species" above.';
    grid.parentNode.insertBefore(none, grid.nextSibling);
    $('#nd-gal-sort').value = gal.sort;
    $('#nd-gal-q').addEventListener('input', function (e) { gal.q = e.target.value; applyGallery(); });
    $('#nd-gal-sort').addEventListener('change', function (e) { gal.sort = e.target.value; store.set(NS + 'galSort', gal.sort); applyGallery(); });
  }
  if (typeof window.buildGallery === 'function') {
    var galleryWithAudio = window.buildGallery;
    window.buildGallery = function () {
      var r = galleryWithAudio.apply(this, arguments);
      try {
        galleryTools();
        $$('#gallery-grid .sp-card').forEach(function (card) {
          var k = cardKey(card), body = $('.sp-body', card) || card;
          if (!k || $('.nd-card-photo-btn', card) || !$('#photo-picker')) return;
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'nd-card-photo-btn';
          b.title = 'Choose a different photo for ' + nameOf(k);
          b.innerHTML = '&#x270F; Photo';
          b.addEventListener('click', function (e) { e.stopPropagation(); openPhotoPicker(k, e); });
          body.appendChild(b);
        });
        applyGallery();
      } catch (e) {}
      return r;
    };
  }
  if (typeof window.filterGallery === 'function') {
    var origFilter = window.filterGallery;
    window.filterGallery = function () { var r = origFilter.apply(this, arguments); applyGallery(); return r; };
  }

  /* ════════════════ PHOTO SELECTION ════════════════ */
  // "Featured" uses the photos iNaturalist's curators chose to represent each species: the
  // most reliably good, typical-looking image. Observation sorts remain for variety.
  var FEATURED = '__featured';
  var idCache = store.get(NS + 'taxonIds') || {};
  function medium(url) { return String(url || '').replace(/\/(square|small|thumb|large|original)\./, '/medium.'); }
  function resolveTaxonIds(keys) {
    var need = keys.filter(function (k) { return !idCache[k] && sciOf(k); });
    return Promise.all(need.map(function (k) {
      return inat('taxa?q=' + encodeURIComponent(sciOf(k)) + '&per_page=10').then(function (d) {
        var sci = String(sciOf(k)).toLowerCase(), res = d.results || [];
        var hit = res.filter(function (t) { return String(t.name).toLowerCase() === sci; })[0] ||
          res.filter(function (t) { return String(t.matched_term || '').toLowerCase() === sci; })[0];
        if (hit) idCache[k] = hit.id;
      }, function () {});
    })).then(function () { store.set(NS + 'taxonIds', idCache); return idCache; });
  }
  function photoCredit(ph) {
    var name = ph.attribution_name;
    if (!name) { var m = /\(c\)\s*([^,]+)/i.exec(ph.attribution || ''); name = m ? m[1] : ''; }
    return String(name).replace(/©|\(c\)/gi, '').trim();
  }
  function featuredPhotos(keys) {           // -> { key: [photo, …] }
    return resolveTaxonIds(keys).then(function () {
      var ids = keys.map(function (k) { return idCache[k]; }).filter(Boolean), out = {}, chunks = [];
      for (var i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
      return Promise.all(chunks.map(function (ch) {
        return inat('taxa/' + ch.join(',')).then(function (d) {
          (d.results || []).forEach(function (t) {
            var k = keys.filter(function (x) { return idCache[x] === t.id; })[0];
            if (!k) return;
            var list = (t.taxon_photos || []).map(function (tp) { return tp.photo; });
            if (!list.length && t.default_photo) list = [t.default_photo];
            out[k] = list.filter(function (p) { return p && USABLE[p.license_code]; }).map(function (p) {
              return { url: medium(p.url || p.medium_url), by: photoCredit(p), license: p.license_code, taxon_id: t.id };
            });
          });
        });
      })).then(function () { return out; });
    });
  }
  function refreshFeaturedPhotos() {
    var all = Object.keys(SPECIES), updated = 0;
    $$('.refresh-photo-btn').forEach(function (b) { b.disabled = true; });
    setStatus('Fetching featured photos from iNaturalist…');
    return featuredPhotos(all).then(function (got) {
      all.forEach(function (k) {
        var p = (got[k] || [])[0];
        if (!p) return;
        store.set(refreshedKey(k), { url: p.url, by: p.by, license: p.license });
        if (!chosenPhoto(k)) { PHOTOS[k] = p.url; SPECIES[k].by = p.by; }
        updated++;
      });
      all.forEach(paint);
      rerender();
      var missing = all.length - updated;
      setStatus('✓ ' + updated + '/' + all.length + ' featured photos' + (missing ? ' · ' + missing + ' kept their current photo (none featured with a reusable license)' : ''));
    }, function () {
      setStatus('Could not reach iNaturalist — photos unchanged. Try again when you’re online.');
    }).then(function () { $$('.refresh-photo-btn').forEach(function (b) { b.disabled = false; }); });
  }

  // Photo picker: featured photos first, a Louisiana-only choice, an adults / living filter,
  // more photos per page with "Show more", and a link to each source observation.
  var ND_SORTS = [
    { label: 'Featured', desc: 'Chosen by iNaturalist curators', featured: true },
    { label: 'Most Favorited', desc: 'Top-voted research-grade', params: 'quality_grade=research&order_by=votes&order=desc' },
    { label: 'From Louisiana', desc: 'Top-voted Louisiana records', params: 'quality_grade=research&place_id=' + PLACE + '&order_by=votes&order=desc' },
    { label: 'Most Recent', desc: 'Latest research-grade', params: 'quality_grade=research&order_by=observed_on&order=desc' },
  ];
  var ANNOT = { any: '', adult: '&term_id=1&term_value_id=2', alive: '&term_id=17&term_value_id=18' };
  var picker = { key: null, sort: 0, page: 1, seen: {}, token: 0 };
  function pickerSetup() {
    var box = $('#photo-picker .photo-picker-box');
    if (!box || $('#nd-picker-opts')) return;
    var bar = $('.picker-sort-bar', box);
    if (bar) {
      bar.innerHTML = '<span class="picker-sort-label">Show:</span>' + ND_SORTS.map(function (s, i) {
        return '<button type="button" class="picker-sort-btn' + (i ? '' : ' active') + '" data-nd-sort="' + i + '" title="' + esc(s.desc) + '">' + esc(s.label) + '</button>';
      }).join('');
      bar.addEventListener('click', function (e) {
        var b = e.target.closest('[data-nd-sort]');
        if (!b) return;
        $$('.picker-sort-btn', bar).forEach(function (x) { x.classList.toggle('active', x === b); });
        loadPicker(picker.key, +b.dataset.ndSort, true);
      });
    }
    var opts = document.createElement('div');
    opts.id = 'nd-picker-opts';
    opts.className = 'nd-picker-opts';
    opts.innerHTML = '<label>Only <select id="nd-picker-annot"><option value="any">any photo</option><option value="adult">adults</option><option value="alive">living animals (no specimens or roadkill)</option></select></label><span class="nd-picker-note">Filters use observers’ annotations, so some good photos are left out.</span>';
    (bar || box).parentNode === box ? box.insertBefore(opts, (bar || box).nextSibling) : box.appendChild(opts);
    var sel = $('#nd-picker-annot', opts);
    sel.value = store.get('nd:pickerAnnot') || 'any';
    sel.addEventListener('change', function () { store.set('nd:pickerAnnot', sel.value); loadPicker(picker.key, picker.sort, true); });
  }
  function pickerCard(k, p, desc) {
    var stored = chosenPhoto(k);
    var div = document.createElement('div');
    div.className = 'picker-option' + ((stored ? stored.url === p.url : PHOTOS[k] === p.url) ? ' chosen' : '');
    div.innerHTML = '<div class="picker-checkmark">✓</div><img src="' + esc(p.url) + '" alt="' + esc(nameOf(k)) + '" loading="lazy">' +
      '<div class="picker-label-bar"><div class="picker-label-name">' + esc(desc) + '</div><div class="picker-label-by">' +
      (p.by ? 'by ' + esc(p.by) + ' · ' : '') + esc(LICENSE_LABEL[p.license] || p.license || '') +
      (p.obs_id ? ' · <a href="https://www.inaturalist.org/observations/' + p.obs_id + '" target="_blank" rel="noopener">observation ↗</a>' : '') + '</div></div>';
    $('img', div).addEventListener('error', function () { div.remove(); });
    div.addEventListener('click', function (e) { if (e.target.closest('a')) return; applyPickerChoice(k, p, div); });
    return div;
  }
  function loadPicker(k, sortIdx, reset) {
    if (!k) return;
    var grid = $('#picker-grid');
    if (!grid) return;
    var tok = ++picker.token;
    if (reset) { picker.page = 1; picker.seen = {}; grid.innerHTML = '<div class="picker-loading">Fetching photos from iNaturalist…</div>'; }
    picker.key = k; picker.sort = sortIdx;
    var s = ND_SORTS[sortIdx], annot = ANNOT[($('#nd-picker-annot') || {}).value || 'any'] || '';
    var more = $('#nd-picker-more'); if (more) more.remove();
    function stillHere() { var box = $('#photo-picker'); return tok === picker.token && box && !box.classList.contains('hidden'); }
    var req = s.featured
      ? featuredPhotos([k]).then(function (got) { return { photos: got[k] || [], more: false }; })
      : inat('observations?taxon_name=' + encodeURIComponent(sciOf(k)) + '&' + s.params + annot + '&photos=true&per_page=30&page=' + picker.page).then(function (d) {
          var photos = [];
          (d.results || []).forEach(function (obs) {
            (obs.photos || []).filter(function (p) { return USABLE[p.license_code]; }).slice(0, 2).forEach(function (p) {
              var url = medium(p.url);
              if (picker.seen[url]) return;
              picker.seen[url] = 1;
              photos.push({ url: url, by: obs.user ? obs.user.login : '', license: p.license_code, obs_id: obs.id });
            });
          });
          return { photos: photos, more: (d.results || []).length === 30 && picker.page < 10 };
        });
    req.then(function (res) {
      if (!stillHere()) return;
      if (reset) grid.innerHTML = '';
      res.photos.forEach(function (p) { grid.appendChild(pickerCard(k, p, s.desc)); });
      if (!grid.children.length) {
        grid.innerHTML = '<div class="picker-loading">' + (s.featured ? 'iNaturalist has no featured photo with a reusable license for this species. Try “Most Favorited”.' : 'No photos with a reusable license match these settings. Try another option above.') + '</div>';
      }
      if (res.more) {
        var b = document.createElement('button');
        b.type = 'button'; b.id = 'nd-picker-more'; b.className = 'nd-picker-more'; b.textContent = 'Show more photos';
        b.addEventListener('click', function () { picker.page++; b.disabled = true; b.textContent = 'Loading…'; loadPicker(k, sortIdx, false); });
        grid.parentNode.appendChild(b);
      }
    }, function () {
      if (!stillHere()) return;
      if (reset) grid.innerHTML = '<div class="picker-loading">Can’t reach iNaturalist right now — reconnecting automatically…</div>';
      waitOnline(10000).then(function () { if (stillHere()) loadPicker(k, sortIdx, reset); });
    });
  }
  if (typeof window.openPhotoPicker === 'function') {
    var origOpenPicker = window.openPhotoPicker;
    window.openPhotoPicker = function (k) {
      pickerSetup();
      var r = origOpenPicker.apply(this, arguments);   // sets title/visibility and calls loadPickerGrid
      return r;
    };
    window.loadPickerGrid = function (k) {
      pickerSetup();
      $$('#photo-picker .picker-sort-btn').forEach(function (b, i) { b.classList.toggle('active', i === 0); });
      loadPicker(k, 0, true);
    };
    window.setPickerSort = function (idx) { loadPicker(picker.key, idx, true); };
  }

  /* ════════════════ TAB BAR: FIND A SPECIES + DATA MENU ════════════════ */
  function tabTools() {
    var inner = $('.tabs .tabs-inner') || $('.tabs-inner');
    if (!inner || $('#nd-tabtools')) return;
    var oldSel = $('.photo-sort-select');
    var sortOpts = '<option value="' + FEATURED + '">Featured (iNaturalist curators)</option>' + (oldSel ? oldSel.innerHTML.replace(/ selected(="selected")?/g, '') : '');
    var names = Object.keys(SPECIES).sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
    var wrap = document.createElement('div');
    wrap.id = 'nd-tabtools';
    wrap.className = 'nd-tabtools';
    wrap.innerHTML =
      '<div class="nd-find"><input type="search" id="nd-find" list="nd-find-list" placeholder="Find a species…" aria-label="Find a species" autocomplete="off">' +
      '<datalist id="nd-find-list">' + names.map(function (k) { return '<option value="' + esc(nameOf(k)) + '">' + esc(sciOf(k)) + '</option>'; }).join('') + '</datalist></div>' +
      '<details class="nd-data-menu" id="nd-data-menu"><summary>Data &amp; photos</summary><div class="nd-data-panel">' +
      '<div class="nd-counts-note"></div>' +
      '<div class="nd-data-row"><button type="button" class="refresh-btn refresh-inat-btn" onclick="refreshInatData()">↻ Refresh record counts</button></div>' +
      '<div class="nd-data-row nd-photo-row"><label class="nd-data-label" for="nd-photo-source">Photos from</label><select id="nd-photo-source" class="photo-sort-select">' + sortOpts + '</select>' +
      '<button type="button" class="refresh-btn refresh-photo-btn" onclick="refreshPhotos(this)">↻ Refresh photos</button></div>' +
      '<div class="nd-data-row"><button type="button" class="refresh-btn" onclick="refreshAudio(this)">▶ Refresh sounds</button>' +
      '<button type="button" class="refresh-btn" id="nd-reset-photos">Undo my photo choices</button></div>' +
      '<div class="refresh-status nd-data-status" role="status"></div>' +
      '<p class="nd-data-help">Counts and photos come from iNaturalist and are saved in this browser. To pick one species’ photo, use ✎ Photo on its card.</p>' +
      '</div></details>';
    inner.appendChild(wrap);
    var find = $('#nd-find');
    function pick() {
      var v = find.value.trim().toLowerCase();
      if (!v) return;
      var k = names.filter(function (x) { return nameOf(x).toLowerCase() === v || String(sciOf(x)).toLowerCase() === v; })[0];
      if (!k) { var hits = names.filter(function (x) { return (nameOf(x) + ' ' + sciOf(x)).toLowerCase().indexOf(v) >= 0; }); if (hits.length === 1) k = hits[0]; }
      if (k) { find.value = ''; find.blur(); window.ndOpenSpecies(k); }
    }
    find.addEventListener('change', pick);
    find.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pick(); } });
    $('#nd-reset-photos').addEventListener('click', function () {
      var n = 0;
      Object.keys(SPECIES).forEach(function (k) {
        if (!chosenPhoto(k)) return;
        store.del('pp:' + k); n++;
        var r = store.get(refreshedKey(k));
        PHOTOS[k] = r ? r.url : ORIGINAL[k];
        paint(k);
      });
      rerender();
      setStatus(n ? '✓ Undid ' + n + ' photo choice' + (n === 1 ? '' : 's') : 'You haven’t chosen any photos in this guide.');
    });
    document.addEventListener('click', function (e) {
      var m = $('#nd-data-menu');
      if (m && m.open && !m.contains(e.target)) m.open = false;
    });
  }

  /* ════════════════ FLOW CHART: TREE, CHART AND NUMBERED KEY ════════════════ */
  var fc = { view: store.get(NS + 'fcView') || 'tree', zoom: null, hl: null, built: false };
  function fcHeader() {
    var bar = $('.fc-header-bar');
    if (!bar || $('#nd-fc-tools')) return;
    var subs = $('.fc-subtabs', bar);
    if (subs) subs.innerHTML = [['tree', 'Tree'], ['visual', 'Chart'], ['numbered', 'Numbered key']].map(function (v) {
      return '<button type="button" class="fc-sub" data-fc-view="' + v[0] + '">' + v[1] + '</button>';
    }).join('');
    var tools = document.createElement('div');
    tools.id = 'nd-fc-tools';
    tools.className = 'nd-fc-tools';
    tools.innerHTML = '<div class="nd-find"><input type="search" id="nd-fc-find" list="nd-find-list" placeholder="Highlight a species’ path…" aria-label="Highlight a species in the chart" autocomplete="off"></div>' +
      '<button type="button" class="nd-fc-btn" id="nd-fc-clear" hidden>Clear highlight</button>' +
      '<span class="nd-fc-only" data-for="tree"><button type="button" class="nd-fc-btn" data-tree="open">Expand all</button><button type="button" class="nd-fc-btn" data-tree="close">Collapse all</button></span>' +
      '<span class="nd-fc-only" data-for="visual"><button type="button" class="nd-fc-btn" data-zoom="-1" aria-label="Zoom out">−</button><span id="nd-zoom-pct" class="nd-zoom-pct"></span><button type="button" class="nd-fc-btn" data-zoom="1" aria-label="Zoom in">+</button><button type="button" class="nd-fc-btn" data-zoom="fit">Fit</button></span>';
    bar.appendChild(tools);
    var tree = document.createElement('div');
    tree.id = 'fc-tree';
    tree.className = 'fc-sec';
    var vis = $('#fc-visual');
    vis.parentNode.insertBefore(tree, vis);
    var find = $('#nd-fc-find');
    function go() {
      var v = find.value.trim().toLowerCase();
      if (!v) return;
      var k = Object.keys(SPECIES).filter(function (x) { return nameOf(x).toLowerCase() === v || String(sciOf(x)).toLowerCase() === v; })[0];
      if (!k) { var hits = Object.keys(SPECIES).filter(function (x) { return (nameOf(x) + ' ' + sciOf(x)).toLowerCase().indexOf(v) >= 0; }); if (hits.length === 1) k = hits[0]; }
      if (k) highlight(k, true);
    }
    find.addEventListener('change', go);
    find.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    $('#nd-fc-clear').addEventListener('click', function () { find.value = ''; highlight(null); });
  }
  var HINTS = {
    tree: 'Open a branch to follow the key. Each answer shows how many species it leads to; tap a species for details, or “Key from here” to continue in the interactive key.',
    visual: 'Read left to right. Drag to move around, use − / + / Fit to zoom. Tap a question to key from there, or a species for details.',
    numbered: 'A traditional printed key: at each couplet choose a or b, then follow “→” to the next couplet. Tap numbers and names to jump.',
  };
  window.fcShow = function (view) {
    if (!/^(tree|visual|numbered)$/.test(view)) view = 'tree';
    fc.view = view;
    store.set(NS + 'fcView', view);
    $$('.fc-sec').forEach(function (s) { s.classList.toggle('on', s.id === 'fc-' + view); });
    $$('.fc-sub').forEach(function (b) { b.classList.toggle('on', b.dataset.fcView === view); });
    $$('.nd-fc-only').forEach(function (s) { s.style.display = s.dataset.for === view ? '' : 'none'; });
    var hint = $('#fc-hint');
    if (hint) { hint.style.display = 'block'; hint.textContent = HINTS[view]; }
    if (view === 'visual' && fc.zoom == null) requestAnimationFrame(function () { zoom('fit'); });
  };

  function leafHTML(k) {
    return '<button type="button" class="fct-leaf" data-sp="' + k + '" data-leaf="' + k + '">' +
      (PHOTOS[k] ? '<img src="' + esc(PHOTOS[k]) + '" data-species-photo="' + k + '" alt="" loading="lazy">' : '<span class="nd-mini-noimg"></span>') +
      '<span class="fct-leaf-text"><b>' + esc(nameOf(k)) + '</b><i>' + esc(sciOf(k)) + '</i>' + rarityChip(k) + '</span></button>';
  }
  function treeNodeHTML(id, depth) {
    var n = NK[id];
    var html = '<div class="fct-node" data-node="' + id + '"><div class="fct-q"><span class="fct-num" id="fct-' + NUM[id] + '">' + NUM[id] + '</span>' +
      '<div class="fct-qbody"><div class="fct-qtext">' + esc(plain(n.q)) + '</div>' +
      (n.tip ? '<details class="fct-tip"><summary>Tip</summary><div>' + esc(plain(n.tip)) + '</div></details>' : '') + '</div>' +
      '<button type="button" class="fct-start" data-start="' + id + '" title="Continue in the interactive key from this question">Key from here</button></div><div class="fct-branches">';
    choicesOf(n).forEach(function (c) {
      var br = n[c];
      var head = '<span class="fct-letter">' + c.toUpperCase() + '</span><span class="fct-ctext">' + br.text + '</span>';
      if (br.result) {
        html += '<div class="fct-br fct-br-leaf" data-node="' + id + '" data-choice="' + c + '"><div class="fct-sum">' + head + '</div>' + leafHTML(br.result) + '</div>';
      } else {
        var count = speciesUnder(br.next).length;
        html += '<details class="fct-br" data-node="' + id + '" data-choice="' + c + '"' + (depth < 1 ? ' open' : '') + '><summary>' + head +
          '<span class="fct-count">' + count + ' species</span></summary>' + treeNodeHTML(br.next, depth + 1) + '</details>';
      }
    });
    return html + '</div></div>';
  }
  function renderTree() {
    var box = $('#fc-tree');
    if (box && HAS_KEY) box.innerHTML = '<div class="fct">' + treeNodeHTML(ROOT, 0) + '</div>';
  }
  function refreshFlowTree() {
    if (!fc.built) return;
    var open = $$('#fc-tree details.fct-br[open]').map(function (d) { return d.dataset.node + ':' + d.dataset.choice; });
    renderTree();
    $$('#fc-tree details.fct-br').forEach(function (d) { d.open = open.indexOf(d.dataset.node + ':' + d.dataset.choice) >= 0; });
    if (fc.hl) highlight(fc.hl, false);
  }

  // Left-to-right chart: every question and answer is shown in full (wrapped, never cut off).
  function wrapText(t, max) {
    var words = plain(t).split(/\s+/), lines = [], cur = '';
    words.forEach(function (w) {
      if (!w) return;
      var next = cur ? cur + ' ' + w : w;
      if (next.length > max && cur) { lines.push(cur); cur = w; } else cur = next;
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function renderChart() {
    var box = $('#fc-visual');
    if (!box || !HAS_KEY) return;
    var QW = 230, LW = 190, RW = 170, COL = QW + LW + 40, LH = 14, ROWGAP = 14;
    var nodes = {}, order = [], leaves = [], edges = [], y = 0, maxDepth = 0;
    // Each subtree owns a horizontal band [start, y); a question taller than its children's
    // band widens it, so boxes in the same column can never overlap.
    function lay(id, depth) {
      var n = NK[id], lines = wrapText(n.q, 34);
      var h = lines.length * LH + 30;
      var startY = y, leafStart = leaves.length, nodeStart = order.length;
      maxDepth = Math.max(maxDepth, depth);
      var kids = choicesOf(n).map(function (c) {
        var br = n[c], label = wrapText(br.text, 28), lh = label.length * 12 + 10, child;
        if (br.result) {
          var nm = wrapText(nameOf(br.result), 24), rh = nm.length * 14 + 26, slot = Math.max(rh, lh) + ROWGAP;
          child = { leaf: br.result, x: (depth + 1) * COL, y: y + (slot - rh) / 2, h: rh, nm: nm, cy: y + slot / 2 };
          leaves.push(child);
          y += slot;
        } else child = lay(br.next, depth + 1);
        edges.push({ from: id, c: c, label: label, lh: lh, to: child });
        return child;
      });
      var need = h + ROWGAP - (y - startY);
      if (need > 0) {
        var d = need / 2;
        leaves.slice(leafStart).forEach(function (r) { r.y += d; r.cy += d; });
        order.slice(nodeStart).forEach(function (k) { nodes[k].y += d; nodes[k].cy += d; });
        y += need;
      }
      var cy = (kids[0].cy + kids[kids.length - 1].cy) / 2;
      var top = Math.max(startY, Math.min(cy - h / 2, y - h));
      nodes[id] = { id: id, x: depth * COL, y: top, h: h, lines: lines, cy: top + h / 2 };
      order.push(id);
      return nodes[id];
    }
    lay(ROOT, 0);
    var W = (maxDepth + 1) * COL + RW + 20, H = y + 20;
    Object.keys(nodes).forEach(function (id) { H = Math.max(H, nodes[id].y + nodes[id].h + 20); });
    var s = '<svg xmlns="http://www.w3.org/2000/svg" class="fcv" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" data-w="' + W + '" data-h="' + H + '" font-family="Trebuchet MS, Arial, sans-serif">';
    edges.forEach(function (e) {
      var p = nodes[e.from], x1 = p.x + QW, y1 = p.cy, x2 = e.to.x, y2 = e.to.cy;
      s += '<path class="fcv-edge" data-node="' + e.from + '" data-choice="' + e.c + '" d="M' + x1 + ',' + y1 + ' C' + (x1 + 26) + ',' + y1 + ' ' + (x1 + 4) + ',' + y2 + ' ' + (x1 + 30) + ',' + y2 + ' L' + x2 + ',' + y2 + '" fill="none"/>';
      var lx = x1 + 26, ly = y2 - e.lh / 2;
      s += '<g class="fcv-label" data-node="' + e.from + '" data-choice="' + e.c + '"><title>' + esc(plain(NK[e.from][e.c].text)) + '</title>' +
        '<rect x="' + lx + '" y="' + ly + '" width="' + LW + '" height="' + e.lh + '" rx="4"/>' +
        '<circle cx="' + (lx + 11) + '" cy="' + (ly + 11) + '" r="7"/><text class="fcv-letter" x="' + (lx + 11) + '" y="' + (ly + 14.5) + '" text-anchor="middle">' + e.c.toUpperCase() + '</text>' +
        e.label.map(function (l, i) { return '<text x="' + (lx + 23) + '" y="' + (ly + 14 + i * 12) + '">' + esc(l) + '</text>'; }).join('') + '</g>';
    });
    Object.keys(nodes).forEach(function (id) {
      var n = nodes[id];
      s += '<g class="fcv-q" data-start="' + id + '" data-node="' + id + '" tabindex="0" role="button" aria-label="Key from question ' + NUM[id] + '"><title>Tap to continue the interactive key from here</title>' +
        '<rect x="' + n.x + '" y="' + n.y + '" width="' + QW + '" height="' + n.h + '" rx="6"/>' +
        '<text class="fcv-num" x="' + (n.x + 10) + '" y="' + (n.y + 16) + '">' + NUM[id] + '</text>' +
        n.lines.map(function (l, i) { return '<text x="' + (n.x + 10) + '" y="' + (n.y + 32 + i * LH) + '">' + esc(l) + '</text>'; }).join('') + '</g>';
    });
    leaves.forEach(function (r) {
      var sci = String(sciOf(r.leaf));
      s += '<g class="fcv-leaf" data-sp="' + r.leaf + '" data-leaf="' + r.leaf + '" tabindex="0" role="button" aria-label="' + esc(nameOf(r.leaf)) + '"><title>' + esc(nameOf(r.leaf) + ' — ' + sci) + '</title>' +
        '<rect x="' + r.x + '" y="' + r.y + '" width="' + RW + '" height="' + r.h + '" rx="' + Math.min(14, r.h / 2) + '"/>' +
        r.nm.map(function (l, i) { return '<text class="fcv-name" x="' + (r.x + RW / 2) + '" y="' + (r.y + 16 + i * 14) + '" text-anchor="middle">' + esc(l) + '</text>'; }).join('') +
        '<text class="fcv-sci" x="' + (r.x + RW / 2) + '" y="' + (r.y + 16 + r.nm.length * 14) + '" text-anchor="middle">' + esc(sci.length > 28 ? sci.slice(0, 27) + '…' : sci) + '</text></g>';
    });
    s += '</svg>';
    box.innerHTML = '<div class="fcv-wrap" id="fcv-wrap">' + s + '</div>';
    fc.zoom = null;
    dragScroll($('#fcv-wrap'));
  }
  function zoom(dir) {
    var svg = $('#fc-visual svg'), wrap = $('#fcv-wrap');
    if (!svg || !wrap) return;
    var W = +svg.dataset.w, H = +svg.dataset.h;
    var fit = Math.min(1, Math.max(0.2, (wrap.clientWidth - 8) / W));
    var z = fc.zoom == null ? fit : fc.zoom;
    if (dir === 'fit') z = fit; else z = Math.min(2, Math.max(0.2, z * (dir > 0 ? 1.25 : 0.8)));
    fc.zoom = z;
    svg.setAttribute('width', Math.round(W * z));
    svg.setAttribute('height', Math.round(H * z));
    var pct = $('#nd-zoom-pct'); if (pct) pct.textContent = Math.round(z * 100) + '%';
  }
  function dragScroll(el) {
    if (!el) return;
    var down = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop, moved: false };
    });
    window.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      down.moved = true;
      el.classList.add('dragging');
      el.scrollLeft = down.l - dx;
      el.scrollTop = down.t - dy;
    });
    window.addEventListener('pointerup', function () {
      if (down && down.moved) { el.dataset.justDragged = '1'; setTimeout(function () { delete el.dataset.justDragged; }, 0); }
      down = null; el.classList.remove('dragging');
    });
  }

  function renderNumbered() {
    var box = $('#fc-numbered');
    if (!box || !HAS_KEY) return;
    var ids = Object.keys(NUM).sort(function (a, b) { return NUM[a] - NUM[b]; });
    var html = '<p class="fc-note">At each couplet choose <b>a</b> or <b>b</b>. “→ 5” means go to couplet 5 (tap it to jump there); a species name is the identification (tap it for details). “from 3b” shows which answer led here.</p>';
    ids.forEach(function (id) {
      var n = NK[id], par = PARENT[id];
      html += '<div class="fc-coup" id="fcn-' + NUM[id] + '" data-node="' + id + '"><span class="fc-cn">' + NUM[id] +
        (par ? '<small class="nd-from">from ' + NUM[par.node] + par.choice + '</small>' : '') + '</span><div class="fc-cb">' +
        '<div class="nd-cq-question">' + esc(plain(n.q)) + '</div>' +
        choicesOf(n).map(function (c) {
          var br = n[c];
          var to = br.result
            ? '<button type="button" class="nd-cn-sp" data-sp="' + br.result + '" data-leaf="' + br.result + '"><strong>' + esc(nameOf(br.result)) + '</strong> <em>' + esc(sciOf(br.result)) + '</em></button>'
            : '<a class="fc-nr" href="#fcn-' + NUM[br.next] + '" data-goto="' + NUM[br.next] + '">→ ' + NUM[br.next] + '</a>';
          return '<div class="fc-cr" data-node="' + id + '" data-choice="' + c + '"><span class="fc-cl">' + c + '.</span><span class="fc-cq">' + br.text + '</span><span class="fc-ct">' + to + '</span></div>';
        }).join('') + '</div></div>';
    });
    box.innerHTML = html;
  }

  // Marks one species' path in all three views and brings it into view.
  function highlight(k, scroll) {
    fc.hl = k;
    $$('.nd-on-path').forEach(function (el) { el.classList.remove('nd-on-path'); });
    var clear = $('#nd-fc-clear'); if (clear) clear.hidden = !k;
    if (!k) return;
    var path = pathToSpecies(k);
    path.forEach(function (s) {
      $$('[data-node="' + s.node + '"][data-choice="' + s.choice + '"]').forEach(function (el) {
        el.classList.add('nd-on-path');
        if (el.tagName === 'DETAILS') el.open = true;
      });
      $$('[data-node="' + s.node + '"]:not([data-choice])').forEach(function (el) { el.classList.add('nd-on-path'); });
    });
    $$('[data-leaf="' + k + '"]').forEach(function (el) { el.classList.add('nd-on-path'); });
    var find = $('#nd-fc-find'); if (find && find.value !== nameOf(k)) find.value = nameOf(k);
    if (!scroll) return;
    requestAnimationFrame(function () {
      var target = $('#fc-' + fc.view + ' [data-leaf="' + k + '"]');
      if (!target) return;
      if (fc.view === 'visual') {
        var wrap = $('#fcv-wrap'), z = fc.zoom || 1, r = target.getBBox();
        if (fc.zoom != null && fc.zoom < 0.6) { fc.zoom = 0.6 / 1.25; zoom(1); z = fc.zoom; }
        wrap.scrollLeft = r.x * z - wrap.clientWidth / 2;
        wrap.scrollTop = r.y * z - wrap.clientHeight / 2;
        wrap.scrollIntoView({ block: 'nearest' });
      } else target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
  window.ndShowInChart = function (k) {
    if (typeof closeModal === 'function') closeModal();
    goToTab('flowchart');
    if (!fc.built && typeof buildFlowchart === 'function') buildFlowchart();
    highlight(k, true);
  };

  if (HAS_KEY && typeof window.buildFlowchart === 'function') {
    window.buildFlowchart = function () {
      try { fcBuilt = true; } catch (e) {}
      fc.built = true;
      fcHeader();
      renderTree();
      renderChart();
      renderNumbered();
      window.fcShow(fc.view);
      if (fc.hl) highlight(fc.hl, false);
    };
    window.openFlowchart = function () { goToTab('flowchart'); if (!fc.built) buildFlowchart(); };
  }
  // Printing the tree prints every branch, not just the open ones.
  var printOpened = [];
  window.addEventListener('beforeprint', function () {
    printOpened = $$('#fc-tree details:not([open])');
    printOpened.forEach(function (d) { d.open = true; });
  });
  window.addEventListener('afterprint', function () { printOpened.forEach(function (d) { d.open = false; }); printOpened = []; });

  /* ════════════════ ONE CLICK HANDLER FOR ALL OF THE ABOVE ════════════════ */
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-sp],[data-start],[data-jump],[data-goto],[data-fc-view],[data-zoom],[data-tree],[data-chart-sp]');
    if (!t) return;
    var wrap = t.closest('#fcv-wrap');
    if (wrap && wrap.dataset.justDragged) return;
    if (t.dataset.chartSp) { e.preventDefault(); window.ndShowInChart(t.dataset.chartSp); }
    else if (t.dataset.sp) { e.preventDefault(); e.stopPropagation(); window.ndOpenSpecies(t.dataset.sp); }
    else if (t.dataset.start) { e.preventDefault(); startKeyAt(t.dataset.start); }
    else if (t.dataset.jump != null) { e.preventDefault(); jumpTo(+t.dataset.jump); }
    else if (t.dataset.fcView) window.fcShow(t.dataset.fcView);
    else if (t.dataset.zoom) zoom(t.dataset.zoom === 'fit' ? 'fit' : +t.dataset.zoom);
    else if (t.dataset.tree) $$('#fc-tree details.fct-br').forEach(function (d) { d.open = t.dataset.tree === 'open'; });
    else if (t.dataset.goto) {
      e.preventDefault();
      var c = document.getElementById('fcn-' + t.dataset.goto);
      if (c) { c.scrollIntoView({ block: 'center', behavior: 'smooth' }); c.classList.remove('nd-flash'); void c.offsetWidth; c.classList.add('nd-flash'); }
    }
  }, true);
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('g[role="button"]')) { e.preventDefault(); e.target.closest('g[role="button"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });

  /* ════════════════ START ════════════════ */
  try { tabTools(); } catch (e) {}
  window.applyStoredPhotoOverrides();
  updateCounts(false);
})();
