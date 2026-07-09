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
messaging.onBackgroundMessage((payload) => {
    const icono = 'https://raw.githubusercontent.com/mke210/asistente-escolar/main/asistente-virtual.png';
    const titulo = (payload.notification && payload.notification.title) || '🔔 Recordatorio escolar';
    const cuerpo = (payload.notification && payload.notification.body) || '';

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

// Caché simple para funcionamiento offline (lo que hacía el SW anterior)
const CACHE_NAME = 'asistente-escolar-v11';
self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(['./'])));
});
self.addEventListener('activate', (e) => {
    e.waitUntil(clients.claim());
});
self.addEventListener('fetch', (e) => {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
