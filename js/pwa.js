if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        // Register the service worker normally
        navigator.serviceWorker.register('/service-worker.js')
            .then(registration => {
                console.log('[PWA] ✅ Service Worker registered:', registration.scope);

                // Check for updates every time page visible
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') {
                        registration.update();
                    }
                });

                // Check for updates periodically (every 5 min)
                setInterval(() => registration.update(), 5 * 60 * 1000);

                // Listen for updates
                registration.addEventListener('updatefound', () => {
                    const newWorker = registration.installing;
                    console.log('[PWA] 🔄 New Service Worker found, installing...');

                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            console.log('[PWA] ✨ New version available! Refresh page to update.');
                            // Don't auto-reload - let user manually refresh to avoid loops
                            // window.location.reload();
                        }
                    });
                });
            })
            .catch(error => {
                console.log('[PWA] ❌ Service Worker registration failed:', error);
            });

        // Listen for messages from SW
        navigator.serviceWorker.addEventListener('message', event => {
            if (event.data?.type === 'SW_UPDATED') {
                console.log('[PWA] 🆕 SW updated to version:', event.data.version);
                window.location.reload();
            }
        });
    });
}
