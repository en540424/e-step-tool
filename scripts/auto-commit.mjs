// scripts/auto-commit.mjs
import { spawnSync } from "node:child_process";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim();
    throw new Error(`[${cmd} ${args.join(" ")}] failed\n${msg}`);
  }
  return (r.stdout || "").trim();
}

function safeFirstLine(s) {
  const line = (s || "").split(/\r?\n/)[0].trim();
  return line.slice(0, 72) || "chore: update";
}

async function main() {
  // 1) 変更が無いなら終了
  const status = run("git", ["status", "--porcelain"]);
  if (!status) {
    console.log("No changes. Nothing to commit.");
    return;
  }

  // 2) 差分情報を集める（AI無しでも最低限の要約ができるように）
  const nameStatus = run("git", ["diff", "--name-status"]);
  const stat = run("git", ["diff", "--stat"]);
  const branch = run("git", ["branch", "--show-current"]);

  // 3) コミットメッセージ生成（AIが使えなければローカル要約にフォールバック）
  let message = "";
  const apiKey = process.env.OPENAI_API_KEY;

  if (apiKey) {
    try {
      // OpenAI Responses API を直接叩く（追加ライブラリ不要）
      const prompt = [
        "You are an expert engineer writing a concise Conventional Commits message.",
        "Rules:",
        "- Output ONLY one line commit message.",
        "- Use Conventional Commits type: feat/fix/chore/refactor/docs/test.",
        "- Must be <= 72 chars.",
        "- Be specific but short.",
        "",
        `Branch: ${branch}`,
        "",
        "git diff --name-status:",
        nameStatus,
        "",
        "git diff --stat:",
        stat,
      ].join("\n");

      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: prompt,
          max_output_tokens: 60,
        }),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(`OpenAI error: ${res.status} ${t}`);
      }
      const data = await res.json();

      // responses は output_text が付くことが多いのでまずそれを使う
      message = safeFirstLine(data.output_text || "");
    } catch (e) {
      console.log("AI message generation failed. Fallback to local summary.");
      console.log(String(e.message || e));
    }
  }

  if (!message) {
    // AIが無い/失敗した場合のフォールバック（最低限）
    const files = nameStatus
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((l) => l.replace(/\s+/g, " "))
      .join(", ");
    message = safeFirstLine(`chore: update ${files || "changes"}`);
  }

  console.log("Commit message:", message);

  // 4) add -> commit -> push（1コマンドで完結）
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", `"${message.replace(/"/g, '\\"')}"`]);

  // push は失敗することもあるので try にする（コミットは残す）
  try {
    run("git", ["push", "origin", branch]);
    console.log("Pushed to origin:", branch);
  } catch (e) {
    console.log("Commit created, but push failed. You can push later.");
    console.log(String(e.message || e));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});