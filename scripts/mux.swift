// Video + voice track → one MP4 (H.264 + AAC) under a size cap. AVFoundation only, no ffmpeg.
//   swift scripts/mux.swift <video.mp4> <voice.wav|.m4a|.aiff|.mp3> <out.mp4> [--trim] [--max-mb 12]
// The voice starts at 0. If it is longer than the video, the last video frame is held until the voice ends
// (or, with --trim, the voice is cut at the end of the video); if it is shorter, the rest of the video is silent.
// The video is decoded and re-encoded at a bitrate that keeps the file under --max-mb (it retries lower if needed);
// the voice is encoded as AAC 44.1 kHz. <out.mp4> may be the same file as <video.mp4>: it is replaced at the end.
import AVFoundation
import Foundation

func fail(_ s: String) -> Never { fputs("mux.swift: \(s)\n", stderr); exit(1) }
var args = Array(CommandLine.arguments.dropFirst())
let trim = args.contains("--trim"); args.removeAll { $0 == "--trim" }
var maxMB = 12.0
if let i = args.firstIndex(of: "--max-mb"), i + 1 < args.count { maxMB = Double(args[i + 1]) ?? 12; args.removeSubrange(i...(i + 1)) }
guard args.count == 3 else { fputs("usage: swift mux.swift <video.mp4> <voice.wav> <out.mp4> [--trim] [--max-mb 12]\n", stderr); exit(2) }
let videoURL = URL(fileURLWithPath: args[0]), voiceURL = URL(fileURLWithPath: args[1]), outURL = URL(fileURLWithPath: args[2])
let maxBytes = Int(maxMB * 1_000_000)

let vAsset = AVURLAsset(url: videoURL), aAsset = AVURLAsset(url: voiceURL)
guard let vTrack = try? await vAsset.loadTracks(withMediaType: .video).first else { fail("no video track in \(args[0])") }
guard let aTrack = try? await aAsset.loadTracks(withMediaType: .audio).first else { fail("no audio track in \(args[1])") }
let vDur = (try? await vAsset.load(.duration).seconds) ?? 0
let aDur = (try? await aAsset.load(.duration).seconds) ?? 0
let size = (try? await vTrack.load(.naturalSize)) ?? CGSize(width: 1440, height: 900)
let fps = Double((try? await vTrack.load(.nominalFrameRate)) ?? 24).rounded()
let fmt = try? await aTrack.load(.formatDescriptions).first
let srcChannels = fmt.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mChannelsPerFrame } ?? 1
let channels = Int(min(2, max(1, srcChannels)))
guard vDur > 0, aDur > 0 else { fail("could not read durations (video \(vDur) s, voice \(aDur) s)") }

let gap = aDur - vDur
let extend = gap > 0.5 / fps && !trim
let outDur = extend ? aDur : vDur
let plan = gap > 0.5 / fps
  ? (trim ? String(format: "voice is %.2f s longer than the video: voice trimmed at %.2f s", gap, vDur)
          : String(format: "voice is %.2f s longer than the video: last video frame held for %.2f s", gap, gap))
  : gap < -0.5 / fps ? String(format: "voice ends %.2f s before the video: the rest is silent", -gap) : "voice and video have the same length"
fputs("video \(String(format: "%.2f", vDur)) s \(Int(size.width))×\(Int(size.height)) @ \(Int(fps)) fps · voice \(String(format: "%.2f", aDur)) s, \(channels) ch\n\(plan)\n", stderr)

let audioBitrate = channels == 2 ? 128_000 : 96_000
let tmpURL = FileManager.default.temporaryDirectory.appendingPathComponent("explainer-mux-\(ProcessInfo.processInfo.processIdentifier).mp4")

final class Box<T>: @unchecked Sendable { var v: T; init(_ v: T) { self.v = v } }

