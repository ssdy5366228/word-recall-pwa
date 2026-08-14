Word Recall v6.0 Beta 4.7

唯一开发基线：v6.0 Beta 4.6.1。

本版目标：把发音主链路升级为“同源静态音频优先”，降低复习时对第三方 Dictionary API 和 iPhone Safari 系统 TTS 的依赖。

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
