# BASS

`libbass.dylib` (macOS, universal x86_64/i386/arm64) is BASS 2.4 by Un4seen Developments
(https://www.un4seen.com), copied from the osu!lazer app, which ships the same library.
The SDL host decodes songs with it (`sdl/bass-decode.c`) so song time matches osu!/lazer exactly.

BASS is free for non-commercial use; see https://www.un4seen.com/bass.html#license.
Windows (`bass.dll`) and Linux (`libbass.so`) builds go in `win32/` and `linux/` when those are packaged.
