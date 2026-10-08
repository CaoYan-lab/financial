#!/usr/bin/env swift

import AppKit
import CoreGraphics
import Foundation

let outputURL: URL
if CommandLine.arguments.count == 2 {
    outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
} else {
    fputs("usage: render-app-icon.swift <output.png>\n", stderr)
    exit(64)
}

let size = 1024
guard
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ),
    let context = NSGraphicsContext(bitmapImageRep: bitmap)?.cgContext
else {
    fputs("failed to create icon canvas\n", stderr)
    exit(1)
}

let canvas = CGRect(x: 0, y: 0, width: size, height: size)
context.clear(canvas)
context.setAllowsAntialiasing(true)
context.setShouldAntialias(true)

let iconRect = CGRect(x: 54, y: 54, width: 916, height: 916)
let iconPath = CGPath(
    roundedRect: iconRect,
    cornerWidth: 218,
    cornerHeight: 218,
    transform: nil
)

context.saveGState()
context.setShadow(
    offset: CGSize(width: 0, height: -18),
    blur: 34,
    color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.36)
)
context.addPath(iconPath)
context.setFillColor(CGColor(red: 0.045, green: 0.055, blue: 0.063, alpha: 1))
context.fillPath()
context.restoreGState()

context.saveGState()
context.addPath(iconPath)
context.clip()

let backgroundGradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [
        CGColor(red: 0.15, green: 0.17, blue: 0.18, alpha: 1),
        CGColor(red: 0.035, green: 0.043, blue: 0.048, alpha: 1),
    ] as CFArray,
    locations: [0, 1]
)!
context.drawLinearGradient(
    backgroundGradient,
    start: CGPoint(x: 180, y: 900),
    end: CGPoint(x: 850, y: 130),
    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
)

context.setStrokeColor(CGColor(red: 0.72, green: 0.76, blue: 0.77, alpha: 0.10))
context.setLineWidth(2)
for coordinate in stride(from: 208, through: 816, by: 152) {
    context.move(to: CGPoint(x: coordinate, y: 190))
    context.addLine(to: CGPoint(x: coordinate, y: 834))
    context.strokePath()
    context.move(to: CGPoint(x: 190, y: coordinate))
    context.addLine(to: CGPoint(x: 834, y: coordinate))
    context.strokePath()
}

let candles: [(x: CGFloat, low: CGFloat, high: CGFloat, open: CGFloat, close: CGFloat, up: Bool)] = [
    (260, 300, 555, 368, 468, true),
    (390, 340, 665, 530, 430, false),
    (520, 430, 735, 492, 620, true),
    (650, 490, 810, 690, 572, false),
    (780, 575, 850, 630, 760, true),
]
for candle in candles {
    let color = candle.up
        ? CGColor(red: 0.12, green: 0.72, blue: 0.53, alpha: 0.50)
        : CGColor(red: 0.78, green: 0.82, blue: 0.82, alpha: 0.26)
    context.setStrokeColor(color)
    context.setFillColor(color)
    context.setLineWidth(12)
    context.setLineCap(.round)
    context.move(to: CGPoint(x: candle.x, y: candle.low))
    context.addLine(to: CGPoint(x: candle.x, y: candle.high))
    context.strokePath()
    let bodyBottom = min(candle.open, candle.close)
    let bodyHeight = max(abs(candle.close - candle.open), 38)
    context.fill(
        CGRect(
            x: candle.x - 34,
            y: bodyBottom,
            width: 68,
            height: bodyHeight
        )
    )
}

let trendPoints = [
    CGPoint(x: 218, y: 320),
    CGPoint(x: 352, y: 420),
    CGPoint(x: 474, y: 390),
    CGPoint(x: 602, y: 560),
    CGPoint(x: 738, y: 620),
    CGPoint(x: 824, y: 748),
]

context.saveGState()
context.setShadow(
    offset: .zero,
    blur: 22,
    color: CGColor(red: 0.04, green: 0.92, blue: 0.62, alpha: 0.48)
)
context.setStrokeColor(CGColor(red: 0.08, green: 0.88, blue: 0.59, alpha: 1))
context.setLineWidth(34)
context.setLineJoin(.round)
context.setLineCap(.round)
context.move(to: trendPoints[0])
for point in trendPoints.dropFirst() {
    context.addLine(to: point)
}
context.strokePath()
context.restoreGState()

let nodeIndices = [1, 3, 5]
for index in nodeIndices {
    let center = trendPoints[index]
    context.setShadow(
        offset: .zero,
        blur: 14,
        color: CGColor(red: 0.96, green: 0.72, blue: 0.20, alpha: 0.55)
    )
    context.setFillColor(CGColor(red: 0.96, green: 0.72, blue: 0.20, alpha: 1))
    context.fillEllipse(
        in: CGRect(x: center.x - 27, y: center.y - 27, width: 54, height: 54)
    )
    context.setShadow(offset: .zero, blur: 0, color: nil)
    context.setFillColor(CGColor(red: 0.17, green: 0.14, blue: 0.08, alpha: 1))
    context.fillEllipse(
        in: CGRect(x: center.x - 10, y: center.y - 10, width: 20, height: 20)
    )
}

context.restoreGState()

context.addPath(iconPath)
context.setStrokeColor(CGColor(red: 0.92, green: 0.95, blue: 0.94, alpha: 0.18))
context.setLineWidth(7)
context.strokePath()

guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
    fputs("failed to encode icon PNG\n", stderr)
    exit(1)
}

try FileManager.default.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
)
try pngData.write(to: outputURL, options: .atomic)
