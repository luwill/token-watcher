// Token Watcher 菜单栏胶囊：轮询本地 /api/summary，常驻显示今日消耗与配额。
// 编译：npm run build-bar
import AppKit
import Foundation
import UserNotifications

// 端口来自 `token-watcher bar --port N`（经 open --args 传入）；直接双击启动时取默认值。
// 写死端口会让 `serve --port 9000` 的用户拿到一个连不上的胶囊。
let PORT: Int = {
  let a = CommandLine.arguments
  if let i = a.firstIndex(of: "--port"), i + 1 < a.count, let p = Int(a[i + 1]) { return p }
  return 8787
}()
let BASE = "http://127.0.0.1:\(PORT)"
let API = URL(string: "\(BASE)/api/summary?days=1")!

struct Summary: Decodable {
  struct Totals: Decodable { var today_tokens: Int?; var all_time_tokens: Int? }
  struct Quota: Decodable {
    var codex: CodexQ?
    struct CodexQ: Decodable { var ts: Int?; var data: DataQ?
      // 后端（src/codexQuota.js）输出窗口列表；平铺的 used_percent 是 1.8 之前的旧形态，留作兜底
      struct DataQ: Decodable { var windows: [Window]?; var used_percent: Double?; var plan_type: String? }
      struct Window: Decodable { var window_minutes: Double?; var used_percent: Double? }
      /// 胶囊看最紧的那个窗口（已用比例最高者）
      var usedPercent: Double? {
        let pcts = (data?.windows ?? []).compactMap { $0.used_percent }
        return pcts.max() ?? data?.used_percent
      }
      /// 菜单逐窗口列出：5h / 周 / 其他按分钟数
      var windowLines: [(label: String, pct: Double)] {
        (data?.windows ?? []).compactMap { w in
          guard let pct = w.used_percent else { return nil }
          let m = Int(w.window_minutes ?? 0)
          let label = m == 300 ? "5h" : m == 10080 ? "周" : m > 0 ? "\(m)分钟" : "窗口"
          return (label, pct)
        }
      }
    }
    var claude5h: ClaudeQ?
    struct ClaudeQ: Decodable { var active: Bool?; var window_tokens: Int?
      var window_ends_at: Double? }
  }
  struct Balance: Decodable { var provider: String?; var balance: Double?; var currency: String?; var id: String? }
  struct AlertItem: Decodable {
    var key: String
    var rule_id: String
    var metric: String
    var level: String
    var value: Double
    var threshold: Double
    var title: String
    var body: String
  }
  // 每项独立解码：坏项不会让整份 summary 失效。
  struct AlertEntry: Decodable {
    var item: AlertItem?
    init(from decoder: Decoder) throws {
      let decoded = try? AlertItem(from: decoder)
      item = decoded.flatMap { ["warn", "crit"].contains($0.level) && !$0.key.isEmpty ? $0 : nil }
    }
  }
  struct Alerts: Decodable {
    var items: [AlertItem] = []
    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      items = ((try? c.decode([AlertEntry].self, forKey: .items)) ?? []).compactMap { $0.item }
    }
    enum CodingKeys: String, CodingKey { case items }
  }
  var alerts: Alerts?
  enum CodingKeys: String, CodingKey { case totals, quota, balances, alerts }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    totals = try c.decodeIfPresent(Totals.self, forKey: .totals)
    quota = try c.decodeIfPresent(Quota.self, forKey: .quota)
    balances = try c.decodeIfPresent([Balance].self, forKey: .balances)
    alerts = try? c.decodeIfPresent(Alerts.self, forKey: .alerts)
  }
  var totals: Totals?
  var quota: Quota?
  var balances: [Balance]?
}

func fmtTokens(_ n: Int) -> String {
  switch n {
  case 100_000_000...: return String(format: "%.1f亿", Double(n) / 1e8)
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
    let conditions = (s.alerts?.items ?? []).map {
      (key: $0.key, level: $0.level == "crit" ? 2 : 1, title: $0.title, body: $0.body)
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
      let codexPct = s.quota?.codex?.usedPercent.map { String(format: "·C%.0f%%", $0) } ?? ""
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
    if let codex = s?.quota?.codex {
      let plan = codex.data?.plan_type ?? "-"
      let lines = codex.windowLines
      if !lines.isEmpty {
        for l in lines { add(String(format: "Codex（%@）%@：已用 %.1f%%", plan, l.label, l.pct)) }
      } else if let pct = codex.data?.used_percent {
        add(String(format: "Codex（%@）：已用 %.1f%%", plan, pct))
      }
    }
    if let c5 = s?.quota?.claude5h, c5.active == true, let w = c5.window_tokens {
      add("Claude 5h 窗口（推算）：\(fmtTokens(w)) tokens")
    }
    for b in s?.balances ?? [] where b.balance != nil {
      add(String(format: "%@ 余额：¥%.2f", b.provider ?? "?", b.balance!))
    }
    menu.addItem(.separator())
    for alert in s?.alerts?.items ?? [] {
      add("\(alert.level == "crit" ? "‼" : "⚠") \(alert.title)：\(alert.body)")
    }
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
    NSWorkspace.shared.open(URL(string: BASE + "/")!)
  }

  @objc func refreshNow() { refresh() }
}

let app = NSApplication.shared
let delegate = BarApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
