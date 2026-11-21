import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MessageBody({ text }: { text: string }) {
  return <div className="wb-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({ children }) => <div className="wb-markdown-table"><table>{children}</table></div>,
  }}>{text}</ReactMarkdown></div>
}
