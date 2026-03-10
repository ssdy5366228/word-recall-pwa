单词记忆轻程序（iPhone 稳定版）

这不是“直接点开本地 html 文件”的方案，而是一个适合 iPhone 的 PWA 静态网站版本。

为什么这个版本更稳：
1. 使用 IndexedDB 存数据，比直接本地文件 + localStorage 更适合手机浏览器。
2. 支持“添加到主屏幕”，像轻应用一样打开。
3. 支持离线缓存。
4. 支持导出 / 导入 JSON 备份。

你需要怎么用：
A. 最省事：把这个文件夹上传到 GitHub Pages / Netlify / Cloudflare Pages 任一静态托管。
B. 打开生成的网址。
C. 在 iPhone Safari 里点“分享” → “添加到主屏幕”。

最简 GitHub Pages 方法：
1. 新建一个 GitHub 仓库，例如 word-recall-pwa
2. 把这个文件夹里的所有文件上传到仓库根目录
3. 在仓库 Settings → Pages → Build and deployment → Deploy from a branch
4. 选择 main 分支和 /(root)
5. 保存，等 1–3 分钟
6. 打开生成的网址
7. 在 iPhone Safari 添加到主屏幕

文件说明：
- index.html：页面结构
- styles.css：样式
- app.js：核心逻辑
- sw.js：离线缓存
- manifest.webmanifest：PWA 配置
- icon-180.png / icon-512.png：图标

建议：
- 每周至少导出一次 JSON 备份
- 初期先用每天 10 个新词；如果负担大，可在设置改成 5 个
