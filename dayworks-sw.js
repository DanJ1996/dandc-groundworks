/* D&C Day Works — offline service worker */
var CACHE = 'dandc-dayworks-v5';
var ASSETS = [
  'dayworks.html',
  'dayworks.webmanifest',
  'assets/logo.png',
  'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Oswald:wght@500;600;700&display=swap'
];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){
    return Promise.all(ASSETS.map(function(url){
      return c.add(url).catch(function(){ /* ignore a single failed asset */ });
    }));
  }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.map(function(k){ if(k!==CACHE) return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

/* Network-first for the app's own HTML/JS (so updates always land when online,
   still works offline from cache). Cache-first for static assets + fonts. */
self.addEventListener('fetch', function(e){
  if(e.request.method!=='GET') return;
  var url = e.request.url;
  var sameOrigin = url.indexOf(self.location.origin)===0;
  var isAppCode = sameOrigin && /\.(html|js|webmanifest)(\?|$)/.test(url);
  if(isAppCode || e.request.mode==='navigate'){
    e.respondWith(
      fetch(e.request).then(function(res){
        if(res && res.ok){ var copy=res.clone(); caches.open(CACHE).then(function(c){ c.put(e.request, copy); }); }
        return res;
      }).catch(function(){
        return caches.match(e.request).then(function(hit){ return hit || caches.match('dayworks.html'); });
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function(hit){
      if(hit) return hit;
      return fetch(e.request).then(function(res){
        var copy = res.clone();
        if(res.ok && (url.indexOf('fonts.g')>-1 || sameOrigin)){
          caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
        }
        return res;
      }).catch(function(){ return caches.match('dayworks.html'); });
    })
  );
});
