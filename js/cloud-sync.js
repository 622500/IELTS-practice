/*!
 * IELTS Atlas · 跨设备练习记录同步（cloud-sync）
 *
 * 设计要点
 * - 只依赖 window.AppData（首屏 core-foundation 就绪即可用），不依赖 window.PracticeRecorder
 * - push：把本地全部练习记录 POST 到 /api/practice-records/import，服务端按 id + 时间戳合并（不会删掉别的设备的记录）
 * - pull：GET 服务端记录 → 与本地按 id 比对 → 只把「服务端更新 / 本地没有」的子集喂给 AppData.backups.previewImport(merge)
 *         → 覆盖前先建 pre-import 快照兜底 → commitImport → 真有变更才 reload
 * - 触发：打开页面、练习记录提交（onDataCommitted，1.5s 防抖）、页面重新可见 / 聚焦（30s 节流）、可见时每 120s 轮询
 * - 未登录（401）静默降级为纯本地模式，不打扰做题
 */
(function () {
    'use strict';

    if (typeof window === 'undefined') return;
    if (window.__ieltsCloudSyncLoaded) return;
    window.__ieltsCloudSyncLoaded = true;

    var CONFIG = {
        csrfEndpoint: '/api/auth/csrf',
        meEndpoint: '/api/auth/me',
        recordsEndpoint: '/api/practice-records',
        importEndpoint: '/api/practice-records/import',
        maxRecords: 5000,
        pushDebounceMs: 1500,
        pullThrottleMs: 30000,
        pollIntervalMs: 120000,
        reloadGuardMs: 20000,
        requestTimeoutMs: 25000,
        reloadKey: 'ielts.cloudSync.lastReload',
        disableKey: 'ielts.cloudSync.disabled'
    };

    var state = {
        ready: false,
        loggedIn: false,
        busy: false,
        pending: false,
        lastPushAt: 0,
        lastPullAt: 0,
        lastError: '',
        lastResult: 'idle'
    };

    var pushTimer = null;

    /* ------------------------------------------------------------------ 基础设施 */

    function disabled() {
        try { return window.localStorage.getItem(CONFIG.disableKey) === '1'; } catch (_) { return false; }
    }

    function appData() {
        var app = window.AppData;
        return app && typeof app === 'object' ? app : null;
    }

    function readTimestamp(record) {
        if (!record || typeof record !== 'object') return 0;
        var candidates = [record.updatedAt, record.endTime, record.timestamp, record.date, record.createdAt, record.completedAt];
        for (var i = 0; i < candidates.length; i += 1) {
            var ts = Number(new Date(candidates[i]));
            if (!Number.isNaN(ts) && ts > 0) return ts;
        }
        return 0;
    }

    function recordId(record) {
        if (!record || typeof record !== 'object') return '';
        return String(record.id || record.recordId || record.sessionId || '');
    }

    function fetchJson(url, options) {
        var opts = options || {};
        opts.credentials = 'same-origin';
        opts.headers = opts.headers || {};
        if (opts.body && !opts.headers['content-type']) opts.headers['content-type'] = 'application/json';
        opts.cache = 'no-store';
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        if (controller) opts.signal = controller.signal;
        var timer = controller ? window.setTimeout(function () { try { controller.abort(); } catch (_) {} }, CONFIG.requestTimeoutMs) : null;
        return window.fetch(url, opts).then(function (response) {
            if (timer) window.clearTimeout(timer);
            return response.text().then(function (text) {
                var data = null;
                try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
                return { ok: response.ok, status: response.status, data: data, text: text };
            });
        }, function (error) {
            if (timer) window.clearTimeout(timer);
            throw error;
        });
    }

    /* ------------------------------------------------------------------ 状态条 */

    var pill = null;

    function ensurePill() {
        if (pill || !document || !document.body) return pill;
        pill = document.createElement('div');
        pill.id = 'ielts-cloud-sync-status';
        pill.setAttribute('role', 'status');
        pill.setAttribute('aria-live', 'polite');
        pill.style.cssText = [
            'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483000',
            'display:flex', 'align-items:center', 'gap:6px',
            'padding:6px 10px', 'border-radius:999px',
            'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif',
            'color:#e8eaf0', 'background:rgba(20,22,30,.82)', 'backdrop-filter:blur(8px)',
            'border:1px solid rgba(255,255,255,.12)', 'box-shadow:0 6px 20px rgba(0,0,0,.35)',
            'opacity:0', 'transition:opacity .25s ease', 'pointer-events:none', 'user-select:none'
        ].join(';');
        pill.innerHTML = '<span data-dot style="width:7px;height:7px;border-radius:50%;background:#6b7280;display:inline-block"></span><span data-text>同步待命</span>';
        document.body.appendChild(pill);
        return pill;
    }

    var hideTimer = null;

    function setStatus(kind, text, options) {
        var node = ensurePill();
        state.lastResult = kind;
        if (!node) return;
        var dot = node.querySelector('[data-dot]');
        var label = node.querySelector('[data-text]');
        var colors = { syncing: '#f59e0b', ok: '#22c55e', error: '#ef4444', idle: '#6b7280', off: '#6b7280' };
        if (dot) dot.style.background = colors[kind] || colors.idle;
        if (label) label.textContent = text;
        node.style.opacity = '1';
        if (hideTimer) { window.clearTimeout(hideTimer); hideTimer = null; }
        var stay = options && options.sticky;
        if (!stay) {
            hideTimer = window.setTimeout(function () {
                if (pill) pill.style.opacity = '0';
            }, kind === 'error' ? 6000 : 2600);
        }
    }

    /* ------------------------------------------------------------------ 服务端交互 */

    function loadSession() {
        return fetchJson(CONFIG.meEndpoint, { method: 'GET' }).then(function (res) {
            if (res.ok && res.data && res.data.user) {
                state.loggedIn = true;
                return { user: res.data.user, csrfToken: res.data.csrfToken || '' };
            }
            state.loggedIn = false;
            return null;
        }).catch(function () {
            state.loggedIn = false;
            return null;
        });
    }

    function withCsrf(session, run) {
        return run(session && session.csrfToken ? session.csrfToken : '').then(function (res) {
            if (res && res.status === 403 && res.data && /csrf/i.test(String(res.data.error || ''))) {
                return loadSession().then(function (fresh) {
                    if (!fresh) return res;
                    session.csrfToken = fresh.csrfToken;
                    return run(fresh.csrfToken);
                });
            }
            return res;
        });
    }

    function localRecords() {
        var app = appData();
        if (!app) return Promise.resolve([]);
        return Promise.resolve(app.practice.list({ projection: 'full' })).then(function (records) {
            var list = Array.isArray(records) ? records : [];
            if (list.length <= CONFIG.maxRecords) return list;
            var sorted = list.slice().sort(function (a, b) { return readTimestamp(b) - readTimestamp(a); });
            if (window.console && console.warn) {
                console.warn('[cloud-sync] 本地练习记录 ' + list.length + ' 条，超过单次上限 ' + CONFIG.maxRecords + '，只同步最近的部分');
            }
            return sorted.slice(0, CONFIG.maxRecords);
        }).catch(function () { return []; });
    }

    function push(session) {
        if (!session || !session.user) return Promise.resolve({ pushed: 0 });
        return localRecords().then(function (records) {
            if (!records.length) return { pushed: 0 };
            return withCsrf(session, function (token) {
                return fetchJson(CONFIG.importEndpoint, {
                    method: 'POST',
                    headers: { 'x-csrf-token': token || '' },
                    body: JSON.stringify({ records: records })
                });
            }).then(function (res) {
                if (!res.ok) throw new Error('push failed: HTTP ' + res.status + ' ' + (res.data && res.data.error ? res.data.error : ''));
                state.lastPushAt = Date.now();
                return { pushed: records.length };
            });
        });
    }

    function shouldImport(serverRecord, localMap) {
        var id = recordId(serverRecord);
        if (!id) return false;
        var mine = localMap.get(id);
        if (!mine) return true;
        return readTimestamp(serverRecord) > readTimestamp(mine);
    }

    function pull(session) {
        var app = appData();
        if (!app || !session || !session.user) return Promise.resolve({ imported: 0 });
        return fetchJson(CONFIG.recordsEndpoint, { method: 'GET' }).then(function (res) {
            if (!res.ok) throw new Error('pull failed: HTTP ' + res.status);
            var records = res.data && Array.isArray(res.data.records) ? res.data.records : [];
            if (!records.length) return { imported: 0, total: 0 };
            return localRecords().then(function (locally) {
                var localMap = new Map();
                locally.forEach(function (record) {
                    var id = recordId(record);
                    if (id) localMap.set(id, record);
                });
                var need = records.filter(function (record) { return shouldImport(record, localMap); });
                if (!need.length) return { imported: 0, total: records.length };
                return Promise.resolve(app.backups.previewImport({ records: need }, { practiceMode: 'merge' })).then(function (plan) {
                    if (!plan || !plan.id) return { imported: 0, total: records.length };
                    return Promise.resolve(app.backups.create({ type: 'pre-import' })).catch(function () { return null; }).then(function () {
                        return app.backups.commitImport(plan.id, { confirmDestructive: plan.destructive === true });
                    }).then(function () {
                        return { imported: need.length, total: records.length, plan: plan };
                    });
                });
            });
        });
    }

    /* ------------------------------------------------------------------ 同步主流程 */

    function canReload() {
        try {
            var last = Number(window.sessionStorage.getItem(CONFIG.reloadKey) || 0);
            return !(last && (Date.now() - last) < CONFIG.reloadGuardMs);
        } catch (_) {
            return true;
        }
    }

    function markReload() {
        try { window.sessionStorage.setItem(CONFIG.reloadKey, String(Date.now())); } catch (_) {}
    }

    function syncOnce(reason) {
        if (disabled() || !state.ready) return Promise.resolve();
        if (state.busy) { state.pending = true; return Promise.resolve(); }
        state.busy = true;
        state.pending = false;
        setStatus('syncing', '同步中…', { sticky: true });
        return loadSession().then(function (session) {
            if (!session) {
                setStatus('off', '未登录 · 仅本地', {});
                state.busy = false;
                return null;
            }
            return push(session).catch(function (error) {
                state.lastError = String(error && error.message || error);
                return { pushed: 0, error: state.lastError };
            }).then(function (pushResult) {
                return pull(session).then(function (pullResult) {
                    state.lastPullAt = Date.now();
                    state.busy = false;
                    var pushed = pushResult && pushResult.pushed ? pushResult.pushed : 0;
                    var imported = pullResult && pullResult.imported ? pullResult.imported : 0;
                    if (imported > 0) {
                        setStatus('ok', '已从云端拉取 ' + imported + ' 条', { sticky: true });
                        if (canReload()) {
                            markReload();
                            window.setTimeout(function () { window.location.reload(); }, 600);
                        }
                    } else if (pushed > 0) {
                        setStatus('ok', '已上传 ' + pushed + ' 条', {});
                    } else {
                        setStatus('ok', '已是最新', {});
                    }
                    if (state.pending) { state.pending = false; schedulePush('queued'); }
                    return { pushed: pushed, imported: imported, reason: reason };
                });
            }).catch(function (error) {
                state.busy = false;
                state.lastError = String(error && error.message || error);
                setStatus('error', '同步失败：' + state.lastError.slice(0, 40), {});
                return null;
            });
        });
    }

    function schedulePush(reason) {
        if (disabled() || !state.ready) return;
        if (pushTimer) window.clearTimeout(pushTimer);
        pushTimer = window.setTimeout(function () {
            pushTimer = null;
            syncOnce(reason || 'commit');
        }, CONFIG.pushDebounceMs);
    }

    function throttledPull(reason) {
        if (disabled() || !state.ready) return;
        if (Date.now() - state.lastPullAt < CONFIG.pullThrottleMs) return;
        syncOnce(reason);
    }

    function isPracticeTarget(event) {
        if (!event) return false;
        var targets = Array.isArray(event.targets) ? event.targets : [];
        if (!targets.length) return true;
        return targets.some(function (target) {
            var name = typeof target === 'string' ? target : (target && (target.store || target.logicalKey || target.name) || '');
            return /practice/i.test(String(name));
        });
    }

    /* ------------------------------------------------------------------ 启动 */

    function start() {
        var app = appData();
        if (!app) return;
        Promise.resolve(app.ready).then(function () {
            state.ready = true;
            if (disabled()) { setStatus('off', '同步已关闭', {}); return; }

            if (typeof app.backups.onDataCommitted === 'function') {
                try {
                    app.backups.onDataCommitted(function (event) {
                        if (isPracticeTarget(event)) schedulePush('commit');
                    });
                } catch (_) {}
            }

            if (document && typeof document.addEventListener === 'function') {
                document.addEventListener('visibilitychange', function () {
                    if (document.visibilityState === 'visible') throttledPull('visible');
                });
            }
            if (typeof window.addEventListener === 'function') {
                window.addEventListener('focus', function () { throttledPull('focus'); });
                window.addEventListener('online', function () { throttledPull('online'); });
                window.addEventListener('beforeunload', function () {
                    if (pushTimer) { window.clearTimeout(pushTimer); pushTimer = null; }
                });
            }

            if (typeof window.setInterval === 'function') {
                window.setInterval(function () {
                    if (document.visibilityState === 'visible') throttledPull('poll');
                }, CONFIG.pollIntervalMs);
            }

            window.setTimeout(function () { syncOnce('boot'); }, 1200);
        }).catch(function () {
            state.ready = false;
        });
    }

    window.CloudSync = {
        syncNow: function (reason) { return syncOnce(reason || 'manual'); },
        push: function () { return loadSession().then(function (session) { return session ? push(session) : { pushed: 0 }; }); },
        pull: function () { return loadSession().then(function (session) { return session ? pull(session) : { imported: 0 }; }); },
        status: function () { return Object.assign({}, state); },
        disable: function () { try { window.localStorage.setItem(CONFIG.disableKey, '1'); } catch (_) {} setStatus('off', '同步已关闭', {}); },
        enable: function () { try { window.localStorage.removeItem(CONFIG.disableKey); } catch (_) {} syncOnce('enable'); }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
