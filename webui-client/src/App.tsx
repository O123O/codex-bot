import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { STYLES } from "./styles";

const TOKEN = new URLSearchParams(location.search).get("token") ?? "";
const NICK = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface Session { nickname: string; endpoint: string; provider: string; projectDir: string; lifecycleState: string; nativeStatus: string | null; activeTurnId: string | null; model: string | null; goal: { objective: string; status: string } | null; }
interface Msg { turnId?: string; body: string; completedAt?: number; terminalStatus?: string; role?: "you" | "assistant"; at?: number; }
type FileResult = { kind: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" | "other" }> } | { kind: "file"; path: string; content: string; truncated: boolean; encoding: string } | { error: string };

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  const body = await r.json();
  if (!r.ok) throw body;
  return body as T;
}

const STATUS_CLASS = (s: Session | null) => (!s ? "other" : s.nativeStatus === "idle" ? "idle" : s.nativeStatus ? "busy" : "other");

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // null = assistant
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("qiyan-theme") as "dark" | "light") || "dark");
  const [assistantLog, setAssistantLog] = useState<Msg[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [live, setLive] = useState(false);
  const [text, setText] = useState("");
  const [filePath, setFilePath] = useState("");
  const [file, setFile] = useState<FileResult | null>(null);
  const [tree, setTree] = useState<FileResult | null>(null);
  const [suggest, setSuggest] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("qiyan-theme", theme); }, [theme]);

  const loadSessions = useCallback(async () => { try { setSessions((await api<{ sessions: Session[] }>("/api/sessions")).sessions); } catch { /* transient */ } }, []);
  const loadMessages = useCallback(async (nickname: string) => {
    try { setMessages((await api<{ messages: Msg[] }>(`/api/sessions/${nickname}/messages?count=20`)).messages); }
    catch (e) { setMessages([{ body: `Error: ${(e as { error?: string }).error ?? e}` }]); }
  }, []);
  const loadTree = useCallback(async (nickname: string, path: string) => {
    try { setTree(await api<FileResult>(`/api/files/${nickname}?path=${encodeURIComponent(path)}`)); }
    catch (e) { setTree({ error: (e as { error?: string }).error ?? "unavailable" }); }
  }, []);

  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => { // WebSocket live updates
    let ws: WebSocket, stop = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
      ws.onopen = () => setLive(true);
      ws.onclose = () => { setLive(false); if (!stop) setTimeout(connect, 2000); };
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "sessions") setSessions(m.sessions);
        else if (m.type === "message") setAssistantLog((prev) => [...prev, { role: "assistant", body: m.body, at: m.at }]); };
    };
    connect();
    return () => { stop = true; try { ws.close(); } catch { /* closing */ } };
  }, []);

  // Refresh the selected worker's transcript + file tree when the selection or a turn completes.
  useEffect(() => { if (selected) { void loadMessages(selected); setFilePath(""); void loadTree(selected, ""); } }, [selected, loadMessages, loadTree]);
  useEffect(() => { if (selected) void loadTree(selected, filePath); }, [selected, filePath, loadTree]);
  useEffect(() => { const s = sessions.find((x) => x.nickname === selected); if (s && !s.activeTurnId && selected) void loadMessages(selected); }, [sessions]); // eslint-disable-line
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [messages, assistantLog, selected]);

  const shown: Msg[] = selected === null ? assistantLog : messages;

  const onText = (v: string) => {
    setText(v);
    const at = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(v); // @-autocomplete of worker nicknames
    setSuggest(at ? sessions.map((s) => s.nickname).filter((n) => n.startsWith(at[1].toLowerCase())).slice(0, 6) : []);
  };
  const pickSuggest = (nick: string) => { setText((t) => t.replace(/@[a-z0-9_-]*$/i, `@${nick} `)); setSuggest([]); };

  const send = async () => {
    const t = text.trim(); if (!t) return;
    // A leading @nickname direct-messages that worker; otherwise the selected tab is the target.
    const lead = /^@([a-z0-9][a-z0-9_-]*)\s+([\s\S]+)$/.exec(t);
    const target = lead && NICK.test(lead[1]) ? lead[1] : selected ?? undefined;
    const body = lead && NICK.test(lead[1]) ? lead[2] : t;
    setText(""); setSuggest([]);
    if (target === undefined) setAssistantLog((p) => [...p, { role: "you", body, at: Date.now() }]);
    try { const r = await api<{ ok: boolean; error?: string }>("/api/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body, target }) });
      if (!r.ok) setAssistantLog((p) => [...p, { role: "assistant", body: `[send failed: ${r.error ?? ""}]`, at: Date.now() }]); }
    catch (e) { setAssistantLog((p) => [...p, { role: "assistant", body: `[send error: ${(e as { error?: string }).error ?? e}]`, at: Date.now() }]); }
    if (target) setTimeout(() => selected === target && loadMessages(target), 900);
  };

  const selSession = useMemo(() => sessions.find((s) => s.nickname === selected) ?? null, [sessions, selected]);
  const crumbs = filePath ? filePath.split("/") : [];

  return (
    <div className="app">
      <style>{STYLES}</style>
      <header className="topbar">
        <div className="brand">QiYan</div>
        <nav className="tabs">
          <button className={`tab ${selected === null ? "on" : ""}`} onClick={() => setSelected(null)}><span className="dot other" />assistant</button>
          {sessions.map((s) => (
            <button key={s.nickname} className={`tab ${selected === s.nickname ? "on" : ""}`} onClick={() => setSelected(s.nickname)} title={`${s.provider} · ${s.nativeStatus ?? "?"}${s.goal ? " · goal:" + s.goal.status : ""}`}>
              <span className={`dot ${STATUS_CLASS(s)}`} />{s.nickname}
            </button>
          ))}
        </nav>
        <div className="right">
          <span className={`live ${live ? "on" : ""}`}>{live ? "live" : "offline"}</span>
          <button className="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "☾"}</button>
        </div>
      </header>

      <div className="body">
        <aside className="files">
          <div className="files-head">{selected ? `Files · ${selected}` : "Files"}</div>
          {selected === null ? <div className="hint">Select a worker to browse its project files.</div> : (
            <div className="tree">
              <div className="crumbs">
                <a onClick={() => setFilePath("")}>{selSession?.projectDir?.split("/").pop() || selected}</a>
                {crumbs.map((p, i) => <span key={i}> / <a onClick={() => setFilePath(crumbs.slice(0, i + 1).join("/"))}>{p}</a></span>)}
              </div>
              {tree && "error" in tree && <div className="hint">{tree.error === "unknown session" ? "Not browsable — a remote worker's files live on another host (deferred)." : tree.error}</div>}
              {tree && "kind" in tree && tree.kind === "dir" && (tree.entries.length ? tree.entries.map((e) => (
                <div key={e.name} className={`frow ${e.type}`} onClick={() => e.type === "dir" ? setFilePath((filePath ? filePath + "/" : "") + e.name) : e.type === "file" ? void api<FileResult>(`/api/files/${selected}?path=${encodeURIComponent((filePath ? filePath + "/" : "") + e.name)}`).then(setFile).catch(() => setFile({ error: "unavailable" })) : undefined}>
                  {e.type === "dir" ? "📁" : e.type === "file" ? "📄" : "🔗"} {e.name}
                </div>
              )) : <div className="hint">empty</div>)}
            </div>
          )}
        </aside>

        <main className="chat">
          <div className="log" ref={logRef}>
            {shown.length === 0 && <div className="empty">{selected === null ? "Message the assistant — replies appear here." : `No final messages yet from ${selected}.`}</div>}
            {shown.map((m, i) => (
              <div key={i} className={`msg ${m.role === "you" ? "you" : ""}`}>
                <div className="when">{m.role === "you" ? "you" : m.role === "assistant" ? "assistant" : `${m.completedAt ? new Date(m.completedAt).toLocaleString() : ""} · ${m.terminalStatus ?? ""}`}</div>
                <div className="md"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{m.body}</Markdown></div>
              </div>
            ))}
          </div>
          <div className="composer">
            {suggest.length > 0 && <div className="suggest">{suggest.map((n) => <div key={n} className="srow" onMouseDown={(e) => { e.preventDefault(); pickSuggest(n); }}>@{n}</div>)}</div>}
            <textarea value={text} onChange={(e) => onText(e.target.value)} rows={2}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder={selected === null ? "Message the assistant… (@worker to direct-message a worker)" : `Message ${selected}… (@other to redirect)`} />
            <button onClick={() => void send()}>Send</button>
          </div>
        </main>
      </div>

      {file && (
        <div className="modal" onClick={() => setFile(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><span>{"kind" in file && file.kind === "file" ? file.path : "file"}</span><button className="ghost" onClick={() => setFile(null)}>✕</button></div>
            <div className="sheet-body">
              {"error" in file ? <div className="hint">{file.error}</div>
                : file.encoding === "base64" ? <div className="hint">[binary file{file.truncated ? ", truncated" : ""} — not shown]</div>
                : <pre>{file.content}{file.truncated ? "\n… [truncated]" : ""}</pre>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
