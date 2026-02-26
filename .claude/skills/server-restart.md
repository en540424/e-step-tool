# Skill: server-restart（作業再開・復帰手順）

## 目的
サーバー復帰・作業再開・作業終了時の手順を固定する。
状態不明のまま作業を開始しない。

---

## 作業再開時（必須）

1) 現在位置確認
- `git branch --show-current`
- `git status`
- `git remote -v`

2) 依存確認
- `npm install`（必要な場合）
- `.env` の存在確認

3) 開発サーバー起動
- `npm run dev`

4) エラー確認
- コンソールエラー確認
- ブラウザ表示確認

---

## 作業終了時

1) 変更確認
- `git status`
- 不要ファイル確認

2) コミット
- `npm run commit:auto`

3) push確認
- ブランチがoriginと同期しているか確認

---

## 絶対禁止

- 状態未確認のまま作業開始
- main 直push
- 未commitのままPC終了