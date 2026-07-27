import Vision
import AppKit
import CoreImage

// Person-segmentation matte, via macOS's Vision framework
// (VNGeneratePersonSegmentationRequest — the same tech behind Portrait
// Mode / FaceTime background replacement). Local and free, no API call
// and no per-image cost, which is why compositing (matte.ts) is built on
// this instead of an identity-generating model: the subject in the output
// is literally the user's own pixels, never synthesized.
//
// Batch mode (one process, many frames) rather than one process per
// image: process startup + Vision model load is a fixed ~0.3-0.4s tax
// per invocation, which would dominate wall time across a video clip's
// worth of frames (hundreds) if paid once per frame.
//
// usage: swift matte.swift <input_dir> <output_dir>
// Every *.png in input_dir gets a same-named grayscale alpha mask (white
// = person) written to output_dir, at the source image's own resolution
// — Vision's raw output buffer is a different, fixed resolution, so this
// upscales/downscales the mask back to match before writing it, sparing
// every caller from handling that mismatch itself.

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: matte.swift <input_dir> <output_dir>\n".data(using: .utf8)!)
    exit(1)
}
let inputDir = args[1]
let outputDir = args[2]

let fm = FileManager.default
try? fm.createDirectory(atPath: outputDir, withIntermediateDirectories: true)

guard let entries = try? fm.contentsOfDirectory(atPath: inputDir) else {
    FileHandle.standardError.write("failed to list \(inputDir)\n".data(using: .utf8)!)
    exit(1)
}
let inputs = entries.filter { $0.lowercased().hasSuffix(".png") }.sorted()

let context = CIContext()
var failures = 0

for name in inputs {
    let inputPath = "\(inputDir)/\(name)"
    let outputPath = "\(outputDir)/\(name)"

    guard let nsImage = NSImage(contentsOfFile: inputPath),
          let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("failed to load \(inputPath)\n".data(using: .utf8)!)
        failures += 1
        continue
    }

    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        FileHandle.standardError.write("Vision request failed for \(name): \(error)\n".data(using: .utf8)!)
        failures += 1
        continue
    }

    guard let result = request.results?.first else {
        FileHandle.standardError.write("no segmentation result for \(name)\n".data(using: .utf8)!)
        failures += 1
        continue
    }

    // Scale the mask back to the source image's own pixel size (a
    // CIAffineTransform on the CIImage, done once here, instead of a
    // separate ffmpeg pass per frame afterward).
    let maskImage = CIImage(cvPixelBuffer: result.pixelBuffer)
    let sx = CGFloat(cgImage.width) / maskImage.extent.width
    let sy = CGFloat(cgImage.height) / maskImage.extent.height
    let scaled = maskImage.transformed(by: CGAffineTransform(scaleX: sx, y: sy))

    guard let outputCG = context.createCGImage(scaled, from: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height)) else {
        FileHandle.standardError.write("failed to create output cgimage for \(name)\n".data(using: .utf8)!)
        failures += 1
        continue
    }

    let rep = NSBitmapImageRep(cgImage: outputCG)
    guard let pngData = rep.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write("failed to encode png for \(name)\n".data(using: .utf8)!)
        failures += 1
        continue
    }
    try? pngData.write(to: URL(fileURLWithPath: outputPath))
}

if failures > 0 {
    FileHandle.standardError.write("\(failures)/\(inputs.count) frames failed\n".data(using: .utf8)!)
    exit(failures == inputs.count ? 1 : 0)
}
