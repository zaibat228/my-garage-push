self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let message = {};
    try {
      message = event.data ? event.data.json() : {};
    } catch (error) {
      console.warn("Не удалось прочитать push-уведомление", error);
    }

    await self.registration.showNotification(message.title || "My Garage", {
      body: message.body || "Пора заглянуть в свой гараж.",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      data: { url: message.url || "./" }
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || "./", self.location.origin);
    if (target.origin !== self.location.origin) return;

    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ("navigate" in client) await client.navigate(target.href);
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
