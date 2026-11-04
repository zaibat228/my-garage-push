// Служба приложения «Мой гараж»: офлайн-режим и push-уведомления.
// При изменении файлов интерфейса увеличь версию кеша
// и параметр ?v= у app.css в index.html.
const CACHE_PREFIX = "my-garage-";
const CACHE_NAME = `${CACHE_PREFIX}0.0.008`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./site.webmanifest",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-badge-96.png",
  "./assets/car-front-transparent.png"
];
const NAVIGATION_TIMEOUT = 4000;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Сохраняем файлы по одному: отсутствие одного файла не ломает установку
    await Promise.all(APP_SHELL.map(async url => {
      try {
        const response = await fetch(new Request(url, { cache: "reload" }));
        if (response.ok) await cache.put(url, response);
      } catch (error) {
        console.warn("Не удалось сохранить для офлайн-режима:", url, error);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function keepAlive(event, promise) {
  try {
    event.waitUntil(promise);
  } catch (error) {
    // событие уже завершено — обновление кеша выполнится в фоне
  }
}

async function findCached(cache, request) {
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached || request.mode !== "navigate") return cached;
  return await cache.match("./index.html") || cache.match("./");
}

async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE_NAME);
  const network = fetch(request).then(response => {
    if (response.ok && response.type === "basic") {
      keepAlive(event, cache.put(request, response.clone()).catch(() => {}));
    }
    return response;
  });

  try {
    if (request.mode === "navigate") {
      const cached = await findCached(cache, request);
      if (cached) {
        // Медленная сеть: показываем сохранённую версию, сеть обновит кеш
        const response = await Promise.race([
          network,
          new Promise(resolve => setTimeout(resolve, NAVIGATION_TIMEOUT))
        ]);
        if (response) return response;
        keepAlive(event, network.catch(() => {}));
        return cached;
      }
    }
    return await network;
  } catch (error) {
    const cached = await findCached(cache, request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
    return;
  }
  event.respondWith(networkFirst(event));
});

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let message = {};
    try {
      message = event.data ? event.data.json() : {};
    } catch (error) {
      console.warn("Не удалось прочитать push-уведомление", error);
    }

    const options = {
      body: message.body || "Пора заглянуть в свой гараж.",
      icon: "./icon-192.png",
      badge: "./icon-badge-96.png",
      lang: "ru",
      data: { url: message.url || "./" }
    };
    if (typeof message.tag === "string" && message.tag) {
      options.tag = message.tag;
      options.renotify = true;
    }
    await self.registration.showNotification(
      message.title || "My Garage",
      options
    );
  })());
});

// Адрес из уведомления считаем относительно папки приложения:
// на GitHub Pages сайт лежит не в корне домена
function resolveAppUrl(value) {
  const scope = new URL(self.registration.scope);
  const relative = typeof value === "string"
    ? value.trim().replace(/^\/+/, "")
    : "";
  try {
    const target = new URL(relative || "./", scope);
    return target.href.startsWith(scope.href) ? target : scope;
  } catch (error) {
    return scope;
  }
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const target = resolveAppUrl(event.notification.data?.url);
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });
    for (const client of windows) {
      if (!client.url.startsWith(scope)) continue;
      await client.focus();
      if (client.url !== target.href && "navigate" in client) {
        try {
          await client.navigate(target.href);
        } catch (error) {
          console.warn("Не удалось открыть адрес из уведомления", error);
        }
      }
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
