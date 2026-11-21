"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { RuntimeContextDocumentView, RuntimeContextListNode } from "@capybara-agent/protocol";

type FoldState = { open: boolean; expanded: string[] };

function readFolds(key: string, defaultOpen: boolean): FoldState {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (typeof value?.open === "boolean" && Array.isArray(value.expanded)) {
      return { open: value.open, expanded: value.expanded.filter((id: unknown) => typeof id === "string") };
    }
  } catch { /* Keep folds usable in memory if local preferences are unavailable. */ }
  return { open: defaultOpen, expanded: [] };
}

function ContextTree({ view, expanded, toggle }: {
  view: RuntimeContextDocumentView;
  expanded: ReadonlySet<string>;
  toggle: (id: string, open: boolean) => void;
}) {
  const renderChildren = (items: RuntimeContextListNode[], prefix: string): ReactNode => items.slice(1).map((node, index) => {
    const path = `${prefix}/${index + 1}`;
    const id = view.nodeIdsByPath?.[path];
    if (Array.isArray(node)) {
      const label = typeof node[0] === "string" ? node[0].replace(/^#+\s*/, "") : "未命名章节";
      if (node.length <= 1) return <div className="wb-context-tree-heading" key={id ?? path} data-context-node-id={id}>{label}</div>;
      return <details className="wb-context-tree-branch" key={id ?? path} data-context-node-id={id} open={id ? expanded.has(id) : undefined}
        onToggle={(event) => {
          if (id && event.target === event.currentTarget) toggle(id, event.currentTarget.open);
        }}>
        <summary>{label}</summary>
        <div className="wb-context-tree-children"><div className="wb-context-tree is-nested">{renderChildren(node, path)}</div></div>
      </details>;
    }
    return <div className="wb-context-tree-text" key={id ?? path} data-context-node-id={id}>{node}</div>;
  });
  return <div className="wb-context-tree">
    {typeof view.list[0] === "string" && <div className="wb-context-tree-title">{view.list[0].replace(/^#+\s*/, "")}</div>}
    {renderChildren(view.list, "")}
  </div>;
}

function SavedContextDocumentCard({ storageKey, label, view, defaultOpen }: {
  storageKey: string;
  label: string;
  view: RuntimeContextDocumentView;
  defaultOpen: boolean;
}) {
  const [folds, setFolds] = useState(() => readFolds(storageKey, defaultOpen));
  useEffect(() => {
    try {
      if (folds.expanded.length || folds.open !== defaultOpen) window.localStorage.setItem(storageKey, JSON.stringify(folds));
      else window.localStorage.removeItem(storageKey);
    }
    catch { /* Temporary and restricted workspaces can still use in-memory folds. */ }
  }, [storageKey, folds, defaultOpen]);

  return <details className={`wb-context-document-card wb-context-document-${view.scope}`} data-context-document-id={view.meta.id} open={folds.open}
    onToggle={(event) => {
      if (event.target !== event.currentTarget) return;
      const open = event.currentTarget.open;
      setFolds(previous => previous.open === open ? previous : { ...previous, open });
    }}>
    <summary><span className="wb-context-document-label">{label}</span><span className="wb-context-document-meta">r{view.meta.revision} · {view.information.filter(entry => entry.status === "active").length} 条信息</span></summary>
    <ContextTree view={view} expanded={new Set(folds.expanded)} toggle={(id, open) => setFolds(previous => {
      if (previous.expanded.includes(id) === open) return previous;
      return { ...previous, expanded: open ? [...previous.expanded, id] : previous.expanded.filter(item => item !== id) };
    })} />
  </details>;
}

export function ContextDocumentCard({ workspaceId, label, view, defaultOpen = false }: {
  workspaceId: string;
  label: string;
  view?: RuntimeContextDocumentView;
  defaultOpen?: boolean;
}) {
  if (!view) return <div className="wb-context-document-card wb-context-document-empty"><p className="wb-app-note">{label}暂无正式文档。</p></div>;
  const storageKey = `capybara:context-folds:${JSON.stringify([workspaceId, view.scope, view.meta.id])}`;
  return <SavedContextDocumentCard key={storageKey} storageKey={storageKey} label={label} view={view} defaultOpen={defaultOpen} />;
}