func encode(videoBitrate: Int) -> Bool {
  try? FileManager.default.removeItem(at: tmpURL)
  guard let writer = try? AVAssetWriter(outputURL: tmpURL, fileType: .mp4),
        let vReader = try? AVAssetReader(asset: vAsset), let aReader = try? AVAssetReader(asset: aAsset) else { fail("cannot open reader/writer") }
  writer.shouldOptimizeForNetworkUse = true
  let vOut = AVAssetReaderTrackOutput(track: vTrack, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
  vOut.alwaysCopiesSampleData = false
  vReader.add(vOut)
  let aOut = AVAssetReaderTrackOutput(track: aTrack, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false, AVSampleRateKey: 44100, AVNumberOfChannelsKey: channels,
  ])
  aReader.add(aOut)
  let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Int(size.width), AVVideoHeightKey: Int(size.height),
    AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: videoBitrate, AVVideoMaxKeyFrameIntervalKey: Int(fps) * 10, AVVideoExpectedSourceFrameRateKey: Int(fps),
      AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel, AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC, AVVideoAllowFrameReorderingKey: true],
  ])
  vIn.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: nil)
  let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: audioBitrate])
  aIn.expectsMediaDataInRealTime = false
  writer.add(vIn); writer.add(aIn)
  guard vReader.startReading(), aReader.startReading() else { fail("startReading: \(String(describing: vReader.error ?? aReader.error))") }
  guard writer.startWriting() else { fail("startWriting: \(String(describing: writer.error))") }
  writer.startSession(atSourceTime: .zero)

  let group = DispatchGroup()
  let frameDur = CMTime(value: 1, timescale: CMTimeScale(fps))
  let last = Box<CVPixelBuffer?>(nil), next = Box(CMTime.zero), vDone = Box(false), aDone = Box(false), frames = Box(0), held = Box(0)
  let end = CMTime(seconds: outDur, preferredTimescale: 600)
  group.enter()
  vIn.requestMediaDataWhenReady(on: DispatchQueue(label: "mux.video")) {
    while vIn.isReadyForMoreMediaData && !vDone.v {
      if let sb = vOut.copyNextSampleBuffer() {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
        let t = CMSampleBufferGetPresentationTimeStamp(sb)
        if !adaptor.append(pb, withPresentationTime: t) { fputs("video append failed: \(String(describing: writer.error))\n", stderr) }
        last.v = pb; next.v = t + frameDur; frames.v += 1
      } else if extend, let pb = last.v, next.v < end {
        if !adaptor.append(pb, withPresentationTime: next.v) { fputs("hold append failed: \(String(describing: writer.error))\n", stderr) }
        next.v = next.v + frameDur; held.v += 1
      } else { vDone.v = true; vIn.markAsFinished(); group.leave() }
    }
  }
  group.enter()
  let cutAt = CMTime(seconds: vDur, preferredTimescale: 600)
  aIn.requestMediaDataWhenReady(on: DispatchQueue(label: "mux.audio")) {
    while aIn.isReadyForMoreMediaData && !aDone.v {
      guard let sb = aOut.copyNextSampleBuffer(), !(trim && CMSampleBufferGetPresentationTimeStamp(sb) >= cutAt) else {
        aDone.v = true; aIn.markAsFinished(); group.leave(); break
      }
      if !aIn.append(sb) { fputs("audio append failed: \(String(describing: writer.error))\n", stderr) }
    }
  }
  group.wait()
  let sem = DispatchSemaphore(value: 0)
  writer.finishWriting { sem.signal() }
  sem.wait()
  guard writer.status == .completed else { fputs("mux failed: \(String(describing: writer.error))\n", stderr); return false }
  fputs("encoded \(frames.v) frames\(held.v > 0 ? " + \(held.v) held" : "") at \(videoBitrate / 1000) kbps + AAC \(audioBitrate / 1000) kbps\n", stderr)
  return true
}

var videoBitrate = max(250_000, min(1_600_000, Int(Double(maxBytes) * 0.9 * 8 / outDur) - audioBitrate))
var bytes = 0
for attempt in 1...4 {
  guard encode(videoBitrate: videoBitrate) else { exit(1) }
  bytes = ((try? FileManager.default.attributesOfItem(atPath: tmpURL.path)[.size]) as? Int) ?? 0
  if bytes <= maxBytes || attempt == 4 { break }
  fputs(String(format: "%.2f MB is over %.0f MB, re-encoding lower\n", Double(bytes) / 1e6, maxMB), stderr)
  videoBitrate = Int(Double(videoBitrate) * Double(maxBytes) / Double(bytes) * 0.92)
}
try? FileManager.default.removeItem(at: outURL)
do { try FileManager.default.moveItem(at: tmpURL, to: outURL) } catch { fail("cannot write \(outURL.path): \(error)") }
print(String(format: "%@  %.2f MB  %.1f s  H.264 + AAC", outURL.path, Double(bytes) / 1e6, outDur))
if bytes > maxBytes { fputs("warning: still over \(maxMB) MB\n", stderr); exit(1) }
