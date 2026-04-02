const CACHE_NAME = 'focusos-matrix-v4';

const APP_SHELL = [
    '/index.html',
    '/login.html',
    '/home.html',
    '/planner.html',
    '/habits.html',
    '/themes.css',
    '/matrix-engine.js',
    '/manifest.json'
];

const CDN_RESOURCES = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
    'https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.js',
    'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js'
];

// ── INSTALL: Cache app shell immediately, CDN in background ───────────────
self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            // Cache local files — these MUST succeed
            try {
                await cache.addAll(APP_SHELL);
            } catch (err) {
                console.warn('[SW] Some shell files failed:', err);
                // Try individually so one failure doesn't block all
                for (const url of APP_SHELL) {
                    try { await cache.add(url); } catch(e) { console.warn('[SW] Failed:', url); }
                }
            }
            // Cache CDN resources best-effort — never block install
            for (const url of CDN_RESOURCES) {
                try {
                    const res = await fetch(url, { cache: 'no-cache' });
                    if (res.ok) await cache.put(url, res);
                } catch (e) { /* will retry when online */ }
            }
        })
    );
});

// ── ACTIVATE: Clean old caches ─────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    self.clients.claim();
    event.waitUntil(
        caches.keys().then(names =>
            Promise.all(names.map(n => n !== CACHE_NAME ? caches.delete(n) : null))
        )
    );
});

// ── FETCH ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Never intercept API calls, auth, or external services
    if (
        url.hostname.includes('supabase.co') ||
        url.hostname.includes('workers.dev') ||
        url.hostname.includes('actions.google.com') ||
        event.request.method !== 'GET'
    ) return;

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(event.request, { ignoreSearch: true });

            if (cached) {
                // Stale-while-revalidate
                if (navigator.onLine !== false) {
                    event.waitUntil(
                        fetch(event.request).then(res => {
                            if (res && res.ok) cache.put(event.request, res.clone());
                        }).catch(() => {})
                    );
                }
                return cached;
            }

            // Not cached — fetch from network
            try {
                const res = await fetch(event.request);
                if (res && res.ok) cache.put(event.request, res.clone());
                return res;
            } catch (err) {
                // Offline fallback for navigation
                if (event.request.mode === 'navigate') {
                    const fallback = await cache.match('/index.html', { ignoreSearch: true });
                    if (fallback) return fallback;
                }
                return new Response('Offline', { status: 503 });
            }
        })
    );
});

// ── MESSAGES ───────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
    if (event.data === 'CACHE_CDN') {
        caches.open(CACHE_NAME).then(async (cache) => {
            for (const url of CDN_RESOURCES) {
                try {
                    const res = await fetch(url);
                    if (res.ok) await cache.put(url, res);
                } catch (e) {}
            }
        });
    }
});
