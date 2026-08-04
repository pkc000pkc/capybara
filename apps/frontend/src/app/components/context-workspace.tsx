"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  LockKeyhole,
  Plus,
  Play,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import type {
  Diagnostic,
  JsonValue,
  RenderMessage,
  RenderResultState,
  RuntimeContextsState,
  RuntimeEffectiveContextsState,
  RuntimeHarnessesState,
  RuntimeSkillsState,
  RuntimeToolsState,
  TemplateState,
} from "../runtime-protocol";
import CodeSurface from "./code-surface";
import MarkdownContent from "./markdown-content";
import {
  SearchField,
  WorkspaceTabs,
  type WorkspaceTab,
} from "./workspace-ui";

type ContextTab = "rendered" | "template" | "tools" | "harnesses" | "skills" | "memory";
type MarkdownMode = "edit" | "preview" | "split";

const TABS: { id: ContextTab }[] = [
  { id: "rendered" },
  { id: "template" },
  { id: "tools" },
  { id: "harnesses" },
  { id: "skills" },
  { id: "memory" },
];

function MarkdownPreview({
  source,
  embedded = false,
}: {
  source: string;
  embedded?: boolean;
}) {
  return (
    <div
      className={
        embedded
          ? "bg-white px-1 py-2"
          : "minimal-scrollbar h-full min-h-0 overflow-auto bg-white p-4"
      }
    >
      <MarkdownContent source={source} />
    </div>
  );
}

