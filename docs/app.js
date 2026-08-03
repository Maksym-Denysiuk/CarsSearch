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
  var COLS_LS_KEY = 'carResearchColumns.v2';
  var PRICE_LS_KEY = 'carResearchPriceRanges';
  var THEME_LS_KEY = 'carResearchTheme';

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
    favorites: new Set(), view: 'all',
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

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
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

  function renderOfferings(m) {
    var items = m.offerings || [];
    var log = m.offering_search_log || [];
    if (!items.length) {
      return '<span class="empty-note">none</span>' + (log.length ? renderRoundLog(log) : '');
    }
    var body = items.map(function (o) {
      var where = o.location ? esc(o.location) : esc(o.country);
      return '<span class="listing"><span class="listing-price">' + fmtBudget(o.price_eur) + '</span>' +
        ' &mdash; ' + where + ' (<a href="' + esc(o.url) + '" target="_blank" rel="noopener">' +
        esc(o.source_domain) + '</a>)</span>';
    }).join('');
    return '<details><summary>' + items.length + ' offering' + (items.length > 1 ? 's' : '') +
      '</summary>' + body + (log.length ? renderRoundLog(log) : '') + '</details>';
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
    return m[key];
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
      var payload = {
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
      download('favorites.json', JSON.stringify(payload, null, 2) + '\n');
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
  wireDialogs();
  wireRequestForm();
  loadBodyTypeChart();

  fetchJson('../Requests/index.json')
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
