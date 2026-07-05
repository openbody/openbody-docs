    import {
      mapHevy,
      mapHevyMeasurements,
      mapStrong,
      mapAppleHealth,
      mapOpenBodyToStrong,
      MapperInputError,
      DEFAULT_SUBJECT,
      validate,
      parseLossless,
      type MapOptions,
      type ToStrongResult,
      type MapWarning,
    } from "@openbody/openbody-ts";
    import { mergeLayers, toPlainNumbers, type MergeStats } from "../components/merge";
    import { summarizeSessions, formatSetLine, type SessionSummary } from "../lib/hevy/summarize";
    import {
      detectSource,
      mapStravaActivitiesCsv,
      summarizeEndurance,
      formatHoursMinutes,
      SOURCE_LABEL,
      SOURCE_KIND,
      type SourceId,
      type WeeklyPoint,
    } from "../components/convert-sources";
    import {
      bodyweightTrend,
      measurementTable,
      type BodyweightTrend,
      type MeasurementTable,
    } from "../components/insights";
    import {
      enduranceTrends,
      consistencyTrend,
      bulkCutPhases,
      collectStrengthSets,
      tasteChoice,
      presentSections,
      type DataSectionKind,
    } from "../components/analysis";

    const fileInput = document.getElementById("file-input") as HTMLInputElement;
    const subjectInput = document.getElementById("subject-input") as HTMLInputElement;
    const dropZone = document.getElementById("drop-zone") as HTMLElement;
    const statusEl = document.getElementById("status") as HTMLElement;
    const subjectNoteEl = document.getElementById("subject-note") as HTMLElement;
    const summaryEl = document.getElementById("summary") as HTMLElement;
    const resolutionEl = document.getElementById("resolution") as HTMLElement;
    const previewEl = document.getElementById("preview") as HTMLElement;
    const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
    const downloadStrongBtn = document.getElementById("download-strong-btn") as HTMLButtonElement;
    const strongInfoEl = document.getElementById("strong-info") as HTMLElement;
    const emailCapture = document.getElementById("email-capture") as HTMLElement;
    const emailForm = document.getElementById("email-form") as HTMLFormElement;
    const emailInput = document.getElementById("email-input") as HTMLInputElement;
    const emailStatus = document.getElementById("email-status") as HTMLElement;
    const emailDismiss = document.getElementById("email-dismiss") as HTMLButtonElement;

    const layersEl = document.getElementById("layers") as HTMLElement;

    // Lean-converter view-swap refs: the marketing chrome (intro/supported/how-it-works/
    // explainer) collapses when a result is showing, and the dropzone shrinks to a small
    // "＋ Add another file" control. Both restore on "Start over".
    const marketingEls = Array.from(
      document.querySelectorAll<HTMLElement>(".ob-marketing"),
    );
    const dropTitleEl = document.getElementById("ob-dropzone-title") as HTMLElement | null;
    const DROP_TITLE_DEFAULT = "Choose one or more export files, or drag them here";

    // --- Phase B state: an accumulator of source "layers" ---------------------------------
    // Phase A converted ONE upload at a time. Phase B keeps every upload as a "layer" and the
    // dashboard + downloads always reflect the MERGE of the ENABLED layers (see
    // components/merge.ts). Uploading a single file still works exactly as before — it's just
    // a one-layer accumulator.
    interface Layer {
      /** Stable per-layer key; also the id-namespace prefix used by merge.ts. */
      id: string;
      /** "<source label> · <filename>". */
      label: string;
      source: SourceId | "openbody";
      records: any[];
      enabled: boolean;
      /** Constant/positional-id sources (Apple Health) get their ids prefixed so two files
       *  can't collide; content-stable sources + OpenBody re-imports keep their ids. */
      namespaced: boolean;
      warnings: MapWarning[];
      /** e.g. "3 records failed validation and were skipped" (OpenBody re-import). */
      note?: string;
      /** Records that failed validation on re-import and were dropped (drives the ⚠ note). */
      invalidCount?: number;
      /** Original file text — lets a Subject-ID change re-map the layer with the mapper. */
      text?: string;
      fileName: string;
    }

    let layers: Layer[] = [];
    let layerSeq = 0;
    let lastMerged: any[] | null = null;
    let lastStrong: ToStrongResult | null = null;
    let lastBaseName = "openbody-export";

    // Sticky quick-download bar (OB-92): a slim floating CTA that appears once the export
    // hero scrolls out of view, so the download stays reachable while scrolling the data.
    // Lives on <body> (fixed positioning, viewport-relative regardless of ancestors) and is
    // torn down on every re-render / "Start over" so it never leaks or lingers in the empty
    // state.
    let stickyDl: HTMLElement | null = null;
    let heroObserver: IntersectionObserver | null = null;

    // Apple Health mints constant/positional ids (apple-workout-6, apple-q-3) that collide
    // across different export files; namespacing per layer keeps two files distinct. The
    // content-stable CSV/JSON sources keep their ids so re-import → same id → exact collapse.
    const NAMESPACED_SOURCES = new Set<SourceId>(["apple-health"]);

    function setStatus(message: string, kind: "info" | "success" | "error") {
      statusEl.hidden = false;
      statusEl.textContent = message;
      statusEl.className = `ob-status-msg is-${kind}`;
    }

    /** A merged Session with sets/exercises is "strength"; without, it's "endurance". */
    function hasSets(rec: any): boolean {
      return (rec.exercises?.length ?? 0) > 0 || (rec.blocks?.length ?? 0) > 0;
    }

    const SPARK_METRIC_LABEL = {
      sets: "Sets", km: "Distance (km)", hours: "Hours", workouts: "Workouts",
    } as const;
    type SparkMetric = keyof typeof SPARK_METRIC_LABEL;

    function sparkValueLabel(value: number, metric: SparkMetric): string {
      if (metric === "sets") return `${value} set${value === 1 ? "" : "s"}`;
      if (metric === "workouts") return `${value} workout${value === 1 ? "" : "s"}`;
      if (metric === "km") return `${value.toFixed(1)} km`;
      return formatHoursMinutes(value * 3600);
    }

    // Inline SVG, zero dependencies. One accent color (the site's own token, so it reads
    // in light and dark mode), a hairline baseline, no axes — a sparkline, not a chart
    // widget. Sized in real pixels from the container so bars stay crisp; native <title>
    // tooltips carry the per-week numbers.
    function buildSparkline(
      points: WeeklyPoint[],
      bucket: "week" | "month",
      metric: SparkMetric,
      containerWidth: number,
    ): SVGSVGElement {
      const NS = "http://www.w3.org/2000/svg";
      const H = 56;
      const baseY = H - 1;
      const n = points.length;
      const gap = n > 1 ? (containerWidth / n >= 4 ? 2 : 1) : 0;
      const barW = Math.min(20, Math.max(1, (containerWidth - gap * (n - 1)) / n));
      const width = Math.ceil(n * barW + gap * (n - 1));
      const max = Math.max(...points.map((p) => p.value));

      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "ob-spark");
      svg.setAttribute("viewBox", `0 0 ${width} ${H}`);
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(H));
      svg.setAttribute("role", "img");
      svg.setAttribute(
        "aria-label",
        `${SPARK_METRIC_LABEL[metric]} per ${bucket}, ${points.length} ${bucket}s, ` +
          `peaking at ${sparkValueLabel(max, metric)}.`,
      );

      points.forEach((p, i) => {
        if (p.value <= 0 || max <= 0) return;
        const h = Math.max(2, (p.value / max) * (baseY - 4));
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", (i * (barW + gap)).toFixed(2));
        rect.setAttribute("y", (baseY - h).toFixed(2));
        rect.setAttribute("width", barW.toFixed(2));
        rect.setAttribute("height", h.toFixed(2));
        if (barW >= 3) rect.setAttribute("rx", "1.5");
        const title = document.createElementNS(NS, "title");
        const label = new Date(`${p.bucketStart}T00:00:00Z`).toLocaleDateString(undefined, {
          ...(bucket === "week" ? { day: "numeric" } : {}), month: "short", year: "numeric",
          timeZone: "UTC",
        });
        title.textContent =
          `${bucket === "week" ? "Week of " : ""}${label}: ${sparkValueLabel(p.value, metric)}`;
        rect.append(title);
        svg.append(rect);
      });

      const baseline = document.createElementNS(NS, "line");
      baseline.setAttribute("class", "ob-spark-baseline");
      baseline.setAttribute("x1", "0");
      baseline.setAttribute("x2", String(width));
      baseline.setAttribute("y1", String(baseY + 0.5));
      baseline.setAttribute("y2", String(baseY + 0.5));
      svg.append(baseline);
      return svg;
    }

    // Reusable two-series line chart (sibling to buildSparkline): faint raw daily points +
    // one bold trend line, over a real time axis. Same conventions — inline SVG, zero deps,
    // sized in real pixels from the container, theme via --sl-color-* tokens (CSS classes),
    // role="img" + aria-label, native <title> tooltips. Kept generic (any {t, raw, trend}[])
    // so later phases can chart other metrics; Phase A feeds it the bodyweight EWMA trend.
    function buildLineChart(
      points: { t: number; raw: number; trend: number }[],
      opts: {
        unit: string;
        label: string;
        containerWidth: number;
        /** Faint descriptive phase bands (e.g. bulk/cut) drawn behind the series. */
        phases?: { startMs: number; endMs: number; label: string }[];
        /** Ringed markers on the trend line (e.g. personal-record days). */
        prs?: { t: number; value: number }[];
        /** Faint raw-reading dots (default true); off for series that are already best-per-day. */
        showRawDots?: boolean;
      },
    ): SVGSVGElement {
      const NS = "http://www.w3.org/2000/svg";
      const W = Math.max(280, opts.containerWidth);
      const H = 190;
      const padL = 46, padR = 52, padT = 12, padB = 22;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const unit = opts.unit ? ` ${opts.unit}` : "";
      const showRawDots = opts.showRawDots !== false;

      const ts = points.map((p) => p.t);
      const t0 = Math.min(...ts), t1 = Math.max(...ts);
      const vals = points.flatMap((p) => [p.raw, p.trend]);
      let vMin = Math.min(...vals), vMax = Math.max(...vals);
      const pad = (vMax - vMin || 1) * 0.06;
      vMin -= pad; vMax += pad;

      const xOf = (t: number) => padL + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW);
      const yOf = (v: number) => padT + (1 - (v - vMin) / (vMax - vMin || 1)) * plotH;
      const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

      const first = points[0], last = points[points.length - 1];
      const delta = last.trend - first.trend;
      const dir = Math.abs(delta) < 0.05 ? "flat" : delta < 0 ? "down" : "up";

      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "ob-line");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", String(W));
      svg.setAttribute("height", String(H));
      svg.setAttribute("role", "img");
      svg.setAttribute(
        "aria-label",
        `${opts.label}: ${points.length} days, trend from ${fmt(first.trend)} to ` +
          `${fmt(last.trend)}${unit} (${dir}${dir === "flat" ? "" : ` ${fmt(Math.abs(delta))}${unit}`}). ` +
          `Faint dots are raw daily readings; the bold line is the smoothed trend.`,
      );

      // Faint descriptive phase bands (bulk/cut), drawn first so they sit behind everything.
      for (const ph of opts.phases ?? []) {
        const x1 = xOf(Math.max(t0, ph.startMs));
        const x2 = xOf(Math.min(t1, ph.endMs));
        if (!(x2 > x1)) continue;
        const band = document.createElementNS(NS, "rect");
        band.setAttribute("class", "ob-line-band");
        band.setAttribute("x", x1.toFixed(2));
        band.setAttribute("y", String(padT));
        band.setAttribute("width", (x2 - x1).toFixed(2));
        band.setAttribute("height", String(plotH));
        const bt = document.createElementNS(NS, "title");
        bt.textContent = ph.label;
        band.append(bt);
        svg.append(band);
        const bl = document.createElementNS(NS, "text");
        bl.setAttribute("class", "ob-line-band-label");
        bl.setAttribute("x", (x1 + 4).toFixed(2));
        bl.setAttribute("y", String(padT + 11));
        bl.textContent = ph.label;
        svg.append(bl);
      }

      // y guide lines + labels at min / max of the plotted range.
      for (const v of [vMax - pad, vMin + pad]) {
        const y = yOf(v);
        const gl = document.createElementNS(NS, "line");
        gl.setAttribute("class", "ob-line-guide");
        gl.setAttribute("x1", String(padL));
        gl.setAttribute("x2", String(padL + plotW));
        gl.setAttribute("y1", y.toFixed(2));
        gl.setAttribute("y2", y.toFixed(2));
        svg.append(gl);
        const tx = document.createElementNS(NS, "text");
        tx.setAttribute("class", "ob-line-label");
        tx.setAttribute("x", String(padL - 6));
        tx.setAttribute("y", (y + 3).toFixed(2));
        tx.setAttribute("text-anchor", "end");
        tx.textContent = fmt(v);
        svg.append(tx);
      }

      // Faint raw daily readings (the noise the trend strips).
      if (showRawDots) for (const p of points) {
        const dot = document.createElementNS(NS, "circle");
        dot.setAttribute("class", "ob-line-raw");
        dot.setAttribute("cx", xOf(p.t).toFixed(2));
        dot.setAttribute("cy", yOf(p.raw).toFixed(2));
        dot.setAttribute("r", points.length > 200 ? "1.1" : "1.7");
        const title = document.createElementNS(NS, "title");
        const label = new Date(p.t).toLocaleDateString(undefined, {
          dateStyle: "medium", timeZone: "UTC",
        });
        title.textContent = `${label}: ${fmt(p.raw)}${unit} (trend ${fmt(p.trend)}${unit})`;
        dot.append(title);
        svg.append(dot);
      }

      // Bold trend polyline.
      const path = document.createElementNS(NS, "polyline");
      path.setAttribute("class", "ob-line-trend");
      path.setAttribute("points", points.map((p) => `${xOf(p.t).toFixed(2)},${yOf(p.trend).toFixed(2)}`).join(" "));
      svg.append(path);

      // Personal-record rings on the trend line.
      for (const pr of opts.prs ?? []) {
        const ring = document.createElementNS(NS, "circle");
        ring.setAttribute("class", "ob-line-pr");
        ring.setAttribute("cx", xOf(pr.t).toFixed(2));
        ring.setAttribute("cy", yOf(pr.value).toFixed(2));
        ring.setAttribute("r", "4.2");
        const rt = document.createElementNS(NS, "title");
        rt.textContent = `New best: ${fmt(pr.value)}${unit}`;
        ring.append(rt);
        svg.append(ring);
      }

      // Endpoint markers + value labels (start faint, latest emphasized).
      for (const [p, emphasize] of [[first, false], [last, true]] as const) {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("class", emphasize ? "ob-line-end is-latest" : "ob-line-end");
        c.setAttribute("cx", xOf(p.t).toFixed(2));
        c.setAttribute("cy", yOf(p.trend).toFixed(2));
        c.setAttribute("r", emphasize ? "3.2" : "2.4");
        svg.append(c);
      }
      const endLabel = document.createElementNS(NS, "text");
      endLabel.setAttribute("class", "ob-line-label is-value");
      endLabel.setAttribute("x", String(padL + plotW + 6));
      endLabel.setAttribute("y", (yOf(last.trend) + 3).toFixed(2));
      endLabel.setAttribute("text-anchor", "start");
      endLabel.textContent = `${fmt(last.trend)}${unit}`;
      svg.append(endLabel);

      // x-axis endpoint dates.
      for (const [p, anchor, x] of [
        [first, "start", padL],
        [last, "end", padL + plotW],
      ] as const) {
        const tx = document.createElementNS(NS, "text");
        tx.setAttribute("class", "ob-line-label");
        tx.setAttribute("x", String(x));
        tx.setAttribute("y", String(H - 6));
        tx.setAttribute("text-anchor", anchor);
        tx.textContent = new Date(p.t).toLocaleDateString(undefined, {
          month: "short", year: "numeric", timeZone: "UTC",
        });
        svg.append(tx);
      }
      return svg;
    }

    // --- "Download as Strong CSV" (strength sources) ------------------------------------
    // The app-switch story: Strong-format CSV is also what Hevy accepts as its import
    // format, so this one file is the practical "move your history into Strong or Hevy"
    // path. mapOpenBodyToStrong runs non-strict: it emits everything Strong's CSV can hold
    // and reports every material loss, which we surface honestly below the buttons.

    const OMISSIONS_SHOWN = 200;

    function renderStrongInfo(strong: ToStrongResult, host: HTMLElement) {
      const strongInfoEl = host;
      strongInfoEl.replaceChildren();

      const intro = document.createElement("p");
      intro.className = "ob-strong-note";
      intro.textContent =
        "The Strong CSV is also the format Hevy imports — one file to move your history " +
        "into either app.";
      strongInfoEl.append(intro);

      if (strong.omissions.length === 0) {
        const ok = document.createElement("p");
        ok.className = "ob-strong-note";
        ok.textContent = "Everything in this file fits Strong's format — nothing was left out.";
        strongInfoEl.append(ok);
      } else {
        const details = document.createElement("details");
        details.className = "ob-omissions";
        const summary = document.createElement("summary");
        const n = strong.omissions.length;
        summary.textContent =
          `${n} detail${n === 1 ? "" : "s"} Strong's format can't represent ` +
          `${n === 1 ? "was" : "were"} left out`;
        details.append(summary);

        const list = document.createElement("ul");
        list.className = "ob-omissions-list";
        for (const om of strong.omissions.slice(0, OMISSIONS_SHOWN)) {
          const li = document.createElement("li");
          const code = document.createElement("code");
          code.textContent = om.field ? `${om.recordId} · ${om.field}` : om.recordId;
          li.append(code, ` — ${om.reason}`);
          list.append(li);
        }
        if (n > OMISSIONS_SHOWN) {
          const li = document.createElement("li");
          li.textContent = `…and ${n - OMISSIONS_SHOWN} more.`;
          list.append(li);
        }
        const note = document.createElement("p");
        note.className = "ob-strong-note";
        note.textContent =
          "None of this is lost for good: the OpenBody JSON download is the full-fidelity " +
          "version — this is just what Strong's CSV columns can hold.";
        details.append(list, note);
        strongInfoEl.append(details);
      }
      strongInfoEl.hidden = false;
    }

    function renderPreview(records: unknown[], host: HTMLElement) {
      const previewEl = host;
      const sessions: SessionSummary[] = summarizeSessions(records as any);
      previewEl.replaceChildren();

      if (sessions.length === 0) {
        const p = document.createElement("p");
        p.textContent = "No sessions parsed from that file.";
        previewEl.append(p);
      }

      // Each session is its own collapsible <details>, closed by default: collapsed it's a
      // scannable name · date · count row, so the section is a tidy list the reader expands
      // on demand instead of a wall of every set.
      const cards: HTMLElement[] = [];
      sessions.forEach((session) => {
        const card = document.createElement("details");
        card.className = "ob-session-card";

        const sum = document.createElement("summary");
        sum.className = "ob-session-sum";
        const heading = document.createElement("span");
        heading.className = "ob-session-name";
        heading.textContent = session.name;
        const dateEl = document.createElement("span");
        dateEl.className = "ob-session-date";
        dateEl.textContent = session.dateLabel;
        const setCount = session.exercises.reduce((n, ex) => n + ex.sets.length, 0);
        const meta = document.createElement("span");
        meta.className = "ob-session-meta";
        meta.textContent =
          `${session.exercises.length} exercise${session.exercises.length === 1 ? "" : "s"} · ` +
          `${setCount} set${setCount === 1 ? "" : "s"}`;
        sum.append(heading, dateEl, meta);
        card.append(sum);

        const exList = document.createElement("div");
        exList.className = "ob-exercise-list";
        for (const ex of session.exercises) {
          const exBlock = document.createElement("div");
          exBlock.className = "ob-exercise";

          const exName = document.createElement("p");
          exName.className = "ob-exercise-name";
          exName.textContent = ex.supersetGroup ? `${ex.name} (superset)` : ex.name;
          exBlock.append(exName);

          const setList = document.createElement("ul");
          setList.className = "ob-set-list";
          for (const set of ex.sets) {
            const li = document.createElement("li");
            li.textContent = `Set ${set.index}: ${formatSetLine(set)}`;
            setList.append(li);
          }
          exBlock.append(setList);
          exList.append(exBlock);
        }
        card.append(exList);
        cards.push(card);
      });
      previewEl.append(...cards);
    }

    // Endurance sources (Apple Health, Strava) don't have sets/reps to preview or exercise
    // names to resolve — the rollup lives in the unified summary card above; this renders
    // just the per-session cards. Still 100% client-side.
    const ENDURANCE_PREVIEW_CAP = 200;
    function renderEndurancePreview(records: any[], host: HTMLElement) {
      const previewEl = host;
      const summary = summarizeEndurance(records);

      previewEl.replaceChildren();
      // Same collapsible-per-session treatment as strength, closed by default: each is a
      // name · date row carrying its summary line, expanded on demand.
      const cards: HTMLElement[] = [];
      summary.sessions.slice(0, ENDURANCE_PREVIEW_CAP).forEach((session) => {
        const card = document.createElement("details");
        card.className = "ob-session-card";
        const sum = document.createElement("summary");
        sum.className = "ob-session-sum";
        const heading = document.createElement("span");
        heading.className = "ob-session-name";
        heading.textContent = session.name;
        const dateEl = document.createElement("span");
        dateEl.className = "ob-session-date";
        dateEl.textContent = session.dateLabel;
        sum.append(heading, dateEl);
        card.append(sum);
        const partsEl = document.createElement("p");
        partsEl.className = "ob-session-parts";
        partsEl.textContent = session.parts.join(" · ");
        card.append(partsEl);
        cards.push(card);
      });
      previewEl.append(...cards);
      if (summary.sessions.length > ENDURANCE_PREVIEW_CAP) {
        const more = document.createElement("p");
        more.className = "ob-preview-more";
        more.textContent =
          `Showing the first ${ENDURANCE_PREVIEW_CAP} of ${summary.sessions.length} sessions ` +
          `above — all are in the download and the raw records below.`;
        previewEl.append(more);
      }
    }

    // Just the per-day measurements TABLE (no chart) — the bodyweight chart is the cockpit
    // hero, so the collapsed details only needs the dense grid. Reuses `measurementTable`.
    function renderMeasurementsTable(records: any[], host: HTMLElement) {
      const table: MeasurementTable = measurementTable(records);
      if (table.rows.length === 0) return;
      const scroll = document.createElement("div");
      scroll.className = "ob-tablewrap";
      const el = document.createElement("table");
      el.className = "ob-meas-grid";
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      const dateTh = document.createElement("th");
      dateTh.scope = "col";
      dateTh.textContent = "Date";
      headRow.append(dateTh);
      for (const col of table.columns) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = col.unit ? `${col.label} (${col.unit})` : col.label;
        if (col.namespaced) {
          th.title = "No canonical registry type yet — kept as a namespaced token.";
        }
        headRow.append(th);
      }
      thead.append(headRow);
      const tbody = document.createElement("tbody");
      for (const row of table.rows) {
        const tr = document.createElement("tr");
        const dateTd = document.createElement("th");
        dateTd.scope = "row";
        dateTd.className = "ob-meas-daterow";
        dateTd.textContent = row.dateLabel;
        tr.append(dateTd);
        for (const col of table.columns) {
          const td = document.createElement("td");
          td.className = "ob-meas-value";
          td.textContent = row.cells[col.key] ?? "";
          tr.append(td);
        }
        tbody.append(tr);
      }
      el.append(thead, tbody);
      scroll.append(el);
      host.append(scroll);
    }

    const SUPPORTED_HINT =
      "Supported: Hevy workout CSV, Hevy measurement_data.csv, Strong CSV, " +
      "Apple Health export.xml, Strava activities.csv.";

    function mapForSource(
      source: SourceId,
      text: string,
      opts: MapOptions,
    ): { records: any[]; warnings: MapWarning[] } {
      switch (source) {
        case "hevy": return mapHevy(text, opts);
        // Hevy's body-measurement export → point-in-time Measurement records (no sessions).
        case "hevy-measurements": return mapHevyMeasurements(text, opts);
        case "strong": return mapStrong(text, opts);
        case "apple-health": return mapAppleHealth(text, opts);
        // mapStravaActivitiesCsv is a docs-only adapter (fans out per-row mapStrava calls),
        // not one of the package's mappers — it already returns a plain record array.
        case "strava": return { records: mapStravaActivitiesCsv(text, opts.subject), warnings: [] };
      }
    }

    // --- ingest: turn one uploaded file into a source layer -----------------------------
    // Detects an OpenBody JSON re-import (a JSON array of records) OR an app export, maps it,
    // and pushes a layer. Never throws to the caller — returns a per-file {ok, message}. The
    // Subject-ID field applies to EVERY file so cross-source records share a subject.

    /** Recognize an OpenBody document: a JSON array whose items carry a `recordType`. */
    function looksLikeOpenBody(fileName: string, text: string): any[] | null {
      if (!/\.json$/i.test(fileName) && !text.trimStart().startsWith("[")) return null;
      let parsed: unknown;
      try {
        // parseLossless is robust (RFC-strict, __proto__-safe); toPlainNumbers coerces its
        // LosslessNumber values to plain JS numbers so records validate, dedup and export.
        parsed = toPlainNumbers(parseLossless(text));
      } catch {
        return null;
      }
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const looksRecord = parsed.some(
        (r) => r && typeof r === "object" && typeof (r as any).recordType === "string",
      );
      return looksRecord ? (parsed as any[]) : null;
    }

    async function ingestFile(file: File): Promise<{ ok: boolean; message: string }> {
      // ZIP (Apple Health export.zip, Strava archive) — ask for the inner file instead of
      // shipping an unzip library to the browser.
      const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      if (magic[0] === 0x50 && magic[1] === 0x4b) {
        return {
          ok: false,
          message: `${file.name}: that's a ZIP — unzip it first and add the inner file ` +
            `(export.xml for Apple Health, activities.csv for Strava).`,
        };
      }

      const text = await file.text();
      const subject = subjectInput?.value.trim() || undefined;

      // OpenBody JSON re-import (the round-trip path): validate each record; surface — never
      // silently drop — any that fail.
      const obRecords = looksLikeOpenBody(file.name, text);
      if (obRecords) {
        const valid: any[] = [];
        let invalid = 0;
        const reasons: string[] = [];
        for (const r of obRecords) {
          if (validate(r).valid) valid.push(r);
          else {
            invalid++;
            const e = validate(r).errors;
            if (reasons.length < 1 && e) reasons.push(e);
          }
        }
        if (valid.length === 0) {
          return {
            ok: false,
            message: `${file.name}: looks like OpenBody JSON but no records validated` +
              `${invalid ? ` (${invalid} failed)` : ""}.`,
          };
        }
        // Unify subject across layers when one is given, so cross-source dedup can match.
        if (subject) for (const r of valid) r.subject = subject;
        layers.push({
          id: `layer-${++layerSeq}`,
          label: `OpenBody JSON (re-import) · ${file.name}`,
          source: "openbody",
          records: valid,
          enabled: true,
          namespaced: false, // re-imports carry authoritative ids already
          warnings: [],
          note: invalid
            ? `${invalid} record${invalid === 1 ? "" : "s"} failed validation and ` +
              `${invalid === 1 ? "was" : "were"} skipped (not counted, not exported).` +
              `${reasons[0] ? ` First error: ${reasons[0]}` : ""}`
            : undefined,
          invalidCount: invalid,
          fileName: file.name,
        });
        return {
          ok: true,
          message: `${file.name}: re-imported ${valid.length} OpenBody record` +
            `${valid.length === 1 ? "" : "s"}${invalid ? `, skipped ${invalid} invalid` : ""}.`,
        };
      }

      // App export path.
      const source = detectSource(file.name, text);
      if (!source) {
        return { ok: false, message: `${file.name}: not a recognized export. ${SUPPORTED_HINT}` };
      }
      let mapped: { records: any[]; warnings: MapWarning[] };
      try {
        mapped = mapForSource(source, text, { subject });
      } catch (err) {
        console.error("[convert-tool] parse failed:", err);
        return {
          ok: false,
          message:
            err instanceof MapperInputError
              ? `${file.name}: ${err.message}`
              : `${file.name}: couldn't parse (${err instanceof Error ? err.message : String(err)}).`,
        };
      }
      const { records, warnings } = mapped;
      const kind = SOURCE_KIND[source];
      const sessionCount = records.filter((r: any) => r.recordType === "Session").length;
      if (!records.length || (kind === "strength" && sessionCount === 0)) {
        return {
          ok: false,
          message: `${file.name}: no ${kind === "measurements" ? "measurements" : "workouts"} ` +
            `found — is it an unmodified ${SOURCE_LABEL[source]}?`,
        };
      }
      layers.push({
        id: `layer-${++layerSeq}`,
        label: `${SOURCE_LABEL[source]} · ${file.name}`,
        source,
        records,
        enabled: true,
        namespaced: NAMESPACED_SOURCES.has(source),
        warnings,
        text, // keep the raw text so a Subject-ID change can re-map this layer
        fileName: file.name,
      });
      const realWarnings = warnings.filter((w) => w.code !== "default-subject");
      return {
        ok: true,
        message: `${file.name}: parsed ${records.length} record${records.length === 1 ? "" : "s"} ` +
          `from ${SOURCE_LABEL[source]}` +
          `${realWarnings.length ? ` (${realWarnings.length} warning${realWarnings.length === 1 ? "" : "s"})` : ""}.`,
      };
    }

    async function handleFiles(files: File[]) {
      if (!files.length) return;
      emailCapture.hidden = true;
      setStatus(`Reading ${files.length} file${files.length === 1 ? "" : "s"}…`, "info");
      const results: { ok: boolean; message: string }[] = [];
      for (const file of files) {
        try {
          results.push(await ingestFile(file));
        } catch (err) {
          console.error("[convert-tool] ingest failed:", err);
          results.push({
            ok: false,
            message: `${file.name}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      renderAll();
      const okCount = results.filter((r) => r.ok).length;
      const errCount = results.length - okCount;
      const kind = okCount === 0 ? "error" : errCount ? "info" : "success";
      setStatus(results.map((r) => r.message).join("  "), kind);
      if (okCount > 0) {
        emailCapture.hidden = false;
        // Move focus to the result heading so the view swap is announced and keyboard/screen-
        // reader users land in the new content (not left on the file input above the fold).
        if (layers.length > 0) document.getElementById("ob-result-heading")?.focus();
      }
    }

    // --- render: the whole surface is a MERGE of the enabled layers ---------------------

    // =====================================================================================
    // PHASE C — the "convert cockpit". One profile-driven dashboard over the merged history,
    // laid out top-to-bottom per the approved mockup's information architecture:
    //   coverage hero (generated "aha" sentence + per-source timeline) → merge receipt strip →
    //   source chips → stat tiles → bodyweight EWMA hero (with bulk/cut bands) →
    //   profile-driven insight cards (order + inclusion straight from analysis.insightPlan) →
    //   collapsed details/raw (every Phase A/B surface, preserved) → three-tier import notes →
    //   export bar. The whole surface is a MERGE of the ENABLED layers; toggling a source chip
    //   rebuilds the view. All rendering appends into `previewEl`, which is the single canvas.
    // =====================================================================================

    // Source → validated categorical palette key (the --ob-src-* CSS vars). Both Hevy exports
    // share one identity; an openbody.json re-import gets the neutral "json" colour.
    const SRC_PALETTE: Record<string, string> = {
      hevy: "hevy",
      "hevy-measurements": "hevy",
      strong: "strong",
      "apple-health": "apple",
      strava: "strava",
      openbody: "json",
    };
    const srcKey = (source: string) => SRC_PALETTE[source] ?? "json";
    const srcVar = (source: string) => `var(--ob-src-${srcKey(source)})`;

    const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
    const THIN = " "; // thin space between a number and its unit
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    function el<K extends keyof HTMLElementTagNameMap>(
      tag: K, cls?: string, text?: string,
    ): HTMLElementTagNameMap[K] {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    /** earliest / latest startTime (ms) across a record set (Measurements + Sessions). */
    function timeSpan(records: any[]): { min: number; max: number } | null {
      let min = Infinity, max = -Infinity;
      for (const r of records) {
        const t = Date.parse(String(r.startTime ?? ""));
        if (!Number.isFinite(t)) continue;
        if (t < min) min = t;
        if (t > max) max = t;
      }
      return min === Infinity ? null : { min, max };
    }

    const DAY_MS = 86_400_000;
    function spanLabel(min: number, max: number): string {
      const days = Math.max(0, (max - min) / DAY_MS);
      const years = days / 365.25;
      if (years >= 1.5) return `${Math.round(years)} years`;
      const months = days / 30.44;
      if (months >= 1.5) return `${Math.round(months)} months`;
      const d = Math.max(1, Math.round(days));
      return `${d} day${d === 1 ? "" : "s"}`;
    }
    const monthYear = (ms: number) =>
      new Date(ms).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
    const dayFmt = (day: string) =>
      new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
    const seriesSpanDays = (s: { dateMs: number }[]) =>
      s.length < 2 ? 0 : (s[s.length - 1].dateMs - s[0].dateMs) / DAY_MS;

    const bigKg = (kg: number): { v: string; unit: string } =>
      kg >= 1e6 ? { v: nf1.format(kg / 1e6), unit: "M kg" }
      : kg >= 1e3 ? { v: nf1.format(kg / 1e3), unit: "k kg" }
      : { v: nf0.format(kg), unit: "kg" };

    // --- reusable card furniture (takeaway + chart wrapper) ------------------------------
    function takeaway(icon: string, ...nodes: (Node | string)[]): HTMLElement {
      const p = el("p", "ob-takeaway");
      const ico = el("span", "ob-take-ico", icon);
      ico.setAttribute("aria-hidden", "true");
      const strong = el("b");
      strong.append(...nodes);
      p.append(ico, strong);
      return p;
    }
    function chartWrap(host: HTMLElement): HTMLElement {
      const w = el("div", "ob-chart");
      host.append(w);
      return w;
    }
    function chartWidth(wrap: HTMLElement): number {
      return Math.max(280, Math.min(wrap.clientWidth || 640, 760));
    }

    // --- entry point ---------------------------------------------------------------------
    // The lean converter. Its job is to PROVE an export becomes clean, portable OpenBody data
    // and then hand off — not to be an analytics dashboard. On a successful parse the result
    // view takes over the page (marketing chrome hidden, dropzone collapsed) with the export
    // as the hero, one small "taste" chart, the parsed data grouped by record type, and an
    // ecosystem handoff. All client-side; nothing is uploaded and nothing goes in the URL.
    function renderAll() {
      renderResult();
    }

    // Collapse the marketing chrome + shrink the dropzone once a result is showing.
    function enterResultChrome() {
      for (const m of marketingEls) m.hidden = true;
      dropZone.classList.add("is-compact");
      if (dropTitleEl) dropTitleEl.textContent = "＋ Add another file";
    }
    // Restore the upload/marketing view (used on "Start over" / empty state).
    function exitResultChrome() {
      for (const m of marketingEls) m.hidden = false;
      dropZone.classList.remove("is-compact");
      if (dropTitleEl) dropTitleEl.textContent = DROP_TITLE_DEFAULT;
    }

    // Clear all state and return to the upload/marketing view.
    function startOverReset() {
      layers = [];
      fileInput.value = "";
      statusEl.hidden = true;
      emailCapture.hidden = true;
      renderAll();
      document.getElementById("drop-zone")?.focus();
    }

    function renderResult() {
      // Tear down any prior sticky bar first — rebuilt below only when a result is showing,
      // so it's absent in the upload/empty state and after "Start over".
      teardownSticky();
      // Reset the legacy fixed regions (unused by the lean view) and the single render canvas.
      for (const region of [summaryEl, resolutionEl, strongInfoEl]) {
        region.replaceChildren();
        region.hidden = true;
      }
      subjectNoteEl.hidden = true;
      layersEl.hidden = true;
      layersEl.replaceChildren();
      previewEl.replaceChildren();
      downloadBtn.hidden = true;
      downloadStrongBtn.hidden = true;
      lastMerged = null;
      lastStrong = null;

      if (layers.length === 0) {
        previewEl.hidden = true;
        exitResultChrome();
        return;
      }
      enterResultChrome();
      previewEl.hidden = false;

      const enabled = layers.filter((l) => l.enabled);
      let merged: any[] | null = null;
      let stats: MergeStats | null = null;
      if (enabled.length > 0) {
        const res = mergeLayers(
          enabled.map((l) => ({
            id: l.id, label: l.label, records: l.records, enabled: true, namespaced: l.namespaced,
          })),
        );
        merged = res.merged as any[];
        stats = res.stats;
        lastMerged = merged;
        lastBaseName = enabled.length === 1
          ? enabled[0].fileName.replace(/\.(csv|xml|json)$/i, "") || "openbody-export"
          : "openbody-merged";
      }

      const trend = merged ? bodyweightTrend(merged) : null;

      // 0. RESULT HEADER (focus target) + "Start over".
      buildResultHeader();

      const strengthSessions = merged
        ? merged.filter((r) => r.recordType === "Session" && hasSets(r)) : [];
      const enduranceSessions = merged
        ? merged.filter((r) => r.recordType === "Session" && !hasSets(r)) : [];
      const measurements = merged ? merged.filter((r) => r.recordType === "Measurement") : [];
      if (strengthSessions.length > 0) lastStrong = mapOpenBodyToStrong(strengthSessions as any);

      // Empty state (all sources toggled off): show the chips so a source can be re-enabled,
      // then a short message. No hero/tiles/export without records.
      if (!merged || merged.length === 0) {
        buildChips();
        previewEl.append(el(
          "p", "ob-cockpit-empty",
          enabled.length === 0
            ? "All sources are toggled off — enable at least one above."
            : "No records to show from the enabled sources.",
        ));
        return;
      }

      const sourcesCount = new Set(enabled.map((l) => srcKey(l.source))).size;

      // 1. COVERAGE HERO — headline stat sentence + per-source coverage timeline.
      buildHero(merged, trend, sourcesCount);

      // 2. STAT TILES — at-a-glance counts of what came in.
      buildTiles(strengthSessions, enduranceSessions, measurements, merged, trend);

      // 3. SOURCE TOGGLES + MERGE RECEIPT — toggling never loses data.
      buildChips();
      if (stats) buildMergeStrip(stats);

      // 4. ONE LIGHT "TASTE" — a single profile-chosen chart.
      buildTaste(merged, trend, strengthSessions, enduranceSessions);

      // 5. YOUR DATA — collapsible sections per record type + raw openbody.json.
      buildDataSections(merged, strengthSessions, enduranceSessions, measurements);

      // 6. IMPORT NOTES (three-tier: clean / info / warning) — trust / caveats.
      buildNotes(enabled, strengthSessions, measurements);

      // 7. EXPORT — "take it with you", the payoff near the end (concept arc).
      buildExportHero(merged, strengthSessions.length > 0);
      downloadBtn.hidden = false;
      downloadStrongBtn.hidden = strengthSessions.length === 0;

      // 8. ECOSYSTEM HANDOFF — take the file to any OpenBody-compatible tool to visualize.
      buildEcosystem();
    }

    // --- 0. result header ----------------------------------------------------------------
    function buildResultHeader() {
      const head = el("div", "ob-lean-head");
      const h = el("h2", "ob-lean-h", "Your data, converted");
      h.id = "ob-result-heading";
      h.tabIndex = -1;
      const startOver = el("button", "ob-btn ob-btn-ghost ob-startover", "↺ Start over");
      startOver.type = "button";
      startOver.addEventListener("click", startOverReset);
      head.append(h, startOver);
      previewEl.append(head);
    }

    function formatBytes(bytes: number): string {
      if (bytes >= 1024 * 1024) return `${nf1.format(bytes / (1024 * 1024))} MB`;
      if (bytes >= 1024) return `${nf0.format(bytes / 1024)} KB`;
      return `${nf0.format(bytes)} bytes`;
    }

    // --- 1. coverage hero -----------------------------------------------------------------
    // The opening moment: the headline stat sentence (what you just unified) + a per-source
    // coverage timeline. Revived from the cockpit design; the analytics charts stay retired.
    function buildHero(merged: any[], trend: BodyweightTrend | null, sourcesCount: number) {
      const hero = el("section", "ob-hero");
      hero.setAttribute("aria-label", "Your unified training history");
      hero.append(el("p", "ob-hero-eyebrow", "Your history, unified"));

      const sessions = merged.filter((r) => r.recordType === "Session").length;
      const sets = collectStrengthSets(merged).length;
      const meas = merged.filter((r) => r.recordType === "Measurement").length;
      const span = timeSpan(merged);
      const hl = (t: string) => el("b", "ob-hl", t);

      const h = el("h2", "ob-hero-headline");
      if (span) {
        h.append(hl(spanLabel(span.min, span.max)));
        h.append(document.createTextNode(sessions > 0 ? " of training" : " of body-composition history"));
      } else {
        h.append(document.createTextNode(sessions > 0 ? "Your training" : "Your body history"));
      }
      h.append(document.createTextNode(", from "));
      h.append(hl(`${sourcesCount} app${sourcesCount === 1 ? "" : "s"}`));
      h.append(document.createTextNode(", in one place"));

      const tail: (Node | string)[][] = [];
      if (sessions > 0) tail.push([hl(nf0.format(sessions)), ` workout${sessions === 1 ? "" : "s"}`]);
      if (sets > 0) tail.push([hl(nf0.format(sets)), ` set${sets === 1 ? "" : "s"}`]);
      if (sessions === 0 && meas > 0) {
        tail.push([hl(nf0.format(meas)), ` measurement${meas === 1 ? "" : "s"}`]);
      }
      if (trend) {
        tail.push([
          "bodyweight from ", hl(nf1.format(trend.first.trend)),
          " to ", hl(`${nf1.format(trend.last.trend)}${THIN}${trend.unit}`),
        ]);
      }
      if (tail.length > 0) {
        h.append(document.createTextNode(" — "));
        tail.forEach((part, i) => {
          if (i > 0) h.append(document.createTextNode(i === tail.length - 1 ? ", and " : ", "));
          h.append(...part);
        });
      }
      h.append(document.createTextNode("."));
      hero.append(h);

      const subBits: string[] = [];
      if (span) subBits.push(`${monthYear(span.min)} – ${monthYear(span.max)}`);
      subBits.push(`${sourcesCount} source${sourcesCount === 1 ? "" : "s"} merged`);
      subBits.push("nothing left your browser");
      hero.append(el("p", "ob-hero-sub", subBits.join(" · ")));

      const cov = buildCoverage();
      if (cov) hero.append(cov);
      previewEl.append(hero);
    }

    /** One lane per source (enabled + disabled), coloured by identity, on a shared time axis. */
    function buildCoverage(): HTMLElement | null {
      const laneData = layers
        .map((l) => ({ layer: l, span: timeSpan(l.records) }))
        .filter((x): x is { layer: Layer; span: { min: number; max: number } } => x.span !== null);
      if (laneData.length === 0) return null;
      let T0 = Infinity, T1 = -Infinity;
      for (const { span } of laneData) { T0 = Math.min(T0, span.min); T1 = Math.max(T1, span.max); }
      const range = Math.max(1, T1 - T0);

      const fig = el("figure", "ob-cov");
      fig.setAttribute(
        "aria-label",
        "Date coverage by source: " +
          laneData.map((x) => `${x.layer.label}, ${monthYear(x.span.min)} to ${monthYear(x.span.max)}`)
            .join("; ") + ".",
      );
      const lanes = el("div", "ob-cov-lanes");
      for (const { layer, span } of laneData) {
        const lane = el("div", "ob-cov-lane" + (layer.enabled ? "" : " is-off"));
        const seg = el("span", "ob-cov-seg");
        seg.style.left = `${((span.min - T0) / range) * 100}%`;
        seg.style.width = `${Math.max(1.5, ((span.max - span.min) / range) * 100)}%`;
        seg.style.background = srcVar(layer.source);
        seg.title = `${layer.label}: ${monthYear(span.min)} – ${monthYear(span.max)}`;
        lane.append(seg);
        lanes.append(lane);
      }
      fig.append(lanes);

      const axis = el("figcaption", "ob-cov-axis");
      const startY = new Date(T0).getUTCFullYear();
      const endY = new Date(T1).getUTCFullYear();
      const step = Math.max(1, Math.ceil((endY - startY + 1) / 6));
      for (let y = startY; y <= endY; y += step) {
        const pos = ((Date.UTC(y, 0, 1) - T0) / range) * 100;
        const tick = el("span", "ob-cov-tick", String(y));
        tick.style.left = `${Math.min(98, Math.max(0, pos))}%`;
        axis.append(tick);
      }
      fig.append(axis);
      return fig;
    }

    // --- 2. stat tiles (at a glance) -----------------------------------------------------
    // Proof-of-what-came-in counters. Deliberately NOT analytics — no trends to chase, just
    // the shape of what you imported. Only tiles with data are shown.
    function buildTiles(
      strengthSessions: any[], enduranceSessions: any[], measurements: any[],
      merged: any[], trend: BodyweightTrend | null,
    ) {
      interface Tile { label: string; value: string; unit?: string; chip?: string; }
      const tiles: Tile[] = [];
      const thisYear = new Date().getUTCFullYear();

      const sessionsN = strengthSessions.length + enduranceSessions.length;
      if (sessionsN > 0) {
        const yr = merged.filter(
          (r) => r.recordType === "Session" && new Date(String(r.startTime ?? "")).getUTCFullYear() === thisYear,
        ).length;
        tiles.push({ label: "Workouts", value: nf0.format(sessionsN), chip: yr > 0 ? `${nf0.format(yr)} this year` : undefined });
      }

      let volume = 0;
      for (const s of collectStrengthSets(merged)) {
        if (s.weightKg && s.reps) volume += s.weightKg * s.reps;
      }
      if (volume > 0) {
        const big = bigKg(volume);
        tiles.push({ label: "Total volume lifted", value: big.v, unit: big.unit });
      }

      if (measurements.length > 0) {
        let chip: string | undefined;
        if (trend) {
          const d = trend.last.trend - trend.first.trend;
          if (Math.abs(d) >= 0.05) chip = `${d < 0 ? "▼" : "▲"} ${nf1.format(Math.abs(d))} ${trend.unit}`;
        }
        tiles.push({ label: "Body measurements", value: nf0.format(measurements.length), chip });
      }

      if (enduranceSessions.length > 0) {
        tiles.push({ label: "Endurance sessions", value: nf0.format(enduranceSessions.length) });
      }
      if (tiles.length === 0) return;

      const grid = el("section", "ob-tiles");
      grid.setAttribute("aria-label", "At a glance");
      for (const t of tiles) {
        const tile = el("div", "ob-tile");
        tile.append(el("span", "ob-tile-label", t.label));
        const v = el("span", "ob-tile-value", t.value);
        if (t.unit) v.append(el("span", "ob-tile-unit", t.unit));
        tile.append(v);
        if (t.chip) tile.append(el("span", "ob-tile-chip", t.chip));
        grid.append(tile);
      }
      previewEl.append(grid);
    }

    // --- export hero (the moment) --------------------------------------------------------
    // Relocates the real download buttons (their click handlers live on the nodes, so moving
    // them preserves behaviour) into a prominent block at the very top of the result.
    function buildExportHero(merged: any[], hasStrength: boolean) {
      const section = el("section", "ob-lean-export");
      section.setAttribute("aria-label", "Download your OpenBody data");

      const head = el("div", "ob-lean-export-head");
      head.append(el("h3", "ob-lean-export-h", "Your OpenBody file is ready"));
      head.append(el("p", "ob-lean-export-sub",
        "Clean, portable JSON — the same wire format every OpenBody tool reads."));
      section.append(head);

      const actions = el("div", "ob-lean-export-actions");
      downloadBtn.textContent = "Download openbody.json";
      downloadBtn.className = "ob-btn ob-btn-primary ob-btn-lg";
      actions.append(downloadBtn);
      if (hasStrength) {
        downloadStrongBtn.textContent = "Export as Strong CSV";
        // Same ob-btn-lg sizing as the primary so the two sit at equal height in the row —
        // the colour (filled vs outline) carries the hierarchy, not the size.
        downloadStrongBtn.className = "ob-btn ob-btn-secondary ob-btn-lg";
        actions.append(downloadStrongBtn);
      }
      section.append(actions);

      const bytes = new Blob([JSON.stringify(merged, null, 2)]).size;
      const meta = el("p", "ob-lean-export-meta");
      meta.textContent =
        `${nf0.format(merged.length)} record${merged.length === 1 ? "" : "s"} · ` +
        `${formatBytes(bytes)} · 🔒 built in your browser, nothing uploaded`;
      section.append(meta);

      // Strong-CSV fidelity notes + omissions, tucked into a collapsible.
      if (hasStrength && lastStrong) {
        const det = el("details", "ob-lean-strong");
        det.append(el("summary", undefined, "About the Strong CSV export"));
        const host = el("div", "ob-lean-strong-body");
        renderStrongInfo(lastStrong, host);
        det.append(host);
        section.append(det);
      }

      previewEl.append(section);
      buildStickyDownload(section, merged.length);
    }

    // --- sticky quick-download bar -------------------------------------------------------
    // Reuses the hero download path exactly (clicks the real hero button — no blob/download
    // logic duplicated). Shown only once the hero scrolls out of view, via an
    // IntersectionObserver; hidden state is non-focusable (visibility:hidden) so keyboard
    // users never tab into an invisible control.
    function teardownSticky() {
      heroObserver?.disconnect();
      heroObserver = null;
      stickyDl?.remove();
      stickyDl = null;
    }

    function buildStickyDownload(heroSection: HTMLElement, recordCount: number) {
      const bar = el("div", "ob-sticky-dl");
      bar.setAttribute("role", "region");
      bar.setAttribute("aria-label", "Quick download");

      const label = el("span", "ob-sticky-dl-label");
      label.append(
        el("b", undefined, nf0.format(recordCount)),
        document.createTextNode(` record${recordCount === 1 ? "" : "s"} ready`),
      );

      const btn = el("button", "ob-btn ob-btn-primary ob-sticky-dl-btn", "Download openbody.json");
      btn.type = "button";
      // Delegate to the real hero button so the blob/anchor/download code has one home.
      btn.addEventListener("click", () => downloadBtn.click());

      bar.append(label, btn);
      document.body.append(bar);
      stickyDl = bar;

      // Pin the bar only when the export hero is no longer visible. The negative top margin
      // keeps it from appearing while the hero is still peeking out beneath the site header.
      heroObserver = new IntersectionObserver(
        ([entry]) => bar.classList.toggle("is-pinned", !entry.isIntersecting),
        { rootMargin: "-64px 0px 0px 0px", threshold: 0 },
      );
      heroObserver.observe(heroSection);
    }

    // --- 4. the "taste": ONE small profile-chosen chart ----------------------------------
    function buildTaste(
      merged: any[], trend: BodyweightTrend | null,
      strengthSessions: any[], enduranceSessions: any[],
    ) {
      const section = el("section", "ob-lean-taste ob-card");

      // Exactly ONE profile-chosen trend chart — a taste, not a dashboard. The headline stat
      // sentence now lives in the hero above; merge integrity is covered by the strip + notes.
      const taste = tasteChoice(merged);
      let rendered = false;
      if (taste === "bodyweight" && trend && trend.points.length >= 2) {
        buildBwTaste(section, trend); rendered = true;
      } else if (taste === "distance") {
        rendered = buildDistanceTaste(section, merged);
        if (!rendered && strengthSessions.length + enduranceSessions.length > 0) {
          rendered = buildConsistencyTaste(section, merged);
        }
      } else if (taste === "consistency") {
        rendered = buildConsistencyTaste(section, merged);
      }
      if (!rendered) return; // no naked, empty taste card

      section.append(el("p", "ob-lean-taste-note",
        "A quick look — full analysis is what other OpenBody-compatible tools are for."));
      previewEl.append(section);
    }

    // Bodyweight EWMA taste chart (body-measurement-dominant history).
    function buildBwTaste(host: HTMLElement, trend: BodyweightTrend) {
      const wrap = chartWrap(host);
      const phases = bulkCutPhases(trend.points)
        .map((p) => ({ startMs: p.startMs, endMs: p.endMs, label: p.label }));
      wrap.append(buildLineChart(
        trend.points.map((p) => ({ t: p.t, raw: p.value, trend: p.trend })),
        { unit: trend.unit, label: "Bodyweight trend", containerWidth: chartWidth(wrap), phases },
      ));

      // Bug fix #1: on near-flat data the smoothed monthly rate rounds to ~0, so "about 0 kg
      // a month" reads broken. When the rate rounds below ~0.1 (or the net change is tiny),
      // say the weight held roughly steady over the span; otherwise report one decimal.
      const delta = trend.last.trend - trend.first.trend;
      const spanDays = seriesSpanDays(trend.points.map((p) => ({ dateMs: p.t })));
      const months = spanDays / 30.44;
      const perMonth = months >= 1 ? Math.abs(delta) / months : 0;
      const spanWords = spanLabel(trend.first.t, trend.last.t);
      const steady = perMonth < 0.1 || Math.abs(delta) < 0.5;
      host.append(takeaway(
        steady ? "→" : delta < 0 ? "↘" : "↗",
        steady
          ? `Bodyweight held roughly steady around ${nf1.format(trend.last.trend)}${THIN}${trend.unit} over ${spanWords}.`
          : `Trending ${delta < 0 ? "down" : "up"} — about ${nf1.format(perMonth)}${THIN}${trend.unit} a month over ${spanWords}.`,
      ));
    }

    // Consistency taste chart (workout-dominant history): workouts per week.
    function buildConsistencyTaste(host: HTMLElement, merged: any[]): boolean {
      const ct = consistencyTrend(merged);
      if (ct.weekly.length === 0) return false;
      const wrap = chartWrap(host);
      wrap.append(buildSparkline(
        ct.weekly.map((w) => ({ bucketStart: w.weekStart, value: w.sessions })),
        "week", "workouts", chartWidth(wrap),
      ));
      const spanWords = ct.spanWeeks >= 78
        ? `${Math.round(ct.spanWeeks / 52)} years`
        : ct.spanWeeks >= 8
          ? `${Math.round(ct.spanWeeks / 4.345)} months`
          : `${ct.spanWeeks} week${ct.spanWeeks === 1 ? "" : "s"}`;
      host.append(takeaway(
        ct.direction === "down" ? "↘" : ct.direction === "up" ? "↗" : "→",
        `About ${nf1.format(ct.avgPerWeek)} workout${ct.avgPerWeek === 1 ? "" : "s"} a week over the last ${spanWords}.`,
      ));
      return true;
    }

    // Endurance taste chart (endurance-dominant history): weekly distance.
    function buildDistanceTaste(host: HTMLElement, merged: any[]): boolean {
      const end = enduranceTrends(merged);
      if (end.weekly.length === 0 || end.totalKm <= 0) return false;
      const wrap = chartWrap(host);
      wrap.append(buildSparkline(
        end.weekly.map((w) => ({ bucketStart: w.weekStart, value: w.km })),
        "week", "km", chartWidth(wrap),
      ));
      const distWord = end.distanceTrend === "up" ? "rising"
        : end.distanceTrend === "down" ? "easing off" : "steady";
      host.append(takeaway(
        end.distanceTrend === "down" ? "↘" : "↗",
        `Weekly distance is ${distWord} — ${nf1.format(end.totalKm)}${THIN}km across ` +
          `${nf0.format(end.activeWeeks)} active week${end.activeWeeks === 1 ? "" : "s"}.`,
      ));
      return true;
    }

    // --- 5. your data, grouped by record type (collapsible) ------------------------------
    const DATA_SECTION_LABEL: Record<DataSectionKind, string> = {
      measurements: "Body measurements", strength: "Workouts", endurance: "Endurance sessions",
    };
    function buildDataSections(
      merged: any[], strengthSessions: any[], enduranceSessions: any[], measurements: any[],
    ) {
      previewEl.append(el("h3", "ob-lean-data-h", "Your data, structured"));

      const taste = tasteChoice(merged);
      const defaultOpen: DataSectionKind =
        taste === "bodyweight" ? "measurements"
        : taste === "distance" ? "endurance"
        : "strength";

      const byKind: Record<DataSectionKind, any[]> = {
        measurements, strength: strengthSessions, endurance: enduranceSessions,
      };
      for (const kind of presentSections(merged)) {
        buildDataSection(kind, byKind[kind], kind === defaultOpen);
      }

      // View raw openbody.json — reachable, never the default surface; built on first expand.
      const raw = el("details", "ob-lean-raw ob-raw");
      const n = merged.length;
      raw.append(el("summary", undefined,
        `View raw openbody.json (${nf0.format(n)} record${n === 1 ? "" : "s"})`));
      const pre = el("pre", "ob-raw-json");
      raw.append(pre);
      let built = false;
      raw.addEventListener("toggle", () => {
        if (raw.open && !built) { pre.textContent = JSON.stringify(merged, null, 2); built = true; }
      });
      previewEl.append(raw);
    }

    function buildDataSection(kind: DataSectionKind, records: any[], open: boolean) {
      const det = el("details", "ob-lean-section");
      if (open) det.open = true;
      const sum = el("summary", "ob-lean-section-sum");
      sum.append(el("span", "ob-lean-section-title", DATA_SECTION_LABEL[kind]));
      sum.append(el("span", "ob-lean-section-n",
        `${nf0.format(records.length)} record${records.length === 1 ? "" : "s"}`));
      det.append(sum);
      const body = el("div", "ob-lean-section-body");
      if (kind === "measurements") renderMeasurementsTable(records, body);
      else if (kind === "strength") renderPreview(records, body);
      else renderEndurancePreview(records, body);
      det.append(body);
      previewEl.append(det);
    }

    // --- 6. ecosystem handoff ------------------------------------------------------------
    function buildEcosystem() {
      const section = el("section", "ob-lean-eco ob-card");
      section.setAttribute("aria-label", "Take your data to the ecosystem");
      section.append(el("h3", "ob-lean-eco-h", "Now visualize it →"));
      const p = el("p", "ob-lean-eco-p");
      p.append(document.createTextNode("OpenBody is an open format other tools can read. Take your "));
      p.append(el("code", undefined, "openbody.json"));
      p.append(document.createTextNode(
        " to any OpenBody-compatible tool to chart, analyze, or store it — and re-import it " +
        "here anytime. Your data isn't locked to this page or any one app. ",
      ));
      const a = el("a", "ob-lean-eco-link", "See the ecosystem →");
      (a as HTMLAnchorElement).href = "/ecosystem/";
      p.append(a);
      section.append(p);
      previewEl.append(section);
    }

    // --- 2. merge receipt strip ----------------------------------------------------------
    function buildMergeStrip(stats: MergeStats) {
      const strip = el("div", "ob-merge-strip");
      strip.setAttribute("role", "status");
      const item = (num: string, label: string, accent?: string) => {
        const s = el("span", "ob-ms-item");
        const b = el("b", accent ? "ob-ms-" + accent : undefined, num);
        s.append(b, document.createTextNode(" " + label));
        return s;
      };
      const dot = () => el("span", "ob-ms-dot", "·");
      const parts: HTMLElement[] = [
        item(nf0.format(stats.sources), `source${stats.sources === 1 ? "" : "s"} merged`),
        item(nf0.format(stats.total), `record${stats.total === 1 ? "" : "s"}`),
      ];
      if (stats.exactCollapsed > 0) {
        parts.push(item(
          nf0.format(stats.exactCollapsed),
          `exact duplicate${stats.exactCollapsed === 1 ? "" : "s"} merged`, "accent",
        ));
      }
      if (stats.linked > 0) {
        parts.push(item(nf0.format(stats.linked), `cross-source session${stats.linked === 1 ? "" : "s"} linked`));
      }
      parts.forEach((p, i) => { if (i > 0) strip.append(dot()); strip.append(p); });
      strip.append(dot());
      strip.append(el("span", "ob-ms-kept", "nothing deleted"));

      const how = el("details", "ob-ms-how");
      how.append(el("summary", undefined, "how the merge worked"));
      how.append(el(
        "p", undefined,
        "Records with identical content collapse to one (and are remembered as appearing in " +
        "several apps). Sessions that look like the same workout logged twice — same day, " +
        "overlapping content — are linked, never removed, so both stay present and cross-" +
        "referenced. Re-importing an openbody.json you exported before adds only what's new.",
      ));
      strip.append(how);
      previewEl.append(strip);
    }

    // --- 3. source chips -----------------------------------------------------------------
    function buildChips() {
      const section = el("section", "ob-sources");
      section.setAttribute("aria-label", "Sources — toggle to include or exclude");
      const head = el("div", "ob-sources-head");
      head.append(el("h3", "ob-sources-h", "Sources"));
      head.append(el(
        "p", "ob-sources-hint",
        "Toggle a source to include or exclude it everywhere below. Turning one off never loses data.",
      ));
      section.append(head);

      const row = el("div", "ob-chips-row");
      for (const layer of layers) {
        const chip = el("div", "ob-chip2" + (layer.enabled ? "" : " is-off"));
        const toggle = el("button", "ob-chip2-toggle");
        toggle.type = "button";
        toggle.setAttribute("aria-pressed", String(layer.enabled));
        const dot = el("span", "ob-chip2-dot");
        dot.style.background = srcVar(layer.source);
        dot.setAttribute("aria-hidden", "true");
        toggle.append(dot, document.createTextNode(layer.label));
        toggle.append(el("span", "ob-chip2-n",
          `${layer.records.length} rec${layer.records.length === 1 ? "" : "s"}`));
        toggle.addEventListener("click", () => { layer.enabled = !layer.enabled; renderAll(); });

        const remove = el("button", "ob-chip2-remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${layer.fileName}`);
        remove.addEventListener("click", () => {
          layers = layers.filter((l) => l.id !== layer.id);
          renderAll();
        });

        chip.append(toggle, remove);
        row.append(chip);
      }
      section.append(row);
      previewEl.append(section);
    }

    // --- 8. three-tier import notes ------------------------------------------------------
    // clean ✓ / info ⓘ / warning ⚠. Red is reserved for a true parse failure (which never
    // produces a layer — those surface in the status line), so it isn't a tier here.
    // Info covers defaults + format limitations; warning covers records actually dropped.
    const WARN_CODES = new Set([
      "extra-sessions-dropped", "extra-workouts-dropped", "skipped-entries", "skipped-record",
      "skipped-file", "unparseable-date", "unrecognized-file", "no-mappable-content",
    ]);
    function buildNotes(enabled: Layer[], strengthSessions: any[], measurements: any[]) {
      interface Note { tier: "good" | "info" | "warn"; html: (Node | string)[]; }
      const notes: Note[] = [];

      const inputTotal = enabled.reduce((a, l) => a + l.records.length, 0);
      const invalidTotal = enabled.reduce((a, l) => a + (l.invalidCount ?? 0), 0);
      const grandTotal = inputTotal + invalidTotal;
      notes.push({
        tier: "good",
        html: [
          el("b", undefined,
            invalidTotal > 0
              ? `${nf0.format(inputTotal)} of ${nf0.format(grandTotal)} records imported cleanly.`
              : `${nf0.format(inputTotal)} record${inputTotal === 1 ? "" : "s"} imported cleanly.`),
          " Everything shown is kept and lossless — nothing was dropped silently.",
        ],
      });

      // Warnings from the mappers, grouped by code.
      const byCode = new Map<string, { message: string; count: number }>();
      let sawDefaultSubject = false;
      for (const l of enabled) {
        for (const w of l.warnings) {
          if (w.code === "default-subject") { sawDefaultSubject = true; continue; }
          const cur = byCode.get(w.code) ?? { message: w.message, count: 0 };
          cur.count++;
          byCode.set(w.code, cur);
        }
      }
      for (const [code, { message, count }] of byCode) {
        notes.push({
          tier: WARN_CODES.has(code) ? "warn" : "info",
          html: [el("b", undefined, message), count > 1 ? ` (${nf0.format(count)} occurrences)` : ""],
        });
      }

      // Subject placeholder (info) — from either the warning or the no-subject-given state.
      const noSubject = (subjectInput?.value.trim() || "") === "";
      if (sawDefaultSubject || (noSubject && enabled.some((l) => l.source !== "openbody"))) {
        const frag: (Node | string)[] = [
          el("b", undefined, "No subject ID given"),
          `, so records share an anonymous placeholder (“${DEFAULT_SUBJECT}”). Set one above to label this dataset as you.`,
        ];
        notes.push({ tier: "info", html: frag });
      }

      // Unresolved exercise names (info) — kept as lossless free text.
      if (strengthSessions.length > 0) {
        const names = new Set<string>();
        for (const s of strengthSessions) {
          const exercises = [
            ...(s.exercises ?? []),
            ...((s.blocks ?? []).flatMap((b: any) => b.children ?? [])),
          ];
          for (const ex of exercises) {
            const er = ex?.exerciseRef;
            if (er === undefined) continue;
            const id = typeof er === "string" ? er : er.id;
            const opaque = typeof er === "string" ? undefined : er.opaque;
            if (id === undefined && opaque) names.add(opaque);
          }
        }
        if (names.size > 0) {
          notes.push({
            tier: "info",
            html: [
              el("b", undefined,
                `${nf0.format(names.size)} exercise name${names.size === 1 ? "" : "s"} not in the OpenBody registry yet`),
              ", so they're kept as free text — still valid, just not yet standardised.",
            ],
          });
        }
      }

      // Namespaced measurement types (info) — registry-gap fallbacks.
      if (measurements.length > 0) {
        const ns = measurementTable(measurements).columns.filter((c) => c.namespaced).length;
        if (ns > 0) {
          notes.push({
            tier: "info",
            html: [
              el("b", undefined, `${nf0.format(ns)} measurement type${ns === 1 ? "" : "s"} have no canonical registry type yet`),
              ", so they're kept under a namespaced token — lossless and still schema-valid.",
            ],
          });
        }
      }

      // Records dropped on re-import (warn).
      for (const l of enabled) {
        if ((l.invalidCount ?? 0) > 0) {
          notes.push({
            tier: "warn",
            html: [
              el("b", undefined,
                `${nf0.format(l.invalidCount!)} record${l.invalidCount === 1 ? "" : "s"} from ${l.fileName} failed validation`),
              " and were skipped — not counted, not exported.",
            ],
          });
        }
      }

      const section = el("section", "ob-card ob-notes");
      section.setAttribute("aria-labelledby", "ob-notes-h");
      const h = el("h3", "ob-notes-h", "Import notes");
      h.id = "ob-notes-h";
      section.append(h);
      const ICON = { good: "✓", info: "ⓘ", warn: "⚠" } as const;
      for (const n of notes) {
        const note = el("div", `ob-note ob-note-${n.tier}`);
        const ico = el("span", "ob-note-ico", ICON[n.tier]);
        ico.setAttribute("aria-hidden", "true");
        const body = el("div", "ob-note-body");
        body.append(...n.html);
        note.append(ico, body);
        section.append(note);
      }
      previewEl.append(section);
    }


    fileInput?.addEventListener("change", () => {
      const files = fileInput.files ? Array.from(fileInput.files) : [];
      if (files.length) void handleFiles(files);
      fileInput.value = ""; // allow re-selecting the same file name
    });

    subjectInput?.addEventListener("change", () => {
      if (layers.length === 0) return;
      const subject = subjectInput.value.trim() || undefined;
      // Subject applies to ALL layers: re-map app layers from their stored text (the mapper's
      // own, canonical way to stamp a subject) and re-stamp OpenBody re-imports directly.
      for (const layer of layers) {
        if (layer.source === "openbody") {
          if (subject) for (const r of layer.records) r.subject = subject;
          continue;
        }
        if (!layer.text) continue;
        try {
          layer.records = mapForSource(layer.source as SourceId, layer.text, { subject }).records;
        } catch (err) {
          console.error("[convert-tool] re-map on subject change failed:", err);
        }
      }
      renderAll();
    });

    dropZone?.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("is-dragover");
    });
    for (const evt of ["dragleave", "drop"]) {
      dropZone?.addEventListener(evt, () => dropZone.classList.remove("is-dragover"));
    }
    dropZone?.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length) void handleFiles(files);
    });

    downloadBtn?.addEventListener("click", () => {
      if (!lastMerged) return;
      const blob = new Blob([JSON.stringify(lastMerged, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${lastBaseName}.openbody.json`;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });

    downloadStrongBtn?.addEventListener("click", () => {
      if (!lastStrong) return;
      const blob = new Blob([lastStrong.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${lastBaseName}.strong.csv`;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });

    emailDismiss?.addEventListener("click", () => {
      emailCapture.hidden = true;
    });

    emailForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (!email) return;
      const submitBtn = emailForm.querySelector("button[type=submit]") as HTMLButtonElement;
      submitBtn.disabled = true;
      emailStatus.textContent = "Sending…";
      emailStatus.className = "ob-email-status";
      try {
        // TODO(backend): /api/subscribe is a PLACEHOLDER. There is no server behind this yet —
        // this site builds as static output for Cloudflare Pages, with no Worker / Pages
        // Function / KV / D1 wired up. Implementing it is a founder-level decision (which
        // mechanism, retention, unsubscribe, etc.), not something to fake here. Until it
        // exists this request will fail (404), and we surface that honestly below instead of
        // showing a fake success state.
        const res = await fetch("/api/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, source: "convert-tool" }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        emailStatus.textContent = "Thanks — we'll let you know.";
        emailStatus.className = "ob-email-status is-success";
        emailForm.hidden = true;
      } catch (err) {
        console.warn("[convert-tool] /api/subscribe isn't wired up yet:", err);
        emailStatus.textContent =
          "Thanks for the interest — signups aren't actually wired up in this early version, " +
          "so this didn't go anywhere yet. Check back soon.";
        emailStatus.className = "ob-email-status is-pending";
      } finally {
        submitBtn.disabled = false;
      }
    });
