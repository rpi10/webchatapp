// sw.js

self.addEventListener('install', event => {
    console.log('Service Worker installed');
});

self.addEventListener('activate', event => {
    console.log('Service Worker activated');
});

self.addEventListener('push', event => {
    const data = event.data.json();
    const options = {
        body: data.message,
        icon: '/path/to/icon.png', // Add your icon path here
        badge: '/path/to/badge.png' // Optional: Add a badge image
    };
    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('/') // Adjust URL as needed
    );
});
