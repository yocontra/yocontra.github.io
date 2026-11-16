// Host evidence sidecar for Chrome and Simulator: no window titles or other app content.
import AppKit
import CoreGraphics
import Foundation

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "65") ?? 65
let started = Date()
repeat {
    let front = NSWorkspace.shared.frontmostApplication
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let own = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == front?.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }
    var load = [Double](repeating: 0, count: 3)
    getloadavg(&load, 3)
    let sample: [String: Any] = [
        "wall": Date().timeIntervalSince1970 * 1000,
        "bundle": front?.bundleIdentifier ?? "unknown",
        "pid": Int(front?.processIdentifier ?? 0),
        "onScreenWindows": own.count,
        "windowIds": own.compactMap { $0[kCGWindowNumber as String] },
        "loadAverage": load,
        "logicalProcessors": ProcessInfo.processInfo.processorCount,
        "windowBounds": own.compactMap { $0[kCGWindowBounds as String] }
    ]
    if let data = try? JSONSerialization.data(withJSONObject: sample, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
    // NSWorkspace delivers frontmost-application changes on the main run loop.
    RunLoop.current.run(until: Date().addingTimeInterval(1))
} while Date().timeIntervalSince(started) < seconds
