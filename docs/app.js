/* MD-CarResearch viewer.

   Loads Requests/index.json (the manifest -- GitHub Pages serves no directory
   listing, so there is no other way to discover requests), then loads exactly
   ONE request's results.json at a time. Switching requests replaces the dataset;
   it never unions two requests together.

   Paths in the manifest are repo-root-relative and this file lives in docs/,
   hence the '../' prefix throughout. */
(function () {
  var FAV_LS_PREFIX = 'carResearchFavorites:';   // + request_id -- favorites are per request
  // v2: column ids changed with the multi-request schema (selling_items ->
  // offerings, brand/group/tax added). A returning visitor's v1 selection would
  // render a table of blank columns, so the key is bumped rather than migrated.
  //
  // v3/v4: the spec fields are populated for the first time (by the enrichment
  // step) and Config/spec_fields.json both adds columns the stored list has
  // never heard of and now decides which are shown by default. A stored
  // selection cannot distinguish "column did not exist" from "user switched it
  // off", so the same reasoning as v2 applies in reverse: rather than guess,
  // reset everyone to defaults once, now that the columns finally have
  // something in them.
  var COLS_LS_KEY = 'carResearchColumns.v5';
  var PRICE_LS_KEY = 'carResearchPriceRanges';
  var THEME_LS_KEY = 'carResearchTheme';

  // GitHub Contents API sync: the only way a backend-less static site can
  // commit favorites.json to the repo itself, rather than just a local disk
  // or download. The token is supplied by whoever is using the viewer and
  // never leaves this browser except in requests to api.github.com.
  var GH_OWNER = 'Maksym-Denysiuk';
  var GH_REPO = 'CarsSearch';
  var GH_BRANCH = 'master';
  var GH_TOKEN_LS_KEY = 'carResearchGithubToken';

  var PRICE_RANGES = [
    { id: '0-50', min: 0, max: 50000 },
    { id: '50-100', min: 50000, max: 100000 },
    { id: '100-120', min: 100000, max: 120000 },
    { id: '120+', min: 120000, max: Infinity }
  ];
  var DEFAULT_PRICE_RANGES = ['0-50', '50-100'];

  var COLUMNS = [
    { id: 'name', label: 'Name', sortKey: 'name', defaultVisible: true, cell: nameCell },
    { id: 'brand_name', label: 'Brand', sortKey: 'brand_name', defaultVisible: true,
      cell: function (m) { return m.brand_name ? esc(m.brand_name) : offChecklist(m); } },
    { id: 'group_name', label: 'Group', sortKey: 'group_name', defaultVisible: false,
      cell: function (m) { return m.group_name ? esc(m.group_name) : offChecklist(m); } },
    { id: 'manufacturer', label: 'Manufacturer', sortKey: 'manufacturer', defaultVisible: false,
      cell: function (m) { return esc(m.manufacturer); } },
    { id: 'body_type', label: 'Body type', sortKey: 'body_type', defaultVisible: false,
      cell: function (m) { return '<span class="chip">' + esc(m.body_type) + '</span>'; } },
    { id: 'average_budget_eur', label: 'Avg. Budget (EUR)', sortKey: 'average_budget_eur', numeric: true, defaultVisible: true,
      cell: function (m) { return fmtBudget(m.average_budget_eur); } },
    { id: 'offerings', label: 'Offerings', sortKey: 'offerings_count', numeric: false, defaultVisible: true,
      cell: renderOfferings },
    { id: 'search_status', label: 'Search status', sortKey: 'search_status', defaultVisible: true,
      cell: renderSearchStatus },
    { id: 'tank_or_battery_size', label: 'Tank / battery', sortKey: 'tank_or_battery_size', defaultVisible: true,
      cell: function (m) { return esc(m.tank_or_battery_size); } },
    { id: 'fuel_or_charge_consumption', label: 'Consumption', sortKey: 'fuel_or_charge_consumption', defaultVisible: true,
      cell: function (m) { return esc(m.fuel_or_charge_consumption); } },
    { id: 'engine', label: 'Engine', sortKey: 'engine', defaultVisible: true,
      cell: function (m) { return esc(m.engine); } },
    { id: 'roof_removable', label: 'Roof removable', sortKey: 'roof_removable', defaultVisible: true,
      cell: function (m) { return fmtBool(m.roof_removable); } },
    { id: 'roof_mechanism', label: 'Roof mechanism', sortKey: 'roof_mechanism', defaultVisible: true,
      cell: function (m) { return esc(m.roof_mechanism); } },
    { id: 'tax', label: 'Tax', defaultVisible: true,
      cell: function (m) { return renderTax(m.tax); } },
    { id: 'import_tax', label: 'Import tax', defaultVisible: true,
      cell: function (m) { return renderTax(m.import_tax); } },
    { id: 'tier', label: 'Tier', sortKey: 'tier', defaultVisible: false,
      cell: function (m) { return esc(m.tier); } },
    { id: 'doors', label: 'Doors', sortKey: 'doors', numeric: true, defaultVisible: false,
      cell: function (m) { return esc(m.doors); } },
    { id: 'first_year', label: 'First year', sortKey: 'first_year', numeric: true, defaultVisible: false,
      cell: function (m) { return m.first_year === null || m.first_year === undefined
        ? '<span class="empty-note">n/a</span>' : esc(m.first_year); } }
  ];

  var STATUS_LABELS = {
    'pending': 'pending',
    'completed': 'completed',
    'completed_no_offerings': 'no offerings found',
    'completed_insufficient_sources': 'insufficient sources',
    'failed': 'failed'
  };

  var state = {
    requests: [],          // rows from Requests/index.json
    requestId: null,       // exactly one request is loaded at a time
    request: null,         // that request's request.json
    results: null,         // that request's results.json
    models: [],
    sortKey: 'average_budget_eur', sortDir: 1,
    groupBy: '', collapsedGroups: new Set(),
    favorites: new Set(), view: 'all', favHandle: null,
    visibleColumns: null, priceRanges: null,
    bodyTypes: []          // [{id, label}] read out of assets/body-types.svg
  };

  /* ---------------------------------------------------------------- utils */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtBudget(v) {
    if (v === null || v === undefined) return '<span class="empty-note">n/a</span>';
    return '&euro;' + Number(v).toLocaleString('en-US');
  }

  // An absent spec field is now legal (see results.schema.json's note on
  // the model row), and it must not render as a definite "no": nobody
  // asked whether that roof comes off, and "no" claims somebody did.
  function fmtBool(v) {
    if (v === null || v === undefined) return '<span class="empty-note">n/a</span>';
    return v ? '<span class="bool-yes">yes</span>' : '<span class="bool-no">no</span>';
  }

  function offChecklist(m) {
    return '<span class="empty-note" title="' + esc(m.manufacturer) +
      ' is not on the Config/brands.json checklist">not on checklist</span>';
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.json();
    });
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /* --------------------------------------------- direct favorites.json save
     Chromium's File System Access API lets the page hold a handle to a real
     file on disk and write to it directly, instead of round-tripping through
     the Downloads folder. Firefox/Safari don't implement it, so everything
     here is additive: unsupported browsers silently keep the old
     download-and-commit-by-hand flow. The handle is per request_id (favorites
     are per request) and is persisted in IndexedDB, since it isn't
     JSON-serializable and can't live in localStorage. */

  var FS_SUPPORTED = typeof window.showSaveFilePicker === 'function';
  var FS_DB_NAME = 'carResearchFileHandles';
  var FS_STORE = 'handles';

  function openHandleDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(FS_DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(FS_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getStoredHandle(requestId) {
    return openHandleDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(FS_STORE, 'readonly');
        var req = tx.objectStore(FS_STORE).get(requestId);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function setStoredHandle(requestId, handle) {
    return openHandleDb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(FS_STORE, 'readwrite');
        tx.objectStore(FS_STORE).put(handle, requestId);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function favoritesPayload() {
    return {
      schema_version: 1,
      request_id: state.requestId,
      metadata: {
        description: 'User-curated shortlist for ' + state.requestId +
          ', referencing model ids from this request\'s results.json.',
        updated: todayIso(),
        note: 'Exported from the viewer. Commit this over ' +
          state.requestId + '/favorites.json to persist the selection for other browsers.'
      },
      favorite_ids: Array.from(state.favorites).sort()
    };
  }

  function writeFavoritesToHandle(handle) {
    return handle.createWritable().then(function (writable) {
      return writable.write(JSON.stringify(favoritesPayload(), null, 2) + '\n').then(function () {
        return writable.close();
      });
    });
  }

  function setFavSaveStatus(text) {
    var el = document.getElementById('favSaveStatus');
    if (el) el.textContent = text;
  }

  function updateExportButtonUi() {
    var btn = document.getElementById('exportFavBtn');
    if (!btn) return;
    if (state.favHandle) {
      btn.textContent = 'Favorites.json linked';
      btn.title = 'Auto-saving favorites straight to the linked file on disk. Click to re-save now.';
      setFavSaveStatus('Auto-saving to disk');
    } else if (FS_SUPPORTED) {
      btn.textContent = 'Link favorites.json';
      btn.title = 'Pick the favorites.json file on disk to auto-save into (Requests/' + state.requestId + '/favorites.json).';
      setFavSaveStatus('');
    } else {
      btn.textContent = 'Export favorites.json';
      btn.title = 'Download favorites.json to commit back into the repo (this browser does not support direct file save).';
      setFavSaveStatus('');
    }
  }

  // Called on request load: reattach a previously-granted handle for this
  // request without prompting, if the browser still recognizes the grant.
  function reattachFavHandle(requestId) {
    state.favHandle = null;
    if (!FS_SUPPORTED) { updateExportButtonUi(); return; }
    getStoredHandle(requestId).then(function (handle) {
      if (state.requestId !== requestId) return;
      if (!handle) { updateExportButtonUi(); return; }
      handle.queryPermission({ mode: 'readwrite' }).then(function (perm) {
        if (perm === 'granted' && state.requestId === requestId) {
          state.favHandle = handle;
        }
        updateExportButtonUi();
      }).catch(function () { updateExportButtonUi(); });
    });
  }

  // Fire-and-forget write, used after every favorite toggle so the linked
  // file always mirrors what's on screen without another click.
  function autoSaveFavorites() {
    if (!state.favHandle) return;
    writeFavoritesToHandle(state.favHandle).catch(function () {
      // Handle went stale (file moved/deleted, permission revoked outside
      // the browser) -- fall back to prompting again on the next click.
      state.favHandle = null;
      updateExportButtonUi();
    });
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  /* -------------------------------------------------------- GitHub sync
     Direct-to-git commits via GitHub's REST Contents API, called from the
     browser with a user-supplied token. The Contents API answers CORS
     preflights for browser callers, so this needs no proxy and no server --
     the token itself, not a backend, is what authorizes the write. Kept
     entirely separate from the local file-handle path above: a visitor can
     use either, neither, or both. */

  function getGithubToken() {
    try { return window.localStorage.getItem(GH_TOKEN_LS_KEY) || null; }
    catch (e) { return null; }
  }

  function setGithubToken(token) {
    try {
      if (token) window.localStorage.setItem(GH_TOKEN_LS_KEY, token);
      else window.localStorage.removeItem(GH_TOKEN_LS_KEY);
    } catch (e) { /* localStorage unavailable */ }
  }

  function githubContentsUrl(requestId) {
    return 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/' +
      'Requests/' + encodeURIComponent(requestId) + '/favorites.json';
  }

  function githubHeaders(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  // favorites.json is plain-ASCII JSON (model ids, an ISO date), but this
  // round-trip keeps btoa (latin1-only) safe even if that ever changes.
  function utf8ToBase64(str) {
    return window.btoa(unescape(encodeURIComponent(str)));
  }

  function fetchGithubSha(requestId, token) {
    return fetch(githubContentsUrl(requestId) + '?ref=' + GH_BRANCH, { headers: githubHeaders(token) })
      .then(function (r) {
        if (r.status === 404) return null; // file doesn't exist yet -- first sync will create it
        if (r.status === 401 || r.status === 403) throw new Error('GitHub rejected the token (' + r.status + ')');
        if (!r.ok) return r.text().then(function (t) { throw new Error('GitHub GET ' + r.status + ': ' + t); });
        return r.json().then(function (j) { return j.sha; });
      });
  }

  function putGithubFavorites(requestId, token, sha) {
    var body = {
      message: 'favorites: update ' + requestId + ' (via viewer)',
      content: utf8ToBase64(JSON.stringify(favoritesPayload(), null, 2) + '\n'),
      branch: GH_BRANCH
    };
    if (sha) body.sha = sha;
    var headers = githubHeaders(token);
    headers['Content-Type'] = 'application/json';
    return fetch(githubContentsUrl(requestId), { method: 'PUT', headers: headers, body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 409) return { conflict: true };
        if (r.status === 401 || r.status === 403) throw new Error('GitHub rejected the token (' + r.status + ')');
        if (!r.ok) return r.text().then(function (t) { throw new Error('GitHub PUT ' + r.status + ': ' + t); });
        return { conflict: false };
      });
  }

  // Writes for the same request_id are serialized through this queue so two
  // rapid favorite toggles can't race each other's sha (a stale sha is what
  // the Contents API's 409 means -- someone else, here just "an earlier
  // write from this same browser", touched the file first).
  var ghSyncQueue = {};

  function attemptGithubWrite(requestId, token, retriesLeft) {
    return fetchGithubSha(requestId, token).then(function (sha) {
      return putGithubFavorites(requestId, token, sha);
    }).then(function (result) {
      if (result.conflict && retriesLeft > 0) return attemptGithubWrite(requestId, token, retriesLeft - 1);
      if (result.conflict) throw new Error('GitHub write conflict -- try again');
    });
  }

  function syncFavoritesToGithub(requestId) {
    var token = getGithubToken();
    if (!token) return Promise.reject(new Error('No GitHub token configured'));
    var prior = ghSyncQueue[requestId] || Promise.resolve();
    var next = prior.catch(function () {}).then(function () { return attemptGithubWrite(requestId, token, 2); });
    ghSyncQueue[requestId] = next;
    return next;
  }

  function setGithubSyncStatus(text, isError) {
    var el = document.getElementById('ghSyncStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-error', !!isError);
  }

  function updateGithubSyncButtonUi() {
    var btn = document.getElementById('githubSyncBtn');
    if (!btn) return;
    if (getGithubToken()) {
      btn.textContent = 'GitHub sync: on';
      btn.title = 'Auto-committing favorites.json straight to GitHub on every star click. Click to reconfigure or disconnect.';
    } else {
      btn.textContent = 'Sync to GitHub';
      btn.title = 'Set up automatic commits of favorites.json straight to GitHub via a personal access token -- no backend involved.';
    }
  }

  // Fire-and-forget, used after every favorite toggle so a linked GitHub
  // token keeps the committed file mirroring what's on screen.
  function autoSyncFavoritesToGithub() {
    if (!getGithubToken()) return;
    var requestId = state.requestId;
    setGithubSyncStatus('Syncing to GitHub…');
    syncFavoritesToGithub(requestId).then(function () {
      if (state.requestId === requestId) setGithubSyncStatus('Synced to GitHub just now');
    }).catch(function (e) {
      if (state.requestId === requestId) {
        setGithubSyncStatus('GitHub sync failed: ' + (e && e.message ? e.message : 'unknown error'), true);
      }
    });
  }

  function wireGithubSyncDialog() {
    var dialog = document.getElementById('githubSyncDialog');
    var btn = document.getElementById('githubSyncBtn');
    if (!dialog || !btn) return;

    btn.addEventListener('click', function () {
      document.getElementById('githubTokenInput').value = getGithubToken() || '';
      document.getElementById('githubSyncResult').hidden = true;
      dialog.showModal();
    });

    document.getElementById('githubTokenSave').addEventListener('click', function () {
      var input = document.getElementById('githubTokenInput');
      var token = input.value.trim();
      var result = document.getElementById('githubSyncResult');
      result.hidden = false;
      result.className = 'form-result';
      if (!token) {
        result.className = 'form-result is-error';
        result.textContent = 'Paste a token first.';
        return;
      }
      setGithubToken(token);
      updateGithubSyncButtonUi();
      result.textContent = 'Saving and syncing…';
      syncFavoritesToGithub(state.requestId).then(function () {
        result.textContent = 'Connected -- favorites synced to GitHub.';
        setGithubSyncStatus('Synced to GitHub just now');
        setTimeout(function () { dialog.close(); }, 900);
      }).catch(function (e) {
        result.className = 'form-result is-error';
        result.textContent = 'Could not sync: ' + (e && e.message ? e.message : 'unknown error') +
          '. Check the token has Contents: Read and write on this repo.';
      });
    });

    document.getElementById('githubTokenDisconnect').addEventListener('click', function () {
      setGithubToken(null);
      updateGithubSyncButtonUi();
      setGithubSyncStatus('');
      document.getElementById('githubTokenInput').value = '';
      var result = document.getElementById('githubSyncResult');
      result.hidden = false;
      result.className = 'form-result';
      result.textContent = 'Disconnected. Favorites will no longer auto-sync to GitHub.';
    });
  }

  /* ------------------------------------------------------------ cell HTML */

  function nameCell(m) {
    var variant = m.model_variant ? '<br><span class="chip">' + esc(m.model_variant) + '</span>' : '';
    if (m.photo && m.photo.url) {
      return '<button type="button" class="name-btn" data-photo-id="' + esc(m.id) + '" ' +
        'title="Show photo">' + esc(m.name) + '<span class="cam">&#9673;</span></button>' + variant;
    }
    return '<strong>' + esc(m.name) + '</strong>' + variant;
  }

  function renderTax(t) {
    if (!t) return '<span class="empty-note">n/a</span>';
    if (t.status === 'known' && t.value_eur !== null && t.value_eur !== undefined) {
      var basis = t.basis ? ' title="' + esc(t.basis) + '"' : '';
      return '<span' + basis + '>' + fmtBudget(t.value_eur) + '</span>';
    }
    if (t.status === 'not_applicable') return '<span class="empty-note">n/a</span>';
    return '<span class="chip" title="Not yet determined">TBD</span>';
  }

  function renderSearchStatus(m) {
    var label = STATUS_LABELS[m.search_status] || m.search_status;
    var title = m.search_status_note ? ' title="' + esc(m.search_status_note) + '"' : '';
    return '<span class="chip"' + title + '>' + esc(label) + '</span>';
  }

  function renderRoundLog(log) {
    var rows = log.map(function (r) {
      return '<tr><td>' + esc(r.round) + '</td><td>' + esc(r.source) + '</td>' +
        '<td class="num">' + esc(r.found) + '</td><td class="num">' + esc(r.new) + '</td>' +
        '<td class="num">' + esc(r.duplicates) + '</td><td class="num">' + esc(r.dropped) + '</td>' +
        '<td>' + (r.error ? esc(r.error) : '') + '</td></tr>';
    }).join('');
    return '<details class="round-log"><summary>search log (' + log.length + ' rounds)</summary>' +
      '<table><thead><tr><th>#</th><th>source</th><th>found</th><th>new</th>' +
      '<th>dup</th><th>dropped</th><th>error</th></tr></thead><tbody>' + rows + '</tbody></table></details>';
  }

  /* Per-car detail, as opposed to the spec fields on the model row: these
     describe THIS advert, not the model. `year`, `mileage` and `fuel` come
     off the listing card and have always been captured -- they were simply
     never rendered, so 259 years and 287 mileages sat in results.json
     invisible. `colour` and `condition_notes` are read from the listing's
     own page by the enrichment step. Every one is optional and an absent
     one is not printed at all: an "n/a" per field would drown the row.

     `condition_notes` in particular: absent means the advert said nothing
     about the car's condition, NOT that the car is undamaged. Silence is
     not a clean bill of health and is never rendered as one. */
  function offeringFacts(o) {
    var bits = [];
    if (o.year) bits.push(esc(o.year));
    if (o.mileage) bits.push(esc(o.mileage));
    if (o.colour) bits.push(esc(o.colour));
    if (o.fuel) bits.push(esc(o.fuel));
    return bits.length
      ? '<span class="listing-facts">' + bits.join(' &middot; ') + '</span>' : '';
  }

  /* Marked and not muted. This started as small italic grey text, which
     made the one field that can carry bad news -- hail damage, a repaired
     accident, ex-taxi use -- the quietest thing on the row. A buyer
     scanning prices should not have to squint to find it. */
  function offeringNotes(o) {
    if (!o.condition_notes) return '';
    return '<span class="listing-note" title="Stated by the advert itself">' +
      '&#9888; ' + esc(o.condition_notes) + '</span>';
  }

  function renderOfferings(m) {
    var items = m.offerings || [];
    var log = m.offering_search_log || [];
    if (!items.length) {
      return '<span class="empty-note">none</span>' + (log.length ? renderRoundLog(log) : '');
    }
    var body = items.map(function (o) {
      var where = o.location ? esc(o.location) : esc(o.country);
      var facts = offeringFacts(o);
      return '<span class="listing"><span class="listing-price">' + fmtBudget(o.price_eur) + '</span>' +
        (facts ? ' &mdash; ' + facts : '') +
        ' &mdash; ' + where + ' (<a href="' + esc(o.url) + '" target="_blank" rel="noopener">' +
        esc(o.source_domain) + '</a>)' + offeringNotes(o) + '</span>';
    }).join('');
    /* Collapsed by default.

       This was open for a while, and the argument was a good one: an
       offering stopped being a price and a link, so folding it away made
       a row read like a table with no detail in it.

       What changed is the rest of the table. The per-offering aggregate
       columns now carry colour, year and mileage at row level
       (offeringAggregateCell), so the detail the old default existed to
       expose is already visible without opening anything — while a
       75-model request with every row expanded is several screens of
       listings between one car and the next, which is the scannability
       the original collapsed default was protecting.

       So: summary open, detail on request. The search log stays in its
       own nested, closed disclosure — that one really is diagnostics. */
    var summary = items.length + ' offering' + (items.length > 1 ? 's' : '');
    return '<details><summary>' + summary + '</summary>' + body +
      (log.length ? renderRoundLog(log) : '') + '</details>';
  }

  /* ------------------------------------------------------------- storage */

  function favKey() { return FAV_LS_PREFIX + state.requestId; }

  function loadFavoritesFromLocalStorage() {
    try {
      var raw = window.localStorage.getItem(favKey());
      if (!raw) return null;
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : null;
    } catch (e) { return null; }
  }

  function saveFavoritesToLocalStorage() {
    try { window.localStorage.setItem(favKey(), JSON.stringify(Array.from(state.favorites))); }
    catch (e) { /* localStorage unavailable (e.g. private mode) -- favorites still work this page load */ }
  }

  function loadPriceRanges() {
    try {
      var raw = window.localStorage.getItem(PRICE_LS_KEY);
      if (!raw) return DEFAULT_PRICE_RANGES.slice();
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : DEFAULT_PRICE_RANGES.slice();
    } catch (e) { return DEFAULT_PRICE_RANGES.slice(); }
  }

  function savePriceRanges() {
    try { window.localStorage.setItem(PRICE_LS_KEY, JSON.stringify(Array.from(state.priceRanges))); }
    catch (e) { /* localStorage unavailable */ }
  }

  function loadVisibleColumns() {
    var defaults = COLUMNS.filter(function (c) { return c.defaultVisible; }).map(function (c) { return c.id; });
    try {
      var raw = window.localStorage.getItem(COLS_LS_KEY);
      if (!raw) return defaults;
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : defaults;
    } catch (e) { return defaults; }
  }

  function saveVisibleColumns() {
    try { window.localStorage.setItem(COLS_LS_KEY, JSON.stringify(Array.from(state.visibleColumns))); }
    catch (e) { /* localStorage unavailable */ }
  }

  function visibleColumnDefs() {
    return COLUMNS.filter(function (c) { return state.visibleColumns.has(c.id); });
  }

  /* -------------------------------------------------------- filter / sort */

  function currentFilters() {
    return {
      q: document.getElementById('search').value.trim().toLowerCase(),
      engine: document.getElementById('engineFilter').value.trim().toLowerCase(),
      consumption: document.getElementById('consumptionFilter').value.trim().toLowerCase()
    };
  }

  function sortValue(m, key) {
    if (key === 'favorite') return state.favorites.has(m.id) ? 1 : 0;
    if (key === 'offerings_count') return (m.offerings || []).length;
    // Aggregated per-offering columns (see offeringValues): sort on the
    // first distinct value, which for the sorted list means the lowest
    // year / first colour alphabetically. Sorting a set needs a
    // representative and the smallest is the least surprising one.
    if (key.indexOf('offering:') === 0) {
      var vals = offeringValues(m, key.slice('offering:'.length));
      return vals.length ? vals[0] : null;
    }
    return m[key];
  }

  /* Distinct values of one per-offering field across a model's listings,
     sorted. A model row covers several real cars, so there is no single
     year or colour to show -- "2024, 2025" is the honest answer and a
     picked-one-at-random is not. Values are used verbatim: mileage arrives
     as the site printed it ("33 642 km", "70.449 km") and reparsing those
     into a number to average them would invent precision the cards do not
     carry. */
  function offeringValues(m, key) {
    var seen = {};
    var out = [];
    (m.offerings || []).forEach(function (o) {
      var v = o[key];
      if (v === null || v === undefined || v === '') return;
      var s = String(v);
      if (!seen[s]) { seen[s] = true; out.push(s); }
    });
    return out.sort();
  }

  function offeringAggregateCell(m, key) {
    var vals = offeringValues(m, key);
    if (!vals.length) return '';
    // Three then a count: a model with eight offerings in eight colours
    // would otherwise make its row taller than the rest of the table.
    var shown = vals.slice(0, 3).join(', ');
    return esc(shown) + (vals.length > 3
      ? ' <span class="empty-note">+' + (vals.length - 3) + '</span>' : '');
  }

  function filteredSortedModels() {
    var f = currentFilters();
    var rows = state.models.filter(function (m) {
      if (state.view === 'favorites' && !state.favorites.has(m.id)) return false;
      if (state.priceRanges.size) {
        var budget = m.average_budget_eur;
        if (budget === null || budget === undefined) return false;
        var inRange = PRICE_RANGES.some(function (r) {
          return state.priceRanges.has(r.id) && budget >= r.min && budget < r.max;
        });
        if (!inRange) return false;
      }
      if (f.q) {
        var hay = [m.name, m.brand_name, m.group_name, m.manufacturer, m.tier, m.engine,
                   m.model_variant, m.body_type].join(' ').toLowerCase();
        if (hay.indexOf(f.q) === -1) return false;
      }
      if (f.engine && (m.engine || '').toLowerCase().indexOf(f.engine) === -1) return false;
      if (f.consumption && (m.fuel_or_charge_consumption || '').toLowerCase().indexOf(f.consumption) === -1) return false;
      return true;
    });
    var key = state.sortKey, dir = state.sortDir;
    rows.sort(function (a, b) {
      var av = sortValue(a, key), bv = sortValue(b, key);
      if (av === null || av === undefined) av = dir === 1 ? Infinity : -Infinity;
      if (bv === null || bv === undefined) bv = dir === 1 ? Infinity : -Infinity;
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return rows;
  }

  function groupLabel(m, key) {
    if (key === 'roof_removable') return m.roof_removable ? 'Roof removable: yes' : 'Roof removable: no';
    if (key === 'search_status') return STATUS_LABELS[m.search_status] || m.search_status;
    var v = m[key];
    return (v === null || v === undefined || v === '') ? '(none)' : String(v);
  }

  function groupRows(rows) {
    var key = state.groupBy;
    if (!key) return [{ label: null, key: null, rows: rows }];
    var order = [], buckets = {};
    rows.forEach(function (m) {
      var label = groupLabel(m, key);
      if (!buckets[label]) { buckets[label] = []; order.push(label); }
      buckets[label].push(m);
    });
    order.sort();
    return order.map(function (label) { return { label: label, key: label, rows: buckets[label] }; });
  }

  /* -------------------------------------------------------------- render */

  function modelRowHtml(m, groupKey, cols) {
    var hidden = groupKey !== null && state.collapsedGroups.has(groupKey);
    var isFav = state.favorites.has(m.id);
    var cells = cols.map(function (col) {
      return '<td' + (col.numeric ? ' class="num"' : '') + '>' + col.cell(m) + '</td>';
    }).join('');
    return '<tr class="group-row' + (hidden ? ' hidden-row' : '') + '"' +
      (groupKey !== null ? ' data-group="' + esc(groupKey) + '"' : '') + '>' +
      '<td class="fav-col"><button type="button" class="fav-star' + (isFav ? ' is-fav' : '') +
      '" data-fav-id="' + esc(m.id) + '" aria-pressed="' + isFav + '" title="' +
      (isFav ? 'Remove from favorites' : 'Add to favorites') + '">' +
      (isFav ? '&#9733;' : '&#9734;') + '</button></td>' + cells + '</tr>';
  }

  function groupHeaderHtml(group, colCount) {
    var collapsed = state.collapsedGroups.has(group.key);
    return '<tr class="group-header" data-toggle-group="' + esc(group.key) + '">' +
      '<td colspan="' + colCount + '">' +
      '<span class="group-caret' + (collapsed ? ' collapsed' : '') + '">&#9662;</span> ' +
      esc(group.label) + ' <span class="group-count">(' + group.rows.length + ')</span>' +
      '</td></tr>';
  }

  function renderHead(cols) {
    var favTh = '<th data-key="favorite" class="fav-col" title="Favorite">&#9733;<span class="sort-indicator"></span></th>';
    var colsHtml = cols.map(function (col) {
      return '<th data-key="' + esc(col.sortKey || '') + '"' + (col.numeric ? ' class="num"' : '') +
        (!col.sortKey ? ' style="cursor:default"' : '') + '>' + esc(col.label) +
        '<span class="sort-indicator"></span></th>';
    }).join('');
    document.getElementById('tableHead').innerHTML = '<tr>' + favTh + colsHtml + '</tr>';
    wireSorting();
  }

  function render() {
    var cols = visibleColumnDefs();
    renderHead(cols);
    var rows = filteredSortedModels();
    var groups = groupRows(rows);
    var colCount = cols.length + 1;
    document.getElementById('carRows').innerHTML = groups.map(function (g) {
      var rowsHtml = g.rows.map(function (m) { return modelRowHtml(m, g.key, cols); }).join('');
      return g.label === null ? rowsHtml : groupHeaderHtml(g, colCount) + rowsHtml;
    }).join('');
    document.getElementById('count').textContent = rows.length + ' / ' +
      (state.view === 'favorites' ? state.favorites.size : state.models.length) + ' models shown' +
      (state.groupBy ? ' in ' + groups.length + ' group' + (groups.length === 1 ? '' : 's') : '');
    updateSortIndicators();
    updateFavCount();
  }

  function updateSortIndicators() {
    document.querySelectorAll('#carTable th[data-key]').forEach(function (th) {
      var key = th.getAttribute('data-key');
      var indicator = th.querySelector('.sort-indicator');
      var active = key === state.sortKey;
      th.classList.toggle('sorted', active);
      if (indicator) indicator.textContent = active ? (state.sortDir === 1 ? '▲' : '▼') : '';
    });
  }

  function updateFavCount() {
    document.getElementById('favCount').textContent = state.favorites.size;
  }

  /* -------------------------------------------------------------- wiring */

  function wireSorting() {
    document.querySelectorAll('#carTable th[data-key]').forEach(function (th) {
      var key = th.getAttribute('data-key');
      if (!key) return;
      th.addEventListener('click', function () {
        if (state.sortKey === key) { state.sortDir *= -1; } else { state.sortKey = key; state.sortDir = 1; }
        render();
      });
    });
  }

  function wireGrouping() {
    document.getElementById('groupBy').addEventListener('change', function (e) {
      state.groupBy = e.target.value;
      state.collapsedGroups.clear();
      render();
    });
  }

  // One delegated listener for everything inside the table body: group headers,
  // favorite stars and photo buttons. The tbody element itself is never
  // replaced, so this survives every re-render.
  function wireTableBody() {
    document.getElementById('carRows').addEventListener('click', function (e) {
      var header = e.target.closest('tr.group-header');
      if (header) {
        var key = header.getAttribute('data-toggle-group');
        if (state.collapsedGroups.has(key)) { state.collapsedGroups.delete(key); }
        else { state.collapsedGroups.add(key); }
        render();
        return;
      }
      var star = e.target.closest('.fav-star');
      if (star) {
        toggleFavorite(star.getAttribute('data-fav-id'));
        return;
      }
      var photoBtn = e.target.closest('[data-photo-id]');
      if (photoBtn) openPhoto(photoBtn.getAttribute('data-photo-id'));
    });
  }

  function toggleFavorite(id) {
    if (state.favorites.has(id)) { state.favorites.delete(id); } else { state.favorites.add(id); }
    saveFavoritesToLocalStorage();
    autoSaveFavorites();
    autoSyncFavoritesToGithub();
    render();
  }

  function setView(view) {
    state.view = view;
    document.getElementById('viewToggle').classList.toggle('is-favorites', view === 'favorites');
    document.getElementById('tabAll').classList.toggle('active', view === 'all');
    document.getElementById('tabAll').setAttribute('aria-selected', String(view === 'all'));
    document.getElementById('tabFavorites').classList.toggle('active', view === 'favorites');
    document.getElementById('tabFavorites').setAttribute('aria-selected', String(view === 'favorites'));
    render();
  }

  function wireViewToggle() {
    document.getElementById('tabAll').addEventListener('click', function () { setView('all'); });
    document.getElementById('tabFavorites').addEventListener('click', function () { setView('favorites'); });
  }

  function wireFilters() {
    document.getElementById('search').addEventListener('input', render);
    document.getElementById('engineFilter').addEventListener('input', render);
    document.getElementById('consumptionFilter').addEventListener('input', render);
  }

  function syncPriceFilterChips() {
    document.querySelectorAll('#filtersBar .chip-toggle').forEach(function (chip) {
      chip.classList.toggle('active', state.priceRanges.has(chip.getAttribute('data-range')));
    });
  }

  function wirePriceFilter() {
    syncPriceFilterChips();
    document.getElementById('filtersBar').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip-toggle');
      if (!chip) return;
      var id = chip.getAttribute('data-range');
      if (chip.classList.toggle('active')) { state.priceRanges.add(id); } else { state.priceRanges.delete(id); }
      savePriceRanges();
      render();
    });
  }

  function renderColumnPicker() {
    document.getElementById('colPickerPanel').innerHTML = COLUMNS.map(function (col) {
      return '<label><input type="checkbox" data-col-id="' + esc(col.id) + '"' +
        (state.visibleColumns.has(col.id) ? ' checked' : '') + '>' + esc(col.label) + '</label>';
    }).join('');
  }

  function wireColumnPicker() {
    renderColumnPicker();
    var btn = document.getElementById('colPickerBtn');
    var panel = document.getElementById('colPickerPanel');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      btn.setAttribute('aria-expanded', String(panel.classList.toggle('open')));
    });
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    panel.addEventListener('change', function (e) {
      var checkbox = e.target.closest('input[data-col-id]');
      if (!checkbox) return;
      var id = checkbox.getAttribute('data-col-id');
      if (checkbox.checked) { state.visibleColumns.add(id); } else { state.visibleColumns.delete(id); }
      saveVisibleColumns();
      render();
    });
    document.addEventListener('click', function () {
      panel.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { window.localStorage.setItem(THEME_LS_KEY, theme); } catch (e) { /* localStorage unavailable */ }
    var btn = document.getElementById('themeToggle');
    var isDark = theme === 'dark';
    btn.innerHTML = isDark ? '&#9728;' : '&#9789;';
    var label = isDark ? 'Switch to light theme' : 'Switch to dark theme';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function wireThemeToggle() {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    document.getElementById('themeToggle').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
  }

  function wireDialogs() {
    document.querySelectorAll('[data-close-dialog]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dlg = btn.closest('dialog');
        if (dlg) dlg.close();
      });
    });
  }

  /* --------------------------------------------------------- photo dialog */

  function openPhoto(id) {
    var m = state.models.filter(function (x) { return x.id === id; })[0];
    if (!m || !m.photo || !m.photo.url) return;
    document.getElementById('photoTitle').textContent = m.name;
    var img = document.getElementById('photoImage');
    img.src = m.photo.url;
    img.alt = m.name;
    var meta = [];
    if (m.model_variant) meta.push(esc(m.model_variant));
    if (m.photo.source_url) {
      meta.push('Source: <a href="' + esc(m.photo.source_url) + '" target="_blank" rel="noopener">' +
        esc(m.photo.source_url) + '</a>');
    } else {
      meta.push('Source page not recorded (' + esc(m.photo.source_kind) + ').');
    }
    meta.push('Image: <a href="' + esc(m.photo.url) + '" target="_blank" rel="noopener">open original</a>');
    document.getElementById('photoMeta').innerHTML = meta.join('<br>');
    document.getElementById('photoDialog').showModal();
  }

  /* ------------------------------------------------------ export favorites */

  function wireExportFavorites() {
    document.getElementById('exportFavBtn').addEventListener('click', function () {
      if (state.favHandle) {
        setFavSaveStatus('Saving…');
        writeFavoritesToHandle(state.favHandle).then(function () {
          setFavSaveStatus('Saved just now');
        }).catch(function () {
          state.favHandle = null;
          updateExportButtonUi();
          download('favorites.json', JSON.stringify(favoritesPayload(), null, 2) + '\n');
        });
        return;
      }
      if (!FS_SUPPORTED) {
        download('favorites.json', JSON.stringify(favoritesPayload(), null, 2) + '\n');
        return;
      }
      var requestIdAtPick = state.requestId;
      window.showSaveFilePicker({
        suggestedName: 'favorites.json',
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
      }).then(function (handle) {
        return writeFavoritesToHandle(handle).then(function () {
          return setStoredHandle(requestIdAtPick, handle);
        }).then(function () {
          if (state.requestId === requestIdAtPick) {
            state.favHandle = handle;
            updateExportButtonUi();
            setFavSaveStatus('Saved just now');
          }
        });
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return; // user cancelled the picker
        download('favorites.json', JSON.stringify(favoritesPayload(), null, 2) + '\n');
      });
    });
  }

  /* --------------------------------------------------------- request picker */

  function statusChip(status) {
    var cls = status === 'done' ? ' is-done' : (status === 'in progress' ? ' is-running' : '');
    return '<span class="status-chip' + cls + '">' + esc(status) + '</span>';
  }

  function stateLine(row) {
    // "[Group; Brand]" is DERIVED here -- the request stores it structured,
    // because resume needs the ids, not a display string.
    if (!row.search_state.group && !row.search_state.brand) return '';
    return ' &middot; [' + esc(row.search_state.group || '?') + '; ' +
      esc(row.search_state.brand || '?') + ']';
  }

  function renderRequestPicker() {
    document.getElementById('requestOptions').innerHTML = state.requests.map(function (row) {
      return '<label class="request-option">' +
        '<input type="radio" name="request" value="' + esc(row.request_id) + '"' +
        (row.request_id === state.requestId ? ' checked' : '') + '>' +
        '<span class="request-title">' + esc(row.title) + '</span>' +
        statusChip(row.status) +
        '<span class="request-meta">' + esc(row.date_of_request) + ' &middot; ' +
        row.counts.models + ' models &middot; ' + row.counts.offerings + ' offerings' +
        stateLine(row) + '</span></label>';
    }).join('');
    updateRequestSummary();
  }

  function updateRequestSummary() {
    var row = currentRow();
    document.getElementById('requestSummary').innerHTML = 'Request: ' +
      (row ? esc(row.title) + ' ' + statusChip(row.status) : '&mdash;');
  }

  function currentRow() {
    return state.requests.filter(function (r) { return r.request_id === state.requestId; })[0] || null;
  }

  function wireRequestPicker() {
    document.getElementById('requestSection').addEventListener('change', function (e) {
      var radio = e.target.closest('input[name="request"]');
      if (!radio || radio.value === state.requestId) return;
      selectRequest(radio.value);
    });
  }

  function selectRequest(requestId) {
    var row = state.requests.filter(function (r) { return r.request_id === requestId; })[0];
    if (!row) return Promise.resolve();
    state.requestId = requestId;
    try {
      history.replaceState(null, '', '#req=' + requestId);
    } catch (e) { location.hash = 'req=' + requestId; }

    var statusEl = document.getElementById('status');
    statusEl.hidden = false;
    statusEl.textContent = 'Loading ' + row.title + '…';

    return Promise.all([
      fetchJson('../' + row.request_path),
      fetchJson('../' + row.results_path),
      fetchJson('../' + row.favorites_path).catch(function () { return { favorite_ids: [] }; })
    ]).then(function (res) {
      state.request = res[0];
      state.results = res[1];
      state.models = res[1].models || [];

      // localStorage holds what this browser has clicked since its last export;
      // the committed favorites.json is the shared seed. Local wins when present.
      var seeded = Array.isArray(res[2].favorite_ids) ? res[2].favorite_ids : [];
      var local = loadFavoritesFromLocalStorage();
      state.favorites = new Set(local !== null ? local : seeded);
      reattachFavHandle(requestId);
      setGithubSyncStatus(getGithubToken() ? 'Auto-syncing to GitHub' : '');

      state.collapsedGroups.clear();
      statusEl.hidden = true;
      document.getElementById('carTable').hidden = false;
      updateRequestSummary();
      renderFooterMeta();
      render();
    });
  }

  function renderFooterMeta() {
    var meta = (state.results && state.results.metadata) || {};
    var parts = [];
    if (meta.notes && meta.notes.length) parts.push(esc(meta.notes[0]));
    if (meta.specs_disclaimer) parts.push(esc(meta.specs_disclaimer));
    if (meta.migration) {
      parts.push('Migrated from ' + esc(meta.migration.source) + ': ' +
        meta.migration.offerings_kept + ' offerings kept, ' +
        meta.migration.offerings_dropped + ' dropped (' +
        esc(Object.keys(meta.migration.drop_reasons).join(', ')) + ').');
    }
    document.getElementById('footerMeta').innerHTML = parts.join('<br><br>');
  }

  /* ------------------------------------------------------ new-request form */

  function loadBodyTypeChart() {
    var host = document.getElementById('bodyTypeChart');
    return fetch('assets/body-types.svg').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (svg) {
      // Injected inline rather than used as <img> so each silhouette is a real,
      // clickable, focusable element.
      host.innerHTML = svg;
      state.bodyTypes = Array.prototype.map.call(host.querySelectorAll('.bt-option'), function (g) {
        var label = g.querySelector('.bt-label');
        g.setAttribute('role', 'radio');
        g.setAttribute('aria-checked', 'false');
        g.setAttribute('tabindex', '0');
        return { id: g.getAttribute('data-body-type'), label: label ? label.textContent : g.id };
      });
      host.addEventListener('click', function (e) {
        var opt = e.target.closest('.bt-option');
        if (opt) selectBodyType(opt.getAttribute('data-body-type'));
      });
      host.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var opt = e.target.closest('.bt-option');
        if (!opt) return;
        e.preventDefault();
        selectBodyType(opt.getAttribute('data-body-type'));
      });
    }).catch(function (err) {
      host.innerHTML = '<p class="field-hint">Could not load the body-type chart (' +
        esc(err.message) + ').</p>';
    });
  }

  function selectBodyType(id) {
    var host = document.getElementById('bodyTypeChart');
    host.querySelectorAll('.bt-option').forEach(function (g) {
      g.setAttribute('aria-checked', String(g.getAttribute('data-body-type') === id));
    });
    host.setAttribute('data-selected', id);
    var chosen = state.bodyTypes.filter(function (b) { return b.id === id; })[0];
    document.getElementById('bodyTypeHint').textContent =
      'Selected: ' + (chosen ? chosen.label : id) + ' (' + id + ')';
  }

  function nextRequestId(bodyType) {
    var max = 0;
    state.requests.forEach(function (r) {
      var m = /^req-(\d+)-/.exec(r.request_id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var n = String(max + 1);
    while (n.length < 4) n = '0' + n;
    return 'req-' + n + '-' + bodyType;
  }

  function buildRequestPayload(bodyType, year, filter) {
    var id = nextRequestId(bodyType);
    var chosen = state.bodyTypes.filter(function (b) { return b.id === bodyType; })[0];
    return {
      request_id: id,
      payload: {
        schema_version: 1,
        request_id: id,
        title: (chosen ? chosen.label : bodyType) + ' — ' + year + '+',
        user_fields: {
          body_type: bodyType,
          not_older_than: year,
          special_filter: filter
        },
        system_fields: {
          date_of_request: todayIso(),
          status: 'tbd',
          search_state: { group_id: null, group_name: null, brand_id: null, brand_name: null },
          // Empty on purpose: the pipeline fills the checklist by reconciling
          // against Config/brands.json on its first run, so this file never
          // carries a copy that could go stale before the search even starts.
          progress: {
            groups_total: 0, groups_done: 0,
            brands_total: 0, brands_done: 0, brands_failed: 0,
            models_found: 0, groups: []
          },
          results_path: 'Requests/' + id + '/results.json',
          favorites_path: 'Requests/' + id + '/favorites.json'
        }
      }
    };
  }

  function wireRequestForm() {
    var dialog = document.getElementById('requestDialog');
    document.getElementById('newRequestBtn').addEventListener('click', function () {
      document.getElementById('requestResult').hidden = true;
      dialog.showModal();
    });

    document.getElementById('createRequestBtn').addEventListener('click', function () {
      var result = document.getElementById('requestResult');
      var bodyType = document.getElementById('bodyTypeChart').getAttribute('data-selected');
      var year = parseInt(document.getElementById('notOlderThan').value, 10);
      var filter = document.getElementById('specialFilter').value.trim();

      result.hidden = false;
      if (!bodyType) {
        result.className = 'form-result is-error';
        result.textContent = 'Pick a body type first — it is a closed set, not free text, so that two identical-looking requests search identically.';
        return;
      }
      if (!(year >= 2022)) {
        result.className = 'form-result is-error';
        result.textContent = 'Model year must be 2022 or later.';
        return;
      }

      var built = buildRequestPayload(bodyType, year, filter);
      download('request.json', JSON.stringify(built.payload, null, 2) + '\n');
      result.className = 'form-result';
      result.innerHTML = 'Created <code>' + esc(built.request_id) + '</code> and downloaded its ' +
        '<code>request.json</code>. This page is a static site with no backend, so it cannot write ' +
        'to the repository itself — commit the file to <code>Requests/' + esc(built.request_id) +
        '/request.json</code> (or hand it to the search service), and the search picks it up from there.';
    });
  }

  /* ---------------------------------------------------------------- boot */

  function showError(msg) {
    var el = document.getElementById('status');
    el.hidden = false;
    el.innerHTML = '<strong>Could not load data.</strong> ' + esc(msg) +
      '<br><br>If you opened this file directly (file://), browsers block fetch() of local files. ' +
      'Serve the repo root with a local server instead, e.g.:<br>' +
      '<code>cd CarsSearch &amp;&amp; python3 -m http.server 8000</code><br>' +
      'then open <code>http://localhost:8000/docs/</code>.';
  }

  function hideSplash() {
    var splash = document.getElementById('splash');
    if (!splash) return;
    splash.classList.add('hidden');
    setTimeout(function () { splash.remove(); }, 500);
  }

  function requestIdFromHash() {
    var m = /(?:^|[#&])req=([^&]+)/.exec(location.hash || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  state.visibleColumns = new Set(loadVisibleColumns());
  state.priceRanges = new Set(loadPriceRanges());

  wireThemeToggle();
  wireGrouping();
  wireTableBody();
  wireViewToggle();
  wireFilters();
  wireColumnPicker();
  wirePriceFilter();
  wireRequestPicker();
  wireExportFavorites();
  wireGithubSyncDialog();
  updateGithubSyncButtonUi();
  wireDialogs();
  wireRequestForm();
  loadBodyTypeChart();

  /* Config/spec_fields.json is the single declaration of every car-detail
     parameter (the pipeline reads the same file to build its extraction
     prompts and to keep results.schema.json in step). Appending a column
     per model-level field it declares is what makes adding a parameter a
     one-line change instead of a four-place one.

     Only fields COLUMNS does not already name are appended: the ones
     spelled out above have bespoke cells -- fmtBool for roof_removable
     renders an absent value as "n/a" rather than a definite "no", which a
     generic renderer would get wrong.

     A missing or malformed registry is non-fatal. The viewer's job is to
     show the data that exists; it should not go blank because a config
     file it can do without failed to load. */
  function appendRegistryColumns(registry) {
    var known = {};
    COLUMNS.forEach(function (c) { known[c.id] = c; });
    (registry.fields || []).forEach(function (f) {
      if (f.level === 'offering') {
        /* Per-car fields get a column too, not only a line inside the
           expanded Offerings cell. They were offerings-only at first, and
           that made "показать пробег и цвет" technically true and
           practically false: a parameter you have to expand a row to read
           is not in the table. The cell aggregates across the model's
           listings, because one row covers several real cars. */
        if (known[f.key]) return;
        COLUMNS.push({
          id: f.key,
          label: f.label,
          sortKey: 'offering:' + f.key,
          numeric: f.type === 'integer',
          defaultVisible: f.default_visible !== false,
          cell: function (m) { return offeringAggregateCell(m, f.key); }
        });
        known[f.key] = COLUMNS[COLUMNS.length - 1];
        return;
      }
      if (f.level !== 'model') return;
      if (known[f.key]) {
        // The column already exists with a bespoke cell renderer, which is
        // kept -- fmtBool renders an absent roof_removable as "n/a" rather
        // than a definite "no", and a generic renderer would get that
        // wrong. But whether it is shown by default is the registry's call,
        // not this file's: `doors` is declared default_visible there and was
        // hidden here, so a parameter someone deliberately asked for did not
        // appear until they went hunting in the column picker.
        known[f.key].defaultVisible = f.default_visible !== false;
        return;
      }
      COLUMNS.push({
        id: f.key,
        label: f.label,
        sortKey: f.key,
        numeric: f.type === 'integer',
        defaultVisible: f.default_visible !== false,
        cell: f.type === 'boolean'
          ? function (m) { return fmtBool(m[f.key]); }
          : function (m) { return esc(m[f.key]); }
      });
    });
  }

  fetchJson('../Config/spec_fields.json')
    .then(function (registry) {
      appendRegistryColumns(registry);
      // `wireColumnPicker()` above already rendered the picker from the
      // built-in COLUMNS, and `state.visibleColumns` was resolved from its
      // defaults. Both have to be redone now that the registry has added
      // to that list, or a newly declared parameter would exist in the
      // data and in the schema but be unreachable in the UI.
      state.visibleColumns = new Set(loadVisibleColumns());
      renderColumnPicker();
    })
    .catch(function () { /* registry absent -- the built-in columns still work */ })
    .then(function () { return fetchJson('../Requests/index.json'); })
    .then(function (index) {
      state.requests = (index.requests || []).slice().sort(function (a, b) {
        if (a.date_of_request !== b.date_of_request) return a.date_of_request < b.date_of_request ? 1 : -1;
        return a.request_id < b.request_id ? 1 : -1;
      });
      if (!state.requests.length) throw new Error('Requests/index.json lists no requests.');

      var wanted = requestIdFromHash();
      var exists = state.requests.some(function (r) { return r.request_id === wanted; });
      state.requestId = exists ? wanted : state.requests[0].request_id;
      renderRequestPicker();
      return selectRequest(state.requestId).then(renderRequestPicker);
    })
    .then(hideSplash)
    .catch(function (err) { showError(err.message); hideSplash(); });
})();
