require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const webpush = require("web-push");

const root = __dirname;
const dataDirectory = path.resolve(
  process.env.DATA_DIR || path.join(root, "data")
);
const subscriptionsFile = path.join(dataDirectory, "subscriptions.json");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT;
const adminToken = process.env.ADMIN_TOKEN;
const maxRequestBytes = 64 * 1024;
const reminderInterval = 3 * 60 * 60 * 1000;
// Тихие часы: с 22:00 до 9:00 по времени подписчика напоминания не отправляются
const quietHoursStart = 22;
const quietHoursEnd = 9;
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "https://zaibat228.github.io")
    .split(",")
    .map(origin => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean)
);
const startedAt = Date.now();

if (!publicKey || !privateKey || !vapidSubject ||
    !/^(mailto:.+|https:\/\/.+)$/.test(vapidSubject)) {
  throw new Error(
    "Укажи VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY и корректный VAPID_SUBJECT в .env."
  );
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT должен быть целым числом от 1 до 65535.");
}

webpush.setVapidDetails(vapidSubject, publicKey, privateKey);

function isValidTimeZone(value) {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const defaultTimeZone = isValidTimeZone(process.env.DEFAULT_TIME_ZONE)
  ? process.env.DEFAULT_TIME_ZONE
  : "Europe/Moscow";

let subscriptions = [];
let persistenceQueue = Promise.resolve();
let reminderCycleRunning = false;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value, headOnly = false) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(headOnly ? undefined : JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    request.setEncoding("utf8");
    request.on("data", chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxRequestBytes) {
        reject(new HttpError(413, "Слишком большой запрос."));
        request.resume();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (size > maxRequestBytes) return;
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new HttpError(400, "Некорректный JSON."));
      }
    });
    request.on("error", reject);
  });
}

function validateSettings(value) {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "Не заданы настройки уведомлений.");
  }
  const hasReminderSetting = typeof value.reminders === "boolean" ||
    (typeof value.daily === "boolean" && typeof value.weekly === "boolean");
  if (!hasReminderSetting || typeof value.updates !== "boolean") {
    throw new HttpError(400, "Некорректные настройки уведомлений.");
  }
  return {
    reminders: typeof value.reminders === "boolean"
      ? value.reminders
      : value.daily || value.weekly,
    updates: value.updates,
    quietHours: value.quietHours !== false
  };
}

function getLocalHour(timeZone, now = new Date()) {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : defaultTimeZone,
    hour: "2-digit",
    hourCycle: "h23"
  }).format(now);
  return Number(hour) % 24;
}

function isQuietTime(entry, now = new Date()) {
  if (entry.settings.quietHours === false) return false;
  const hour = getLocalHour(entry.timeZone, now);
  return hour >= quietHoursStart || hour < quietHoursEnd;
}

