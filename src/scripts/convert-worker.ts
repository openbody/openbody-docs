/// <reference lib="webworker" />
// Off-main-thread parser for /tools/convert/ (OB-97). The convert tool used to map every
// uploaded export SYNCHRONOUSLY on the main thread; for a multi-hundred-MB Apple Health
// export.xml that froze the tab (no paint, spinner stalled, the page looked hung/crashed).
//
// This module runs the exact same, pure mapping step (components/convert-map → mapTextFile:
// OpenBody-JSON detection + source detection + the openbody-ts mapper call) inside a
// dedicated Web Worker, so the heavy XML/CSV/JSON scan happens off the UI thread and the page
// keeps painting an animated progress indicator throughout. Bundled by Vite via the
// `new Worker(new URL("./convert-worker.ts", import.meta.url), { type: "module" })` pattern in
// the page script; if that ever fails, the page falls back to calling mapTextFile directly.
import { mapTextFile, type MapTextRequest, type MapTextResult } from "../components/convert-map";

interface IngestRequest extends MapTextRequest {
  /** Correlates a response with its request (files are parsed one at a time, but be explicit). */
  id: number;
}
interface IngestResponse {
  id: number;
  result: MapTextResult;
}

// `self` is typed as the DOM `Window` by the ambient lib; cast to the worker global so
// `postMessage`/`addEventListener("message")` narrow correctly (webworker lib referenced above).
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener("message", (e: MessageEvent<IngestRequest>) => {
  const { id, fileName, text, subject } = e.data;
  let result: MapTextResult;
  try {
    result = mapTextFile({ fileName, text, subject });
  } catch (err) {
    // mapTextFile is written not to throw, but be defensive so a bug can't wedge the worker.
    result = {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
      isMapperInputError: false,
    };
  }
  ctx.postMessage({ id, result } satisfies IngestResponse);
});
