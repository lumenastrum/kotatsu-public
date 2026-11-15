package app.kotatsu;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The app window: a boot screen while the server comes up, then Kotatsu itself in a WebView on
 * 127.0.0.1. Kotatsu's phone layout does the rest, the same one the desktop serves to phones.
 */
public class MainActivity extends Activity {
    private static final String URL_HOME = "http://127.0.0.1:" + ServerService.PORT + "/";
    private static final int PICK_FILE = 10;
    private static final int SAVE_FILE = 11;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private TextView boot;
    private ValueCallback<Uri[]> pendingUpload;
    private boolean loaded;
    private final SaveBridge saves = new SaveBridge();
    /** The save whose "save as" screen is open; the page asks for one at a time. */
    private String pendingSave;

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
        // A debug build can be inspected from a PC (chrome://inspect); a release never can.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        // Exports (kotatsu-public#12). A WebView has no downloads of its own: without these two, the backup and every
        // export button did nothing at all. The page (public/kotatsu/shell/android-save.js) sends its files through
        // the bridge; the listener catches a download that reaches the WebView some other way and hands it back to
        // the page, the only side that can read a blob.
        web.addJavascriptInterface(saves, "KotatsuAndroid");
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            String name = URLUtil.guessFileName(url, disposition, mime);
            page("window.__kotatsuAndroidSave && window.__kotatsuAndroidSave.fromUrl(" + JSONObject.quote(url) + ", " + JSONObject.quote(name) + ")");
        });
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

    /** Runs a line of script in the page. Main thread only. */
    private void page(String script) {
        web.evaluateJavascript(script, null);
    }

    /** Tells the page how its "save as" screen ended: ok, cancelled or error. */
    private void savePicked(String id, String result) {
        page("window.__kotatsuAndroidSave && window.__kotatsuAndroidSave.picked(" + JSONObject.quote(id) + ", " + JSONObject.quote(result) + ")");
    }

    /**
     * What the page calls to save a file (window.KotatsuAndroid). The person chooses the folder and the name on
     * Android's own "save as" screen, so the app needs no storage permission and can write nowhere they did not pick.
     * The bytes arrive as base64 pieces because a JavaScript bridge only carries strings and a backup is too large for
     * one. These methods run on the WebView's bridge thread, not the main one.
     */
    private final class SaveBridge {
        private final AtomicInteger next = new AtomicInteger();
        private final ConcurrentHashMap<String, Uri> files = new ConcurrentHashMap<>();
        private final ConcurrentHashMap<String, OutputStream> streams = new ConcurrentHashMap<>();

        @JavascriptInterface
        public String begin(String name, String mime) {
            String id = String.valueOf(next.incrementAndGet());
            main.post(() -> {
                Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                create.addCategory(Intent.CATEGORY_OPENABLE);
                create.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                create.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    pendingSave = id;
                    startActivityForResult(create, SAVE_FILE);
                } catch (Exception e) {
                    pendingSave = null;
                    savePicked(id, "error");
                }
            });
            return id;
        }

        /** Main thread: the person picked where the file goes. */
        void open(String id, Uri uri) {
            try {
                OutputStream stream = getContentResolver().openOutputStream(uri, "wt");
                if (stream == null) throw new java.io.IOException("no stream for " + uri);
                files.put(id, uri);
                streams.put(id, stream);
                savePicked(id, "ok");
            } catch (Exception e) {
                savePicked(id, "error");
            }
        }

        @JavascriptInterface
        public boolean write(String id, String base64) {
            OutputStream stream = streams.get(id);
            if (stream == null) return false;
            try {
                stream.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean finish(String id) {
            OutputStream stream = streams.remove(id);
            files.remove(id);
            if (stream == null) return false;
            try {
                stream.close();
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** A save that failed part-way: close it and take the half-written file away again. */
        @JavascriptInterface
        public void cancel(String id) {
            OutputStream stream = streams.remove(id);
            Uri uri = files.remove(id);
            try {
                if (stream != null) stream.close();
            } catch (Exception ignored) {
            }
            try {
                if (uri != null) DocumentsContract.deleteDocument(getContentResolver(), uri);
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == SAVE_FILE) {
            String id = pendingSave;
            pendingSave = null;
            if (id == null) return;
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            if (uri == null) savePicked(id, "cancelled");
            else saves.open(id, uri);
            return;
        }
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
