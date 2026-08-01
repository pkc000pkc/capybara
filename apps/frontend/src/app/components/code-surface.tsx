"use client";

import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { jinja } from "@codemirror/lang-jinja";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { linter } from "@codemirror/lint";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { useI18n } from "../i18n";

export type CodeSurfaceProps = {
  ariaLabel: string;
  className?: string;
  extensions?: readonly Extension[];
  height?: "content" | "fill";
  language?: string;
  lineNumbers?: boolean;
  lineWrapping?: boolean;
  maxHeight?: string;
  minHeight?: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  onSubmit?: () => void;
  placeholder?: string;
  readOnly?: boolean;
  statusBar?: boolean;
  value: string;
};

function normalizedLanguage(language: string) {
  return language.toLowerCase().replaceAll(/[^a-z0-9+#]+/g, "");
}

export function codeLanguageExtensions(language = "Text"): Extension[] {
  switch (normalizedLanguage(language)) {
    case "json":
    case "jsonc":
      return [json(), linter(jsonParseLinter())];
    case "javascript":
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "typescript":
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "markdown":
    case "md":
      return [markdown({ base: markdownLanguage })];
    case "jinja":
    case "jinja2":
    case "jinja2+markdown":
      return [jinja()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "python":
    case "py":
      return [python()];
    case "bash":
    case "shell":
    case "sh":
      return [StreamLanguage.define(shell)];
    case "powershell":
    case "ps1":
      return [StreamLanguage.define(powerShell)];
    default:
      return [];
  }
}

export default function CodeSurface({
  ariaLabel,
  className = "",
  extensions = [],
  height = "fill",
  language = "Text",
  lineNumbers = true,
  lineWrapping = false,
  maxHeight,
  minHeight,
  onChange,
  onSave,
  onSubmit,
  placeholder,
  readOnly = false,
  statusBar = true,
  value,
}: CodeSurfaceProps) {
  const { t } = useI18n();
  const editorExtensions = useMemo(() => {
    const commandKeys = [];
    if (onSave) {
      commandKeys.push({
        key: "Mod-s",
        run: () => {
          onSave();
          return true;
        },
      });
    }
    if (onSubmit) {
      commandKeys.push({
        key: "Enter",
        run: (view: EditorView) => {
          if (view.composing) return false;
          onSubmit();
          return true;
        },
      });
    }
    return [
      ...codeLanguageExtensions(language),
      syntaxHighlighting(classHighlighter),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({
        "aria-label": ariaLabel,
        "aria-readonly": String(readOnly),
      }),
      ...(lineWrapping ? [EditorView.lineWrapping] : []),
      ...(commandKeys.length > 0 ? [Prec.highest(keymap.of(commandKeys))] : []),
      ...extensions,
    ];
  }, [ariaLabel, extensions, language, lineWrapping, onSave, onSubmit, readOnly]);

  const contentHeight = height === "fill" ? "100%" : undefined;
  return (
    <div
      className={`code-surface min-h-0 min-w-0 bg-[#f8faf9] ${height === "fill" ? `grid h-full ${statusBar ? "grid-rows-[minmax(0,1fr)_24px]" : "grid-rows-[minmax(0,1fr)]"}` : statusBar ? "grid grid-rows-[auto_24px]" : "block"} ${className}`}
      data-height={height}
      data-language={normalizedLanguage(language)}
      data-read-only={readOnly ? "true" : "false"}
    >
      <CodeMirror
        basicSetup={{
          autocompletion: !readOnly,
          foldGutter: lineNumbers,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly && lineNumbers,
          lineNumbers,
          syntaxHighlighting: false,
        }}
        className="min-h-0 min-w-0 overflow-hidden"
        editable={!readOnly}
        extensions={editorExtensions}
        height={contentHeight}
        indentWithTab={!readOnly}
        maxHeight={maxHeight}
        minHeight={minHeight}
        onChange={(nextValue) => onChange?.(nextValue)}
        placeholder={placeholder}
        readOnly={readOnly}
        theme="none"
        value={value}
        width="100%"
      />
      {statusBar && (
        <div className="flex items-center justify-between border-t border-[#dce5e5] bg-[#edf3f2] px-2.5 font-mono text-[10px] text-[#6b7e82]">
          <span>{language}</span>
          <span>
            {t("editor.stats", {
              lines: value.split("\n").length,
              chars: value.length,
            })}
          </span>
        </div>
      )}
    </div>
  );
}
