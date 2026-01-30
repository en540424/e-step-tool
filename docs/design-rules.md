# Design / UI Rules

- App Router (Next.js) 前提
- 業務アプリのため可読性優先
- magic number を避ける
- 計算ロジックは UI から分離
# Design / Engineering Rules (E-STEP-TOOL)

## UI
- Tailwind CSS を優先。クラスが肥大化する場合のみコンポーネント分割。
- 画面は「入力 → 計算/確認 → 保存/出力」の3ブロックで構成する。
- 主要アクションは1画面に1つ（例: 保存）。危険操作は confirm を挟む。
- エラーは画面上部に集約して表示（field error は各入力の直下）。

## Data / State
- DBのカラム名（snake_case）とフロントの型名を一致させ、変換を最小化する。
- 画面入力の state は「raw入力」と「計算結果」を分離する。
- 保存時は「部分更新」で上書き事故を防ぐ（null/空で既存を潰さない）。

## API / Validation
- APIは必ず input validation → error message を返す。
- 失敗は 4xx（入力） / 5xx（内部）を分ける。
- ログは「誰が」「何を」「結果」を最低限残す（個人情報は避ける）。

## Testing / Safety
- 変更は小さくコミット。UI変更とロジック変更を混ぜない。
- 重要ロジック（給与計算等）は純関数化して差分検証できる形にする。
