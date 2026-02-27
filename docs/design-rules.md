# Design / Engineering Rules（E-STEP-TOOL）

> ⚠ 本ドキュメントは **E-STEP-TOOL** の設計・実装ルールの正本（single source of truth）です。  
> ルール追加/例外は必ず `docs/decision-log.md` に記録してから実装します。

---

## 0. 前提（このプロジェクトの性質）
- Next.js App Router 前提（Server Components を基本）
- 業務アプリ（給与/社員/拠点/設定）であり、**事故らない・追跡できる・再現できる**を最優先
- “賢さ” より “明確さ・保守性” を優先

---

## 1. グローバル原則（非交渉ルール）
- 予測可能性 > 賢い実装
- magic number 禁止：定数は必ず命名して集約する
- 計算・業務ロジックは UI から分離（純関数化を優先）
- docs/ は契約書。AI提案や一般論より docs が常に優先

---

## 2. UI（画面設計）
- Tailwind CSS を優先。クラスが肥大化/重複が増えた時のみコンポーネント分割
- 画面構成は「入力 → 計算/確認 → 保存/出力」の3ブロックを基本とする
- 主要アクションは 1 画面 1 つ（例：保存）
- 危険操作（破壊的/不可逆）は confirm 必須
- エラー表示は画面上部に集約
  - フィールドエラーは各入力の直下に表示

---

## 3. Data / State（データと状態管理）
- DB カラム名 `snake_case` を source of truth とする
- フロントの型・state も `snake_case` で統一（変換層を増やさない）
- state は必ず分離する：
  - raw入力（ユーザー入力）
  - derived（計算結果/導出値）
- derived が raw を mutate しない（再計算可能な関係を保つ）
- 保存は部分更新（PATCH思考）
  - `null` / `undefined` / `""` で既存を潰さない
  - 明示的にユーザーが “消した” 場合のみクリアを許可

---

## 4. Server / Client Boundary（App Router）
- 認証・権限・データ取得・validation は Server（Server Component or Route Handler）で行う
- Client Component は「UI操作・ローカル状態」に限定
- `"use client"` は必要最小限（安易に付けない）

---

## 5. API / Validation（境界で守る）
- Route Handler 入口で必ず input validation
- 入力不正は 4xx、内部失敗は 5xx
- レスポンス shape を固定：
  - Success: `{ ok: true, data: ... }`
  - Error: `{ ok: false, error: { code: string, message: string, details?: any } }`
- ログは最低限「誰が」「何を」「結果」
- 秘密情報・個人情報はログ出力しない

---

## 6. 計算ロジック（給与・手当など）
- 給与/手当/控除などの重要ロジックは **純関数** として分離し、UIと疎結合にする
- 入力は必ず型と単位（円/時間/日）を明確にする
- 端数処理はルール化して定数として管理する（例：切捨て/四捨五入/切上げ）
- “途中入力” を許容し、欠損があっても落ちない設計にする

---

## 7. 運用・安全（コミット/変更管理）
- 変更は小さくコミット（レビュー可能な単位）
- UI変更とロジック変更は同一コミットに混ぜない
- 既存挙動は正とみなす（変えるなら decision-log に理由を書く）
- 破壊的変更（DBスキーマ/計算仕様）は必ず decision-log 先行

---

## 7.5 Tooling Policy（Skills / Python / Normal）

### 目的
- 開発時の判断コスト（「どれ使う？」）をゼロにする
- 事故（給与・DB・出力）を防ぎ、再現性と引継ぎを強化する
- AI（Claude / 外部ChatGPT / エディタ内AI）が同じ前提で動くようにする

### 優先順位（原則）
- Normal（実装）: 本番コード・DB・UI・APIを変更する作業
- Python（検証）: 計算/集計/Excel/CSV/アルゴリズムの検算・実験
- Skills（固定化）: 手順・運用・事故防止・再利用ルールの標準化（“型”の作成）

### 自律トリガー（AIは以下に従い自動で切り替える）
#### Skills を使う（= ルール/手順を docs/skills に固定）条件
- 同じ説明・同じ作業が **2回以上** 発生
- 失敗時の損害が大きい（給与、請求、個人情報、Excel出力、本番DB）
- 手順が **5ステップ以上** / 依頼が複合（例：確認→修正→テスト→反映）
- ユーザーが「次回も使う」「覚えて」「テンプレ化」「標準化」を示唆

#### Python を使う（= 検算してから実装）条件
- 金額・税・控除・時間・日数など、**正しさが重要な計算**
- ExcelJS出力のセル/数式/集計の妥当性確認
- CSV/Excelの整形・差分比較・集計・検算
- 仕様が曖昧で、サンプルデータで検証した方が速い

### 出力フォーマット（AIの回答を固定）
- Python実行/検算を伴う回答は必ず：
  1) Input assumptions（前提・入力例）
  2) Result（結果）
  3) Implementation rule（実装に落とすルール）
  4) Edge cases（境界値・注意点）

- Skills追記を伴う回答は必ず：
  1) Title（1行）
  2) Purpose（目的）
  3) Steps（手順）
  4) Pitfalls & Guards（事故パターンと防止策）
  5) Done criteria（完了条件）

### 配置（運用ルール）
- Skillsの成果物は `docs/skills/` に置く（プロジェクトの契約書として扱う）
- 例外・変更は `docs/decision-log.md` に理由を残してから実装する

## 8. 例外
- 例外は実装前に `docs/decision-log.md` に記録する（口約束禁止）
