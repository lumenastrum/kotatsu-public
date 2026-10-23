package app.kotatsu;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * The app window: a boot screen while the server comes up, then Kotatsu itself in a WebView on
 * 127.0.0.1. Kotatsu's phone layout does the rest, the same one the desktop serves to phones.
 */
public class MainActivity extends Activity {
    private static final String URL_HOME = "http://127.0.0.1:" + ServerService.PORT + "/";
    private static final int PICK_FILE = 10;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private TextView boot;
    private ValueCallback<Uri[]> pendingUpload;
    private boolean loaded;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        startForegroundService(new Intent(this, ServerService.class));

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        web.setVisibility(View.INVISIBLE);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("127.0.0.1".equals(url.getHost())) return false;
                // Links out of the app (docs, GitHub, provider sign-ups) open in the real browser.
                startActivity(new Intent(Intent.ACTION_VIEW, url));
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingUpload != null) pendingUpload.onReceiveValue(null);
                pendingUpload = callback;
                Intent pick = params.createIntent();
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(pick, PICK_FILE);
                return true;
            }
        });

        boot = new TextView(this);
        boot.setGravity(Gravity.CENTER);
        boot.setPadding(48, 48, 48, 48);
        boot.setTextSize(18);
        boot.setTypeface(Typeface.SERIF, Typeface.BOLD);
        boot.setTextColor(getColor(R.color.ink));
        boot.setText(R.string.boot_starting);

        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(boot, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        waitForServer();
    }

    /** Poll the server until it answers, then show the app. */
    private void waitForServer() {
        new Thread(() -> {
            while (!isFinishing()) {
                if (reachable()) {
                    main.post(this::showApp);
                    return;
                }
                ServerService.State state = ServerService.state;
                main.post(() -> showBoot(state));
                if (state == ServerService.State.FAILED) return;
                try {
                    Thread.sleep(500);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }, "kotatsu-wait").start();
    }

    private static boolean reachable() {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(URL_HOME).openConnection();
            connection.setConnectTimeout(500);
            connection.setReadTimeout(2000);
            int code = connection.getResponseCode();
            connection.disconnect();
            return code > 0;
        } catch (Exception e) {
            return false;
        }
    }

    private void showBoot(ServerService.State state) {
        if (state == ServerService.State.UNPACKING) boot.setText(R.string.boot_unpacking);
        else if (state == ServerService.State.FAILED) boot.setText(getString(R.string.boot_failed) + "\n\n" + logTail());
        else boot.setText(R.string.boot_starting);
    }

    private void showApp() {
        if (!loaded) {
            loaded = true;
            if (web.getUrl() == null) web.loadUrl(URL_HOME);
        }
        web.setVisibility(View.VISIBLE);
        boot.setVisibility(View.GONE);
    }

    private String logTail() {
        try (RandomAccessFile log = new RandomAccessFile(ServerService.logFile(this), "r")) {
            long start = Math.max(0, log.length() - 2000);
            byte[] bytes = new byte[(int) (log.length() - start)];
            log.seek(start);
            log.readFully(bytes);
            return new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == PICK_FILE && pendingUpload != null) {
            pendingUpload.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            pendingUpload = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
