/* シフト管理 — Service Worker
 *
 * ・アプリ本体（HTML・マニフェスト・アイコン）を保存して、通信できなくても起動できるようにする
 * ・本体は「保存済みをすぐ表示 → 裏で最新を確認」。変わっていたら画面に「更新があります」を出す
 * ・PDF用ライブラリ・フォント・Firebase SDK は、一度読み込んだら保存してオフラインでも使えるようにする
 * ・ログイン（Firebase Auth）や Firestore の通信は一切キャッシュしない
 *
 * sw.js を書き換えたら VERSION を上げてください（古いキャッシュが自動で削除されます）。
 */
const VERSION = "2026-09-24-5";
const SHELL_CACHE = "shift-shell-" + VERSION;
const RUNTIME_CACHE = "shift-runtime-" + VERSION;

const SHELL_URL = new URL("./", self.location).href;           // index.html
const SHELL_FILES = [
  "./",
  "./manifest.webmanifest",
  "./icon-192.png?v=2",
  "./icon-512.png?v=2",
  "./icon-maskable-192.png?v=2",
  "./icon-maskable-512.png?v=2",
  "./apple-touch-icon.png?v=2"
];

// オフラインでもPDF出力・ログイン画面が動くよう、インストール時に先読みしておく外部ファイル（失敗しても無視）
const WARM_URLS = [
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js",
  "https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js"
];

// 保存してよい外部ホスト（静的ファイルのみ）
const CACHEABLE_HOSTS = new Set([
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "www.gstatic.com"
]);
const RUNTIME_MAX_ENTRIES = 120;

// ---------- install ----------
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // 本体（./）だけは必須。アイコン等は1つずつ保存し、見つからなくてもインストールを止めない
    await shell.add(new Request("./", { cache: "reload" }));
    await Promise.all(SHELL_FILES.filter((u) => u !== "./").map(async (u) => {
      try { await shell.add(new Request(u, { cache: "reload" })); }
      catch (e) { console.warn("[sw] 保存できませんでした:", u, e); }
    }));

    const runtime = await caches.open(RUNTIME_CACHE);
    await Promise.all(WARM_URLS.map(async (u) => {
      try {
        const res = await fetch(u, { mode: "cors", credentials: "omit" });
        if (res.ok) await runtime.put(u, res);
      } catch (e) { /* オフラインや取得失敗は無視 */ }
    }));
  })());
  // 初回インストール時はすぐ有効化。更新時は画面の「更新する」ボタン（SKIP_WAITING）を待つ
});

// ---------- activate ----------
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith("shift-") && k !== SHELL_CACHE && k !== RUNTIME_CACHE && k !== SHARE_INBOX)
      .map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) {}
    }
    await self.clients.claim();
  })());
});

// ---------- messages from the page ----------
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "CHECK_SHELL") event.waitUntil(refreshShell(true));
});

// ---------- Android の共有メニューから届いたバックアップファイル（manifest の share_target）----------
const SHARE_INBOX = "shift-share-inbox";
const SHARE_TARGET_PATH = new URL("./share-target", self.location).pathname;
async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    const file = form.get("backup");
    if (file && typeof file.text === "function") {
      const text = await file.text();
      const cache = await caches.open(SHARE_INBOX);
      await cache.put("shared-backup", new Response(text, {
        headers: { "Content-Type": "application/json", "X-File-Name": encodeURIComponent(file.name || "") }
      }));
    }
  } catch (e) { /* 読み込めなければアプリ側で「見つかりません」と表示 */ }
  return Response.redirect(new URL("./?open=shared", self.location).href, 303);
}

// ---------- fetch ----------
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === "POST" && url.origin === self.location.origin && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith(handleShareTarget(req));
    return;
  }
  if (req.method !== "GET") return;

  // Firebase のログイン処理（/__/auth/…）や Chrome 拡張などは触らない
  if (url.pathname.startsWith("/__/")) return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // ページ本体（アプリ起動・再読み込み・ショートカット）
  if (req.mode === "navigate" && url.origin === self.location.origin && isAppPage(url)) {
    event.respondWith(handleNavigation(event));
    return;
  }

  // 同じサイトのファイル（アイコン・マニフェストなど）：保存済み優先、裏で更新
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event, req, SHELL_CACHE));
    return;
  }

  // CDN・フォント・Firebase SDK：保存済み優先、裏で更新
  if (CACHEABLE_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(event, req, RUNTIME_CACHE, true));
  }
  // それ以外（Firebase Auth / Firestore / Google API など）はブラウザに任せる
});

// アプリ本体のURL（/ または /index.html）だけを対象にする。同じサイトの別ページはそのまま通す
const SCOPE_PATH = new URL("./", self.location).pathname;
function isAppPage(url) {
  return url.pathname === SCOPE_PATH || url.pathname === SCOPE_PATH + "index.html";
}

async function handleNavigation(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_URL, { ignoreSearch: true });
  if (cached) {
    // すぐ表示して、裏で最新版を確認
    event.waitUntil(refreshShell(true, event.preloadResponse));
    return cached;
  }
  // 初回（まだ保存がない）
  try {
    const preloaded = await event.preloadResponse;
    const res = preloaded || await fetch(event.request);
    if (res && res.ok) await cache.put(SHELL_URL, res.clone());
    return res;
  } catch (e) {
    return new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<title>オフライン</title><body style='font-family:sans-serif;padding:40px 20px;text-align:center;color:#333'>" +
      "<h1 style='font-size:1.2rem'>オフラインです</h1><p>はじめて開くときはインターネット接続が必要です。<br>接続してから再読み込みしてください。</p></body>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

// 本体HTMLを取り直し、中身が変わっていたら保存し直して画面に知らせる
let shellCheckRunning = null;
function refreshShell(notify, preloadPromise) {
  if (shellCheckRunning) return shellCheckRunning;
  shellCheckRunning = (async () => {
    try {
      const cache = await caches.open(SHELL_CACHE);
      const old = await cache.match(SHELL_URL, { ignoreSearch: true });
      let fresh = null;
      try { fresh = preloadPromise ? await preloadPromise : null; } catch (e) {}
      if (!fresh) fresh = await fetch(SHELL_URL, { cache: "no-cache" });
      if (!fresh || !fresh.ok) return;
      const [oldText, newText] = await Promise.all([old ? old.clone().text() : Promise.resolve(""), fresh.clone().text()]);
      if (oldText === newText) return;
      await cache.put(SHELL_URL, fresh);
      if (notify && old) {
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach((c) => c.postMessage({ type: "SHELL_UPDATED" }));
      }
    } catch (e) {
      /* オフライン時は何もしない */
    } finally {
      shellCheckRunning = null;
    }
  })();
  return shellCheckRunning;
}

async function staleWhileRevalidate(event, req, cacheName, trim) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreVary: true });
  const network = fetch(req).then(async (res) => {
    // opaque（no-cors の CSS/フォント）も保存対象。エラー応答は保存しない
    if (res && (res.ok || res.type === "opaque")) {
      await cache.put(req, res.clone());
      if (trim) trimCache(cache, RUNTIME_MAX_ENTRIES);
    }
    return res;
  }).catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const res = await network;
  return res || new Response("", { status: 504, statusText: "Offline" });
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}
