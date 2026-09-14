Word Recall v6.0 Beta 4.9

唯一开发基线：v6.0 Beta 4.8。

本版目标：修复较长时间无发音后，自动或手动发音可能丢失第一个音节的问题。

发音恢复改进：
- 记录最近一次真实音频活动时间。
- 音频闲置 45 秒后，下一次播放前自动重新预热输出通道。
- 静音预热持续约 260 毫秒，避免只完成播放授权、但扬声器或蓝牙通道尚未完全恢复。
- 手动发音、自动发音、静态 MP3、词典音频和系统备用发音共用同一套恢复判断。
- 连续复习发音不重复预热，不增加正常逐词播放的等待时间。
- 页面进入后台后清除旧的音频活动状态，返回后重新解锁或预热。

保留 v6.0 Beta 4.8 的例句查询改进：

例句查询顺序：
1. Dictionary API 词典例句
2. Tatoeba 备用真实例句
3. 可编辑的本地简单例句

例句功能：
- Dictionary API 无例句或查询失败时，自动继续查询 Tatoeba。
- 在线例句存在多个候选时显示“换一句”。
- 备用例句限制为 3 至 16 个英文词，并要求完整包含目标单词或短语。
- Tatoeba 若返回中文直译，会在例句中文为空时自动填写；用户手动填写的中文不会被覆盖。
- Tatoeba 是开放句库，备用例句仍需人工确认是否符合目标释义。

发音来源和优先顺序保持 v6.0 Beta 4.8 不变：

发音顺序：
1. 程序同源静态音频：./audio/<locale>/<word>.mp3，其次 ./audio/<word>.mp3
2. 浏览器 Cache Storage：word-recall-pronunciation-v2
3. Dictionary API 在线词典音频
4. iPhone/Safari SpeechSynthesis 系统备用发音

静态音频文件命名规则：
- 全部小写。
- 空格及其他非字母数字分隔符转为下划线。
- 连字符和英文撇号保留。
- 例：dormant -> audio/en-US/dormant.mp3
- 例：ice cream -> audio/en-US/ice_cream.mp3
- 美音放 audio/en-US/，英音放 audio/en-GB/。
- 若不区分口音，也可直接放 audio/dormant.mp3。

运行逻辑：
- 找到静态音频后会优先播放，并尽量复制到本机 pronunciation Cache Storage。
- 静态音频不存在时不会报错中断，会自动继续使用原有缓存/词典/TTS。
- 不要求一次性准备完整音频库；可逐步补充。
- 新录入词仍可继续通过原有词典在线音频进行自动缓存。

未改动：
- 四任务与 Review Session
- Easy / Good / Hard / Again
- 两轮复习与 Again 即时循环
- 今日页进度
- 历史积压、长期巩固、薄弱词恢复
- 日历、导入导出及现有数据存储 key

部署前建议先导出 JSON 备份。
