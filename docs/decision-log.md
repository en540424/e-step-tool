# Decision Log (E-STEP-TOOL)

This file records **binding architectural and operational decisions**.
All AI systems and contributors must respect these decisions.

---

## 2026-01-31: Introduce docs/ as authoritative design memory

### Context
- Claude Code / OpenCode / ChatGPT など複数の AI を併用する中で、
  設計判断や前提条件がセッションごとにブレる問題が顕在化した。
- チャットベースの指示だけでは、長期的な判断軸を維持できない。

### Decision
- `docs/` フォルダを **AI・人間共通の契約書置き場**として扱う。
- 以下のドキュメントを最優先の判断基準とする：
  - `docs/ai-principles.md`
  - `docs/design-rules.md`
  - `docs/decision-log.md`

### Consequences
- docs に書かれていないルールは「未決定」扱いとする。
- AI 提案が docs に反する場合、必ず停止して指摘する。
- 重要な判断は必ず decision-log に記録する。

### Status
- Accepted

---

## 2026-02-21: Replace manualAllowance with row-based AllowanceRow editor

### Context
- 給与計算ページの手当入力が「手当（手入力合計）」という1つの金額フィールドしかなく、
  定額残業費・住宅手当・技能手当などの個別項目管理ができなかった。
- 控除側は既に行ベースエディタ（DeductionRowsEditor）で管理できている。
- 課税/非課税の区分が必要（通勤手当等は非課税として所得税計算から除外する必要）。

### Decision
- `manualAllowance: number` を `allowanceRows: AllowanceRow[]` に置き換える。
- AllowanceRow に `isTaxable: boolean` を持たせ、課税/非課税を行ごとに制御する。
- デフォルト7行：定額残業費, 特別手当, 住宅手当, 技能手当, 皆勤手当, 欠勤控除, 休業手当。
- localStorage 永続化は deduction_rows と同じパターン（月次キー + recurring 引き継ぎ）。
- `payroll_runs` テーブルに `allowance_rows` JSONB カラムを追加（カラム無し時は fallback）。
- `taxableForIncomeTaxYen` は `grossWithTemplates - nonTaxableTotal - socialInsurance` に変更。
- Excel出力: テンプレ行17-22 に手当項目をマッピング。

### Consequences
- `result.allowances.manualYen` は `allowanceRowsTotal` を保存（後方互換）。
- 旧データの `manualYen` はそのまま読み取り可能（Excel出力に影響なし）。
- DB に `allowance_rows` カラムが無い環境では graceful fallback（カラム除外してリトライ）。

### Status
- Accepted

---

## 2026-01-31: Standardize API response shape

### Context
- API ごとにレスポンス形式が揺れ、UI 側の分岐や事故リスクが増えていた。
- AI 実装提案時にも前提が揃わず、精度が低下していた。

### Decision
- 全ての Route Handler は以下の形式に統一する。

Success:
```ts
{ ok: true, data: T }
{ ok: false, error: { code: string, message: string, details?: any } }


