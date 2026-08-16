import CoreGraphics
import Foundation
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in info {
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  guard layer == 0 else { continue }
  let num = w[kCGWindowNumber as String] as? Int ?? 0
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
  let title = (w[kCGWindowName as String] as? String ?? "").replacingOccurrences(of: "\t", with: " ")
  print("\(num)\t\(owner)\t\(title)\t\(pid)")
}
