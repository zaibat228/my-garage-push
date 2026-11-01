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
const weeklyTips = [
  "Проверь давление в шинах: правильное давление помогает экономить топливо.",
  "Осмотри уровень моторного масла и обрати внимание на возможные утечки.",
  "Проверь состояние щёток стеклоочистителя и уровень омывающей жидкости.",
  "Убедись, что фары и указатели поворота работают исправно."
];

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

let subscriptions = [];
let persistenceQueue = Promise.resolve();
let reminderCycleRunning = false;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
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
  if (typeof value.daily !== "boolean" ||
      typeof value.weekly !== "boolean" ||
      typeof value.updates !== "boolean" ||
      typeof value.dailyTime !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.dailyTime)) {
    throw new HttpError(400, "Некорректные настройки уведомлений.");
  }
  return {
    daily: value.daily,
    dailyTime: value.dailyTime,
    weekly: value.weekly,
    updates: value.updates
  };
}

function validateTimeZone(value) {
  if (typeof value !== "string" || value.length > 100) {
    throw new HttpError(400, "Не задан часовой пояс устройства.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new HttpError(400, "Указан некорректный часовой пояс.");
  }
  return value;
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
    subscriptions = value;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    subscriptions = [];
  }
}

function getLocalParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    weekday: values.weekday
  };
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
    const now = new Date();
    const reminders = [];
    for (const entry of [...subscriptions]) {
      const local = getLocalParts(now, entry.timeZone);
      if (entry.settings.daily &&
          local.time === entry.settings.dailyTime &&
          entry.lastDailyDate !== local.date) {
        entry.lastDailyDate = local.date;
        reminders.push([
          entry,
          {
            title: "Время заглянуть в My Garage",
            body: "Добавь расходы и заправки, чтобы история автомобиля была актуальной."
          }
        ]);
      }
      if (entry.settings.weekly &&
          local.weekday === "Sun" &&
          local.time === "10:00" &&
          entry.lastWeeklyDate !== local.date) {
        entry.lastWeeklyDate = local.date;
        const weekNumber = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
        reminders.push([
          entry,
          {
            title: "Еженедельный уход за автомобилем",
            body: weeklyTips[weekNumber % weeklyTips.length]
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
    const timeZone = validateTimeZone(body.timeZone);
    const existing = subscriptions.find(
      entry => entry.subscription.endpoint === subscription.endpoint
    );
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
      lastDailyDate: existing?.lastDailyDate || "",
      lastWeeklyDate: existing?.lastWeeklyDate || ""
    };
    subscriptions = subscriptions.filter(
      item => item.subscription.endpoint !== subscription.endpoint
    );
    subscriptions.push(entry);
    await saveSubscriptions();
    sendJson(response, 200, { ok: true });
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
      { title: body.title.trim(), body: body.body.trim(), url },
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
  ".png": "image/png",
  ".svg": "image/svg+xml"
};
const publicFiles = new Set([
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "icon.svg",
  "index.html",
  "site.webmanifest",
  "sw.js"
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
    if (path.basename(filename) === "sw.js" ||
        path.extname(filename) === ".html" ||
        path.basename(filename) === "site.webmanifest") {
      headers["Cache-Control"] = "no-cache";
    }
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
  });
  setInterval(() => void runReminderCycle(), 15_000);
}

start().catch(error => {
  console.error("Не удалось запустить My Garage:", error);
  process.exitCode = 1;
});
