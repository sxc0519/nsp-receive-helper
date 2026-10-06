# NSP 批量入库脚本

用于 NSP「入库扫描」页面的 Tampermonkey 用户脚本。逐票提交，看到入库列表的新记录后才处理下一票；超时会停在当前单号并保存进度。

## 安装

打开 [nsp-receive-helper.user.js](https://raw.githubusercontent.com/sxc0519/nsp-receive-helper/main/nsp-receive-helper.user.js)，在 Tampermonkey 中安装。脚本内的 `@updateURL` 和 `@downloadURL` 指向此仓库的 `main` 分支。

## 使用

1. 打开 `https://nsp-jp.ytoglobal.com/port-out/receive`。
2. 在右下角面板粘贴运单号，设置重量及长宽高，点击「开始新批次」。
3. 超时或页面刷新后，先核对待处理单号，再选择继续、重试或跳过。

单号须为 `G` 加 11 位数字。一次只在一个标签页运行。脚本不会在超时后自动重发单号。
