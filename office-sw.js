/* D&C Site Office — service worker: shows schedule alerts on the phone,
   even when the Site Office isn't open. No caching (the office needs live data). */
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch(_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'D&C Site Office', {
    body: d.body || 'Something was added to the schedule',
    tag: d.tag || undefined,
    icon: 'assets/logo.png',
    badge: 'assets/logo.png',
    data: { url: d.url || 'office.html#schedule' }
  }));
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || 'office.html#schedule', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf('office.html') >= 0 && 'focus' in c) {
        if ('navigate' in c) c.navigate(url).catch(function(){});
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
