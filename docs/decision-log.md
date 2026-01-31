# Decision Log (E-STEP-TOOL)

This file records **binding architectural and operational decisions**.
All AI systems and contributors must respect these decisions.

---

## 2026-01-31: Introduce docs/ as authoritative design memory

### Context
- Claude Code / OpenCode / ChatGPT 等の AI を併用する中で、
  設計判断・前提条件がセッションごとにブレる問題が顕在化した。
- チャットベースの指示だけでは、長期的な判断軸を維持できない。

### Decision
- `docs/` フォルダを **AI・人間共通の契約書置き場**として扱う。
- 以下を最優先ドキュメントとする：
  - `docs/ai-principles.md`
  - `docs/design-rules.md`
  - `docs/decision-log.md`

### Consequences
- docs に書かれていないルールは「未決定」扱い。
- AI 提案は docs に反する場合、必ず停止して指摘する。
- 重要な判断は必ず decision-log に記録する。

### Status
- Accepted

---

## 2026-01-31: Standardize API response shape

### Context
- API ごとにレスポンス形式が揺れ、UI 側の分岐・事故リスクが増えていた。
- AI 実装提案時にも前提が揃わず、精度が落ちていた。

### Decision
- 全ての Route Handler は以下の形式に統一する。

Success:
```ts
{ ok: true, data: T }
