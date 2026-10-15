set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq python3 g++ make curl unzip xz-utils patch >/dev/null
cd /build
[ -d android-ndk-r30 ] || { curl -sLo ndk.zip https://dl.google.com/android/repository/android-ndk-r30-linux.zip && unzip -q ndk.zip && rm ndk.zip; }
[ -d node-v26.12.0 ] || curl -sL https://nodejs.org/dist/v26.12.0/node-v26.12.0.tar.xz | tar xJ
cd node-v26.12.0
sed -i 's#--cross-compiling")#--cross-compiling --shared --without-npm")#' android_configure.py
python3 android_configure.py patch || true
python3 /out/zlib-cpufeatures.py; export CC_host=gcc CXX_host=g++ AR_host=ar LINK_host=g++; ./android-configure /build/android-ndk-r30 29 arm64
make -j2 2>&1 | tail -40
ls -la out/Release/*.so* || true
