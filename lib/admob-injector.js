// lib/admob-injector.js
// AdMob injection helper for Web App Studio APK builds
// Author: Web App Studio
// Usage: applyAdMobIntegration() — call inside /api/cloud-build-apk handler

const TEST_ADMOB_IDS = {
    appId: 'ca-app-pub-3940256099942544~3347511713',
    bannerId: 'ca-app-pub-3940256099942544/6300978111',
    interstitialId: 'ca-app-pub-3940256099942544/1033173712',
    rewardedId: 'ca-app-pub-3940256099942544/5224354917',
    nativeId: 'ca-app-pub-3940256099942544/2247696110',
    appOpenId: 'ca-app-pub-3940256099942544/9257395921'
};

/**
 * Resolve effective AdMob IDs (test mode = test IDs, real mode = user IDs)
 */
function resolveAdMobConfig(adMob) {
    if (!adMob || !adMob.enabled) {
        return { enabled: false };
    }
    const useTest = adMob.testMode !== false;
    return {
        enabled: true,
        testMode: useTest,
        appId: useTest ? TEST_ADMOB_IDS.appId : (adMob.appId || ''),
        bannerId: useTest ? TEST_ADMOB_IDS.bannerId : (adMob.bannerId || ''),
        interstitialId: useTest ? TEST_ADMOB_IDS.interstitialId : (adMob.interstitialId || ''),
        rewardedId: useTest ? TEST_ADMOB_IDS.rewardedId : (adMob.rewardedId || ''),
        nativeId: useTest ? TEST_ADMOB_IDS.nativeId : (adMob.nativeId || ''),
        appOpenId: useTest ? TEST_ADMOB_IDS.appOpenId : (adMob.appOpenId || '')
    };
}

/**
 * Builds the AdMob bridge JavaScript (inline injected into index.html)
 */
function buildAdMobBridgeScript(resolvedConfig) {
    const cfgJson = JSON.stringify(resolvedConfig);
    return `
<script>
// ===== AdMob Bridge (auto-injected by Web App Studio) =====
window.__ADMOB_CONFIG__ = ${cfgJson};
(function() {
    'use strict';
    var cfg = window.__ADMOB_CONFIG__ || {};
    function callBridge(method) {
        if (!cfg.enabled) return false;
        if (!window.AndroidAds) return false;
        try {
            if (typeof window.AndroidAds[method] === 'function') {
                window.AndroidAds[method]();
                return true;
            }
        } catch (e) { console.warn('[AdMob] ' + method + ' failed:', e); }
        return false;
    }
    window.showBanner = function() { return callBridge('showBanner'); };
    window.hideBanner = function() { return callBridge('hideBanner'); };
    window.showInterstitial = function() { return callBridge('showInterstitial'); };
    window.showRewarded = function() { return callBridge('showRewarded'); };
    window.showNative = function() { return callBridge('showNative'); };
    window.showAppOpen = function() { return callBridge('showAppOpen'); };
    window.isAdMobReady = function() { return cfg.enabled && !!window.AndroidAds; };
    if (typeof window.onAdRewardEarned !== 'function') {
        window.onAdRewardEarned = function(a, t) { console.log('[AdMob] reward:', a, t); };
    }
    if (window.AndroidAds) {
        try {
            if (typeof window.AndroidAds.configure === 'function') {
                window.AndroidAds.configure(${JSON.stringify(cfgJson)});
            }
            if (cfg.enabled && typeof window.AndroidAds.initialize === 'function') {
                window.AndroidAds.initialize();
            }
        } catch (e) { console.warn('[AdMob] configure failed:', e); }
    }
    console.log('[AdMob Bridge] Loaded | Enabled:', cfg.enabled, '| Test:', cfg.testMode);
})();
</script>`;
}

/**
 * Injects AdMob bridge into index.html (safely, no duplication)
 */
function injectIntoHtml(html, bridgeScript) {
    if (!html || typeof html !== 'string') return html;
    // Remove previous injection to avoid duplication
    html = html.replace(/<!-- ADMOB_BRIDGE_START -->[\s\S]*?<!-- ADMOB_BRIDGE_END -->/g, '');
    const marked = '<!-- ADMOB_BRIDGE_START -->' + bridgeScript + '<!-- ADMOB_BRIDGE_END -->';
    if (html.includes('</head>')) {
        return html.replace('</head>', marked + '</head>');
    }
    if (html.includes('</body>')) {
        return html.replace('</body>', marked + '</body>');
    }
    return marked + html;
}

/**
 * Updates AndroidManifest.xml with AdMob APPLICATION_ID
 */
function injectManifestAppId(manifest, appId) {
    if (!manifest || !appId) return manifest;
    const metaTag = `<meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="${appId}" />`;
    // Remove existing AdMob meta-data if present
    manifest = manifest.replace(
        /<meta-data[^>]*com\.google\.android\.gms\.ads\.APPLICATION_ID[^>]*\/?>/g,
        ''
    );
    if (manifest.includes('</application>')) {
        return manifest.replace('</application>', '    ' + metaTag + '\n    </application>');
    }
    return manifest;
}

/**
 * Ensures AdMob SDK dependency is present in build.gradle
 */
function injectGradleDependency(gradle) {
    if (!gradle) return gradle;
    if (gradle.includes('play-services-ads')) return gradle;
    const dep = "    implementation 'com.google.android.gms:play-services-ads:22.6.0'\n";
    if (gradle.includes('dependencies {')) {
        return gradle.replace('dependencies {', 'dependencies {\n' + dep);
    }
    return gradle + '\ndependencies {\n' + dep + '}\n';
}

/**
 * MAIN FUNCTION — Call this from /api/cloud-build-apk
 * Mutates the `files` object in place and returns metadata.
 *
 * @param {object} files - Virtual file system from payload
 * @param {object} adMob - payload.adMob
 * @returns {object} - { applied: boolean, reason: string, resolved: object }
 */
function applyAdMobIntegration(files, adMob) {
    const resolved = resolveAdMobConfig(adMob);

    if (!resolved.enabled) {
        // Clean up: ensure no stale AdMob files remain
        if (files['admob.config.json']) delete files['admob.config.json'];
        return { applied: false, reason: 'AdMob disabled — build is exactly as before', resolved };
    }

    // 1. Write admob.config.json
    files['admob.config.json'] = JSON.stringify(resolved, null, 2);

    // 2. Write admob-bridge.js (for reference / manual use)
    files['admob-bridge.js'] = buildAdMobBridgeScript(resolved).replace(/<\/?script>/g, '');

    // 3. Inject bridge into index.html
    const htmlKey = files['index.html'] ? 'index.html' :
                    files['Crikzone/index.html'] ? 'Crikzone/index.html' : null;
    if (htmlKey) {
        files[htmlKey] = injectIntoHtml(files[htmlKey], buildAdMobBridgeScript(resolved));
    }

    // 4. Update AndroidManifest.xml if present in files
    if (files['AndroidManifest.xml']) {
        files['AndroidManifest.xml'] = injectManifestAppId(files['AndroidManifest.xml'], resolved.appId);
    }

    // 5. Update build.gradle if present
    if (files['build.gradle']) {
        files['build.gradle'] = injectGradleDependency(files['build.gradle']);
    }

    return {
        applied: true,
        reason: 'AdMob integrated — testMode=' + resolved.testMode,
        resolved
    };
}

module.exports = {
    applyAdMobIntegration,
    resolveAdMobConfig,
    TEST_ADMOB_IDS
};