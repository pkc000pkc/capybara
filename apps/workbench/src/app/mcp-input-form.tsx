"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { CommandPayloadMap, RuntimeMcpFormField, RuntimeMcpFormValue, RuntimeMcpInputReply, RuntimeMcpInputView } from "@capybara-agent/protocol";

type ReplyPayload = CommandPayloadMap["runtime.mcp.input.reply"];
type Action = RuntimeMcpInputReply["action"];
type ReadUrl = (requestId: string, urlId: string) => Promise<{ url: string; host: string; message: string }>;
type OpenUrl = (requestId: string, urlId: string) => Promise<{ opened: boolean }>;

function Field({ name, id, field }: { name: string; id: string; field: RuntimeMcpFormField }) {
  const props = { name, id, required: field.required && field.kind !== "choices", "aria-describedby": field.description ? `${id}-description` : undefined };
  return <div className="wb-mcp-field">
    <label htmlFor={id}>{field.label}{field.required && <span className="wb-mcp-required">（必填）</span>}</label>
    {field.kind === "choice" || field.kind === "choices" ? <select {...props} multiple={field.kind === "choices"} defaultValue={field.kind === "choices" ? [] : ""}>
      {field.kind === "choice" && <option value="">请选择</option>}
      {field.options?.map(option => <option key={option.value} value={`value:${option.value}`}>{option.label}</option>)}
    </select> : field.kind === "boolean" ? <select {...props} defaultValue="">
      <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
    </select> : <input {...props} autoComplete="off" type={field.kind === "string" ? "text" : "number"} step={field.kind === "number" ? "any" : undefined} />}
    {field.description && <small id={`${id}-description`}>{field.description}</small>}
  </div>;
}

function UrlField({ requestId, item, readUrl, openUrl }: {
  requestId: string; item: NonNullable<RuntimeMcpInputView["urls"]>[number]; readUrl: ReadUrl; openUrl: OpenUrl;
}) {
  const [details, setDetails] = useState<Awaited<ReturnType<ReadUrl>>>();
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  useEffect(() => {
    let current = true;
    void readUrl(requestId, item.id).then(value => {
      if (current) {
        setDetails(value);
        setLoadingFailed(false);
      }
    }).catch(() => {
      if (current) setLoadingFailed(true);
    });
    return () => { current = false; };
  }, [item.id, readUrl, reload, requestId]);

  async function navigate() {
    if (opening || item.opened || !details) return;
    setOpening(true);
    setOpenFailed(false);
    try {
      if (!(await openUrl(requestId, item.id)).opened) setOpenFailed(true);
    } catch {
      setOpenFailed(true);
    } finally {
      setOpening(false);
    }
  }

  if (loadingFailed) return <>
    <p className="wb-mcp-error" role="alert">无法读取目标地址，请核对服务权限或重试。</p>
    <button type="button" onClick={() => { setLoadingFailed(false); setReload(value => value + 1); }}>重试读取</button>
  </>;
  if (!details) return <small role="status">正在读取目标地址…</small>;
  return <>
    <p>{details.message}</p>
    <div className="wb-mcp-url">
      <strong><bdi dir="ltr">{details.host}</bdi></strong>
      <span dir="ltr">{details.url}</span>
      {/(?:^|\.)xn--/i.test(details.host) && <small>域名包含国际化编码，请核对目标。</small>}
    </div>
    {item.opened ? <small role="status">已打开系统浏览器。完成外部操作后，在这里继续。</small> :
      <button type="button" disabled={opening} onClick={() => void navigate()}>{opening ? "正在打开…" : "确认并打开浏览器"}</button>}
    {openFailed && <p className="wb-mcp-error" role="alert">无法打开浏览器，请重试。</p>}
  </>;
}

export function McpInputForm({ request, onReply, readUrl, openUrl }: {
  request: RuntimeMcpInputView; onReply: (reply: ReplyPayload) => Promise<void>; readUrl: ReadUrl; openUrl: OpenUrl;
}) {
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const urls = request.urls ?? [];
  const items = [...request.forms, ...urls];
  const selectedAction = (id: string) => actions[id] ?? "accept";
  const approvesWrite = request.operationId && items.every(item => selectedAction(item.id) === "accept");
  const acceptsUrl = urls.some(item => selectedAction(item.id) === "accept");
  const ready = urls.every(item => item.opened || selectedAction(item.id) !== "accept");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !ready || request.status !== "pending") return;
    setSubmitting(true);
    setError("");
    try {
      const data = new FormData(event.currentTarget);
      const responses = Object.fromEntries(items.map((form, index): [string, RuntimeMcpInputReply] => {
        const action = selectedAction(form.id);
        if (action !== "accept") return [form.id, { action }];
        if (!("fields" in form)) return [form.id, { action }];
        const content = Object.fromEntries(form.fields.flatMap((field, fieldIndex): Array<[string, RuntimeMcpFormValue]> => {
          const name = `field-${index}-${fieldIndex}`;
          if (field.kind === "choices") {
            const selected = data.getAll(name).map(value => String(value).slice(6));
            return selected.length || field.required ? [[field.id, selected]] : [];
          }
          const value = data.get(name);
          if (typeof value !== "string" || (!value && !field.required)) return [];
          if (field.kind === "boolean") return [[field.id, value === "true"]];
          if (field.kind === "integer" || field.kind === "number") return [[field.id, Number(value)]];
          return [[field.id, field.kind === "choice" ? value.slice(6) : value]];
        }));
        return [form.id, { action: "accept", content }];
      }));
      await onReply({ requestId: request.id, responses });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "提交失败，请重试。");
    } finally { setSubmitting(false); }
  }

  return <details className="wb-mcp-input" open>
    <summary>来自 <strong>{request.serverId}</strong> 的{request.operationId ? "写入确认" : "输入请求"} <span>{request.toolName}{request.workflow ? ` · Workflow ${request.workflow.nodeId}` : ""}</span></summary>
    {request.status === "answered" ? <p role="status">已提交，等待服务继续。</p> : <form onSubmit={submit}>
      {items.map((form, index) => {
        const action = selectedAction(form.id);
        const isForm = "fields" in form;
        return <fieldset key={form.id} disabled={submitting}>
          <legend>{isForm ? form.message : "在浏览器完成外部操作"}</legend>
          <label className="wb-mcp-action">回复方式 <select value={action} onChange={event => setActions(current => ({ ...current, [form.id]: event.target.value as Action }))}>
            <option value="accept">{isForm ? "提供信息" : "继续外部操作"}</option><option value="decline">拒绝</option><option value="cancel">取消</option>
          </select></label>
          {action === "accept" && (isForm ? form.fields.map((field, fieldIndex) => <Field key={field.id} id={`${request.id}-${index}-${fieldIndex}`} name={`field-${index}-${fieldIndex}`} field={field} />)
            : <UrlField requestId={request.id} item={form} readUrl={readUrl} openUrl={openUrl} />)}
        </fieldset>;
      })}
      {error && <p className="wb-mcp-error" role="alert">{error}</p>}
      <button type="submit" disabled={submitting || !ready}>{submitting ? "正在提交…" : approvesWrite ? "确认并继续写入" : acceptsUrl ? "完成外部操作后继续" : "提交回复"}</button>
    </form>}
  </details>;
}
