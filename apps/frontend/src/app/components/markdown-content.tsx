"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../i18n";
import CodeSurface from "./code-surface";

export default function MarkdownContent({
  source,
  variant = "compact",
}: {
  source: string;
  variant?: "compact" | "conversation";
}) {
  const { t } = useI18n();

  return (
    <div
      className={`markdown-content min-w-0 break-words text-[#294247] [&_a]:text-[#0c766e] [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[#77aaa4] [&_blockquote]:pl-3 [&_blockquote]:text-[#60767a] [&_code]:rounded-sm [&_code]:bg-[#eaf1f0] [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-sm [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol]:my-2 [&_ol_li]:list-decimal [&_p]:my-2 [&_p]:whitespace-pre-line [&_strong]:font-semibold [&_ul]:my-2 ${
        variant === "conversation" ? "text-sm leading-7" : "text-xs leading-6"
      }`}
      data-markdown-content
    >
      <ReactMarkdown
        components={{
          code: ({ children, className }) => {
            const code = String(children);
            const block = Boolean(className) || code.endsWith("\n");
            if (!block) return <code className={className}>{children}</code>;

            const language = className?.replace(/^language-/, "") || "Text";
            const value = code.replace(/\n$/, "");
            return (
              <CodeSurface
                ariaLabel={t("editor.codeBlock", { language })}
                className="my-3 border border-[#d4dfdf]"
                height="content"
                language={language}
                lineNumbers
                lineWrapping
                maxHeight="320px"
                minHeight={`${Math.min(300, Math.max(40, value.split("\n").length * 20 + 20))}px`}
                readOnly
                statusBar={false}
                value={value}
              />
            );
          },
          h1: ({ children }) => (
            <h2 className="mb-4 text-lg font-semibold">{children}</h2>
          ),
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="minimal-scrollbar my-3 max-w-full overflow-x-auto">
              <table className="w-full border-collapse">{children}</table>
            </div>
          ),
          td: ({ children }) => (
            <td className="border border-[#d5e0df] px-2 py-1">{children}</td>
          ),
          th: ({ children }) => (
            <th className="border border-[#c5d4d3] bg-[#edf3f2] px-2 py-1 text-left">
              {children}
            </th>
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
