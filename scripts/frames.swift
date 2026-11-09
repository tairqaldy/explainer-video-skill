// Check a finished video: print its tracks and loudness, and save sample frames as JPEGs. AVFoundation only.
//   swift scripts/frames.swift <video.mp4> <out-dir> [--at 1.5,7,12] [--labels intro,save,end] [--count 6] [--width 960]
// --at      times in seconds to grab (default: --count frames spread evenly over the video)
// --labels  file name for each --at time (default: frame-01 …)
// Prints e.g. "audio: 1 ch 44100 Hz, 42.9 s, peak -4.2 dBFS, sound in 81% of the time" so a missing or silent voice
// track shows up without listening to it.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ s: String) -> Never { fputs("frames.swift: \(s)\n", stderr); exit(1) }
var args = Array(CommandLine.arguments.dropFirst())
func opt(_ name: String) -> String? {
  guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
  let v = args[i + 1]; args.removeSubrange(i...(i + 1)); return v
}
let atArg = opt("at"), labelsArg = opt("labels"), count = Int(opt("count") ?? "6") ?? 6, width = Double(opt("width") ?? "960") ?? 960
guard args.count == 2 else { fputs("usage: swift frames.swift <video.mp4> <out-dir> [--at 1,5,9] [--labels a,b,c] [--count 6] [--width 960]\n", stderr); exit(2) }
let url = URL(fileURLWithPath: args[0]), outDir = URL(fileURLWithPath: args[1])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let asset = AVURLAsset(url: url)
let dur = (try? await asset.load(.duration).seconds) ?? 0
guard dur > 0 else { fail("cannot read \(args[0])") }
let size = (try? await url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
print(String(format: "file: %@  %.2f MB  %.2f s", url.lastPathComponent, Double(size) / 1e6, dur))

if let v = try? await asset.loadTracks(withMediaType: .video).first {
  let s = (try? await v.load(.naturalSize)) ?? .zero
  let fps = (try? await v.load(.nominalFrameRate)) ?? 0
  print(String(format: "video: %d×%d @ %.0f fps", Int(s.width), Int(s.height), fps))
} else { print("video: none") }

if let a = try? await asset.loadTracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: asset) {
  let out = AVAssetReaderTrackOutput(track: a, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1,
  ])
  reader.add(out)
  let fmt = try? await a.load(.formatDescriptions).first
  let ch = fmt.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mChannelsPerFrame } ?? 0
  let rate = fmt.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mSampleRate } ?? 0
  guard reader.startReading() else { fail("cannot read the audio track") }
  var peak: Int32 = 0, windows = 0, loud = 0, acc = 0.0, n = 0, samples = 0
  let win = 4410 // 100 ms
  while let sb = out.copyNextSampleBuffer() {
    guard let bb = CMSampleBufferGetDataBuffer(sb) else { continue }
    let len = CMBlockBufferGetDataLength(bb)
    var data = Data(count: len)
    data.withUnsafeMutableBytes { _ = CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: len, destination: $0.baseAddress!) }
    data.withUnsafeBytes { raw in
      for s in raw.bindMemory(to: Int16.self) {
        let v = Int32(s); peak = max(peak, abs(v)); acc += Double(v) * Double(v); n += 1; samples += 1
        if n == win { windows += 1; if 20 * log10(max(1e-9, sqrt(acc / Double(n)) / 32768)) > -45 { loud += 1 }; acc = 0; n = 0 }
      }
    }
  }
  let peakDb = 20 * log10(max(1e-9, Double(peak) / 32768))
  print(String(format: "audio: %d ch %.0f Hz, %.1f s, peak %.1f dBFS, sound in %.0f%% of the time%@", ch, rate, Double(samples) / 44100, peakDb,
               windows > 0 ? 100 * Double(loud) / Double(windows) : 0, peak < 300 ? "  ← looks silent" : ""))
} else { print("audio: none") }

var times: [Double] = atArg?.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) } ?? []
if times.isEmpty { times = (0..<max(1, count)).map { dur * (Double($0) + 0.5) / Double(max(1, count)) } }
let labels = labelsArg?.split(separator: ",").map(String.init) ?? []
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.maximumSize = CGSize(width: width, height: width * 10)
gen.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 24)
gen.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 24)
for (i, t) in times.enumerated() {
  let at = CMTime(seconds: min(max(0, t), dur - 0.05), preferredTimescale: 600)
  guard let (img, _) = try? await gen.image(at: at) else { fputs("no frame at \(t) s\n", stderr); continue }
  let name = (i < labels.count ? labels[i] : String(format: "frame-%02d", i + 1)) + ".jpg"
  let dest = outDir.appendingPathComponent(name)
  guard let d = CGImageDestinationCreateWithURL(dest as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { continue }
  CGImageDestinationAddImage(d, img, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
  if CGImageDestinationFinalize(d) { print(String(format: "%6.2f s  %@", t, dest.path)) }
}
