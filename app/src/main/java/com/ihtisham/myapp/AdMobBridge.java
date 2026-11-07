package com.studio.webapp; // ⚠️ Replace with your package name

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.appopen.AppOpenAd;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;

import org.json.JSONObject;

public class AdMobBridge {
    private static final String TAG = "AdMobBridge";
    private final Activity activity;
    private final WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private boolean initialized = false;
    private boolean enabled = false;
    private boolean testMode = true;

    private String appId = "", bannerId = "", interstitialId = "";
    private String rewardedId = "", nativeId = "", appOpenId = "";

    private AdView bannerAdView;
    private InterstitialAd interstitialAd;
    private RewardedAd rewardedAd;
    private AppOpenAd appOpenAd;

    public AdMobBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    @JavascriptInterface
    public void configure(String jsonStr) {
        try {
            JSONObject cfg = new JSONObject(jsonStr);
            enabled = cfg.optBoolean("enabled", false);
            testMode = cfg.optBoolean("testMode", true);
            appId = cfg.optString("appId", "");
            bannerId = cfg.optString("bannerId", "");
            interstitialId = cfg.optString("interstitialId", "");
            rewardedId = cfg.optString("rewardedId", "");
            nativeId = cfg.optString("nativeId", "");
            appOpenId = cfg.optString("appOpenId", "");
            Log.d(TAG, "configure: enabled=" + enabled + " test=" + testMode);
        } catch (Exception e) {
            Log.e(TAG, "configure parse failed", e);
        }
    }

    @JavascriptInterface
    public boolean initialize() {
        if (!enabled) {
            Log.d(TAG, "AdMob disabled, skipping init");
            return false;
        }
        if (initialized) return true;
        mainHandler.post(() -> {
            try {
                MobileAds.initialize(activity, status -> {
                    initialized = true;
                    Log.d(TAG, "MobileAds initialized");
                    preloadInterstitial();
                    preloadRewarded();
                    preloadAppOpen();
                });
            } catch (Exception e) {
                Log.e(TAG, "init failed", e);
            }
        });
        return true;
    }

    @JavascriptInterface
    public void showBanner() {
        if (!enabled || bannerId.isEmpty()) return;
        mainHandler.post(() -> {
            try {
                if (bannerAdView == null) {
                    bannerAdView = new AdView(activity);
                    bannerAdView.setAdUnitId(bannerId);
                    bannerAdView.setAdSize(AdSize.BANNER);
                    int containerId = activity.getResources().getIdentifier(
                            "banner_container", "id", activity.getPackageName());
                    if (containerId != 0) {
                        android.widget.FrameLayout container = activity.findViewById(containerId);
                        container.removeAllViews();
                        container.addView(bannerAdView);
                        bannerAdView.setVisibility(AdView.VISIBLE);
                    }
                }
                bannerAdView.loadAd(new AdRequest.Builder().build());
            } catch (Exception e) {
                Log.e(TAG, "showBanner failed", e);
            }
        });
    }

    @JavascriptInterface
    public void hideBanner() {
        mainHandler.post(() -> {
            if (bannerAdView != null) bannerAdView.setVisibility(AdView.GONE);
        });
    }

    private void preloadInterstitial() {
        if (interstitialId.isEmpty()) return;
        try {
            InterstitialAd.load(activity, interstitialId, new AdRequest.Builder().build(),
                new InterstitialAdLoadCallback() {
                    @Override public void onAdLoaded(InterstitialAd ad) {
                        interstitialAd = ad;
                        Log.d(TAG, "Interstitial loaded");
                    }
                    @Override public void onAdFailedToLoad(LoadAdError err) {
                        Log.w(TAG, "Interstitial failed: " + err.getMessage());
                    }
                });
        } catch (Exception e) { Log.e(TAG, "preloadInterstitial", e); }
    }

    @JavascriptInterface
    public void showInterstitial() {
        if (!enabled || interstitialId.isEmpty()) return;
        mainHandler.post(() -> {
            if (interstitialAd != null) {
                interstitialAd.show(activity);
                interstitialAd = null;
                preloadInterstitial();
            } else {
                preloadInterstitial();
            }
        });
    }

    private void preloadRewarded() {
        if (rewardedId.isEmpty()) return;
        try {
            RewardedAd.load(activity, rewardedId, new AdRequest.Builder().build(),
                new RewardedAdLoadCallback() {
                    @Override public void onAdLoaded(RewardedAd ad) {
                        rewardedAd = ad;
                        Log.d(TAG, "Rewarded loaded");
                    }
                    @Override public void onAdFailedToLoad(LoadAdError err) {
                        Log.w(TAG, "Rewarded failed: " + err.getMessage());
                    }
                });
        } catch (Exception e) { Log.e(TAG, "preloadRewarded", e); }
    }

    @JavascriptInterface
    public void showRewarded() {
        if (!enabled || rewardedId.isEmpty()) return;
        mainHandler.post(() -> {
            if (rewardedAd != null) {
                rewardedAd.show(activity, rewardItem -> {
                    int amount = rewardItem.getAmount();
                    String type = rewardItem.getType();
                    if (webView != null) {
                        String js = "if(window.onAdRewardEarned) window.onAdRewardEarned("
                                    + amount + ", '" + type + "');";
                        webView.post(() -> webView.evaluateJavascript(js, null));
                    }
                });
                rewardedAd = null;
                preloadRewarded();
            } else {
                preloadRewarded();
            }
        });
    }

    @JavascriptInterface
    public void showNative() {
        // Native ads need a custom layout; skip if not set up.
        Log.d(TAG, "showNative called — needs native ad layout");
    }

    private void preloadAppOpen() {
        if (appOpenId.isEmpty()) return;
        try {
            AppOpenAd.load(activity, appOpenId, new AdRequest.Builder().build(),
                new AppOpenAd.AppOpenAdLoadCallback() {
                    @Override public void onAdLoaded(AppOpenAd ad) {
                        appOpenAd = ad;
                        Log.d(TAG, "AppOpen loaded");
                    }
                    @Override public void onAdFailedToLoad(LoadAdError err) {
                        Log.w(TAG, "AppOpen failed: " + err.getMessage());
                    }
                });
        } catch (Exception e) { Log.e(TAG, "preloadAppOpen", e); }
    }

    @JavascriptInterface
    public void showAppOpen() {
        if (!enabled || appOpenId.isEmpty()) return;
        mainHandler.post(() -> {
            if (appOpenAd != null) {
                appOpenAd.show(activity);
                appOpenAd = null;
                preloadAppOpen();
            } else {
                preloadAppOpen();
            }
        });
    }

    @JavascriptInterface
    public boolean isInitialized() { return initialized; }

    @JavascriptInterface
    public boolean isEnabled() { return enabled; }
}