// Draws Scanline's icon at 1024×1024: a near-black tile, a glowing level meter, and the
// scanline across it. Run with `swift draw.swift out.png`; make.sh turns it into AppIcon.icns.
import AppKit

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))

image.lockFocus()

let context = NSGraphicsContext.current!.cgContext
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let corner = 185.0

// The tile.
context.saveGState()
context.addPath(CGPath(roundedRect: tile, cornerWidth: corner, cornerHeight: corner, transform: nil))
context.clip()
let colours = [CGColor(red: 0.07, green: 0.08, blue: 0.10, alpha: 1), CGColor(red: 0.02, green: 0.025, blue: 0.035, alpha: 1)] as CFArray
let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colours, locations: [0, 1])!
context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 924), end: CGPoint(x: 0, y: 100), options: [])

// A faint grid.
context.setStrokeColor(CGColor(red: 0.3, green: 0.36, blue: 0.45, alpha: 0.18))
context.setLineWidth(3)
for step in 1..<6 {
    let at = 100 + Double(step) * 824 / 6
    context.move(to: CGPoint(x: 100, y: at)); context.addLine(to: CGPoint(x: 924, y: at))
    context.move(to: CGPoint(x: at, y: 100)); context.addLine(to: CGPoint(x: at, y: 924))
}
context.strokePath()

// Five columns of meter segments, lit to different heights, green to blue.
let lit = [5, 8, 6, 10, 7]
let hues: [(Double, Double, Double)] = [(0.29, 0.87, 0.5), (0.29, 0.87, 0.5), (0.38, 0.65, 0.98), (0.38, 0.65, 0.98), (0.75, 0.52, 0.99)]
for column in 0..<5 {
    let x = 200 + Double(column) * 128
    let (r, g, b) = hues[column]
    for segment in 0..<11 {
        let y = 190 + Double(segment) * 52
        let on = segment < lit[column]
        let rect = CGRect(x: x, y: y, width: 96, height: 36)
        if on {
            context.setShadow(offset: .zero, blur: 28, color: CGColor(red: r, green: g, blue: b, alpha: 0.9))
            context.setFillColor(CGColor(red: r, green: g, blue: b, alpha: 1))
        } else {
            context.setShadow(offset: .zero, blur: 0, color: nil)
            context.setFillColor(CGColor(red: r, green: g, blue: b, alpha: 0.12))
        }
        context.addPath(CGPath(roundedRect: rect, cornerWidth: 9, cornerHeight: 9, transform: nil))
        context.fillPath()
    }
}

// The scanline: a bright line across, with its glow.
context.setShadow(offset: .zero, blur: 50, color: CGColor(red: 0.85, green: 1, blue: 0.9, alpha: 1))
context.setFillColor(CGColor(red: 0.92, green: 1, blue: 0.95, alpha: 1))
context.fill(CGRect(x: 100, y: 612, width: 824, height: 14))
context.restoreGState()

// The tile's edge.
context.addPath(CGPath(roundedRect: tile.insetBy(dx: 3, dy: 3), cornerWidth: corner - 3, cornerHeight: corner - 3, transform: nil))
context.setStrokeColor(CGColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 0.45))
context.setLineWidth(6)
context.strokePath()

image.unlockFocus()

let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
