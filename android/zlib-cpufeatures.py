# zlib's cpu_features.c calls android_getCpuFeatures(): build the NDK's cpufeatures into it.
import re, shutil
ndk = '/build/android-ndk-r30/sources/android/cpufeatures'
shutil.copy(f'{ndk}/cpu-features.c', 'deps/zlib/android_cpu_features.c')
shutil.copy(f'{ndk}/cpu-features.h', 'deps/zlib/cpu-features.h')
p = 'deps/zlib/zlib.gyp'
s = open(p).read()
s = re.sub(r"\n            \['OS==\"android\"', \{\n              'sources': \[ '<\(android_ndk_path\)[^\n]*\n[^\n]*\n            \}\],", '', s)
if 'android_cpu_features.c' not in s:
    i = s.index("'target_name': 'zlib',")
    j = s.index("'conditions': [", i) + len("'conditions': [")
    s = s[:j] + """
            ['OS=="android"', {
              'sources': [ 'android_cpu_features.c' ],
            }],""" + s[j:]
open(p, 'w').write(s)
