# MyJavis 内测安装说明（发给内测用户）

> 适用：macOS 12+（Apple Silicon）。安装包：https://javis.chenchuan.cc/updates/ 下最新 `MyJavis_x.y.z_aarch64.dmg`。

## 安装步骤（三步，第 2 步不能跳）

1. 打开 DMG，把 **MyJavis 拖进「应用程序」文件夹**（⚠️ 不要在 DMG 窗口里直接双击运行——那样跑在只读盘上，自动更新永远不生效，会一直用旧版）。
2. **打开终端，粘贴运行**（首次必须，本 App 是内测未签名版，macOS 会拦"无法打开"）：
   ```bash
   xattr -cr /Applications/MyJavis.app
   ```
3. 从「应用程序」里打开 MyJavis → 输入邀请码激活 → 允许麦克风权限。

装好后升级全自动：启动时弹出更新横幅点一下即可，不用再下 DMG。

## 常见问题

- **"应用程序 MyJavis 无法打开"**：没做第 2 步。跑一遍 `xattr -cr /Applications/MyJavis.app` 再开。
- **提示"来自身份不明的开发者"**：同上，或到 系统设置 → 隐私与安全性 → 拉到底部点"仍要打开"。
- **为什么要这一步**：内测版没有购买 Apple 开发者证书签名（$99/年），macOS Gatekeeper 会拦所有从网络下载的未签名 App；`xattr -cr` 是移除下载隔离标记的标准做法。正式发布若购买证书+公证后此步骤取消。

## 给维护者的备注

- 根因：`codesign` 显示 `Signature=adhoc / TeamIdentifier=not set`——构建机自己能跑（本机豁免），其他 Mac 的 Gatekeeper 必拦。
- 长期方案（待拍板）：Apple Developer Program（$99/年）→ Developer ID 签名 + notarytool 公证 → 用户零命令直接开。届时 `release-app.sh` 加 `codesign --sign "Developer ID..." + xcrun notarytool submit`。
- 用户从 DMG 卷直接运行的坑（2026-07-06 真机实锤）：updater 无法在只读卷上自更新，用户会永远停在下载时的版本——安装说明第 1 步的"拖进应用程序"就是防这个。