function saveSubscriptions() {
  persistenceQueue = persistenceQueue.then(async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${subscriptionsFile}.${process.pid}.tmp`;
    await fs.writeFile(
      temporaryFile,
      JSON.stringify(subscriptions, null, 2),
      { mode: 0o600 }
    );
    await fs.rename(temporaryFile, subscriptionsFile);
  });
  return persistenceQueue;
}

async function loadSubscriptions() {
  await fs.mkdir(dataDirectory, { recursive: true });
  try {
    const value = JSON.parse(await fs.readFile(subscriptionsFile, "utf8"));
    if (!Array.isArray(value)) {
      throw new Error("subscriptions.json должен содержать массив.");
    }
    const now = Date.now();
    let changed = false;
    subscriptions = value.flatMap(entry => {
      let settings;
      try {
        if (!entry?.subscription?.endpoint) {
          throw new Error("нет адреса подписки");
        }
        settings = validateSettings(entry.settings);
      } catch (error) {
        console.warn("Пропущена повреждённая подписка:", error.message);
        changed = true;
        return [];
      }
      const lastReminderAt = Number.isFinite(entry.lastReminderAt)
        ? entry.lastReminderAt
        : now;
      if (JSON.stringify(settings) !== JSON.stringify(entry.settings) ||
          lastReminderAt !== entry.lastReminderAt) {
        changed = true;
      }
      return [{ ...entry, settings, lastReminderAt }];
    });
    if (changed) await saveSubscriptions();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    subscriptions = [];
  }
}

function isExpiredPushError(error) {
  return error.statusCode === 404 || error.statusCode === 410;
}

async function deliverPush(entry, message) {
  try {
    await webpush.sendNotification(
      entry.subscription,
      JSON.stringify(message),
      { TTL: 3600 }
    );
    return true;
  } catch (error) {
    if (isExpiredPushError(error)) {
      subscriptions = subscriptions.filter(
        item => item.subscription.endpoint !== entry.subscription.endpoint
      );
      await saveSubscriptions();
      return false;
    }
    console.error("Не удалось отправить push-уведомление:", error.message);
    return false;
  }
}

async function deliverToSubscribers(message, predicate = () => true) {
  const recipients = subscriptions.filter(predicate);
  const results = await Promise.all(
    recipients.map(entry => deliverPush(entry, message))
  );
  return results.filter(Boolean).length;
}

async function runReminderCycle() {
  if (reminderCycleRunning) return;
  reminderCycleRunning = true;
  try {
    const now = Date.now();
    const reminders = [];
    for (const entry of [...subscriptions]) {
      if (entry.settings.reminders &&
          now - entry.lastReminderAt >= reminderInterval &&
          !isQuietTime(entry, new Date(now))) {
        entry.lastReminderAt = now;
        reminders.push([
          entry,
          {
            title: "Напоминание My Garage",
            body: "Загляни в гараж: добавь расходы, заправки или записи об обслуживании.",
            tag: "my-garage-reminder",
            url: "./"
          }
        ]);
      }
    }
    if (reminders.length === 0) return;

    await saveSubscriptions();
    await Promise.all(
      reminders.map(([entry, message]) => deliverPush(entry, message))
    );
  } catch (error) {
    console.error("Ошибка планировщика push-уведомлений:", error);
  } finally {
    reminderCycleRunning = false;
  }
}

function hasValidAdminToken(request) {
  if (!adminToken) return false;
  const authorization = request.headers.authorization || "";
  const expected = Buffer.from("Bearer " + adminToken);
  const actual = Buffer.from(authorization);
  return expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);
}

async function handleApi(request, response, pathname) {
  if ((request.method === "GET" || request.method === "HEAD") &&
      (pathname === "/api/health" || pathname === "/api/push/health")) {
    // Для проверки работы сервера и внешнего «пинга» на бесплатном Render
    sendJson(response, 200, {
      ok: true,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
    }, request.method === "HEAD");
    return;
  }

  if (request.method === "GET" && pathname === "/api/push/public-key") {
    sendJson(response, 200, { publicKey });
    return;
  }

  if (pathname === "/api/push/subscribe" && request.method === "POST") {
    const body = await readJson(request);
    const subscription = body.subscription;
    if (!subscription || typeof subscription.endpoint !== "string") {
      throw new HttpError(400, "Некорректная push-подписка.");
    }
    let endpoint;
    try {
      endpoint = new URL(subscription.endpoint);
    } catch {
      throw new HttpError(400, "Некорректный адрес push-подписки.");
    }
    if (endpoint.protocol !== "https:" ||
        endpoint.port !== "" ||
        !isAllowedPushHost(endpoint.hostname) ||
        !subscription.keys ||
        typeof subscription.keys.p256dh !== "string" ||
        typeof subscription.keys.auth !== "string") {
      throw new HttpError(400, "Некорректная push-подписка.");
    }
    const settings = validateSettings(body.settings);
    const existing = subscriptions.find(
      entry => entry.subscription.endpoint === subscription.endpoint
    );
    const timeZone = isValidTimeZone(body.timeZone)
      ? body.timeZone
      : isValidTimeZone(existing?.timeZone)
        ? existing.timeZone
        : defaultTimeZone;
    const entry = {
      subscription: {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime || null,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth
        }
      },
      settings,
      timeZone,
      lastReminderAt: existing?.lastReminderAt || Date.now()
    };
    // previousEndpoint — старая подписка этого же устройства (после смены ключей)
    const previousEndpoint = typeof body.previousEndpoint === "string"
      ? body.previousEndpoint
      : "";
    subscriptions = subscriptions.filter(
      item => item.subscription.endpoint !== subscription.endpoint &&
        (!previousEndpoint || item.subscription.endpoint !== previousEndpoint)
    );
    subscriptions.push(entry);
    await saveSubscriptions();
    sendJson(response, 200, { ok: true, publicKey });
    return;
  }

  if (pathname === "/api/push/subscribe" && request.method === "DELETE") {
    const body = await readJson(request);
    if (typeof body.endpoint !== "string") {
      throw new HttpError(400, "Не задан адрес push-подписки.");
    }
    subscriptions = subscriptions.filter(
      entry => entry.subscription.endpoint !== body.endpoint
    );
    await saveSubscriptions();
    sendJson(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/push/notify-update" && request.method === "POST") {
    if (!adminToken) {
      sendJson(response, 503, { error: "Не настроен ADMIN_TOKEN." });
      return;
    }
    if (!hasValidAdminToken(request)) {
      sendJson(response, 401, { error: "Неверный токен администратора." });
      return;
    }
    const body = await readJson(request);
    if (typeof body.title !== "string" ||
        typeof body.body !== "string" ||
        !body.title.trim() ||
        !body.body.trim() ||
        body.title.length > 100 ||
        body.body.length > 300) {
      throw new HttpError(400, "Укажи заголовок и текст обновления.");
    }
    const url = typeof body.url === "string" &&
      body.url.startsWith("/") && !body.url.startsWith("//")
      ? body.url
      : "/";
    const sent = await deliverToSubscribers(
      {
        title: body.title.trim(),
        body: body.body.trim(),
        url,
        tag: "my-garage-update"
      },
      entry => entry.settings.updates
    );
    sendJson(response, 200, { ok: true, sent });
    return;
  }

  sendJson(response, 404, { error: "API-маршрут не найден." });
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".manifest": "application/manifest+json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};
const publicFiles = new Set([
  "app.css",
  "assets/car-front-transparent.png",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "icon-badge-96.png",
  "icon.svg",
  "index.html",
  "site.webmanifest",
  "sw.js"
]);
// Эти файлы меняются с каждой версией — браузер должен их перепроверять
const revalidatedExtensions = new Set([
  ".css", ".html", ".js", ".webmanifest"
]);

function isAllowedPushHost(hostname) {
  return hostname === "fcm.googleapis.com" ||
    hostname === "updates.push.services.mozilla.com" ||
    hostname === "web.push.apple.com" ||
    hostname.endsWith(".push.apple.com") ||
    /^wns\d+-.+\.notify\.windows\.com$/.test(hostname);
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Метод не поддерживается." });
    return;
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Некорректный адрес страницы." });
    return;
  }
  if (decodedPath === "/") decodedPath = "/index.html";

  const relativePath = decodedPath.replace(/^\/+/, "");
  if (!publicFiles.has(relativePath)) {
    sendJson(response, 404, { error: "Страница не найдена." });
    return;
  }
  const filename = path.join(root, relativePath);
  try {
    const contents = await fs.readFile(filename);
    const headers = {
      "Content-Type": mimeTypes[path.extname(filename)] ||
        "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    };
    headers["Cache-Control"] = revalidatedExtensions.has(path.extname(filename))
      ? "no-cache"
      : "public, max-age=86400";
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : contents);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(response, 404, { error: "Страница не найдена." });
      return;
    }
    throw error;
  }
}

async function handleRequest(request, response) {
  const origin = request.headers.origin;

  response.setHeader("Vary", "Origin");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader(
      "Access-Control-Allow-Methods",
      "GET, HEAD, POST, DELETE, OPTIONS"
    );
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type"
    );
    response.setHeader("Access-Control-Max-Age", "86400");
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(request, response, requestUrl.pathname);
      return;
    }
    await serveStatic(request, response, requestUrl.pathname);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    console.error("Ошибка обработки запроса:", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "Внутренняя ошибка сервера." });
    } else {
      response.destroy();
    }
  }
}

async function start() {
  await loadSubscriptions();
  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(port, host, () => {
    console.log(`My Garage доступен на http://${host}:${port}`);
    console.log(`Разрешённые сайты (CORS): ${[...allowedOrigins].join(", ")}`);
  });
  setInterval(() => void runReminderCycle(), 15_000);
}

start().catch(error => {
  console.error("Не удалось запустить My Garage:", error);
  process.exitCode = 1;
});
