// firebase-messaging-sw.js
// Este archivo DEBE vivir en la RAÍZ del sitio (mismo nivel que asistente.html),
// con ese nombre exacto. Es lo que permite recibir notificaciones push
// aunque el navegador o la app estén cerrados.

importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

// Misma configuración que en asistente.html
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

// Se dispara cuando llega un push y la app/pestaña está CERRADA o en segundo plano.
// Numerito rojo en el ícono de la app (Badging API). El Service Worker no
// tiene memoria propia entre eventos, así que el conteo se guarda usando
// Cache Storage (funciona igual, es la forma "persistente" disponible aquí).
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
    if (!('setAppBadge' in navigator)) return; // navegador sin soporte (ej. iPhone): se ignora sin romper nada
    const count = (await obtenerContadorBadge()) + 1;
    await guardarContadorBadge(count);
    try { await navigator.setAppBadge(count); } catch (e) { /* silencioso */ }
}

messaging.onBackgroundMessage((payload) => {
    const icono = 'https://raw.githubusercontent.com/mke210/asistente-escolar/main/asistente-virtual.png';
    const titulo = (payload.notification && payload.notification.title) || '🔔 Recordatorio escolar';
    const cuerpo = (payload.notification && payload.notification.body) || '';

    incrementarBadge();

    self.registration.showNotification(titulo, {
        body: cuerpo,
        icon: icono,
        badge: icono,
        vibrate: [200, 100, 200],
        requireInteraction: true,
        tag: 'recordatorio-escolar'
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
            if (clientList.length > 0) {
                clientList[0].focus();
            } else {
                clients.openWindow('./');
            }
        })
    );
});

// Caché simple para funcionamiento offline, con estrategia "red primero":
// siempre intenta traer la versión más nueva del servidor; solo usa la
// copia guardada si no hay conexión. Así, cuando actualices el sitio,
// los usuarios ven los cambios de inmediato en vez de quedarse con una
// versión vieja guardada para siempre.
const CACHE_NAME = 'asistente-escolar-v12';

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((nombres) =>
            Promise.all(
                nombres
                    .filter((n) => n !== CACHE_NAME)
                    .map((n) => caches.delete(n)) // borra cachés de versiones anteriores
            )
        ).then(() => clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        fetch(e.request)
            .then((respuesta) => {
                const copia = respuesta.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copia));
                return respuesta;
            })
            .catch(() => caches.match(e.request)) // sin conexión: usa la copia guardada
    );
});
