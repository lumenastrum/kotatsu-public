package app.kotatsu;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Runs the Kotatsu server (Node + server.js) on the phone while the app is open or backgrounded.
 *
 * Node ships as jniLibs/<abi>/libnode.so so it lands in nativeLibraryDir, the one place Android 10+
 * lets an app exec. The server files ship as assets/kotatsu.zip and are unpacked into filesDir once
 * per app version; chats, characters and settings live beside them in filesDir/data, which an
 * update never touches.
 */
public class ServerService extends Service {
    static final String TAG = "Kotatsu";
    static final int PORT = 8123;
    static final String ACTION_STOP = "app.kotatsu.STOP";
    private static final String CHANNEL = "server";
    private static final int NOTIFICATION = 1;

    enum State { IDLE, UNPACKING, STARTING, FAILED }

    /** Read by MainActivity's boot screen; the server being reachable is what means "running". */
    static volatile State state = State.IDLE;

    private Process node;
    private Thread worker;

    static File logFile(android.content.Context context) {
        return new File(context.getFilesDir(), "server.log");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(getString(R.string.notif_running));
        if (worker == null) {
            worker = new Thread(this::run, "kotatsu-server");
            worker.start();
        }
        return START_STICKY;
    }

    private void run() {
        try {
            File app = new File(getFilesDir(), "kotatsu");
            unpackIfNeeded(app);
            launch(app);
            int code = node.waitFor();
            Log.w(TAG, "server exited with " + code);
            state = State.FAILED;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            Log.e(TAG, "server failed", e);
            appendLog("[kotatsu-app] " + e);
            state = State.FAILED;
        }
    }

    /** Unpack assets/kotatsu.zip when this app version hasn't been unpacked yet. */
    private void unpackIfNeeded(File app) throws IOException {
        String version = appVersion();
        File stamp = new File(app, ".apk-version");
        if (stamp.exists() && version.equals(readString(stamp))) return;

        state = State.UNPACKING;
        startForeground(getString(R.string.notif_unpacking));
        deleteTree(app);
        if (!app.mkdirs()) throw new IOException("could not create " + app);
        String root = app.getCanonicalPath() + File.separator;
        byte[] buffer = new byte[1 << 16];
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(getAssets().open("kotatsu.zip"), 1 << 16))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) {
                File out = new File(app, entry.getName());
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("bad zip entry " + entry.getName());
                if (entry.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                out.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    for (int n; (n = zip.read(buffer)) > 0; ) os.write(buffer, 0, n);
                }
            }
        }
        Files.write(stamp.toPath(), version.getBytes(StandardCharsets.UTF_8));
        startForeground(getString(R.string.notif_running));
    }

    private void launch(File app) throws IOException {
        state = State.STARTING;
        File data = new File(getFilesDir(), "data");
        data.mkdirs();
        String libDir = getApplicationInfo().nativeLibraryDir;

        List<String> command = new ArrayList<>();
        command.add(libDir + "/libnode.so");
        command.add("server.js");
        command.add("--port");
        command.add(String.valueOf(PORT));
        command.add("--listen");
        command.add("false");
        command.add("--browserLaunchEnabled");
        command.add("false");
        // Explicit, so startup never auto-detects: Android 11+ denies apps the netlink socket
        // behind os.networkInterfaces(), and the call throws.
        command.add("--enableIPv4");
        command.add("true");
        command.add("--enableIPv6");
        command.add("false");
        command.add("--dataRoot");
        command.add(data.getAbsolutePath());
        command.add("--configPath");
        command.add(new File(getFilesDir(), "config.yaml").getAbsolutePath());

        ProcessBuilder builder = new ProcessBuilder(command)
                .directory(app)
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(logFile(this)));
        builder.environment().put("HOME", getFilesDir().getAbsolutePath());
        builder.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
        // libc++_shared.so sits beside libnode.so when the build needs it (android-node.yml).
        builder.environment().put("LD_LIBRARY_PATH", libDir);
        builder.environment().put("KOTATSU_PLATFORM", "android");
        builder.environment().put("NODE_ENV", "production");

        appendLog("[kotatsu-app] starting " + String.join(" ", command));
        node = builder.start();
    }

    @Override
    public void onDestroy() {
        if (node != null) node.destroy();
        if (worker != null) worker.interrupt();
        state = State.IDLE;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startForeground(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ServerService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, getString(R.string.notif_stop), stop).build())
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION, notification);
        }
    }

    private String appVersion() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            // lastUpdateTime changes on every install, so a reinstalled dev build unpacks fresh too.
            return info.getLongVersionCode() + "@" + info.lastUpdateTime;
        } catch (Exception e) {
            return "unknown";
        }
    }

    private void appendLog(String line) {
        try (OutputStream os = new FileOutputStream(logFile(this), true)) {
            os.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
            // the log is a convenience; Logcat has the same line
        }
    }

    private static String readString(File file) {
        try (InputStream in = new java.io.FileInputStream(file)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
