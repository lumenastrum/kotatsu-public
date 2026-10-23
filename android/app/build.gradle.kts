plugins {
    id("com.android.application")
}

android {
    namespace = "app.kotatsu"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.kotatsu"
        // Node's android-configure builds for API 28 (android-node.yml), so the app can't go lower.
        minSdk = 28
        targetSdk = 34
        versionCode = (project.findProperty("kotatsuVersionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("kotatsuVersionName") as String?) ?: "0.0.0-dev"
    }

    // Release signing (#17 phase 2): the keystore lives outside the repo, found through the environment
    // (KOTATSU_KEYSTORE = path, KOTATSU_KEYSTORE_PASSWORD, alias "kotatsu"). Every release must be signed with the same
    // key, or Android refuses to install it over the last one.
    val keystore = System.getenv("KOTATSU_KEYSTORE")
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("KOTATSU_KEYSTORE_PASSWORD")
                keyAlias = "kotatsu"
                keyPassword = System.getenv("KOTATSU_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        jniLibs {
            // Extract libnode.so to nativeLibraryDir: Android 10+ only lets an app exec files there.
            useLegacyPackaging = true
        }
    }

    androidResources {
        // The server payload is already a zip; compressing it again only slows the first unpack.
        noCompress += "zip"
    }
}
