// Decodes a song with osu!lazer's own BASS library, the way osu-framework's
// TrackBass opens it (Decode | Prescan), so song time 0 is exactly where lazer
// (and stable, whose maps are timed against BASS) puts it: BASS drops the MP3
// encoder/decoder delay its own way, which no other decoder matches on every file.
//
//   bass-decode <libbass.dylib>  < song bytes  > "rate channels frames\n" + float32 interleaved
//
// Used by sdl/host.mjs (compiled once into ~/.wosu/cache).
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef uint32_t DWORD;
typedef uint64_t QWORD;
typedef int BOOL;
typedef struct { DWORD freq, chans, flags, ctype, origres, plugin, sample; const char *filename; } ChannelInfo;

#define BASS_STREAM_DECODE 0x200000
#define BASS_STREAM_PRESCAN 0x20000
#define BASS_SAMPLE_FLOAT 256
#define BASS_DATA_FLOAT 0x40000000
#define BASS_POS_BYTE 0

int main(int argc, char **argv) {
    if (argc < 2) return 64;
    void *lib = dlopen(argv[1], RTLD_NOW);
    if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    BOOL (*Init)(int, DWORD, DWORD, void *, void *) = dlsym(lib, "BASS_Init");
    DWORD (*CreateFile)(BOOL, const void *, QWORD, QWORD, DWORD) = dlsym(lib, "BASS_StreamCreateFile");
    DWORD (*GetData)(DWORD, void *, DWORD) = dlsym(lib, "BASS_ChannelGetData");
    BOOL (*GetInfo)(DWORD, ChannelInfo *) = dlsym(lib, "BASS_ChannelGetInfo");
    QWORD (*GetLength)(DWORD, DWORD) = dlsym(lib, "BASS_ChannelGetLength");
    int (*ErrorCode)(void) = dlsym(lib, "BASS_ErrorGetCode");
    if (!Init || !CreateFile || !GetData || !GetInfo || !GetLength) { fprintf(stderr, "missing BASS symbols\n"); return 1; }

    // The whole file from stdin (BASS reads it from memory).
    size_t cap = 1 << 24, len = 0;
    unsigned char *data = malloc(cap);
    for (size_t n; (n = fread(data + len, 1, cap - len, stdin)) > 0;) {
        len += n;
        if (len == cap) data = realloc(data, cap *= 2);
    }

    Init(0, 48000, 0, NULL, NULL); // device 0: no output, decoding only
    DWORD stream = CreateFile(1, data, 0, len, BASS_STREAM_DECODE | BASS_STREAM_PRESCAN | BASS_SAMPLE_FLOAT);
    if (!stream) { fprintf(stderr, "BASS_StreamCreateFile failed (%d)\n", ErrorCode ? ErrorCode() : -1); return 2; }
    ChannelInfo info;
    GetInfo(stream, &info);
    QWORD bytes = GetLength(stream, BASS_POS_BYTE);
    QWORD frames = bytes / (4 * (QWORD)info.chans);
    printf("%u %u %llu\n", info.freq, info.chans, (unsigned long long)frames);

    static float buf[65536];
    QWORD written = 0, want = frames * info.chans * 4;
    while (written < want) {
        DWORD n = GetData(stream, buf, sizeof buf | BASS_DATA_FLOAT);
        if (n == (DWORD)-1 || n == 0) break;
        if (written + n > want) n = (DWORD)(want - written);
        fwrite(buf, 1, n, stdout);
        written += n;
    }
    // Pad if BASS delivered less than it announced.
    memset(buf, 0, sizeof buf);
    while (written < want) {
        QWORD n = want - written < sizeof buf ? want - written : sizeof buf;
        fwrite(buf, 1, n, stdout);
        written += n;
    }
    return 0;
}
