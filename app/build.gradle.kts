plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.futureprice.app"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "dev.futureprice.app"
        minSdk = 34
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-dev"
        // 仅测试 APK：对合成截图跑 OCR 与产品识别逻辑。
        testInstrumentationRunner = "dev.futureprice.app.OcrSnapshotInstrumentation"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
    // 打包版中文 OCR，供后续采集识别使用。
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
    testImplementation("junit:junit:4.13.2")
}
