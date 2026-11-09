// JPEG frame sequence → silent H.264 MP4 with burned-in captions. AVFoundation only: no ffmpeg, no packages.
//   swift scripts/encode.swift <manifest.json> <out.mp4>
//
// manifest.json (written by record.mjs):
//   { "dir": "/tmp/…/frames", "fps": 24, "width": 1440, "height": 900, "bitrate": 6000000, "duration_ms": 43000,
//     "keyframe_s": 6, "frames": [{ "t": 0, "f": "000001.jpg" }, …],
//     "captions": [{ "start": ms, "end": ms, "text": "…" }],      optional: drawn as a dark pill, fades in and out
//     "crops": [[x, y, w, h] | null, …] }                         optional, one per output frame: camera zoom
// Output frame k (time k/fps) shows the last captured frame with t ≤ k/fps, so a still screen is the same frame
// repeated (it costs almost no bits) and the video runs at a constant frame rate. Captions are drawn after the crop,
// so a zoom never cuts them. Long captions wrap onto a second line.
import AVFoundation
import CoreGraphics
import CoreText
import CoreVideo
import Foundation
import ImageIO

struct Frame: Decodable { let t: Double; let f: String }
struct Caption: Decodable { let start: Double; let end: Double; let text: String }
struct Manifest: Decodable {
  let dir: String; let fps: Int; let width: Int; let height: Int; let bitrate: Int; let duration_ms: Double; let frames: [Frame]
  let keyframe_s: Int?
  let crops: [[Double]?]?
  let captions: [Caption]?
}

let args = CommandLine.arguments
guard args.count >= 3 else { fputs("usage: swift encode.swift <manifest.json> <out.mp4>\n", stderr); exit(2) }
let m: Manifest
do { m = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: URL(fileURLWithPath: args[1]))) }
catch { fputs("encode.swift: bad manifest: \(error)\n", stderr); exit(2) }
guard !m.frames.isEmpty else { fputs("encode.swift: no frames\n", stderr); exit(2) }

let out = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: out)
let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: out, fileType: .mp4) } catch { fputs("encode.swift: writer: \(error)\n", stderr); exit(1) }
writer.shouldOptimizeForNetworkUse = true // moov atom first: a page can start playing before the download ends

