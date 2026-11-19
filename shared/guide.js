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
    var sort = sel ? sel.value : 'quality_grade=research&order_by=votes&order=desc';
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
                store.set(refreshedKey(k), { url: url, by: by });
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

  /* ════════════════ START ════════════════ */
  window.applyStoredPhotoOverrides();
  updateCounts(false);
})();
