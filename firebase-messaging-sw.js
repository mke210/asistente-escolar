// firebase-messaging-sw.js
// Colocar en la RAÍZ del sitio

importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyBoM-z0NBs21tDAhcz91mQhRQshraUNDpg",
    authDomain: "asistente-escolar-c08e8.firebaseapp.com",
    projectId: "asistente-escolar-c08e8",
    storageBucket: "asistente-escolar-c08e8.firebasestorage.app",
    messagingSenderId: "137805187168",
    appId: "1:137805187168:web:6d92d4e9efa63c683d9b05",
    measurementId: "G-8TGGH1Z5C1"
});

const messaging = firebase.messaging();

async function obtenerContadorBadge() {
    try {
        const cache = await caches.open('badge-store');
        const res = await cache.match('badge-count');
        if (!res) return 0;
        const data = await res.json();
        return data.count || 0;
    } catch (e) { return 0; }
}

async function guardarContadorBadge(count) {
    const cache = await caches.open('badge-store');
    await cache.put('badge-count', new Response(JSON.stringify({ count })));
}

async function incrementarBadge() {
    if (!('setAppBadge' in navigator)) return;
    const count = (await obtenerContadorBadge()) + 1;
    await guardarContadorBadge(count);
    try { await navigator.setAppBadge(count); } catch (e) { /* silencioso */ }
}

messaging.onBackgroundMessage((payload) => {
    const icono = 'https://raw.githubusercontent.com/mke210/asistente-escolar/main/asistente-virtual.png';
    
    let titulo = '🔔 Recordatorio escolar';
    let cuerpo = '';
    
    if (payload.notification) {
        titulo = payload.notification.title || titulo;
        cuerpo = payload.notification.body || '';
    }
    
    if (payload.data) {
        if (payload.data.title) titulo = payload.data.title;
        if (payload.data.body) cuerpo = payload.data.body;
    }

    incrementarBadge();

    self.registration.showNotification(titulo, {
        body: cuerpo,
        icon: icono,
        badge: icono,
        vibrate: [200, 100, 200],
        requireInteraction: true,
        tag: 'recordatorio-escolar',
        data: {
            url: payload.data?.url || '/'
        }
    });
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    
    if ('clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch(() => {});
        caches.open('badge-store').then(c => c.delete('badge-count'));
    }
    
    e.waitUntil(
        clients.matchAll({ type: 'window' }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes('asistente') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(e.notification.data?.url || '/');
            }
        })
    );
});

const CACHE_NAME = 'asistente-escolar-v13';

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((nombres) =>
            Promise.all(
                nombres
                    .filter((n) => n !== CACHE_NAME)
                    .map((n) => caches.delete(n))
            )
        ).then(() => clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') {
        return;
    }

    e.respondWith(
        fetch(e.request)
            .then((respuesta) => {
                const copia = respuesta.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copia));
                return respuesta;
            })
            .catch(() => caches.match(e.request))
    );
});