let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: m.width,
  AVVideoHeightKey: m.height,
  AVVideoColorPropertiesKey: [
    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
  ],
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: m.bitrate,
    // screen recordings are mostly still: rare keyframes leave the bits for scrolling and transitions
    AVVideoMaxKeyFrameIntervalKey: m.fps * (m.keyframe_s ?? 10),
    AVVideoExpectedSourceFrameRateKey: m.fps,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
    AVVideoAllowFrameReorderingKey: true,
  ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: m.width,
  kCVPixelBufferHeightKey as String: m.height,
])
writer.add(input)
guard writer.startWriting() else { fputs("encode.swift: startWriting: \(String(describing: writer.error))\n", stderr); exit(1) }
writer.startSession(atSourceTime: .zero)

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
func loadImage(_ file: String) -> CGImage? {
  let url = URL(fileURLWithPath: m.dir).appendingPathComponent(file) as CFURL
  guard let src = CGImageSourceCreateWithURL(url, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
}

// Caption pill: bold system font, white on #0e151c, near the bottom edge, fades and slides over 180 ms.
// Sizes are tuned for 1440 px wide and scale with the video width.
let k = CGFloat(m.width) / 1440
let capFont = CTFontCreateUIFontForLanguage(.emphasizedSystem, 31 * k, nil)!
let padX = 36 * k, padY = 17 * k, bottom = 30 * k, lineGap = 6 * k
let maxTextWidth = CGFloat(m.width) - 2 * (90 * k) - 2 * padX
let ink = CGColor(red: 14 / 255, green: 21 / 255, blue: 28 / 255, alpha: 1)

func wrap(_ text: String) -> [CTLine] {
  let attr = NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): capFont,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 1, green: 1, blue: 1, alpha: 1)])
  let ts = CTTypesetterCreateWithAttributedString(attr)
  var lines: [CTLine] = [], start = 0
  while start < attr.length {
    let n = CTTypesetterSuggestLineBreak(ts, start, Double(maxTextWidth))
    if n <= 0 { break }
    lines.append(CTTypesetterCreateLine(ts, CFRange(location: start, length: n)))
    start += n
  }
  return lines
}
var wrapped: [String: [CTLine]] = [:]
func drawCaption(_ ctx: CGContext, _ text: String, _ alpha: Double) {
  let lines = wrapped[text] ?? wrap(text); wrapped[text] = lines
  guard !lines.isEmpty else { return }
  var asc: CGFloat = 0, desc: CGFloat = 0, lead: CGFloat = 0
  var widths: [CGFloat] = []
  for l in lines { widths.append(CGFloat(CTLineGetTypographicBounds(l, &asc, &desc, &lead))) }
  let lineH = asc + desc
  let tw = widths.max() ?? 0
  let ph = 2 * padY + CGFloat(lines.count) * lineH + CGFloat(lines.count - 1) * lineGap, pw = tw + 2 * padX
  let py = bottom - 10 * k * CGFloat(1 - alpha)
  let pill = CGRect(x: (CGFloat(m.width) - pw) / 2, y: py, width: pw, height: ph)
  let radius = min(ph / 2, (lineH + 2 * padY) / 2)
  ctx.saveGState()
  ctx.setAlpha(CGFloat(alpha))
  ctx.setShadow(offset: CGSize(width: 0, height: -10 * k), blur: 36 * k, color: CGColor(red: 14 / 255, green: 21 / 255, blue: 28 / 255, alpha: 0.28))
  ctx.addPath(CGPath(roundedRect: pill, cornerWidth: radius, cornerHeight: radius, transform: nil))
  ctx.setFillColor(ink); ctx.fillPath()
  ctx.setShadow(offset: .zero, blur: 0, color: nil)
  // CoreGraphics has its origin at the bottom left: the first line is drawn highest
  for (i, l) in lines.enumerated() {
    let y = pill.maxY - padY - asc - CGFloat(i) * (lineH + lineGap)
    ctx.textPosition = CGPoint(x: (CGFloat(m.width) - widths[i]) / 2, y: y)
    CTLineDraw(l, ctx)
  }
  ctx.restoreGState()
}
func captionAt(_ tms: Double) -> (String, Double)? {
  guard let caps = m.captions, let c = caps.last(where: { $0.start <= tms && tms < $0.end }) else { return nil }
  let a = min(1, (tms - c.start) / 180, (c.end - tms) / 180)
  return (c.text, max(0, a))
}
func render(_ img: CGImage, _ crop: [Double]?, _ cap: (String, Double)?) -> CVPixelBuffer? {
  guard let pool = adaptor.pixelBufferPool else { return nil }
  var pb: CVPixelBuffer?
  guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb) == kCVReturnSuccess, let b = pb else { return nil }
  CVPixelBufferLockBaseAddress(b, [])
  defer { CVPixelBufferUnlockBaseAddress(b, []) }
  guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(b), width: m.width, height: m.height, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(b), space: srgb,
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
  ctx.interpolationQuality = .high
  let full = CGRect(x: 0, y: 0, width: m.width, height: m.height)
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); ctx.fill(full)
  if let c = crop, c.count == 4 {
    // page pixels (top-left origin) → scale the crop up to the full frame; drawing the whole image scaled and shifted
    // keeps sub-pixel camera motion smooth (CGImage.cropping would snap to whole pixels)
    let s = Double(m.width) / c[2]
    let dx = -c[0] * s, dy = -(Double(img.height) - c[1] - c[3]) * s
    ctx.saveGState(); ctx.clip(to: full)
    ctx.draw(img, in: CGRect(x: dx, y: dy, width: Double(img.width) * s, height: Double(img.height) * s))
    ctx.restoreGState()
  } else {
    ctx.draw(img, in: full)
  }
  if let (text, a) = cap, a > 0.01 { drawCaption(ctx, text, a) }
  return b
}

let total = Int((m.duration_ms / 1000.0 * Double(m.fps)).rounded(.up))
var shown = -1
var image: CGImage?
var current: CVPixelBuffer?
var lastKey = ""
var decoded = 0
for f in 0..<total {
  let tms = Double(f) * 1000.0 / Double(m.fps)
  var j = max(shown, 0)
  while j + 1 < m.frames.count && m.frames[j + 1].t <= tms { j += 1 }
  if j != shown || image == nil {
    if let img = loadImage(m.frames[j].f) { image = img; decoded += 1 } else { fputs("skip unreadable frame \(m.frames[j].f)\n", stderr) }
    shown = j
  }
  let crop = (m.crops != nil && f < m.crops!.count) ? m.crops![f] : nil
  let cap = captionAt(tms)
  let key = "\(shown)|\(crop.map { "\($0)" } ?? "-")|\(cap.map { "\($0.0)\(String(format: "%.2f", $0.1))" } ?? "-")"
  if key != lastKey || current == nil, let img = image { current = render(img, crop, cap); lastKey = key }
  guard let b = current else { continue }
  while !input.isReadyForMoreMediaData { usleep(500) }
  if !adaptor.append(b, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: CMTimeScale(m.fps))) {
    fputs("encode.swift: append failed at frame \(f): \(String(describing: writer.error))\n", stderr); exit(1)
  }
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { fputs("encode.swift: failed: \(String(describing: writer.error))\n", stderr); exit(1) }
print("encoded \(total) frames (\(decoded) distinct) at \(m.fps) fps, \(m.width)x\(m.height), \(m.bitrate / 1000) kbps")
