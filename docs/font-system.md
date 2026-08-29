# SnipNest 字体系统

SnipNest 使用三类本地字体。字体随扩展打包，不依赖网络加载。

- **朱雀仿宋（Zhuque Fangsong v0.212）**：中文标题、按钮、较大的正文与用户内容预览。当前采用官方预览测试版，用于保留界面的书卷气与纸张感。
- **Iosevka Aile / Etoile**：Aile 负责小字号中的英文、网址、日期和数字；Etoile 用于品牌与少量装饰性数字，品牌英文使用 Italic。
- **更纱黑体 UI SC（Sarasa UI SC）**：负责小字号中文，包括说明、状态、时间、计数和辅助标签。与 Iosevka Aile 共同组成小字字体栈。

字体文件位于 `public/fonts/`，许可原文位于 `docs/third-party-licenses/`。Zhuque Fangsong、Sarasa Gothic 和 Iosevka 均按 SIL Open Font License 1.1 发布。

## 使用边界

- 12px 及以下的界面小字优先使用 Iosevka Aile + Sarasa UI SC，保证窄侧栏中的清晰度。
- 朱雀仿宋主要用于标题、按钮、13px 以上正文和用户内容，不在小字号上强行使用；仅使用官方字形，不做非官方修改。
- 装饰字仅用于 `SnipNest`、`01 / 02 / 03`、统计数字等短内容。
- 英文品牌和数据字符继续使用 Iosevka；小字号中文回退到 Sarasa UI SC。
- 数字信息启用等宽数字，避免计数变化时发生横向跳动。
