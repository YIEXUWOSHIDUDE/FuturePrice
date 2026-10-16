# Source this file from bash or zsh: source scripts/android-env.sh
# Select Android's JDK in this shell without changing the system Java default.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${FUTUREPRICE_JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
# This Mac reaches Google's Maven host over IPv6; IPv4 Java requests time out.
# Keep the preference scoped to shells that opt into this project environment.
case " ${JAVA_TOOL_OPTIONS:-} " in
  *"-Djava.net.preferIPv6Addresses="*) ;;
  *) export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Djava.net.preferIPv6Addresses=true" ;;
esac
