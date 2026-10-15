// Prints the default output device's real output latency (ms) as a JSON line,
// and again whenever it changes (device switched, buffer size changed).
// Used by sdl/host.mjs: node-web-audio-api reports only part of it.
//
// latency = device latency + safety offset + stream latency   (the hardware)
//         + 2 × I/O buffer                                     (CoreAudio double-buffers)
import CoreAudio
import Foundation

func prop<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ zero: T) -> T? {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var value = zero
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func measure() -> (ms: Double, name: String)? {
    guard let dev: AudioDeviceID = prop(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, AudioDeviceID(0)), dev != 0 else { return nil }
    let out = kAudioDevicePropertyScopeOutput
    let rate: Float64 = prop(dev, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, Float64(0)) ?? 48000
    let latency: UInt32 = prop(dev, kAudioDevicePropertyLatency, out, UInt32(0)) ?? 0
    let safety: UInt32 = prop(dev, kAudioDevicePropertySafetyOffset, out, UInt32(0)) ?? 0
    let buffer: UInt32 = prop(dev, kAudioDevicePropertyBufferFrameSize, out, UInt32(0)) ?? 0
    var streamLatency: UInt32 = 0
    if let stream: AudioStreamID = prop(dev, kAudioDevicePropertyStreams, out, AudioStreamID(0)), stream != 0 {
        streamLatency = prop(stream, kAudioStreamPropertyLatency, kAudioObjectPropertyScopeGlobal, UInt32(0)) ?? 0
    }
    var name: CFString = "" as CFString
    var addr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<CFString>.size)
    _ = withUnsafeMutablePointer(to: &name) { AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, $0) }
    let frames = Double(latency + safety + streamLatency) + 2 * Double(buffer)
    return (frames / max(1, rate) * 1000, name as String)
}

setvbuf(stdout, nil, _IOLBF, 0)
var last = ""
while true {
    if let m = measure() {
        let line = String(format: "{\"ms\":%.2f,\"device\":\"%@\"}", m.ms, m.name.replacingOccurrences(of: "\"", with: "'"))
        if line != last {
            print(line)
            last = line
        }
    }
    Thread.sleep(forTimeInterval: 1)
}
