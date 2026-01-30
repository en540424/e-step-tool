# Decision Log

## 2026-01-xx
- docs フォルダを作成
- Claude Code を前提に、設計・判断ログを残す方針にした
- UI / 設計ルールは別ファイルで管理する
# Decision Log (E-STEP-TOOL)

## 2026-01-31
### docs/ を作成
- Decision: docs/decision-log.md と docs/design-rules.md を導入
- Why: AI（Claude Code/OpenCode）に“設計の前提”を共有し、修正ブレを減らす
- Scope: 全機能（UI/設計/実装ルールの参照元）

### Git運用
- Decision: docs/ だけを先に commit（app 側は別 commit）
- Why: 変更範囲を小さく保ち、差分レビューとロールバックを容易にする
- Scope: リポジトリ運用
