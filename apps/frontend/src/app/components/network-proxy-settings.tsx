"use client";
import { useEffect, useState } from "react";

export default function NetworkProxySettings() {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const endpoint = () => `${process.env.NEXT_PUBLIC_RUNTIME_HTTP_URL?.replace(/\/$/, "") ?? `${window.location.protocol}//${window.location.hostname}:3005`}/api/preferences`;
  useEffect(() => {
    let active = true;
    fetch(endpoint()).then(async response => { if (!response.ok) throw new Error("读取代理配置失败"); return response.json(); }).then(value => {
      if (!active) return;
      setEnabled(value.proxy?.enabled ?? false); setUrl(value.proxy?.url ?? ""); setLoaded(true);
    }).catch(error => { if (active) setMessage(String(error)); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint(), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ proxy: { enabled, url: url.trim() } }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "保存失败");
      setMessage("已保存，新模型连接生效；现有请求不会被中断。");
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  };
  return <section className="mt-5 grid gap-3 border-t py-5 text-sm">
    <h3 className="font-semibold">网络代理</h3>
    <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={!loaded || busy} onChange={e => setEnabled(e.target.checked)} />启用模型代理（含 Hook 模型调用）</label>
    <label className="grid gap-1">HTTP / HTTPS 代理地址<input className="h-8 border px-2" placeholder="http://127.0.0.1:33210" value={url} disabled={!loaded || busy} onChange={e => setUrl(e.target.value)} /></label>
    <p className="text-xs text-gray-500">本机级配置，所有项目共用。本地服务直连。网页等外部工具仍使用其自身的代理配置；此处不修改操作系统代理。</p>
    <button type="button" className="w-fit border px-3 py-1" disabled={!loaded || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存代理设置"}</button>
    <p role="status" className="text-xs">{message}</p>
  </section>;
}