function RenderWarnings({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const { t } = useI18n();
  const warnings = diagnostics.filter((item) => item.severity === "warning");
  const missingVariables = warnings
    .filter((item) =>
      item.code === "MISSING_VARIABLE" || item.code === "MISSING_SYSTEM_VARIABLE",
    )
    .map((item) => item.message.match(/"([^"]+)"/)?.[1])
    .filter((name): name is string => Boolean(name));
  const missingReferences = warnings
    .filter((item) => item.code === "MISSING_SYSTEM_VARIABLE_REFERENCE")
    .map((item) => item.message.match(/"([^"]+)"/)?.[1])
    .filter((name): name is string => Boolean(name));
  const otherWarnings = warnings.filter((item) =>
    !["MISSING_VARIABLE", "MISSING_SYSTEM_VARIABLE", "MISSING_SYSTEM_VARIABLE_REFERENCE"].includes(item.code),
  );
  const messages = [
    ...(missingVariables.length > 0
      ? [t(
          warnings.every((item) => item.code === "MISSING_SYSTEM_VARIABLE")
            ? "context.missingSystemVariables"
            : "context.missingVariables",
          { variables: missingVariables.join(", ") },
        )]
      : []),
    ...(missingReferences.length > 0
      ? [t("context.missingSystemVariableReferences", {
          variables: missingReferences.join(", "),
        })]
      : []),
    ...otherWarnings.map((item) => item.message),
  ];

  return warnings.length > 0 ? (
        <div
          className="flex items-start gap-2 border-t border-[#d7b76a] bg-[#fff8df] px-3 py-2 text-[11px] leading-5 text-[#745317]"
          data-render-warnings
          role="status"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 shrink-0"
            size={14}
            strokeWidth={1.8}
          />
          <span>{messages.join("; ")}</span>
        </div>
  ) : null;
}

function prettyToolContent(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function RuntimeMessage({ message, index }: { message: RenderMessage; index: number }) {
  const { t } = useI18n();
  const toolContent = message.role === "tool" ? prettyToolContent(message.content) : "";
  const largeToolResult = toolContent.length > 1_200 || toolContent.split("\n").length > 14;
  const roleLabel = [message.role, message.name].filter(Boolean).join(" · ");

  return (
    <section className="pb-2" data-context-role={message.role}>
      <div className="flex items-center gap-2 py-1 text-[6px] font-medium uppercase text-[#74878a]">
        <span className="message-role-divider h-px flex-1" aria-hidden="true" />
        <span>{roleLabel}</span>
        <span className="message-role-divider h-px flex-1" aria-hidden="true" />
      </div>

      {message.toolCalls?.map((call) => (
        <div className="border-b border-[#dbe5e4] border-l-2 border-l-[#c58a27] py-1 pl-2" data-tool-call={call.name} key={call.id}>
          <div className="flex min-w-0 items-center justify-between gap-2 py-1">
            <span className="truncate font-mono text-[10px] font-semibold text-[#76531b]">{call.name}</span>
            <span className="truncate font-mono text-[8px] text-[#829194]" title={call.id}>{call.id}</span>
          </div>
          <CodeSurface
            ariaLabel={t("context.toolCallArguments", { name: call.name })}
            height="content"
            language="JSON"
            lineWrapping
            maxHeight="180px"
            minHeight="38px"
            readOnly
            statusBar={false}
            value={JSON.stringify(call.arguments, null, 2)}
          />
        </div>
      ))}

      {message.role === "tool" ? (
        <details className="border-l-2 border-l-[#347f91] pl-2" data-tool-result={message.name ?? message.toolCallId ?? index} open={!largeToolResult}>
          <summary className="cursor-pointer select-none py-1 font-mono text-[9px] text-[#486a70] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]">
            {t("context.toolResult", { count: toolContent.length })}
          </summary>
          <CodeSurface
            ariaLabel={t("context.toolResultContent", { name: message.name ?? "tool" })}
            height="content"
            language={toolContent.startsWith("{") || toolContent.startsWith("[") ? "JSON" : "Text"}
            lineNumbers
            lineWrapping
            maxHeight="360px"
            minHeight="44px"
            readOnly
            statusBar={false}
            value={toolContent}
          />
        </details>
      ) : message.content.trim() ? (
        <MarkdownPreview source={message.content} embedded />
      ) : null}
    </section>
  );
}

function RenderResultWorkspace({
  artifactContents,
  contexts,
  effectiveContexts,
  onGetArtifact,
  requestId,
  renderResult,
}: {
  artifactContents: Record<string, JsonValue>;
  contexts: RuntimeContextsState;
  effectiveContexts: RuntimeEffectiveContextsState;
  onGetArtifact: (artifactId: string) => void;
  requestId: string | null;
  renderResult: RenderResultState | null;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<{
    requestId: string | null;
    contextId: string | null;
  }>({ requestId: null, contextId: null });
  const selectedId = selection.requestId === requestId ? selection.contextId : null;
  const contentRef = useRef<HTMLDivElement>(null);
  const requestContexts = requestId
    ? effectiveContexts.items.filter((item) => item.runId === requestId)
    : effectiveContexts.items;
  const latestRequestId = effectiveContexts.items.at(-1)?.runId;
  const hasLivePage = !requestId || !latestRequestId || requestId === latestRequestId;
  const selectedIndex = selectedId
    ? requestContexts.findIndex((item) => item.id === selectedId)
    : -1;
  const selected = selectedIndex >= 0
    ? requestContexts[selectedIndex]
    : hasLivePage ? undefined : requestContexts.at(-1);
  const effectiveSelectedIndex = selected
    ? requestContexts.findIndex((item) => item.id === selected.id)
    : -1;
  const totalPages = Math.max(requestContexts.length + (hasLivePage ? 1 : 0), 1);
  const currentPage = selected ? effectiveSelectedIndex + 1 : totalPages;
  useEffect(() => {
    if (selected && !(selected.messagesArtifactId in artifactContents)) {
      onGetArtifact(selected.messagesArtifactId);
    }
  }, [artifactContents, onGetArtifact, selected]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  const artifact = selected
    ? artifactContents[selected.messagesArtifactId]
    : undefined;
  const historicalMessages = Array.isArray(artifact)
    ? artifact as unknown as RenderMessage[]
    : null;
  const sourceContext = selected?.contextRevisionId
    ? contexts.items.find((item) => item.id === selected.contextRevisionId)
    : undefined;
  const historicalResult: RenderResultState | null = selected && historicalMessages
    ? {
        messages: historicalMessages,
        format: "llm-messages",
        templateRevision: sourceContext?.templateRevision ?? renderResult?.templateRevision ?? 0,
        variablesRevision: sourceContext?.variablesRevision ?? renderResult?.variablesRevision ?? 0,
        renderedAt: selected.createdAt,
        diagnostics: (sourceContext?.missingVariables ?? []).map((name) => ({
          severity: "warning",
          code: "MISSING_VARIABLE",
          message: `Missing variable "${name}"`,
        })),
      }
    : null;
  const visibleResult = selected ? historicalResult : renderResult;

  const showPrevious = () => {
    const index = selected ? effectiveSelectedIndex : requestContexts.length;
    const previous = requestContexts[index - 1];
    if (previous) setSelection({ requestId, contextId: previous.id });
  };

  const showNext = () => {
    const next = requestContexts[effectiveSelectedIndex + 1];
    if (next) setSelection({ requestId, contextId: next.id });
    else if (hasLivePage) setSelection({ requestId, contextId: null });
  };

  return (
    <div
      className="grid h-full min-h-0 grid-rows-[32px_minmax(0,1fr)_auto]"
      data-context-replay-mode={selected ? "history" : "live"}
    >
      <div
        aria-label={t("context.replay")}
        className="flex min-w-0 items-center justify-between border-b border-[#cbd8d8] bg-[#edf3f2] px-2"
        role="toolbar"
      >
        <span
          className={`min-w-0 truncate text-[9px] font-semibold uppercase ${
            selected ? "text-[#82611f]" : "text-[#17675f]"
          }`}
        >
          {selected ? t("context.replayHistorical") : t("context.replayLive")}
          {requestId ? ` · ${requestId.slice(-8)}` : ""}
        </span>
        <div className="flex h-full shrink-0 items-center" role="group">
          <button
            aria-label={t("context.replayPrevious")}
            className="flex h-7 w-7 items-center justify-center text-[#536d72] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-default disabled:text-[#aab7b8] disabled:hover:bg-transparent"
            disabled={currentPage <= 1}
            onClick={showPrevious}
            title={t("context.replayPrevious")}
            type="button"
          >
            <ChevronLeft aria-hidden="true" size={14} strokeWidth={1.8} />
          </button>
          <output
            aria-label={t("context.replayPage", { current: currentPage, total: totalPages })}
            className="w-11 text-center font-mono text-[9px] text-[#5f7377]"
          >
            {currentPage} / {totalPages}
          </output>
          <button
            aria-label={t("context.replayNext")}
            className="flex h-7 w-7 items-center justify-center text-[#536d72] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-default disabled:text-[#aab7b8] disabled:hover:bg-transparent"
            disabled={!selected || (!hasLivePage && currentPage >= totalPages)}
            onClick={showNext}
            title={t("context.replayNext")}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={14} strokeWidth={1.8} />
          </button>
          <button
            aria-label={t("context.replayLatest")}
            className="flex h-7 w-7 items-center justify-center text-[#536d72] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-default disabled:text-[#aab7b8] disabled:hover:bg-transparent"
            disabled={!selected || !hasLivePage}
            onClick={() => setSelection({ requestId, contextId: null })}
            title={t("context.replayLatest")}
            type="button"
          >
            <ChevronsRight aria-hidden="true" size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <div
        className="minimal-scrollbar min-h-0 overflow-auto bg-white px-4 py-2"
        ref={contentRef}
      >
        {selected && !historicalResult ? (
          <div className="flex h-full min-h-24 items-center justify-center text-[10px] text-[#718488]">
            {t("context.replayLoading")}
          </div>
        ) : (
          <div>
            {(visibleResult?.messages ?? []).map((message, index) => (
              <RuntimeMessage
                index={index}
                key={`${message.role}-${message.toolCallId ?? message.toolCalls?.[0]?.id ?? index}`}
                message={message}
              />
            ))}
          </div>
        )}
      </div>
      <RenderWarnings diagnostics={visibleResult?.diagnostics ?? []} />
    </div>
  );
}

type MarkdownWorkspaceProps = {
  source: string;
  language: string;
  onChange: (value: string) => void;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  error?: string | null;
  diagnostics?: Diagnostic[];
};

function MarkdownWorkspace({
  source,
  language,
  onChange,
  action,
  error,
  diagnostics = [],
}: MarkdownWorkspaceProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<MarkdownMode>("edit");

  return (
    <div
      className="grid h-full min-h-0"
      style={{
        gridTemplateRows: [
          "36px",
          ...(error ? ["28px"] : []),
          "minmax(0, 1fr)",
          ...(diagnostics.some((item) => item.severity === "warning") ? ["auto"] : []),
        ].join(" "),
      }}
    >
      <div className="flex items-center justify-between border-b border-[#d4dfdf] bg-[#f2f6f5] px-2">
        <span className="font-mono text-[10px] text-[#718488]">{language}</span>
        <div className="flex items-center gap-1.5">
          {action && (
            <button
              className="h-6 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-[#a9b9b9] disabled:hover:bg-[#a9b9b9]"
              disabled={action.disabled}
              onClick={action.onClick}
              type="button"
            >
              {action.label}
            </button>
          )}
          <div
            aria-label={t("editor.view")}
            className="flex border border-[#c5d4d3] bg-white"
            role="group"
          >
            {(["edit", "preview", "split"] as const).map((item) => (
              <button
                aria-pressed={mode === item}
                className={`h-6 border-r border-[#d7e1e0] px-2 text-[10px] last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${
                  mode === item
                    ? "bg-[#dcebe8] font-semibold text-[#175a54]"
                    : "text-[#64787c] hover:bg-[#eef4f3]"
                }`}
                key={item}
                onClick={() => setMode(item)}
                type="button"
              >
                {item === "edit"
                  ? t("editor.edit")
                  : item === "preview"
                    ? t("editor.preview")
                    : t("editor.split")}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="truncate border-b border-[#d7b9b9] bg-[#fff1f1] px-2.5 py-1 text-[10px] text-[#843d3d]" title={error}>
          {error}
        </div>
      )}

      {mode === "edit" && (
        <CodeSurface
          ariaLabel={t("editor.label", { language })}
          language={language}
          onChange={onChange}
          onSave={action?.onClick}
          value={source}
        />
      )}
      {mode === "preview" && <MarkdownPreview source={source} />}
      {mode === "split" && (
        <div className="grid min-h-0 grid-rows-2 divide-y divide-[#bfcfce]">
          <CodeSurface
            ariaLabel={t("editor.label", { language })}
            language={language}
            onChange={onChange}
            onSave={action?.onClick}
            value={source}
          />
          <MarkdownPreview source={source} />
        </div>
      )}
      <RenderWarnings diagnostics={diagnostics} />
    </div>
  );
}

function ServerTemplateWorkspace({
  diagnostics,
  error,
  onUpdate,
  template,
}: {
  diagnostics: Diagnostic[];
  error: string | null;
  onUpdate: (source: string) => void;
  template: TemplateState;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState(template.source);

  const dirty = source !== template.source;
  const submit = () => dirty && onUpdate(source);

  return (
    <MarkdownWorkspace
      action={{ label: t("context.save"), onClick: submit, disabled: !dirty }}
      diagnostics={diagnostics}
      error={error}
      language="Jinja2 + Markdown"
      onChange={setSource}
      source={source}
    />
  );
}

type DefinitionListProps = {
  addLabel: string;
  canAdd?: boolean;
  canDelete?: (id: string) => boolean;
  items: { id: string; name: string }[];
  itemType: string;
  selectedId: string | null;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
};

function DefinitionList({
  addLabel,
  canAdd = true,
  canDelete = () => true,
  items,
  itemType,
  selectedId,
  onAdd,
  onDelete,
  onSelect,
}: DefinitionListProps) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-0 grid-rows-[32px_1fr] bg-[#eef4f3]">
      <div className="flex items-center justify-between border-b border-[#d4dfdf] px-2.5">
        <span className="text-[10px] font-semibold uppercase text-[#63777b]">
          {t("definition.count", { count: items.length, type: itemType })}
        </span>
        <button
          aria-label={addLabel}
          className="flex h-6 w-6 items-center justify-center text-base text-[#45666a] outline-none hover:bg-[#d9e8e5] hover:text-[#0c766e] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-not-allowed disabled:text-[#a3b0b2] disabled:hover:bg-transparent"
          disabled={!canAdd}
          onClick={onAdd}
          title={canAdd ? addLabel : t("definition.allToolsAdded")}
          type="button"
        >
          <Plus aria-hidden="true" size={14} strokeWidth={1.8} />
        </button>
      </div>
      <div className="minimal-scrollbar min-h-0 overflow-auto py-1" role="listbox">
        {items.length === 0 ? (
          <button
            className="mx-2 mt-2 border border-dashed border-[#aebfbe] px-3 py-2 text-xs text-[#63777b] hover:border-[#4f8f89] hover:text-[#245d58]"
            disabled={!canAdd}
            onClick={onAdd}
            type="button"
          >
            {addLabel}
          </button>
        ) : (
          items.map((item) => {
            const selected = selectedId === item.id;
            return (
              <div
                className={`group grid min-h-8 grid-cols-[1fr_28px] items-center border-b border-[#dce5e5] ${
                  selected ? "bg-[#d8e9e6]" : "hover:bg-[#e3edeb]"
                }`}
                key={item.id}
              >
                <button
                  aria-selected={selected}
                  className="min-w-0 truncate px-3 text-left font-mono text-[11px] text-[#29484c] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
                  onClick={() => onSelect(item.id)}
                  role="option"
                  type="button"
                >
                  {item.name || t("definition.unnamed", { type: itemType })}
                </button>
                {canDelete(item.id) ? (
                  <button
                    aria-label={t("definition.delete", {
                      name: item.name || itemType,
                    })}
                    className="flex h-7 w-7 items-center justify-center text-base text-[#718488] opacity-0 outline-none hover:bg-[#cfdfdc] hover:text-[#843d3d] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] group-hover:opacity-100"
                    onClick={() => onDelete(item.id)}
                    title={t("definition.deleteShort")}
                    type="button"
                  >
                    ×
                  </button>
                ) : <span aria-hidden="true" />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ToolsWorkspace({
  onOpenToolResources,
  tools,
  onAttachTool,
  onDetachTool,
}: {
  onOpenToolResources: () => void;
  tools: RuntimeToolsState;
  onAttachTool: (toolId: string) => void;
  onDetachTool: (toolId: string) => void;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(
    tools.items[0]?.id ?? null,
  );
  const effectiveSelectedId = tools.items.some((tool) => tool.id === selectedId)
    ? selectedId
    : (tools.items[0]?.id ?? null);
  const selected =
    tools.items.find((tool) => tool.id === effectiveSelectedId) ?? null;
  const availableTools = tools.catalog.filter(
    (candidate) => !tools.items.some((tool) => tool.id === candidate.id),
  );
  const canAdd = availableTools.length > 0;
  const [pickerOpen, setPickerOpen] = useState(false);

  const addTool = () => {
    if (canAdd) setPickerOpen(true);
  };

  const selectTool = (id: string) => {
    setPickerOpen(false);
    setSelectedId(id);
    onAttachTool(id);
  };

  const deleteTool = (id: string) => {
    onDetachTool(id);
  };

  return (
    <div className="relative grid h-full min-h-0 grid-rows-[minmax(112px,30%)_1fr] divide-y divide-[#aebfbe]">
      <DefinitionList
        addLabel={t("definition.addTool")}
        canAdd={canAdd}
        itemType={t("definition.tool")}
        items={tools.items}
        onAdd={addTool}
        onDelete={deleteTool}
        onSelect={setSelectedId}
        selectedId={effectiveSelectedId}
      />
      {selected ? (
        <div className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)_minmax(0,1.35fr)] divide-y divide-[#bfcfce]">
          <div className="flex min-w-0 items-center gap-2 border-b border-[#d4dfdf] bg-[#f5f8f7] px-2">
            <LockKeyhole
              aria-hidden="true"
              className="shrink-0 text-[#60777b]"
              size={13}
              strokeWidth={1.8}
            />
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-[#29484c]">
              {selected.name}
            </span>
            <button
              className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[10px] font-medium text-[#17675f] outline-none hover:bg-[#dfecea] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
              onClick={onOpenToolResources}
              title={t("definition.editInResources")}
              type="button"
            >
              {t("definition.editInResources")}
              <ArrowUpRight aria-hidden="true" size={12} strokeWidth={1.8} />
            </button>
          </div>
          <CodeSurface
            ariaLabel={t("definition.toolDescription")}
            language="Text"
            readOnly
            value={selected.description}
          />
          <CodeSurface
            ariaLabel={t("definition.toolYaml")}
            language="JSON"
            readOnly
            value={JSON.stringify(
              {
                inputSchema: selected.inputSchema,
                outputSchema: selected.outputSchema,
                definitionRevision: selected.definitionRevision,
                enabled: selected.enabled,
              },
              null,
              2,
            )}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center text-xs text-[#718488]">
          {t("definition.chooseTool")}
        </div>
      )}
      {pickerOpen && (
        <ToolPicker
          onClose={() => setPickerOpen(false)}
          onSelect={selectTool}
          tools={availableTools}
        />
      )}
    </div>
  );
}

function ToolPicker({
  onClose,
  onSelect,
  tools,
}: {
  onClose: () => void;
  onSelect: (id: string) => void;
  tools: RuntimeToolsState["catalog"];
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const pickerRef = useRef<HTMLElement>(null);
  const queryTerms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredTools = tools.filter((tool) => {
    const searchable = `${tool.name} ${tool.description}`.toLowerCase();
    return queryTerms.every((term) => searchable.includes(term));
  });

  useEffect(() => {
    pickerRef.current?.querySelector("input")?.focus();
  }, []);

  return (
    <div
      className="absolute inset-0 z-20 bg-[#18272c]/15 p-2"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      role="presentation"
    >
      <section
        aria-labelledby="tool-picker-title"
        className="grid max-h-full min-h-0 grid-rows-[34px_38px_minmax(0,1fr)] border border-[#91aaa9] bg-white shadow-[0_10px_24px_rgba(24,39,44,0.18)]"
        onKeyDown={(event) => event.key === "Escape" && onClose()}
        ref={pickerRef}
        role="dialog"
      >
        <header className="flex min-w-0 items-center justify-between border-b border-[#cbd8d9] bg-[#edf3f2] px-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-[11px] font-semibold text-[#29484c]" id="tool-picker-title">
              {t("definition.toolPickerTitle")}
            </h3>
            <span className="shrink-0 font-mono text-[9px] text-[#718488]">
              {t("definition.availableToolCount", { count: tools.length })}
            </span>
          </div>
          <button
            aria-label={t("definition.closeToolPicker")}
            className="flex h-7 w-7 shrink-0 items-center justify-center text-[#60777a] outline-none hover:bg-[#dce8e6] hover:text-[#29484c] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
            onClick={onClose}
            title={t("definition.closeToolPicker")}
            type="button"
          >
            <X aria-hidden="true" size={14} strokeWidth={1.8} />
          </button>
        </header>
        <div className="border-b border-[#d9e3e3] p-1.5">
          <SearchField
            compact
            label={t("definition.searchTools")}
            onChange={setQuery}
            value={query}
          />
        </div>
        <div className="minimal-scrollbar min-h-0 overflow-y-auto py-1" role="listbox">
          {filteredTools.length > 0 ? filteredTools.map((tool) => (
            <button
              aria-label={t("definition.addToolToContext", { name: tool.name })}
              aria-selected="false"
              className="block w-full border-b border-[#dce5e5] px-3 py-2 text-left outline-none hover:bg-[#e3edeb] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
              key={tool.id}
              onClick={() => onSelect(tool.id)}
              role="option"
              type="button"
            >
              <span className="block truncate font-mono text-[11px] font-semibold text-[#29484c]">
                {tool.name}
              </span>
              <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-[#667b7f]">
                {tool.description}
              </span>
            </button>
          )) : (
            <div className="flex min-h-20 items-center justify-center px-4 text-center text-[10px] text-[#718488]">
              {t("definition.noMatchingTools")}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function HarnessesWorkspace({
  harnesses,
  onAttachHarness,
  onDetachHarness,
  onOpenHarnessResources,
}: {
  harnesses: RuntimeHarnessesState;
  onAttachHarness: (harnessId: string) => void;
  onDetachHarness: (harnessId: string) => void;
  onOpenHarnessResources: () => void;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(
    harnesses.items[0]?.id ?? null,
  );
  const effectiveSelectedId = harnesses.items.some(
    (harness) => harness.id === selectedId,
  )
    ? selectedId
    : (harnesses.items[0]?.id ?? null);
  const selected =
    harnesses.items.find((harness) => harness.id === effectiveSelectedId) ??
    null;
  const available = harnesses.catalog.filter((candidate) =>
    !harnesses.items.find((item) => item.id === candidate.id)?.bindings
      .some((binding) => binding.source === "user"),
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="relative grid h-full min-h-0 grid-rows-[minmax(112px,30%)_1fr] divide-y divide-[#aebfbe]">
      <DefinitionList
        addLabel={t("definition.addHarness")}
        canAdd={available.length > 0}
        canDelete={(id) => harnesses.items.find((item) => item.id === id)?.bindings
          .some((binding) => binding.source === "user" || binding.source === "retrieval") ?? false}
        itemType={t("definition.harness")}
        items={harnesses.items}
        onAdd={() => setPickerOpen(true)}
        onDelete={onDetachHarness}
        onSelect={setSelectedId}
        selectedId={effectiveSelectedId}
      />
      {selected ? (
        <div className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)_minmax(92px,0.7fr)] divide-y divide-[#bfcfce]">
          <div className="flex min-w-0 items-center gap-2 bg-[#f5f8f7] px-2">
            <span className={selected.status === "active" ? "h-1.5 w-1.5 bg-[#2f8a65]" : "h-1.5 w-1.5 bg-[#b44747]"} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-[#29484c]">{selected.name}</span>
            <span className="font-mono text-[8px] uppercase text-[#718488]">{selected.type}</span>
            <button
              className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[10px] font-medium text-[#17675f] outline-none hover:bg-[#dfecea] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
              onClick={onOpenHarnessResources}
              type="button"
            >
              {t("definition.editInResources")}
              <ArrowUpRight aria-hidden="true" size={12} strokeWidth={1.8} />
            </button>
          </div>
          <CodeSurface
            ariaLabel={t("definition.harnessEditor")}
            language="Markdown"
            readOnly
            value={selected.content}
          />
          <CodeSurface
            ariaLabel={t("definition.harnessBindings")}
            language="JSON"
            readOnly
            value={JSON.stringify({
              status: selected.status,
              bindings: selected.bindings,
              diagnostics: selected.diagnostics,
              renderArtifactId: selected.renderArtifactId,
            }, null, 2)}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center text-xs text-[#718488]">
          {t("definition.chooseHarness")}
        </div>
      )}
      {pickerOpen && (
        <HarnessPicker
          harnesses={available}
          onClose={() => setPickerOpen(false)}
          onSelect={(id) => {
            setPickerOpen(false);
            setSelectedId(id);
            onAttachHarness(id);
          }}
        />
      )}
    </div>
  );
}

function HarnessPicker({
  harnesses,
  onClose,
  onSelect,
}: {
  harnesses: RuntimeHarnessesState["catalog"];
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const pickerRef = useRef<HTMLElement>(null);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = harnesses.filter((harness) => {
    const searchable = `${harness.name} ${harness.description} ${harness.type}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });

  useEffect(() => { pickerRef.current?.querySelector("input")?.focus(); }, []);
  return (
    <div className="absolute inset-0 z-20 bg-[#18272c]/15 p-2" onMouseDown={(event) => event.target === event.currentTarget && onClose()} role="presentation">
      <section
        aria-labelledby="harness-picker-title"
        className="grid max-h-full min-h-0 grid-rows-[34px_38px_minmax(0,1fr)] border border-[#91aaa9] bg-white shadow-[0_10px_24px_rgba(24,39,44,0.18)]"
        onKeyDown={(event) => event.key === "Escape" && onClose()}
        ref={pickerRef}
        role="dialog"
      >
        <header className="flex items-center justify-between border-b border-[#cbd8d9] bg-[#edf3f2] px-2.5">
          <h3 className="text-[11px] font-semibold text-[#29484c]" id="harness-picker-title">{t("definition.harnessPickerTitle")}</h3>
          <button aria-label={t("definition.closeHarnessPicker")} className="flex h-7 w-7 items-center justify-center text-[#60777a] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" onClick={onClose} type="button">
            <X aria-hidden="true" size={14} />
          </button>
        </header>
        <div className="border-b border-[#d9e3e3] p-1.5">
          <SearchField compact label={t("definition.searchHarnesses")} onChange={setQuery} value={query} />
        </div>
        <div className="minimal-scrollbar min-h-0 overflow-y-auto py-1" role="listbox">
          {filtered.map((harness) => (
            <button aria-selected="false" className="block w-full border-b border-[#dce5e5] px-3 py-2 text-left outline-none hover:bg-[#e3edeb] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" key={harness.id} onClick={() => onSelect(harness.id)} role="option" type="button">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[11px] font-semibold text-[#29484c]">{harness.name}</span>
                <span className="font-mono text-[8px] uppercase text-[#718488]">{harness.type}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-[#667b7f]">{harness.description}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function SkillsWorkspace({
  onAttachSkill,
  onDetachSkill,
  onLoadReference,
  onOpenSkillResources,
  onRunScript,
  skills,
}: {
  onAttachSkill: (skillId: string) => void;
  onDetachSkill: (skillId: string) => void;
  onLoadReference: (skillId: string, path: string) => void;
  onOpenSkillResources: () => void;
  onRunScript: (skillId: string, path: string, argv: string[]) => void;
  skills: RuntimeSkillsState;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(skills.items[0]?.id ?? null);
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [argv, setArgv] = useState("[]");
  const [argvError, setArgvError] = useState<string | null>(null);
  const effectiveSelectedId = skills.items.some((item) => item.id === selectedId)
    ? selectedId
    : (skills.items[0]?.id ?? null);
  const selected = skills.items.find((item) => item.id === effectiveSelectedId) ?? null;
  const resource = selected?.resources.find((item) => item.path === selectedResource) ?? null;
  const available = skills.catalog.filter(
    (candidate) => !skills.items.some((item) => item.id === candidate.id),
  );
  const run = (path: string) => {
    try {
      const value = JSON.parse(argv) as unknown;
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(t("definition.skillArgvInvalid"));
      }
      setArgvError(null);
      onRunScript(selected!.id, path, value);
    } catch (error) {
      setArgvError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="relative grid h-full min-h-0 grid-rows-[minmax(104px,28%)_1fr] divide-y divide-[#aebfbe]">
      <DefinitionList
        addLabel={t("definition.addSkill")}
        canAdd={available.length > 0}
        itemType={t("definition.skill")}
        items={skills.items}
        onAdd={() => setPickerOpen(true)}
        onDelete={onDetachSkill}
        onSelect={(id) => { setSelectedId(id); setSelectedResource(null); }}
        selectedId={effectiveSelectedId}
      />
      {selected ? (
        <div className="grid min-h-0 grid-rows-[34px_minmax(90px,0.8fr)_minmax(110px,1fr)] divide-y divide-[#bfcfce]">
          <div className="flex min-w-0 items-center gap-2 bg-[#f5f8f7] px-2">
            <span className={selected.status === "active" ? "h-1.5 w-1.5 bg-[#2f8a65]" : "h-1.5 w-1.5 bg-[#b44747]"} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-[#29484c]">{selected.name}</span>
            <span className="font-mono text-[8px] uppercase text-[#718488]">{selected.source}</span>
            <button className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[10px] font-medium text-[#17675f] outline-none hover:bg-[#dfecea] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" onClick={onOpenSkillResources} type="button">
              {t("definition.editInResources")}
              <ArrowUpRight aria-hidden="true" size={12} strokeWidth={1.8} />
            </button>
          </div>
          <CodeSurface ariaLabel={t("definition.skillInstructions")} language="Markdown" readOnly value={selected.instructions} />
          <div className="grid min-h-0 grid-cols-[minmax(130px,42%)_1fr] divide-x divide-[#bfcfce]">
            <div className="minimal-scrollbar min-h-0 overflow-auto bg-[#eef4f3] py-1">
              {selected.resources.map((item) => (
                <button
                  className={`grid min-h-8 w-full grid-cols-[16px_1fr_auto] items-center gap-1 border-b border-[#dce5e5] px-2 text-left outline-none hover:bg-[#e3edeb] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${resource?.path === item.path ? "bg-[#d8e9e6]" : ""}`}
                  key={`${item.kind}:${item.path}`}
                  onClick={() => setSelectedResource(item.path)}
                  type="button"
                >
                  {item.kind === "script" ? <Play aria-hidden="true" size={11} /> : <BookOpen aria-hidden="true" size={11} />}
                  <span className="truncate font-mono text-[9px] text-[#29484c]">{item.path}</span>
                  <span className="font-mono text-[7px] uppercase text-[#718488]">{item.status}</span>
                </button>
              ))}
            </div>
            {resource ? (
              <div className="grid min-h-0 grid-rows-[32px_1fr]">
                <div className="flex min-w-0 items-center gap-1 border-b border-[#d4dfdf] bg-[#f5f8f7] px-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-[#60777a]">{resource.path}</span>
                  {resource.kind === "reference" && (
                    <button className="h-6 px-2 text-[9px] font-semibold text-[#17675f] hover:bg-[#dfecea]" disabled={resource.status === "loading"} onClick={() => onLoadReference(selected.id, resource.path)} type="button">
                      {resource.status === "loaded" ? t("definition.reload") : t("definition.load")}
                    </button>
                  )}
                  {resource.kind === "script" && (
                    <>
                      <input aria-label={t("definition.skillArgv")} className="h-6 min-w-0 flex-1 border border-[#c6d4d3] bg-white px-1.5 font-mono text-[8px] outline-none focus:border-[#0c766e]" onChange={(event) => setArgv(event.target.value)} title={argvError ?? t("definition.skillArgv")} value={argv} />
                      <button aria-label={t("definition.runSkillScript")} className="flex h-6 w-6 items-center justify-center text-[#17675f] hover:bg-[#dfecea] disabled:text-[#9aabaa]" disabled={resource.status === "loading"} onClick={() => run(resource.path)} title={t("definition.runSkillScript")} type="button">
                        <Play aria-hidden="true" size={12} />
                      </button>
                    </>
                  )}
                </div>
                <CodeSurface ariaLabel={resource.path} language={resource.kind === "reference" ? "Markdown" : "Text"} readOnly value={resource.error ?? resource.content ?? ""} />
              </div>
            ) : (
              <div className="flex items-center justify-center text-[10px] text-[#718488]">{t("definition.chooseSkillResource")}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center text-xs text-[#718488]">{t("definition.chooseSkill")}</div>
      )}
      {pickerOpen && (
        <SkillPicker
          onClose={() => setPickerOpen(false)}
          onSelect={(id) => { setPickerOpen(false); setSelectedId(id); onAttachSkill(id); }}
          skills={available}
        />
      )}
    </div>
  );
}

function SkillPicker({ onClose, onSelect, skills }: {
  onClose: () => void;
  onSelect: (id: string) => void;
  skills: RuntimeSkillsState["catalog"];
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = skills.filter((skill) => terms.every(
    (term) => `${skill.name} ${skill.description}`.toLowerCase().includes(term),
  ));
  return (
    <div className="absolute inset-0 z-20 bg-[#18272c]/15 p-2" onMouseDown={(event) => event.target === event.currentTarget && onClose()} role="presentation">
      <section aria-labelledby="skill-picker-title" className="grid max-h-full min-h-0 grid-rows-[34px_38px_minmax(0,1fr)] border border-[#91aaa9] bg-white shadow-[0_10px_24px_rgba(24,39,44,0.18)]" role="dialog">
        <header className="flex items-center justify-between border-b border-[#cbd8d9] bg-[#edf3f2] px-2.5">
          <h3 className="text-[11px] font-semibold text-[#29484c]" id="skill-picker-title">{t("definition.skillPickerTitle")}</h3>
          <button aria-label={t("definition.closeSkillPicker")} className="flex h-7 w-7 items-center justify-center text-[#60777a] hover:bg-[#dce8e6]" onClick={onClose} type="button"><X aria-hidden="true" size={14} /></button>
        </header>
        <div className="border-b border-[#d9e3e3] p-1.5"><SearchField compact label={t("definition.searchSkills")} onChange={setQuery} value={query} /></div>
        <div className="minimal-scrollbar min-h-0 overflow-y-auto py-1" role="listbox">
          {filtered.map((skill) => (
            <button aria-selected="false" className="block w-full border-b border-[#dce5e5] px-3 py-2 text-left outline-none hover:bg-[#e3edeb]" key={skill.id} onClick={() => onSelect(skill.id)} role="option" type="button">
              <span className="block truncate font-mono text-[11px] font-semibold text-[#29484c]">{skill.name}</span>
              <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-[#667b7f]">{skill.description}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function ContextWorkspace({
  artifactContents,
  contexts,
  effectiveContexts,
  error,
  harnesses,
  skills,
  onAttachHarness,
  onAttachSkill,
  onAttachTool,
  onDetachHarness,
  onDetachSkill,
  onDetachTool,
  onGetArtifact,
  onOpenHarnessResources,
  onOpenSkillResources,
  onOpenToolResources,
  onLoadSkillReference,
  onRunSkillScript,
  onUpdateTemplate,
  renderResult,
  selectedRequestId,
  template,
  tools,
}: {
  artifactContents: Record<string, JsonValue>;
  contexts: RuntimeContextsState;
  effectiveContexts: RuntimeEffectiveContextsState;
  error: string | null;
  harnesses: RuntimeHarnessesState;
  skills: RuntimeSkillsState;
  onAttachHarness: (harnessId: string) => void;
  onAttachSkill: (skillId: string) => void;
  onAttachTool: (toolId: string) => void;
  onDetachHarness: (harnessId: string) => void;
  onDetachSkill: (skillId: string) => void;
  onDetachTool: (toolId: string) => void;
  onGetArtifact: (artifactId: string) => void;
  onOpenHarnessResources: () => void;
  onOpenSkillResources: () => void;
  onOpenToolResources: () => void;
  onLoadSkillReference: (skillId: string, path: string) => void;
  onRunSkillScript: (skillId: string, path: string, argv: string[]) => void;
  onUpdateTemplate: (source: string) => void;
  renderResult: RenderResultState | null;
  selectedRequestId: string | null;
  template: TemplateState;
  tools: RuntimeToolsState;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<ContextTab>("rendered");
  const tabs: WorkspaceTab<ContextTab>[] = TABS.map(({ id }) => ({
    controls: `context-${id}-panel`,
    id,
    label: id === "rendered"
      ? t("context.rendered")
      : id === "template"
        ? t("context.template")
        : id === "tools"
          ? t("context.tools")
          : id === "harnesses"
            ? t("context.harnesses")
             : id === "skills"
               ? t("context.skills")
               : t("context.memory"),
  }));

  return (
    <section
      aria-label={t("context.workspace")}
      className="grid min-h-0 min-w-0 grid-rows-[34px_1fr] bg-[#f4f8f8]"
      id="context-panel"
    >
      <WorkspaceTabs
        activeTab={activeTab}
        ariaLabel={t("context.content")}
        idPrefix="context"
        nextLabel={t("context.nextTab")}
        onChange={setActiveTab}
        previousLabel={t("context.previousTab")}
        scrollable
        tabs={tabs}
      />

      <div
        aria-labelledby={`context-${activeTab}-tab`}
        className="h-full min-h-0"
        id={`context-${activeTab}-panel`}
        role="tabpanel"
      >
        {activeTab === "rendered" && (
          <RenderResultWorkspace
            artifactContents={artifactContents}
            contexts={contexts}
            effectiveContexts={effectiveContexts}
            onGetArtifact={onGetArtifact}
            requestId={selectedRequestId}
            renderResult={renderResult}
          />
        )}
        {activeTab === "template" && (
          <ServerTemplateWorkspace
            diagnostics={(renderResult?.diagnostics ?? []).filter(
              (diagnostic) => diagnostic.code.startsWith("MISSING_SYSTEM_VARIABLE"),
            )}
            error={error}
            key={template.revision}
            onUpdate={onUpdateTemplate}
            template={template}
          />
        )}
        {activeTab === "tools" && (
          <ToolsWorkspace
            onAttachTool={onAttachTool}
            onDetachTool={onDetachTool}
            onOpenToolResources={onOpenToolResources}
            tools={tools}
          />
        )}
        {activeTab === "harnesses" && (
          <HarnessesWorkspace
            harnesses={harnesses}
            onAttachHarness={onAttachHarness}
            onDetachHarness={onDetachHarness}
            onOpenHarnessResources={onOpenHarnessResources}
          />
        )}
        {activeTab === "skills" && (
          <SkillsWorkspace
            onAttachSkill={onAttachSkill}
            onDetachSkill={onDetachSkill}
            onLoadReference={onLoadSkillReference}
            onOpenSkillResources={onOpenSkillResources}
            onRunScript={onRunSkillScript}
            skills={skills}
          />
        )}
        {activeTab === "memory" && (
          <div className="flex h-full items-center justify-center text-xs text-[#718488]">
            {t("context.memoryEmpty")}
          </div>
        )}
      </div>
    </section>
  );
}
