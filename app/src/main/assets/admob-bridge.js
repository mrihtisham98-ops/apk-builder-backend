/**
 * admob-bridge.js
 * Auto-injected by Web App Studio during APK build.
 * Provides safe JS wrappers around native AndroidAds bridge.
 */
(function() {
    'use strict';

    const TEST_ADMOB_IDS = {
        appId: 'ca-app-pub-3940256099942544~3347511713',
        bannerId: 'ca-app-pub-3940256099942544/6300978111',
        interstitialId: 'ca-app-pub-3940256099942544/1033173712',
        rewardedId: 'ca-app-pub-3940256099942544/5224354917',
        nativeId: 'ca-app-pub-3940256099942544/2247696110',
        appOpenId: 'ca-app-pub-3940256099942544/9257395921'
    };

    const cfg = window.__ADMOB_CONFIG__ || {};
    const useTest = cfg.testMode !== false;

    const resolved = {
        enabled: !!cfg.enabled,
        testMode: useTest,
        appId: useTest ? TEST_ADMOB_IDS.appId : (cfg.appId || ''),
        bannerId: useTest ? TEST_ADMOB_IDS.bannerId : (cfg.bannerId || ''),
        interstitialId: useTest ? TEST_ADMOB_IDS.interstitialId : (cfg.interstitialId || ''),
        rewardedId: useTest ? TEST_ADMOB_IDS.rewardedId : (cfg.rewardedId || ''),
        nativeId: useTest ? TEST_ADMOB_IDS.nativeId : (cfg.nativeId || ''),
        appOpenId: useTest ? TEST_ADMOB_IDS.appOpenId : (cfg.appOpenId || '')
    };

    window.__ADMOB_RESOLVED__ = resolved;

    function callBridge(method, ...args) {
        if (!resolved.enabled) return false;
        if (!window.AndroidAds) return false;
        try {
            if (typeof window.AndroidAds[method] === 'function') {
                window.AndroidAds[method](...args);
                return true;
            }
        } catch (e) {
            console.warn('[AdMob Bridge] ' + method + ' failed:', e);
        }
        return false;
    }

    window.showBanner = () => callBridge('showBanner');
    window.hideBanner = () => callBridge('hideBanner');
    window.showInterstitial = () => callBridge('showInterstitial');
    window.showRewarded = () => callBridge('showRewarded');
    window.showNative = () => callBridge('showNative');
    window.showAppOpen = () => callBridge('showAppOpen');
    window.isAdMobReady = () => resolved.enabled && !!window.AndroidAds;

    if (typeof window.onAdRewardEarned !== 'function') {
        window.onAdRewardEarned = (amount, type) => {
            console.log('[AdMob] Reward earned:', amount, type);
        };
    }

    // Auto-configure native bridge if present
    if (window.AndroidAds) {
        try {
            if (typeof window.AndroidAds.configure === 'function') {
                window.AndroidAds.configure(JSON.stringify(resolved));
            }
            if (resolved.enabled && typeof window.AndroidAds.initialize === 'function') {
                window.AndroidAds.initialize();
            }
        } catch (e) {
            console.warn('[AdMob Bridge] configure failed:', e);
        }
    }

    // Optional: Auto show app open on load
    window.addEventListener('load', () => {
        if (resolved.enabled && resolved.appOpenId) {
            setTimeout(() => callBridge('showAppOpen'), 1500);
        }
    });

    console.log('[AdMob Bridge] Loaded | Enabled:', resolved.enabled, '| TestMode:', useTest);
})();