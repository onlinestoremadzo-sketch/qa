/* MADZO offline layer.
 * - Every data read (Supabase /rest/v1 GET) is saved on this device; when there is no internet the saved copy is shown.
 * - In the admin, changes made offline (add / edit / delete) are queued on the device, shown immediately,
 *   and sent to the server automatically, in the same order, when the internet returns.
 * - Login/auth, file uploads and server counters (rpc) always need internet.
 */
(function () {
  if (window.madzoOffline) return; // already loaded (the page framework can run scripts twice)
  var nativeFetch = window.fetch.bind(window);
  var QUEUE_ON = /admin/i.test(location.pathname);
  var DB_NAME = 'madzo-offline', DB;
  var state = { offline: !navigator.onLine, syncing: false, failed: 0, pending: 0, needLogin: false };
  var tempId = 0;

  /* ---------- tiny IndexedDB helper ---------- */
  function open() {
    if (DB) return DB;
    DB = new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore('cache');
        d.createObjectStore('queue', { autoIncrement: true });
        d.createObjectStore('failed', { autoIncrement: true });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return DB;
  }
  function tx(store, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  function getAll(store) {
    return open().then(function (d) {
      return new Promise(function (res, rej) {
        var out = [], c = d.transaction(store, 'readonly').objectStore(store).openCursor();
        c.onsuccess = function () { var cur = c.result; if (cur) { out.push({ key: cur.key, value: cur.value }); cur.continue(); } else res(out); };
        c.onerror = function () { rej(c.error); };
      });
    });
  }
  function safe(p) { return p.catch(function () {}); }

  /* ---------- helpers ---------- */
  function hget(h, name) {
    if (!h) return '';
    if (typeof h.get === 'function') return h.get(name) || '';
    for (var k in h) if (k.toLowerCase() === name.toLowerCase()) return h[k];
    return '';
  }
  function hobj(h) {
    var o = {};
    if (!h) return o;
    if (typeof h.forEach === 'function' && typeof h.get === 'function') h.forEach(function (v, k) { o[k] = v; });
    else for (var k in h) o[k] = h[k];
    return o;
  }
  function isNetErr(e) { return e && (e.name === 'TypeError' || /fetch|network|load failed/i.test(e.message || '')); }
  function tableOf(u) { return new URL(u, location.href).pathname.split('/rest/v1/')[1] || ''; }
  function filtersOf(u) {
    var out = [], sp = new URL(u, location.href).searchParams;
    sp.forEach(function (v, k) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].indexOf(k) > -1) return;
      out.push([k, v]);
    });
    return out;
  }
  function matcher(filters) {
    return function (row) {
      for (var i = 0; i < filters.length; i++) {
        var k = filters[i][0], v = filters[i][1], cell = String(row[k]);
        if (v.indexOf('eq.') === 0) { if (cell !== v.slice(3)) return false; }
        else if (v.indexOf('in.(') === 0) {
          var list = v.slice(4, -1).split(',').map(function (x) { return x.replace(/^"|"$/g, ''); });
          if (list.indexOf(cell) < 0) return false;
        } else return false; // unknown operator: do not touch the saved copy
      }
      return true;
    };
  }

  /* ---------- status pill ---------- */
  var pill, panel;
  function ui() {
    if (!document.body) return;
    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button';
      pill.setAttribute('style', 'position:fixed;left:12px;bottom:12px;z-index:99999;border:0;border-radius:999px;padding:9px 14px;font:600 12px Poppins,Arial,sans-serif;color:#fff;background:#461610;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;display:none;max-width:calc(100vw - 24px)');
      pill.addEventListener('click', togglePanel);
      pill.id = 'madzo-offline-pill';
      document.documentElement.appendChild(pill);
    }
    var txt = '', bg = '#461610';
    if (state.failed) { txt = '⚠ ' + state.failed + ' change' + (state.failed > 1 ? 's' : '') + ' could not sync — tap'; bg = '#b3261e'; }
    else if (state.syncing) { txt = 'Syncing ' + state.pending + ' change' + (state.pending > 1 ? 's' : '') + '…'; bg = '#2e6b3a'; }
    else if (state.offline) { txt = 'Offline — saved data' + (state.pending ? ' · ' + state.pending + ' waiting to sync' : ''); bg = '#7a5a00'; }
    else if (state.pending) { txt = state.needLogin ? state.pending + ' waiting — sign in again to sync' : state.pending + ' waiting to sync — tap'; bg = '#7a5a00'; }
    pill.style.display = txt ? 'block' : 'none';
    pill.style.background = bg;
    pill.textContent = txt;
    if (panel && panel.parentNode) renderPanel();
  }
  function togglePanel() {
    if (panel && panel.parentNode) { panel.parentNode.removeChild(panel); return; }
    if (!state.failed && state.offline) return;
    panel = document.createElement('div');
    panel.setAttribute('style', 'position:fixed;left:12px;bottom:58px;z-index:99999;background:#fff;color:#222;border-radius:12px;padding:14px;width:min(380px,calc(100vw - 24px));max-height:60vh;overflow:auto;font:13px Poppins,Arial,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)');
    document.documentElement.appendChild(panel);
    renderPanel();
  }
  function renderPanel() {
    Promise.all([getAll('queue'), getAll('failed')]).then(function (r) {
      var q = r[0], f = r[1], h = '';
      h += '<div style="font-weight:600;margin-bottom:8px">Offline changes</div>';
      h += '<div style="margin-bottom:8px">' + q.length + ' waiting to sync · ' + f.length + ' could not sync</div>';
      f.forEach(function (it) {
        var v = it.value;
        h += '<div style="border-top:1px solid #eee;padding:8px 0"><b>' + esc(v.method) + ' ' + esc(v.table) + '</b><br><span style="color:#b3261e">' + esc(v.error || '') + '</span></div>';
      });
      h += '<div style="display:flex;gap:8px;margin-top:10px">';
      if (q.length || f.length) h += '<button data-a="retry" style="flex:1;padding:8px;border:0;border-radius:8px;background:#461610;color:#fff;font-weight:600;cursor:pointer">Retry now</button>';
      if (f.length) h += '<button data-a="discard" style="flex:1;padding:8px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer">Discard failed</button>';
      h += '</div>';
      panel.innerHTML = h;
      var b = panel.querySelectorAll('button');
      for (var i = 0; i < b.length; i++) b[i].onclick = function (e) {
        var a = e.target.getAttribute('data-a');
        if (a === 'retry') { retryFailed().then(flush); }
        if (a === 'discard') { tx('failed', 'readwrite', function (s) { s.clear(); }).then(refreshCounts).then(function () { if (panel.parentNode) panel.parentNode.removeChild(panel); }); }
      };
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function refreshCounts() {
    return Promise.all([getAll('queue'), getAll('failed')]).then(function (r) {
      state.pending = r[0].length; state.failed = r[1].length; ui();
    }, function () {});
  }
  function retryFailed() {
    return getAll('failed').then(function (f) {
      return Promise.all(f.map(function (it) {
        return tx('queue', 'readwrite', function (s) { s.add(it.value.req); }).then(function () { return tx('failed', 'readwrite', function (s) { s.delete(it.key); }); });
      }));
    }).then(refreshCounts);
  }

  /* ---------- read cache ---------- */
  function cacheKey(method, url, init) {
    return method + ' ' + url + '|' + hget(init && init.headers, 'accept') + '|' + hget(init && init.headers, 'prefer');
  }
  function readThrough(input, init, url, method) {
    var key = cacheKey(method, url, init);
    var live = navigator.onLine ? Promise.race([
      nativeFetch(input, init),
      new Promise(function (_, rej) { setTimeout(function () { rej(new TypeError('timeout')); }, 25000); })
    ]) : Promise.reject(new TypeError('offline'));
    return live.then(function (res) {
      setOffline(false);
      // A request sent without a signed-in user (token still refreshing) gets an empty list for private tables.
      // Never let that wipe the saved copy; show the saved data instead.
      var auth = hget(init && init.headers, 'authorization'), key0 = hget(init && init.headers, 'apikey');
      if (QUEUE_ON && res.ok && method === 'GET' && (!auth || auth === 'Bearer ' + key0)) {
        return res.clone().text().then(function (t) {
          if (t.replace(/\s/g, '') !== '[]') return store(res);
          return new Promise(function (ok) {
            open().then(function (d) { var r = d.transaction('cache', 'readonly').objectStore('cache').get(key); r.onsuccess = function () { ok(r.result); }; r.onerror = function () { ok(null); }; });
          }).then(function (hit) {
            if (hit && hit.body.replace(/\s/g, '') !== '[]') return new Response(hit.body, { status: hit.status, headers: hit.headers });
            return res;
          });
        });
      }
      return store(res);
      function store(res) {
      if (res.ok) {
        var c = res.clone();
        c.text().then(function (body) {
          var h = {}; ['content-type', 'content-range'].forEach(function (n) { var v = c.headers.get(n); if (v) h[n] = v; });
          safe(tx('cache', 'readwrite', function (s) { s.put({ status: c.status, headers: h, body: body, t: Date.now() }, key); }));
        });
      }
      return res;
      }
    }, function (err) {
      if (!isNetErr(err)) throw err;
      setOffline(true);
      return open().then(function (d) {
        return new Promise(function (res) {
          var r = d.transaction('cache', 'readonly').objectStore('cache').get(key);
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { res(null); };
        });
      }).then(function (hit) {
        if (!hit) throw err;
        return new Response(method === 'HEAD' ? null : hit.body, { status: hit.status, headers: hit.headers });
      });
    });
  }

  /* ---------- queued writes ---------- */
  function applyToCache(table, method, filters, rows, prefer, conflict) {
    var match = matcher(filters), changed = [];
    return getAll('cache').then(function (all) {
      var jobs = [];
      all.forEach(function (e) {
        if (e.key.indexOf('GET ') !== 0) return;
        var u = e.key.slice(4).split('|')[0];
        if (tableOf(u) !== table) return;
        var list;
        try { list = JSON.parse(e.value.body); } catch (x) { return; }
        if (!Array.isArray(list)) return;
        var out = list;
        if (method === 'POST') {
          out = list.slice();
          rows.forEach(function (r) {
            var idx = -1;
            if (/merge-duplicates/.test(prefer)) {
              var col = conflict || 'id';
              for (var i = 0; i < out.length; i++) if (String(out[i][col]) === String(r[col])) { idx = i; break; }
            }
            if (idx > -1) out[idx] = Object.assign({}, out[idx], r); else out.push(r);
          });
        } else if (method === 'PATCH') {
          out = list.map(function (row) { return match(row) ? Object.assign({}, row, rows[0]) : row; });
        } else if (method === 'DELETE') {
          out = list.filter(function (row) { return !match(row); });
        }
        var v = Object.assign({}, e.value, { body: JSON.stringify(out) });
        jobs.push(tx('cache', 'readwrite', function (s) { s.put(v, e.key); }));
      });
      return Promise.all(jobs);
    });
  }
  function queueWrite(url, init, method) {
    var table = tableOf(url), prefer = hget(init.headers, 'prefer'), accept = hget(init.headers, 'accept');
    var body = init.body ? JSON.parse(init.body) : null;
    var filters = filtersOf(url), conflict = new URL(url, location.href).searchParams.get('on_conflict');
    var rows = body ? (Array.isArray(body) ? body : [body]) : [];
    if (method === 'POST') {
      rows = rows.map(function (r) { if (r.id === undefined || r.id === null) { r = Object.assign({}, r); r.id = -(Date.now() * 100 + (tempId++ % 100)); } return r; });
    }
    var req = { method: method, url: url, table: table, headers: hobj(init.headers), body: init.body || null };
    delete req.headers.authorization; delete req.headers.Authorization;
    return tx('queue', 'readwrite', function (s) { s.add(req); })
      .then(function () { return applyToCache(table, method, filters, rows, prefer, conflict); })
      .then(refreshCounts)
      .then(function () {
        var wantRows = /return=representation/.test(prefer);
        if (method === 'PATCH' || method === 'DELETE') {
          if (wantRows && method === 'PATCH') {
            var m = matcher(filters);
            return getAll('cache').then(function (all) {
              var found = [];
              all.forEach(function (e) {
                if (e.key.indexOf('GET ') !== 0 || tableOf(e.key.slice(4).split('|')[0]) !== table || found.length) return;
                try { JSON.parse(e.value.body).forEach(function (r) { if (m(r)) found.push(r); }); } catch (x) {}
              });
              return mkResp(200, found, accept);
            });
          }
          return new Response(null, { status: 204 });
        }
        if (wantRows) return mkResp(201, rows, accept);
        return new Response(null, { status: 201 });
      });
  }
  function mkResp(status, rows, accept) {
    var single = /vnd\.pgrst\.object/.test(accept);
    return new Response(JSON.stringify(single ? (rows[0] || null) : rows), { status: status, headers: { 'content-type': 'application/json' } });
  }

  /* ---------- sync ---------- */
  var flushing = false;
  function token() {
    try {
      var sb = window.getSupabase && window.getSupabase();
      return sb.auth.getSession().then(function (r) { return r && r.data && r.data.session ? r.data.session.access_token : null; }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function flush() {
    if (!QUEUE_ON || flushing || !navigator.onLine) return Promise.resolve();
    flushing = true;
    return getAll('queue').then(function (q) {
      if (!q.length) { flushing = false; return; }
      state.syncing = true; state.pending = q.length; ui();
      return token().then(function (tk) {
        if (!tk) { state.needLogin = true; return; }
        state.needLogin = false;
        var synced = 0;
        function next(i) {
          if (i >= q.length) return;
          var it = q[i], r = it.value, h = Object.assign({}, r.headers, { Authorization: 'Bearer ' + tk });
          return nativeFetch(r.url, { method: r.method, headers: h, body: r.body }).then(function (res) {
            if (res.ok) { synced++; return tx('queue', 'readwrite', function (s) { s.delete(it.key); }).then(function () { return next(i + 1); }); }
            if (res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500) { if (res.status === 401) state.needLogin = true; return; }
            return res.text().then(function (t) {
              var msg = t; try { msg = JSON.parse(t).message || t; } catch (x) {}
              return tx('failed', 'readwrite', function (s) { s.add({ method: r.method, table: r.table, error: msg, req: r }); })
                .then(function () { return tx('queue', 'readwrite', function (s) { s.delete(it.key); }); })
                .then(function () { return next(i + 1); });
            });
          }).catch(function (e) { if (!isNetErr(e)) throw e; setOffline(true); });
        }
        return next(0).then(function () { if (synced) fire('madzo-synced'); });
      });
    }).catch(function () {}).then(function () {
      flushing = false; state.syncing = false; return refreshCounts();
    });
  }
  function fire(n) { try { window.dispatchEvent(new Event(n)); } catch (e) {} }
  function setOffline(v) {
    if (state.offline === v) return;
    state.offline = v; ui();
    if (!v) { flush().then(function () { fire('madzo-online'); }); }
  }

  /* ---------- the fetch the Supabase client uses ---------- */
  function wfetch(input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = (init.method || (input && input.method) || 'GET').toUpperCase();
    if (url.indexOf('/rest/v1/') < 0) return nativeFetch(input, init);
    var isRpc = url.indexOf('/rest/v1/rpc/') > -1;
    if (isRpc) return nativeFetch(input, init);
    if (method === 'GET' || method === 'HEAD') return readThrough(input, init, url, method);
    if (!QUEUE_ON) return nativeFetch(input, init);
    // a write: keep order — if older changes are still waiting, join the queue
    return getAll('queue').then(function (q) {
      if (!q.length && navigator.onLine) {
        return nativeFetch(input, init).catch(function (e) {
          if (!isNetErr(e)) throw e;
          setOffline(true);
          return queueWrite(url, init, method);
        });
      }
      return queueWrite(url, init, method).then(function (r) { if (navigator.onLine) flush(); return r; });
    });
  }

  function hasStoredSession() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/^sb-.*-auth-token$/.test(k)) { var v = JSON.parse(localStorage.getItem(k)); if (v && (v.refresh_token || (v.currentSession && v.currentSession.refresh_token))) return true; }
      }
    } catch (e) {}
    return false;
  }

  window.madzoOffline = { fetch: wfetch, flush: flush, hasStoredSession: hasStoredSession, state: state, _nativeFetch: nativeFetch };
  window.addEventListener('online', function () { state.offline = false; ui(); flush().then(function () { fire('madzo-online'); }); });
  window.addEventListener('offline', function () { state.offline = true; ui(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) flush(); });
  setInterval(flush, 30000);
  function boot() { refreshCounts().then(flush); ui(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
