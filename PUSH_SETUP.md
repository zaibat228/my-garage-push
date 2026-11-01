# Push-уведомления My Garage

Push требуют HTTPS и работающего Node.js-сервера. На iPhone сайт нужно сначала
добавить на экран «Домой» и открыть как приложение. Обычная вкладка Safari на
iPhone не может подписаться на веб-push.

## Подготовка сервера

Нужен Node.js 18 или новее. В каталоге сайта установи зависимости:

```powershell
npm install
```

Скопируй `.env.example` в `.env`, сгенерируй VAPID-ключи и добавь значения в
`.env`:

```powershell
node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys(), null, 2))"
```

`publicKey` запиши в `VAPID_PUBLIC_KEY`, `privateKey` — в
`VAPID_PRIVATE_KEY`. Укажи действующий адрес владельца сайта в
`VAPID_SUBJECT` (например, `mailto:you@example.com`) и создай длинный случайный
секрет для `ADMIN_TOKEN`. Не публикуй `.env` и приватный VAPID-ключ.

Запусти сервер командой:

```powershell
npm start
```

Для разработки открой `http://localhost:3000`. Для доступа с устройств
публикуй сайт через HTTPS reverse proxy или Node.js-хостинг. Если proxy
завершает TLS, укажи для `HOST` адрес интерфейса, доступного proxy, а сам
`server.js` не выставляй напрямую в публичный интернет без HTTPS.

Файл подписок по умолчанию хранится в `data/subscriptions.json`. На хостинге
укажи для `DATA_DIR` постоянный каталог вне публичной директории сайта и
настрой резервное копирование с ограниченным доступом.

## Уведомление об обновлении

После публикации обновления владелец сайта может отправить объявление:

```powershell
$headers = @{ Authorization = "Bearer $env:ADMIN_TOKEN" }
$body = @{
  title = "My Garage обновлён"
  body = "Добавлены новые возможности."
  url = "/"
} | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "https://your-domain.example/api/push/notify-update" `
  -Headers $headers -ContentType "application/json" -Body $body
```

Объявление получают только подписчики, включившие уведомления об обновлениях.
Ежедневные напоминания отправляются в выбранное время устройства, еженедельные
подсказки — по воскресеньям в 10:00 местного времени.

Подписки и расписание привязаны к этому серверу. Несколько экземпляров Node.js
без общего хранилища и единственного планировщика использовать нельзя: это
приведёт к повторным уведомлениям.
