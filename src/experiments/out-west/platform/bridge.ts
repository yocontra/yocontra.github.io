/**
 * The native bridge. On the web every call is a no-op; inside the future Expo WebView it talks to
 * `window.ReactNativeWebView`. Owned by stream A.
 */
export const isNativeShell = (): boolean => 'ReactNativeWebView' in globalThis
