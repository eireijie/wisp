plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.warren.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.warren.android"
        minSdk = 26
        targetSdk = 35
        // release builds get these from the tag (see .github/workflows/desktop-release.yml)
        versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // signed with the debug key until there's a Play Console upload key, so testers can sideload it
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    // Google's ready-made QR scanner (through Play services): no camera permission for Warren itself
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
