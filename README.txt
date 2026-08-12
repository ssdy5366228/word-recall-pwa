Word Recall v6.0 Beta 4.6.1

本版严格以 v6.0 Beta 4.4 作为唯一开发基线。

本版仅针对 Beta 4.4 仍存在的发音竞态问题进行根因修复，并保留 Beta 4.4 的今日页进度、Review Session、四任务、评分、Again、长期巩固、薄弱词恢复等既有逻辑。

发音修复：
1. “音频解锁”与“真实单词播放”改为严格串行，避免两者同时操作共享 <audio> 导致真实发音被 unlock 清理逻辑 pause。
2. “开始复习并启用发音”会先等待解锁流程完全结束，再渲染复习卡；renderReview 触发的自动发音不会再与 unlock 抢播放器。
3. 移除开始按钮中额外的 speakWord 调用，避免 renderReview 自动发音 + 手动调用形成双重播放请求。
4. 所有手动喇叭入口统一改为 await unlockAndSpeakWord(...)：复习、错词、词库、录入、日历、编辑等页面均先完成解锁，再播放真实音频。
5. 保留 Beta 4.3/4.4 已有的本地音频缓存、多个词典音频候选、坏缓存自动删除、系统 TTS 兜底和旧请求防抢播。
6. 保留原 Review Session 本地存储 key，不因版本升级主动清空未完成复习进度。

部署前建议先导出 JSON 备份。

v6.0 Beta 4.6.1 发音修复：
- 基于 Beta 4.5 唯一基线。
- 修复 Safari HTML Audio 被拦截时直接退出、没有进入系统 TTS 兜底的问题。
- 将用于解锁的静音 WAV 替换为包含有效音频数据的 100ms WAV，提升 iPhone/Safari 解锁兼容性。
- NotAllowedError 不再误判为坏缓存，也不会删除有效词典音频缓存。
- 手动点击喇叭仍先解锁同一个共享播放器，再进行词典/缓存播放。
- 保留 Beta 4.5 的 Review Session、四任务、Again、评分、今日进度等逻辑。


v6.0 Beta 4.6.1 系统审查修复：
- 以 v6.0 Beta 4.6 为唯一基线。
- 音频解锁改为“非静音的静音内容 WAV”，避免 muted autoplay 被误判为真实媒体解锁成功。
- 解锁失败时不再错误设置 reviewAudioEnabled=true；保留启用按钮供重新尝试。
- 日历日期批次复习也显示“开始复习并启用发音”入口。
- 离开复习/错词音频上下文、页面隐藏或 pagehide 时，使旧的异步发音请求和自动发音定时器失效。
- 页面进入后台后重置媒体解锁状态，返回时重新通过用户手势启用，更符合 iPhone/Safari 行为。
- Service Worker 注册 URL 改为使用 APP_VERSION_NUMBER 动态生成，消除残留 4.4 版本号。
- 未改动四任务、Review Session、Again、四档评分、两轮复习、今日进度、历史积压、长期巩固、薄弱词恢复等业务逻辑。
