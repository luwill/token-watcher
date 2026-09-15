// Token Watcher 菜单栏胶囊：轮询本地 /api/summary，常驻显示今日消耗与配额。
// 编译：npm run build-bar
import AppKit
import Foundation
import UserNotifications

let API = URL(string: "http://127.0.0.1:8787/api/summary?days=1")!

struct Summary: Decodable {
  struct Totals: Decodable { var today_tokens: Int?; var all_time_tokens: Int? }
  struct Quota: Decodable {
    var codex: CodexQ?
    struct CodexQ: Decodable { var ts: Int?; var data: DataQ?
      struct DataQ: Decodable { var used_percent: Double?; var plan_type: String? } }
    var claude5h: ClaudeQ?
    struct ClaudeQ: Decodable { var active: Bool?; var window_tokens: Int?
      var window_ends_at: Double? }
  }
  struct Balance: Decodable { var provider: String?; var balance: Double?; var currency: String?; var id: String? }
  var totals: Totals?
  var quota: Quota?
  var balances: [Balance]?
}

func fmtTokens(_ n: Int) -> String {
  switch n {
  case 1_000_000...: return String(format: "%.1f亿", Double(n) / 1e8)
  case 10_000...: return String(format: "%.0f万", Double(n) / 1e4)
  default: return "\(n)"
  }
}

func fetchSummary() -> Summary? {
  guard let data = try? Data(contentsOf: API) else { return nil }
  return try? JSONDecoder().decode(Summary.self, from: data)
}

final class BarApp: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  var statusItem: NSStatusItem!
  var timer: Timer!
  var summary: Summary?
  var alertLevels: [String: Int] = [:]   // 条件键 -> 当前告警级别（0 恢复，1 警告，2 严重）

  func applicationDidFinishLaunching(_ notification: Notification) {
    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    rebuildMenu()
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.refresh() }
  }

  /** 阈值通知：仅在级别上升时发一次，恢复后重置 */
  func checkThresholds() {
    guard let s = summary else { return }
    var conditions: [(key: String, level: Int, title: String, body: String)] = []
    if let pct = s.quota?.codex?.data?.used_percent {
      if pct >= 95 { conditions.append(("codex", 2, "Codex 配额即将耗尽", String(format: "已用 %.0f%%，即将触发限速", pct))) }
      else if pct >= 80 { conditions.append(("codex", 1, "Codex 配额偏高", String(format: "已用 %.0f%%", pct))) }
    }
    for b in s.balances ?? [] where b.balance != nil {
      let key = "bal:\(b.id ?? b.provider ?? "?")"
      if b.balance! < 2 { conditions.append((key, 2, "\(b.provider ?? "?") 余额即将耗尽", String(format: "仅剩 ¥%.2f", b.balance!))) }
      else if b.balance! < 10 { conditions.append((key, 1, "\(b.provider ?? "?") 余额偏低", String(format: "剩余 ¥%.2f，建议充值", b.balance!))) }
    }
    var active = Set<String>()
    for c in conditions {
      active.insert(c.key)
      let prev = alertLevels[c.key] ?? 0
      if c.level > prev { notify(c.title, c.body) }
      alertLevels[c.key] = c.level
    }
    for (k, _) in alertLevels where !active.contains(k) { alertLevels[k] = 0 }
  }

  func notify(_ title: String, _ body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(req)
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter,
                             willPresent notification: UNNotification,
                             withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .sound])  // 前台也弹横幅
  }

  func refresh() {
    summary = fetchSummary()
    if let s = summary, let today = s.totals?.today_tokens {
      let codexPct = s.quota?.codex?.data?.used_percent.map { String(format: "·C%.0f%%", $0) } ?? ""
      statusItem.button?.title = "T\(fmtTokens(today))\(codexPct)"
    } else {
      statusItem.button?.title = "T--"
    }
    checkThresholds()
    rebuildMenu()
  }

  func rebuildMenu() {
    let menu = NSMenu()
    func add(_ title: String) { menu.addItem(NSMenuItem(title: title, action: nil, keyEquivalent: "")) }
    let s = summary
    add(s.map { "今日 \($0.totals?.today_tokens.map(fmtTokens) ?? "--") tokens" } ?? "TokenMeter：服务未启动")
    if let all = s?.totals?.all_time_tokens {
      add("累计 \(fmtTokens(all)) tokens")
    }
    menu.addItem(.separator())
    if let pct = s?.quota?.codex?.data?.used_percent, let plan = s?.quota?.codex?.data?.plan_type {
      add(String(format: "Codex（%@）：已用 %.1f%%", plan, pct))
    }
    if let c5 = s?.quota?.claude5h, c5.active == true, let w = c5.window_tokens {
      add("Claude 5h 窗口（推算）：\(fmtTokens(w)) tokens")
    }
    for b in s?.balances ?? [] where b.balance != nil {
      add(String(format: "%@ 余额：¥%.2f", b.provider ?? "?", b.balance!))
    }
    menu.addItem(.separator())
    let open = NSMenuItem(title: "打开面板", action: #selector(openDashboard), keyEquivalent: "o")
    open.target = self
    menu.addItem(open)
    let refreshItem = NSMenuItem(title: "立即刷新", action: #selector(refreshNow), keyEquivalent: "r")
    refreshItem.target = self
    menu.addItem(refreshItem)
    menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    statusItem.menu = menu
  }

  @objc func openDashboard() {
    NSWorkspace.shared.open(URL(string: "http://127.0.0.1:8787/")!)
  }

  @objc func refreshNow() { refresh() }
}

let app = NSApplication.shared
let delegate = BarApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
