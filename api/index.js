name: Build APK

on:
  workflow_dispatch:
    inputs:
      app_name:
        description: 'App Name'
        required: true
        default: 'MyApp'
      package_name:
        description: 'Package Name'
        required: true
        default: 'com.studio.webapp'
      app_version:
        description: 'App Version'
        required: false
        default: '1.0.0'
  repository_dispatch:
    types: [build-apk]

permissions:
  contents: write
  actions: read

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up JDK 17
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Set up Android SDK
        uses: android-actions/setup-android@v3

      # =====================================================================
      # ANDROID PROJECT GENERATION / SCAFFOLDING STEP
      # (e.g. npx cap add android, react-native init, flutter create, etc.)
      # =====================================================================

      - name: Generate / Scaffold Android Project
        shell: bash
        run: |
          set -euo pipefail
          echo "🔧 Preparing Android project..."
          # ---------------------------------------------------------------
          # ⬇️ YOUR EXISTING ANDROID PROJECT GENERATION STEPS GO HERE
          # ---------------------------------------------------------------
          # Example (uncomment / adapt as per your project):
          # npx cap add android
          # OR: react-native init MyApp
          # OR: flutter create --platforms=android .
          echo "✅ Android project ready."

      # ============================================================
      # Google AdMob (Google Mobile Ads SDK) — BUILD-TIME DEPENDENCY
      # Idempotent: safe to run on every build, no duplicates added.
      # NOTE: No AdMob App ID / Ad Unit ID / API key is hardcoded here.
      #       Manifest App ID + SDK initialization are handled separately.
      # ============================================================
      - name: Configure Google Mobile Ads SDK dependency
        shell: bash
        run: |
          set -euo pipefail

          ADMOB_SDK_VERSION="23.2.0"
          ADMOB_DEP_LINE="implementation 'com.google.android.gms:play-services-ads:${ADMOB_SDK_VERSION}'"
          ADMOB_DEP_LINE_KTS="implementation(\"com.google.android.gms:play-services-ads:${ADMOB_SDK_VERSION}\")"

          echo "🔧 Locating Android app module Gradle file..."
          APP_GRADLE=""
          for f in \
            "app/build.gradle" \
            "app/build.gradle.kts" \
            "*/app/build.gradle" \
            "*/app/build.gradle.kts" \
            "android/app/build.gradle" \
            "android/app/build.gradle.kts"; do
            if [ -f "$f" ]; then APP_GRADLE="$f"; break; fi
          done

          if [ -z "$APP_GRADLE" ]; then
            echo "❌ Could not find app/build.gradle or app/build.gradle.kts"
            find . -maxdepth 4 -name "build.gradle*" -not -path "*/node_modules/*" || true
            exit 1
          fi
          echo "✅ Found app Gradle file: $APP_GRADLE"

          # ---- 1) Add Google Mobile Ads SDK dependency (idempotent) ----
          if grep -q "com.google.android.gms:play-services-ads" "$APP_GRADLE"; then
            echo "ℹ️ AdMob SDK dependency already present in $APP_GRADLE — skipping."
          else
            echo "➕ Adding Google Mobile Ads SDK $ADMOB_SDK_VERSION to $APP_GRADLE"
            case "$APP_GRADLE" in
              *.kts)
                if grep -qE '^[[:space:]]*dependencies[[:space:]]*\{' "$APP_GRADLE"; then
                  awk -v dep="$ADMOB_DEP_LINE_KTS" '
                    BEGIN { done=0 }
                    /^[[:space:]]*dependencies[[:space:]]*\{/ && !done {
                      print
                      print "    " dep
                      done=1
                      next
                    }
                    { print }
                  ' "$APP_GRADLE" > "$APP_GRADLE.tmp" && mv "$APP_GRADLE.tmp" "$APP_GRADLE"
                else
                  printf '\n\ndependencies {\n    %s\n}\n' "$ADMOB_DEP_LINE_KTS" >> "$APP_GRADLE"
                fi
                ;;
              *)
                if grep -qE '^[[:space:]]*dependencies[[:space:]]*\{' "$APP_GRADLE"; then
                  awk -v dep="$ADMOB_DEP_LINE" '
                    BEGIN { done=0 }
                    /^[[:space:]]*dependencies[[:space:]]*\{/ && !done {
                      print
                      print "    " dep
                      done=1
                      next
                    }
                    { print }
                  ' "$APP_GRADLE" > "$APP_GRADLE.tmp" && mv "$APP_GRADLE.tmp" "$APP_GRADLE"
                else
                  printf '\n\ndependencies {\n    %s\n}\n' "$ADMOB_DEP_LINE" >> "$APP_GRADLE"
                fi
                ;;
            esac
          fi

          # ---- 2) Ensure Google Maven repository is available (idempotent) ----
          echo "🔧 Ensuring Google Maven repository is declared..."
          SETTINGS_GRADLE=""
          for f in \
            "settings.gradle" \
            "settings.gradle.kts" \
            "*/settings.gradle" \
            "*/settings.gradle.kts" \
            "android/settings.gradle" \
            "android/settings.gradle.kts"; do
            if [ -f "$f" ]; then SETTINGS_GRADLE="$f"; break; fi
          done

          ROOT_GRADLE=""
          for f in \
            "build.gradle" \
            "build.gradle.kts" \
            "*/build.gradle" \
            "*/build.gradle.kts" \
            "android/build.gradle" \
            "android/build.gradle.kts"; do
            if [ -f "$f" ]; then ROOT_GRADLE="$f"; break; fi
          done

          ensure_google_repo() {
            local file="$1"
            [ -z "$file" ] && return 0
            if grep -qE 'google\(\)|maven\.google\.com' "$file"; then
              echo "ℹ️ Google Maven repo already present in $file"
              return 0
            fi
            echo "➕ Adding google() to repositories in $file"
            case "$file" in
              *.kts)
                awk '
                  BEGIN { done=0 }
                  /repositories[[:space:]]*\{/ && !done {
                    print
                    print "        google()"
                    done=1
                    next
                  }
                  { print }
                ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
                ;;
              *)
                awk '
                  BEGIN { done=0 }
                  /repositories[[:space:]]*\{/ && !done {
                    print
                    print "        google()"
                    done=1
                    next
                  }
                  { print }
                ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
                ;;
            esac
          }

          ensure_google_repo "$SETTINGS_GRADLE"
          ensure_google_repo "$ROOT_GRADLE"

          echo "✅ AdMob SDK configuration step completed."

      - name: Verify AdMob SDK configuration
        shell: bash
        run: |
          set -euo pipefail
          echo "🔎 Verifying AdMob SDK dependency and Google Maven repo..."
          FOUND_DEP=$(grep -R "com.google.android.gms:play-services-ads" --include='build.gradle' --include='build.gradle.kts' . | grep -v node_modules || true)
          echo "--- AdMob dependency lines ---"
          echo "${FOUND_DEP:-<none>}"
          FOUND_REPO=$(grep -R -E 'google\(\)|maven\.google\.com' --include='settings.gradle' --include='settings.gradle.kts' --include='build.gradle' --include='build.gradle.kts' . | grep -v node_modules || true)
          echo "--- Google Maven repo lines ---"
          echo "${FOUND_REPO:-<none>}"
          if [ -z "$FOUND_DEP" ]; then
            echo "❌ AdMob SDK dependency was not added!"
            exit 1
          fi
          if [ -z "$FOUND_REPO" ]; then
            echo "❌ Google Maven repo not found!"
            exit 1
          fi
          echo "✅ Verification passed."

      # =====================================================================
      # GRADLE BUILD STEP — UNCHANGED
      # =====================================================================
      - name: Build APK
        shell: bash
        working-directory: ./android
        run: |
          set -euo pipefail
          chmod +x ./gradlew
          ./gradlew assembleDebug --no-daemon

      # =====================================================================
      # ARTIFACT UPLOAD STEP — UNCHANGED
      # =====================================================================
      - name: Upload APK artifact
        uses: actions/upload-artifact@v4
        with:
          name: app-debug-apk
          path: |
            **/build/outputs/apk/debug/*.apk
            **/build/outputs/apk/**/*.apk
          if-no-files-found: warn