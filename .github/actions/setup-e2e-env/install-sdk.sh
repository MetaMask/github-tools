#!/bin/bash -e -o pipefail

# Android SDK installer following GitHub runner pattern

ANDROID_HOME=/usr/local/lib/android/sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest:$ANDROID_HOME/cmdline-tools/latest/bin

SDKMANAGER=$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager

# Accept all licenses first - this is crucial for NDK and other components
echo "Accepting all SDK licenses..."
yes | $SDKMANAGER --licenses

echo "Installing latest tools & platform tools..."
echo y | $SDKMANAGER "tools" "platform-tools"

echo "Installing NDK..."
echo y | $SDKMANAGER "ndk;${NDK_VERSION}"

# Build components array for batch installation
components=()
components+=("platforms;android-${ANDROID_API_LEVEL}")
components+=("build-tools;34.0.0")
components+=("emulator")
components+=("system-images;android-${ANDROID_API_LEVEL};google_apis;${ANDROID_ABI}")

echo "Installing SDK components: ${components[@]}"
echo y | $SDKMANAGER ${components[@]}

echo "Verifying installed packages..."
$SDKMANAGER --list_installed | grep "system-images"
$SDKMANAGER --list_installed | grep "ndk"

echo "✅ Android SDK packages installed successfully" 
