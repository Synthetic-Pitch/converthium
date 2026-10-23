import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import imageCompression from "browser-image-compression";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import mtCoreURL from "@ffmpeg/core-mt?url";
import mtWasmURL from "@ffmpeg/core-mt/wasm?url";
import mtWorkerURL from "@ffmpeg/core-mt/worker?url";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import "./App.css";

type Kind = "image" | "video" | "document";
type Result = { file: File; preview: string };
type VideoEngine = "idle" | "multicore" | "compatibility";
type VideoResolution = 720 | 1080;
const formatBytes = (size: number) =>
  size < 1048576
    ? `${(size / 1024).toFixed(1)} KB`
    : `${(size / 1048576).toFixed(2)} MB`;
const docPattern = /\.docx$/i;

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const [kind, setKind] = useState<Kind>("image");
  const [source, setSource] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [quality, setQuality] = useState(0.7);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState("");
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [videoEngine, setVideoEngine] = useState<VideoEngine>("idle");
  const [videoResolution, setVideoResolution] =
    useState<VideoResolution>(720);
  const isImage = kind === "image";
  const isVideo = kind === "video";

  useEffect(
    () => () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    },
    [sourceUrl],
  );
  useEffect(
    () => () => {
      if (result?.preview) URL.revokeObjectURL(result.preview);
    },
    [result],
  );
  const clearResult = () => {
    if (result?.preview) URL.revokeObjectURL(result.preview);
    setResult(null);
  };
  const reset = (nextKind: Kind) => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    clearResult();
    setKind(nextKind);
    setSource(null);
    setSourceUrl("");
    setError("");
    setProgress("");
    setPercent(null);
    setVideoEngine("idle");
  };
  const chooseFile = (file?: File) => {
    if (!file) return;
    const detected: Kind | null = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
        ? "video"
        : docPattern.test(file.name)
          ? "document"
          : null;
    if (!detected)
      return setError("Choose an image, video, or supported document file.");
    if (detected !== kind)
      return setError(`Choose a ${kind} file, or switch formats above.`);
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    clearResult();
    setError("");
    setProgress("");
    setPercent(null);
    setSource(file);
    setSourceUrl(URL.createObjectURL(file));
  };
  const loadFfmpeg = async () => {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;
    const useMt =
      window.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
    setProgress(
      useMt
        ? "Loading the fast multi-core video engine..."
        : "Loading the compatible video engine...",
    );
    if (useMt)
      try {
        const ffmpeg = new FFmpeg();
        await ffmpeg.load({
          coreURL: await toBlobURL(mtCoreURL, "text/javascript"),
          wasmURL: await toBlobURL(mtWasmURL, "application/wasm"),
          workerURL: await toBlobURL(mtWorkerURL, "text/javascript"),
        });
        ffmpegRef.current = ffmpeg;
        setVideoEngine("multicore");
        return ffmpeg;
      } catch {
        setProgress("Multi-core mode unavailable. Loading compatible mode...");
      }
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      coreURL: await toBlobURL(coreURL, "text/javascript"),
      wasmURL: await toBlobURL(wasmURL, "application/wasm"),
    });
    ffmpegRef.current = ffmpeg;
    setVideoEngine("compatibility");
    return ffmpeg;
  };
  const compressImage = async () => {
    const compressed = await imageCompression(source!, {
      maxSizeMB: 2,
      maxWidthOrHeight: 2400,
      initialQuality: quality,
      useWebWorker: true,
    });
    return new File(
      [compressed],
      `${source!.name.replace(/\.[^/.]+$/, "")}-compressed.${compressed.type === "image/png" ? "png" : "jpg"}`,
      { type: compressed.type },
    );
  };
  const compressVideo = async () => {
    const ffmpeg = await loadFfmpeg();
    const input = `input.${source!.name.split(".").pop() || "mp4"}`;
    const output = "compressed.mp4";
    const update = ({ progress: value }: { progress: number }) => {
      const next = Math.min(99, Math.round(value * 100));
      setPercent(next);
      setProgress(`Compressing video - ${next}%`);
    };
    ffmpeg.on("progress", update);
    setPercent(0);
    setProgress("Starting video compression...");
    try {
      await ffmpeg.writeFile(input, await fetchFile(source!));
      await ffmpeg.exec([
        "-i",
        input,
        "-vf",
        `scale=-2:min(${videoResolution}\\,ih)`,
        "-r",
        "24",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        String(Math.round(42 - quality * 20)),
        "-threads",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "80k",
        "-movflags",
        "+faststart",
        output,
      ]);
      const data = new Uint8Array(
        (await ffmpeg.readFile(output)) as Uint8Array,
      );
      return new File(
        [data.buffer as ArrayBuffer],
        `${source!.name.replace(/\.[^/.]+$/, "")}-compressed.mp4`,
        { type: "video/mp4" },
      );
    } finally {
      ffmpeg.off("progress", update);
      await ffmpeg.deleteFile(input).catch(() => undefined);
      await ffmpeg.deleteFile(output).catch(() => undefined);
    }
  };
  const convertDocument = async () => {
    setPercent(10);
    setProgress("Loading DOCX converter...");
    const [{ default: mammoth }, { default: html2pdf }] = await Promise.all([
      import("mammoth"),
      import("html2pdf.js"),
    ]);
    setPercent(25);
    setProgress("Reading DOCX content...");
    const { value: html, messages } = await mammoth.convertToHtml({
      arrayBuffer: await source!.arrayBuffer(),
    });
    const conversionErrors = messages.filter((message) => message.type === "error");
    if (conversionErrors.length) {
      throw new Error(conversionErrors.map((message) => message.message).join(" "));
    }

    setPercent(45);
    setProgress("Preparing document layout...");
    const container = document.createElement("article");
    container.className = "pdf-document";
    container.innerHTML = html;
    document.body.appendChild(container);

    try {
      setPercent(70);
      setProgress("Creating PDF...");
      const blob = await html2pdf()
        .set({
          margin: [12, 12, 12, 12],
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(container)
        .outputPdf("blob");
      return new File(
        [blob],
        `${source!.name.replace(/\.docx$/i, "")}.pdf`,
        { type: "application/pdf" },
      );
    } finally {
      container.remove();
    }
  };
  const run = async () => {
    if (!source) return;
    setWorking(true);
    setError("");
    clearResult();
    setPercent(null);
    try {
      const file = isImage
        ? await compressImage()
        : isVideo
          ? await compressVideo()
          : await convertDocument();
      setResult({ file, preview: URL.createObjectURL(file) });
      setPercent(100);
      setProgress("");
    } catch (reason) {
      setError(
        `Could not process this ${kind}.${reason instanceof Error ? ` ${reason.message}` : ""}`,
      );
      setPercent(null);
      setProgress("");
    } finally {
      setWorking(false);
    }
  };
  const download = () => {
    if (!result) return;
    const link = document.createElement("a");
    link.href = result.preview;
    link.download = result.file.name;
    link.click();
  };
  const accept = isImage
    ? "image/*"
    : isVideo
      ? "video/*"
      : ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const documentStyle = {
    minHeight: "239px",
    display: "grid",
    placeContent: "center",
    textAlign: "center" as const,
    background: "#f5f5f1",
    color: "#245a48",
    font: "600 28px 'DM Mono', monospace",
  };
  const original =
    source &&
    (isImage ? (
      <img src={sourceUrl} alt="Original upload" />
    ) : isVideo ? (
      <video src={sourceUrl} controls preload="metadata" />
    ) : (
      <div className="document-preview" style={documentStyle}>
        DOC
        <br />
        <small>{source.name.split(".").pop()?.toUpperCase()}</small>
      </div>
    ));
  const converted =
    result &&
    (isImage ? (
      <img src={result.preview} alt="Compressed result" />
    ) : isVideo ? (
      <video src={result.preview} controls preload="metadata" />
    ) : (
      <div className="document-preview pdf" style={documentStyle}>
        PDF
      </div>
    ));
  const savings =
    source && result
      ? Math.max(0, Math.round((1 - result.file.size / source.size) * 100))
      : 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span>~</span> converthium
        </a>
        <span className="privacy-note">Your files stay on your device</span>
      </header>
      <section className="hero-copy">
        <p className="eyebrow">FAST, PRIVATE FILE CONVERSION</p>
        <h1>
          Make your files
          <br />
          <em>lighter.</em>
        </h1>
        <p className="subtitle">
          Compress media or convert documents to PDF, entirely in your browser.
        </p>
      </section>
      <div className="mode-picker" role="tablist">
        <button
          className={isImage ? "active" : ""}
          onClick={() => reset("image")}
        >
          Image
        </button>
        <button
          className={isVideo ? "active" : ""}
          onClick={() => reset("video")}
        >
          Video
        </button>
        <button
          className={kind === "document" ? "active" : ""}
          onClick={() => reset("document")}
        >
          Document <small>PDF</small>
        </button>
      </div>
      {!source ? (
        <section
          className="dropzone"
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            chooseFile(event.dataTransfer.files[0]);
          }}
          onDragOver={(event) => event.preventDefault()}
        >
          <div className="upload-icon">
            {isImage ? "IMG" : isVideo ? "VID" : "PDF"}
          </div>
          <h2>Drop your {kind} here</h2>
          <p>or choose a file from your computer</p>
          <button
            className="button primary"
            onClick={() => inputRef.current?.click()}
          >
            Choose {kind} <span>-&gt;</span>
          </button>
          <small>
            {isImage
              ? "Supports JPG, PNG, WebP and more"
              : isVideo
                ? "MP4 output - choose up to 720p or 1080p"
                : "Supports DOCX files"}
          </small>
        </section>
      ) : (
        <section className="workspace">
          <div className="image-card original">
            <div className="card-heading">
              <span>Original</span>
              <span>{formatBytes(source.size)}</span>
            </div>
            {original}
            <p>{source.name}</p>
          </div>
          <div className="controls">
            <div className="compression-mark">~</div>
            {kind !== "document" && (
              <>
                <label htmlFor="quality">
                  Compression level{" "}
                  <strong>{Math.round(quality * 100)}%</strong>
                </label>
                <input
                  id="quality"
                  type="range"
                  min="0.2"
                  max="1"
                  step="0.05"
                  value={quality}
                  onChange={(event) => {
                    setQuality(Number(event.target.value));
                    clearResult();
                  }}
                />
                <div className="range-labels">
                  <span>Smaller file</span>
                  <span>Best quality</span>
                </div>
              </>
            )}
            {isVideo && (
              <>
                <div className="resolution-control" aria-label="Output resolution">
                  <span>Output resolution</span>
                  <div className="resolution-options">
                    {([720, 1080] as const).map((resolution) => (
                      <button
                        key={resolution}
                        type="button"
                        className={
                          videoResolution === resolution ? "active" : ""
                        }
                        disabled={working}
                        onClick={() => {
                          setVideoResolution(resolution);
                          clearResult();
                        }}
                      >
                        {resolution}p
                      </button>
                    ))}
                  </div>
                </div>
                <p className="speed-note">
                  Up to {videoResolution}p / 24 fps{" "}
                  {videoEngine === "multicore"
                    ? "- multi-core active"
                    : videoEngine === "compatibility"
                      ? "- compatibility mode"
                      : ""}
                </p>
              </>
            )}
            {kind === "document" && (
              <p className="speed-note">Converts locally to PDF</p>
            )}
            <button className="button primary" disabled={working} onClick={run}>
              {working
                ? "Working..."
                : kind === "document"
                  ? "Convert to PDF"
                  : `Compress ${kind}`}{" "}
              <span>-&gt;</span>
            </button>
            {working && (
              <div className="progress-wrap" aria-live="polite">
                <div className="progress-track">
                  <div
                    className={
                      percent === null
                        ? "progress-fill indeterminate"
                        : "progress-fill"
                    }
                    style={
                      percent === null ? undefined : { width: `${percent}%` }
                    }
                  />
                </div>
                <p className="progress">
                  {progress || "Working on your file..."}
                </p>
              </div>
            )}
            <button
              className="change-file"
              onClick={() => inputRef.current?.click()}
            >
              Choose a different {kind}
            </button>
          </div>
          <div className="image-card result-card">
            {result ? (
              <>
                <div className="card-heading success">
                  <span>
                    {kind === "document" ? "PDF ready" : "Compressed"}
                  </span>
                  <span>{formatBytes(result.file.size)}</span>
                </div>
                {converted}
                <div className="saved">
                  {kind === "document"
                    ? "Ready to download"
                    : `${savings}% smaller`}
                </div>
                <button className="button download" onClick={download}>
                  Download {kind === "document" ? "PDF" : kind}{" "}
                  <span>down</span>
                </button>
              </>
            ) : (
              <div className="result-empty">
                <span>+</span>
                <p>
                  {kind === "document"
                    ? "Your PDF will appear here"
                    : `Your smaller ${kind} will appear here`}
                </p>
              </div>
            )}
          </div>
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept={accept}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          chooseFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <footer>Built for the web. Processed entirely in your browser.</footer>
    </main>
  );
}
export default App;
