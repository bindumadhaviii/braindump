import { useEffect, useRef, useState } from "react";
import { api, type Pending } from "../api.ts";
import { formatSize } from "../format.ts";
import type { Scan } from "./PhotoAccess.tsx";

type Recording = { recorder: MediaRecorder; recognition: any; startedAt: number; transcript: string };

// Web Speech API (Chrome, Edge, Safari): dictation into the text box, and the transcript of a voice memo.
const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

const DICTATION_ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow it for this site in your browser, and for your browser in System Settings → Privacy & Security → Microphone.",
  "service-not-allowed": "Your browser's speech service isn't available here. Try Chrome or Safari, or type instead.",
  "audio-capture": "No microphone found. Connect one and try again.",
  network: "Voice input needs an internet connection: the browser sends your speech to its speech service to turn it into text.",
  "no-speech": "Didn't hear anything. Tap the mic and try again.",
};

type Props = {
  dropped: File[];
  onDroppedConsumed: () => void;
  /** Opens the photo library dialog; without it the paperclip goes straight to the file picker (demo build). */
  onOpenPhotos?: () => void;
  scan?: Scan;
};

export function Composer({ dropped, onDroppedConsumed, onOpenPhotos, scan }: Props) {
  const [attachOpen, setAttachOpen] = useState(false);
  const attachRef = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rec, setRec] = useState<Recording | null>(null);
  const [listening, setListening] = useState(false);
  const dictation = useRef<any>(null);
  const [, tick] = useState(0);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: File[]) =>
    setPending((p) => [...p, ...files.map((file) => ({ file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined }))]);

  useEffect(() => {
    if (dropped.length) {
      addFiles(dropped);
      onDroppedConsumed();
    }
  }, [dropped, onDroppedConsumed]);

  // Auto-grow the textarea.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  // Close the attach menu on a click elsewhere or Escape.
  useEffect(() => {
    if (!attachOpen) return;
    const onDown = (e: MouseEvent) => !attachRef.current?.contains(e.target as Node) && setAttachOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAttachOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [attachOpen]);

  // Stop listening if the composer goes away mid-dictation.
  useEffect(() => () => dictation.current?.abort(), []);

  // Recording timer.
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [rec]);

  async function send() {
    if (sending || rec || (!text.trim() && pending.length === 0)) return;
    dictation.current?.stop();
    setSending(true);
    setError(null);
    try {
      await api.send(text, pending);
      setText("");
      setPending([]);
    } catch (e) {
      setError("Couldn't send. Try again.");
      console.error(e);
    } finally {
      setSending(false);
      textRef.current?.focus();
    }
  }

  /** Voice input: speech is typed into the text box as you talk, so it can be fixed before sending. */
  function toggleDictation() {
    if (dictation.current) {
      dictation.current.stop();
      return;
    }
    setError(null);
    if (!SpeechRecognition) {
      setError("Voice input needs Chrome, Edge or Safari. You can still type, or record a voice memo.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    const before = text.trimEnd(); // keep whatever was typed; speech goes after it
    recognition.onresult = (e: any) => {
      const said = Array.from(e.results as ArrayLike<any>)
        .map((r) => r[0].transcript)
        .join("")
        .trim();
      setText(before && said ? `${before} ${said}` : before || said);
    };
    recognition.onerror = (e: any) => {
      if (e.error !== "aborted") setError(DICTATION_ERRORS[e.error] ?? "Voice input stopped. Try again, or type instead.");
    };
    recognition.onend = () => {
      dictation.current = null;
      setListening(false);
      textRef.current?.focus();
    };
    try {
      recognition.start();
      dictation.current = recognition;
      setListening(true);
    } catch {
      setError("Couldn't start voice input. Try again, or type instead.");
    }
  }

  async function startRecording() {
    dictation.current?.stop();
    setError(null);
    // Browsers only allow the microphone on https:// or localhost.
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Voice recording only works when the app is opened at http://localhost:5173 (or over https).");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access is blocked. Allow it for this site in your browser, and for your browser in System Settings → Privacy & Security → Microphone."
          : name === "NotFoundError"
            ? "No microphone found. Connect one and try again."
            : name === "NotReadableError"
              ? "The microphone is being used by another app. Close it and try again."
              : "Couldn't start the microphone. You can type instead.",
      );
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const state: Recording = { recorder, recognition: null, startedAt: Date.now(), transcript: "" };

    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.lang = navigator.language || "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (e: any) => {
        state.transcript = Array.from(e.results as ArrayLike<any>)
          .map((r) => r[0].transcript)
          .join("");
        setRec({ ...state });
      };
      recognition.onerror = () => {};
      try {
        recognition.start();
        state.recognition = recognition;
      } catch {
        // Recognition unavailable in this context; audio still records.
      }
    }

    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = recorder.mimeType || "audio/webm";
      const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      const stamp = new Date().toTimeString().slice(0, 5).replace(":", "");
      const file = new File(chunks, `voice-${stamp}.${ext}`, { type });
      setPending((p) => [...p, { file, transcript: state.transcript || undefined }]);
    };
    recorder.start();
    setRec(state);
  }

  function stopRecording() {
    if (!rec) return;
    rec.recognition?.stop();
    rec.recorder.stop();
    setRec(null);
  }

  const elapsed = rec ? Math.floor((Date.now() - rec.startedAt) / 1000) : 0;

  return (
    <div className="composer">
      {pending.length > 0 && (
        <div className="pending">
          {pending.map((p, i) => (
            <div className="pending-chip" key={i}>
              {p.preview ? (
                <img src={p.preview} alt="" />
              ) : (
                <span className="pending-icon">{p.file.type.startsWith("audio/") ? "🎙️" : p.file.type.startsWith("video/") ? "🎬" : "📎"}</span>
              )}
              <span className="pending-name">
                {p.transcript ? `“${p.transcript.slice(0, 24)}${p.transcript.length > 24 ? "…" : ""}”` : p.file.name}
                <small>{formatSize(p.file.size)}</small>
              </span>
              <button className="pending-x" onClick={() => setPending((ps) => ps.filter((_, j) => j !== i))} aria-label="Remove">
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {scan && (
        <button className="scan-status" onClick={onOpenPhotos} title="Open photo library">
          🖼️ {scan.total ? `Reading photos in “${scan.folder}”: ${scan.done} of ${scan.total}` : `Looking in “${scan.folder}”…`}
        </button>
      )}

      {rec ? (
        <div className="recording">
          <span className="rec-dot" />
          <span className="rec-time">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
          <span className="rec-transcript">{rec.transcript || (SpeechRecognition ? "Listening…" : "Recording…")}</span>
          <button className="rec-stop" onClick={stopRecording}>
            Done
          </button>
        </div>
      ) : (
        <div className="composer-row">
          <span className="attach" ref={attachRef}>
            <button
              className="icon-btn"
              title={onOpenPhotos ? "Attach files or open your photo library" : "Add images, videos or files"}
              aria-expanded={onOpenPhotos ? attachOpen : undefined}
              onClick={() => (onOpenPhotos ? setAttachOpen((o) => !o) : fileRef.current?.click())}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l7.9-7.9" />
              </svg>
            </button>
            {attachOpen && onOpenPhotos && (
              <span className="attach-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setAttachOpen(false);
                    fileRef.current?.click();
                  }}
                >
                  <span className="attach-icon">📎</span>
                  <span>
                    <strong>Attach files</strong>
                    <small>Images, videos or files for this message</small>
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setAttachOpen(false);
                    onOpenPhotos();
                  }}
                >
                  <span className="attach-icon">🖼️</span>
                  <span>
                    <strong>Photo library</strong>
                    <small>Give full or limited access so you can ask for photos later</small>
                  </span>
                </button>
              </span>
            )}
          </span>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <textarea
            ref={textRef}
            rows={1}
            value={text}
            placeholder={listening ? "Listening… your words appear here" : "Dump anything here… text, links, images, voice"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // isComposing: don't send while an IME (e.g. pinyin) candidate is being picked.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
          />
          {/* Shared demo pages run in a sandbox that never grants the microphone, so don't offer voice there. */}
          {!api.demo && (
            <>
              <button
                className={`icon-btn ${listening ? "listening" : ""}`}
                title={listening ? "Stop voice input" : "Voice input: speak instead of typing"}
                aria-label={listening ? "Stop voice input" : "Voice input"}
                aria-pressed={listening}
                onClick={toggleDictation}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0014 0M12 18v3" />
                </svg>
              </button>
              <button className="icon-btn" title="Record a voice memo (keeps the audio)" aria-label="Record a voice memo" onClick={startRecording} disabled={listening}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
                </svg>
              </button>
            </>
          )}
          <button className="send-btn" onClick={send} disabled={sending || (!text.trim() && pending.length === 0)} title="Send (Enter)">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M3.4 20.4l17.5-7.5a1 1 0 000-1.8L3.4 3.6a1 1 0 00-1.4 1.2L4.5 12l-2.5 7.2a1 1 0 001.4 1.2z" />
            </svg>
          </button>
        </div>
      )}
      {listening && <div className="composer-hint">Listening… speak and your words are typed in. Tap the mic again to stop.</div>}
      {error && <div className="composer-error">{error}</div>}
    </div>
  );
}
