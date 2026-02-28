"use client";

import { useEffect, useState } from "react";

function isValidYYYYMM(v: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

export function MonthInput({
  value,
  onCommit,
  style,
  className,
  placeholder = "YYYY-MM",
}: {
  value: string;
  onCommit: (v: string) => void;
  style?: React.CSSProperties;
  className?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);

  // 外部から value が変わったら draft も追従
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const v = draft.trim();
    if (isValidYYYYMM(v)) {
      onCommit(v);
    } else {
      setDraft(value); // 不正なら元に戻す
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      style={style}
      className={className}
    />
  );
}
