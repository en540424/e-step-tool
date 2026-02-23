import { execSync } from "child_process";
import OpenAI from "openai";

function sh(cmd) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}
function shInherit(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const CFG = {
  lang: (process.env.COMMIT_LANG || "ja").toLowerCase(), // ja | en
  style: (process.env.COMMIT_STYLE || "conventional").toLowerCase(), // conventional
  model: process.env.COMMIT_AI_MODEL || "gpt-4o-mini",

  maxFiles: envInt("COMMIT_MAX_FILES", 50),
  maxLines: envInt("COMMIT_MAX_LINES", 1200),
  maxChars: envInt("COMMIT_MAX_DIFF_CHARS", 120000),
  forceLarge: process.env.COMMIT_FORCE_LARGE === "1",
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_TYPES = new Set([
  "feat",
  "fix",
  "refactor",
  "perf",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "style",
]);

function sanitizeOneLine(s) {
  return String(s || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeCommitMessageFromJson(j) {
  const type = ALLOWED_TYPES.has(j.type) ? j.type : "chore";
  const scopeRaw = sanitizeOneLine(j.scope || "");
  const scope = scopeRaw ? `(${scopeRaw.replace(/[()]/g, "")})` : "";
  const subject = sanitizeOneLine(j.subject || "");

  // Conventional Commits: type(scope): subject
  const header = `${type}${scope}: ${subject || "update"}`.slice(0, 72);

  const body = String(j.body || "").trim();
  const footer = String(j.footer || "").trim();

  let msg = header;
  if (body) msg += `\n\n${body}`;
  if (footer) msg += `\n\n${footer}`;
  return msg.trim();
}

function parseNumStat(numStatText) {
  // lines: "12\t3\tpath"
  let files = 0;
  let add = 0;
  let del = 0;
  const lines = numStatText.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [a, d] = line.split("\t");
    files += 1;
    const ai = a === "-" ? 0 : Number(a);
    const di = d === "-" ? 0 : Number(d);
    if (Number.isFinite(ai)) add += ai;
    if (Number.isFinite(di)) del += di;
  }
  return { files, add, del, totalLines: add + del };
}

function detectDangerousFiles(stagedNames) {
  const danger = [];
  const patterns = [
    /^\.env(\..+)?$/i,
    /\/\.env(\..+)?$/i,
    /^\.env\.local$/i,
    /\/\.env\.local$/i,
    /supabase\/\.env/i,
  ];
  for (const n of stagedNames) {
    if (patterns.some((p) => p.test(n))) danger.push(n);
  }
  return danger;
}

async function generateConventionalCommit({ diffStat, fullDiff, branch }) {
  const isJa = CFG.lang === "ja";

  const system = isJa
    ? [
        "あなたはGitのコミットメッセージ生成器です。",
        "必ず Conventional Commits 形式で出力します。",
        "出力は JSON のみ（説明文なし）。",
        "先頭行は 72文字以内。",
        "type は feat|fix|refactor|perf|docs|test|build|ci|chore|style のどれか。",
        "subject は日本語で簡潔に（命令形っぽく、体言止めでも可）。",
        "body は日本語で箇条書き（- で始める）最大5行。",
        "破壊的変更がある場合 footer に 'BREAKING CHANGE: ...' を入れる。",
      ].join("\n")
    : [
        "You generate git commit messages.",
        "Output JSON only (no prose).",
        "Use Conventional Commits.",
        "Header max 72 chars.",
        "type must be one of feat|fix|refactor|perf|docs|test|build|ci|chore|style.",
        "Subject concise, imperative.",
        "Body bullet list (max 5).",
        "If breaking change, include footer 'BREAKING CHANGE: ...'.",
      ].join("\n");

  const user = isJa
    ? `ブランチ: ${branch}\n\n以下は staged changes の要約(stat)：\n${diffStat}\n\n以下は staged diff（全文）：\n${fullDiff}\n\n要求：\n1) 変更内容に最も合う type を選ぶ\n2) scope はあれば短く（例: inventory, ebay, api, ui）\n3) subject は日本語で短く（72文字以内に収める）\n4) body は日本語の箇条書き（最大5行）\n5) 破壊的変更があるなら footer に BREAKING CHANGE を入れる\n\nJSON形式：\n{\n  "type": "...",\n  "scope": "...(optional)",\n  "subject": "...",\n  "body": "- ...\\n- ...",\n  "footer": "BREAKING CHANGE: ...(optional)"\n}`
    : `Branch: ${branch}\n\nStaged changes stat:\n${diffStat}\n\nFull staged diff:\n${fullDiff}\n\nReturn JSON:\n{\n  "type": "...",\n  "scope": "... (optional)",\n  "subject": "...",\n  "body": "- ...\\n- ...",\n  "footer": "BREAKING CHANGE: ...(optional)"\n}`;

  const completion = await openai.chat.completions.create({
    model: CFG.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: 350,
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // フォールバック（JSONじゃなかった時）
    parsed = {
      type: "chore",
      scope: "",
      subject: isJa ? "変更を反映" : "apply changes",
      body: "",
      footer: "",
    };
  }

  return safeCommitMessageFromJson(parsed);
}

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
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error("❌ OPENAI_API_KEY is missing.");
      process.exit(1);
    }

    // 1) Stage
    console.log("🔍 Staging changes...");
    shInherit("git add -A");

    const diffStat = sh("git diff --cached --stat");
    if (!diffStat) {
      console.log("✅ No staged changes. Nothing to commit.");
      return;
    }

    const branch = sh("git rev-parse --abbrev-ref HEAD");

    // 2) Guard: no direct commit/push on main/master
    if (branch === "main" || branch === "master") {
      console.error(`❌ Refusing to commit/push directly on ${branch}.`);
      console.error(`   Create a feature branch first, e.g.: git switch -c feature/<topic>`);
      process.exit(1);
    }

    // 3) Guard: dangerous staged files
    const stagedNames = sh("git diff --cached --name-only")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const danger = detectDangerousFiles(stagedNames);
    if (danger.length) {
      console.error("❌ Dangerous files are staged (possible secrets). Aborting.");
      for (const f of danger) console.error(` - ${f}`);
      console.error("👉 Unstage/remove them, then retry.");
      process.exit(1);
    }

    // 4) Size control
    const numStat = sh("git diff --cached --numstat");
    const { files, totalLines } = parseNumStat(numStat);

    // use minimal context diff to reduce tokens
    const fullDiff = sh("git diff --cached --unified=0");

    if (!CFG.forceLarge) {
      if (files > CFG.maxFiles || totalLines > CFG.maxLines || fullDiff.length > CFG.maxChars) {
        console.error("❌ Changes are too large for safe AI commit summarization. Aborting.");
        console.error(`   files: ${files} (limit ${CFG.maxFiles})`);
        console.error(`   lines: ${totalLines} (limit ${CFG.maxLines})`);
        console.error(`   diff chars: ${fullDiff.length} (limit ${CFG.maxChars})`);
        console.error("👉 Please split into smaller commits and rerun.");
        console.error("   (If you really must, set COMMIT_FORCE_LARGE=1 temporarily)");
        process.exit(1);
      }
    }

    // 5) Generate commit message (full diff)
    console.log("🤖 Generating conventional commit message with AI...");
    const message = await generateConventionalCommit({ diffStat, fullDiff, branch });

    console.log(`📝 Commit message:\n${message}\n`);

    // 6) Commit
    const escaped = message.replace(/"/g, '\\"');
    shInherit(`git commit -m "${escaped.split("\n")[0]}"`+ (message.includes("\n\n") ? "" : ""));

    // If body exists, amend with body via -F to avoid quoting issues
    if (message.includes("\n\n")) {
      const fs = await import("fs");
      const path = await import("path");
      const tmp = path.join(process.cwd(), ".git", "COMMIT_AUTO_MSG.txt");
      fs.writeFileSync(tmp, message, "utf8");
      shInherit(`git commit --amend -F "${tmp}"`);
      fs.unlinkSync(tmp);
    }

    // 7) Push (auto-setup upstream if missing)
    console.log("🚀 Pushing...");
    try {
      shInherit("git push");
    } catch (e) {
      const msg = String(e?.message || "");
      if (!msg.includes("has no upstream branch")) throw e;
      console.log(`ℹ️ No upstream. Setting upstream to origin/${branch}...`);
      shInherit(`git push -u origin ${branch}`);
    }

    console.log("✅ Done.");
  } catch (err) {
    console.error("❌ Error:", err?.message || err);
    try {
      console.log("\n--- git status ---");
      shInherit("git status");
    } catch {}
    process.exit(1);
  }
}

main();