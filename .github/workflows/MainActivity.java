# Create MainActivity with WebView, Gallery and AdMob support.
java_code = f'''package {package_name};

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.ValueCallback;
import android.content.ActivityNotFoundException;
import android.webkit.JavascriptInterface;

import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;
import com.google.android.gms.ads.nativead.NativeAd;
import com.google.android.gms.ads.nativead.NativeAdOptions;
import com.google.android.gms.ads.nativead.NativeAdView;
import com.google.android.gms.ads.AdListener;
import com.google.android.gms.ads.AdLoader;
import com.google.android.gms.ads.appopen.AppOpenAd;

import android.widget.TextView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.graphics.Color;

public class MainActivity extends Activity {{

    private WebView webView;
    private FrameLayout rootLayout;
    private FrameLayout bannerContainer;

    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_CHOOSER_REQUEST_CODE = 1001;

    private AdView bannerAd;
    private InterstitialAd interstitialAd;
    private RewardedAd rewardedAd;
    private NativeAd nativeAd;
    private AppOpenAd appOpenAd;

    // Google TEST Ad Unit IDs
    private static final String BANNER_ID =
        "ca-app-pub-3940256099942544/9214589741";

    private static final String INTERSTITIAL_ID =
        "ca-app-pub-3940256099942544/1033173712";

    private static final String REWARDED_ID =
        "ca-app-pub-3940256099942544/5224354917";

    private static final String NATIVE_ID =
        "ca-app-pub-3940256099942544/2247696110";

    private static final String APP_OPEN_ID =
        "ca-app-pub-3940256099942544/9257395921";

    @Override
    protected void onCreate(Bundle savedInstanceState) {{
        super.onCreate(savedInstanceState);

        rootLayout = new FrameLayout(this);

        webView = new WebView(this);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        // 1. Bridge add karo
        AdMobBridge adMobBridge = new AdMobBridge(this, webView);
        webView.addJavascriptInterface(adMobBridge, "AndroidAds");

        // 2. admob.config.json load karo
        try {{
            java.io.InputStream is = getAssets().open("admob.config.json");
            java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(is));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            final String adMobCfgJson = sb.toString();
            webView.post(() -> webView.evaluateJavascript(
                "window.__ADMOB_CONFIG__ = " + adMobCfgJson + ";", null));
        }} catch (Exception e) {{
            Log.w("MainActivity", "No admob.config.json", e);
        }}

        webView.setWebViewClient(new WebViewClient());

        webView.setWebChromeClient(new WebChromeClient() {{
            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {{

                if (MainActivity.this.filePathCallback != null) {{
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }}

                MainActivity.this.filePathCallback = callback;

                try {{
                    Intent intent = params.createIntent();
                    startActivityForResult(
                        intent,
                        FILE_CHOOSER_REQUEST_CODE
                    );
                    return true;
                }} catch (ActivityNotFoundException exception) {{
                    MainActivity.this.filePathCallback = null;
                    return false;
                }}
            }}
        }});

        rootLayout.addView(
            webView,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );

        bannerContainer = new FrameLayout(this);

        FrameLayout.LayoutParams bannerParams =
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );

        bannerParams.gravity = android.view.Gravity.BOTTOM;
        rootLayout.addView(bannerContainer, bannerParams);

        setContentView(rootLayout);

        webView.loadUrl("file:///android_asset/index.html");

        MobileAds.initialize(this, status -> {{
            loadInterstitialAd();
            loadRewardedAd();
            loadNativeAd();
            loadAppOpenAd();
        }});
    }}

    // JavaScript Bridge
    public class AdMobBridge {{

        private final MainActivity activity;
        private final WebView bridgeWebView;

        public AdMobBridge(MainActivity activity, WebView webView) {{
            this.activity = activity;
            this.bridgeWebView = webView;
        }}

        @JavascriptInterface
        public void showBanner() {{
            runOnUiThread(() -> loadBannerAd());
        }}

        @JavascriptInterface
        public void hideBanner() {{
            runOnUiThread(() -> {{
                if (bannerAd != null) {{
                    bannerAd.setVisibility(View.GONE);
                }}
            }});
        }}

        @JavascriptInterface
        public void showInterstitial() {{
            runOnUiThread(() -> displayInterstitialAd());
        }}

        @JavascriptInterface
        public void showRewarded() {{
            runOnUiThread(() -> displayRewardedAd());
        }}

        @JavascriptInterface
        public void showNative() {{
            runOnUiThread(() -> displayNativeAd());
        }}

        @JavascriptInterface
        public void showAppOpen() {{
            runOnUiThread(() -> displayAppOpenAd());
        }}
    }}

    // Banner Ad
    private void loadBannerAd() {{
        if (bannerAd != null) {{
            bannerAd.destroy();
        }}

        bannerAd = new AdView(this);
        bannerAd.setAdSize(AdSize.BANNER);
        bannerAd.setAdUnitId(BANNER_ID);

        bannerContainer.removeAllViews();
        bannerContainer.addView(bannerAd);

        bannerAd.loadAd(new AdRequest.Builder().build());
        bannerContainer.setVisibility(View.VISIBLE);
    }}

    // Interstitial Ad
    private void loadInterstitialAd() {{
        InterstitialAd.load(
            this,
            INTERSTITIAL_ID,
            new AdRequest.Builder().build(),
            new InterstitialAdLoadCallback() {{
                @Override
                public void onAdLoaded(InterstitialAd ad) {{
                    interstitialAd = ad;
                }}

                @Override
                public void onAdFailedToLoad(LoadAdError error) {{
                    interstitialAd = null;
                }}
            }}
        );
    }}

    private void displayInterstitialAd() {{
        if (interstitialAd != null) {{
            interstitialAd.setFullScreenContentCallback(
                new FullScreenContentCallback() {{
                    @Override
                    public void onAdDismissedFullScreenContent() {{
                        interstitialAd = null;
                        loadInterstitialAd();
                    }}
                }}
            );

            interstitialAd.show(this);
        }} else {{
            loadInterstitialAd();
        }}
    }}

    // Rewarded Ad
    private void loadRewardedAd() {{
        RewardedAd.load(
            this,
            REWARDED_ID,
            new AdRequest.Builder().build(),
            new RewardedAdLoadCallback() {{
                @Override
                public void onAdLoaded(RewardedAd ad) {{
                    rewardedAd = ad;
                }}

                @Override
                public void onAdFailedToLoad(LoadAdError error) {{
                    rewardedAd = null;
                }}
            }}
        );
    }}

    private void displayRewardedAd() {{
        if (rewardedAd != null) {{
            rewardedAd.show(this, rewardItem -> {{
                runOnUiThread(() -> {{
                    webView.evaluateJavascript(
                        "window.onAdRewardEarned && window.onAdRewardEarned(" +
                        rewardItem.getAmount() + ", '" +
                        rewardItem.getType() + "')",
                        null
                    );
                }});
            }});

            rewardedAd = null;
            loadRewardedAd();
        }} else {{
            loadRewardedAd();
        }}
    }}

    // Native Ad
    private void loadNativeAd() {{
        AdLoader loader = new AdLoader.Builder(
            this,
            NATIVE_ID
        )
        .forNativeAd(ad -> {{
            if (nativeAd != null) {{
                nativeAd.destroy();
            }}
            nativeAd = ad;
        }})
        .withNativeAdOptions(
            new NativeAdOptions.Builder().build()
        )
        .build();

        loader.loadAd(new AdRequest.Builder().build());
    }}

    private void displayNativeAd() {{
        if (nativeAd == null) {{
            loadNativeAd();
            return;
        }}

        NativeAdView adView = new NativeAdView(this);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(20, 15, 20, 15);
        layout.setBackgroundColor(Color.WHITE);

        TextView headline = new TextView(this);
        headline.setTextSize(18);
        headline.setTextColor(Color.BLACK);
        headline.setText(nativeAd.getHeadline());

        TextView body = new TextView(this);
        body.setTextSize(14);
        body.setTextColor(Color.DKGRAY);
        body.setText(nativeAd.getBody());

        Button button = new Button(this);
        button.setText(nativeAd.getCallToAction());

        layout.addView(headline);
        layout.addView(body);
        layout.addView(button);

        adView.addView(layout);
        adView.setHeadlineView(headline);
        adView.setBodyView(body);
        adView.setCallToActionView(button);
        adView.setNativeAd(nativeAd);

        FrameLayout.LayoutParams params =
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );

        params.gravity = android.view.Gravity.CENTER;

        rootLayout.addView(adView, params);
    }}

    // App Open Ad
    private void loadAppOpenAd() {{
        AppOpenAd.load(
            this,
            APP_OPEN_ID,
            new AdRequest.Builder().build(),
            new AppOpenAd.AppOpenAdLoadCallback() {{
                @Override
                public void onAdLoaded(AppOpenAd ad) {{
                    appOpenAd = ad;
                }}

                @Override
                public void onAdFailedToLoad(LoadAdError error) {{
                    appOpenAd = null;
                }}
            }}
        );
    }}

    private void displayAppOpenAd() {{
        if (appOpenAd != null) {{
            appOpenAd.setFullScreenContentCallback(
                new FullScreenContentCallback() {{
                    @Override
                    public void onAdDismissedFullScreenContent() {{
                        appOpenAd = null;
                        loadAppOpenAd();
                    }}
                }}
            );

            appOpenAd.show(this);
        }} else {{
            loadAppOpenAd();
        }}
    }}

    @Override
    protected void onActivityResult(
            int requestCode,
            int resultCode,
            Intent data) {{
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {{
            if (filePathCallback == null) {{
                return;
            }}

            Uri[] results = null;

            if (resultCode == Activity.RESULT_OK && data != null) {{
                results = WebChromeClient.FileChooserParams.parseResult(
                    resultCode,
                    data
                );
            }}

            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }}
    }}

    @Override
    protected void onDestroy() {{
        if (bannerAd != null) {{
            bannerAd.destroy();
        }}

        if (nativeAd != null) {{
            nativeAd.destroy();
        }}

        if (webView != null) {{
            webView.destroy();
        }}

        super.onDestroy();
    }}

    @Override
    public void onBackPressed() {{
        if (webView != null && webView.canGoBack()) {{
            webView.goBack();
        }} else {{
            super.onBackPressed();
        }}
    }}
}}
'''

(java_dir / "MainActivity.java").write_text(
    java_code,
    encoding="utf-8"
)