plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing, supplied through the environment rather than a
// key.properties file, so the values live with every other secret in the
// repo-root .env and in CI's secrets.
//
// Signing a release with the debug key means signing it with whatever
// ~/.android/debug.keystore the build machine happens to have. A CI runner
// generates that file fresh on every run, so each build would carry a
// different certificate — Google Sign-In rejects the app (the SHA-1
// registered for the OAuth client can never match) and Android refuses to
// install a new build over the previous one.
// Gradle only sees the process environment, which is how CI supplies these.
// Locally they live in the repo-root .env with everything else, so that is
// read as a fallback — a real environment variable still wins.
val dotenv: Map<String, String> = rootProject.file("../../../.env").let { file ->
    if (!file.exists()) {
        emptyMap()
    } else {
        file.readLines()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") && it.contains("=") }
            .associate { line ->
                val key = line.substringBefore("=").trim()
                val value = line.substringAfter("=").trim()
                    .removeSurrounding("\"")
                    .removeSurrounding("'")
                key to value
            }
    }
}

fun secret(name: String): String? =
    System.getenv(name)?.takeIf { it.isNotBlank() } ?: dotenv[name]?.takeIf { it.isNotBlank() }

val releaseStorePath: String? = secret("ANDROID_KEYSTORE_PATH")
val releaseStorePassword: String? = secret("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias: String? = secret("ANDROID_KEY_ALIAS")
val releaseKeyPassword: String? = secret("ANDROID_KEY_PASSWORD")
val hasReleaseKeystore =
    !releaseStorePath.isNullOrBlank() && file(releaseStorePath).exists()

android {
    namespace = "io.github.retxchintu.spendlog"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "io.github.retxchintu.spendlog"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml, which scripts/stamp-version.js
        // increments on every release.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                // Keeps `flutter build apk --release` working locally for a
                // quick check. CI refuses to publish a build that lands here.
                // println rather than logger.warn: Flutter filters Gradle's
                // warn-level output, and an unsigned release that looks
                // successful is exactly the thing worth shouting about.
                println("")
                println(
                    "*** No ANDROID_KEYSTORE_PATH set, so this release APK is signed with the " +
                        "DEBUG key. Google Sign-In will not work in it, and it cannot be installed " +
                        "over a properly signed build. See docs/android-signing.md. ***"
                )
                println("")
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
