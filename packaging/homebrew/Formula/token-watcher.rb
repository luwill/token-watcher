# Homebrew formula：token-watcher
#
# 发布流程（维护者）：
#   1. npm publish（formula 直接引用 npm registry 的 tarball，无需 GitHub release 附件）
#   2. ./packaging/homebrew/update-formula.sh 1.5.0   # 回填 url 与 sha256
#   3. 把本文件推进 tap 仓库（github.com/luwill/homebrew-tap 的 Formula/ 下）
# 用户侧即得：brew install luwill/tap/token-watcher
class TokenWatcher < Formula
  desc "Local real-time token usage & quota dashboard for AI coding agents"
  homepage "https://github.com/luwill/token-watcher"
  url "https://registry.npmjs.org/token-watcher/-/token-watcher-1.5.1.tgz"
  sha256 "381513ffb6b35d39938eabd4b788d5cca9840b11bc967a5ef28afe221d2c5948" # update-formula.sh 回填
  license "MIT"

  depends_on "node"

  def install
    # npm 包零原生依赖（node:sqlite 内置于 Node ≥22.13），普通 npm 安装即可
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    on_macos do
      <<~EOS
        常驻 + 开机自启：  token-watcher install-agent
        菜单栏胶囊：      token-watcher bar
        面板默认地址：    http://127.0.0.1:8787
      EOS
    end
  end

  test do
    assert_match "token-watcher v#{version}", shell_output("#{bin}/token-watcher --version")
  end
end
