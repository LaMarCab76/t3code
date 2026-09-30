import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import type {
  DocumentEdits,
  DocumentPage,
  DocumentReadInput,
  DocumentSavedCopy,
} from "@t3tools/contracts";
import { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import styles from "./documentEditor.module.css";

export interface DocumentEditorPort {
  read: (range: Omit<DocumentReadInput, "threadId" | "source">) => Promise<DocumentPage>;
  saveCopy: (
    revision: string,
    edits: DocumentEdits,
  ) => Promise<{ copy: DocumentSavedCopy; url: string }>;
  binaryUrl: () => Promise<string>;
}
const cellKey = (cell: { sheet: string; row: number; column: number }) =>
  `${cell.sheet}:${cell.row}:${cell.column}`;
const columnName = (column: number): string =>
  column > 26
    ? `${columnName(Math.floor((column - 1) / 26))}${String.fromCharCode(65 + ((column - 1) % 26))}`
    : String.fromCharCode(64 + column);

function DocxEditor(props: { html: string; editable: boolean; onChange: (html: string) => void }) {
  const [href, setHref] = useState("");
  const editor = useEditor({
    extensions: [StarterKit, TableKit],
    content: props.html,
    editable: props.editable,
    onUpdate: ({ editor }) => props.onChange(editor.getHTML()),
  });
  useEffect(() => {
    editor?.setEditable(props.editable);
  }, [editor, props.editable]);
  useEffect(() => {
    if (editor && editor.getHTML() !== props.html)
      editor.commands.setContent(props.html, { emitUpdate: false });
  }, [editor, props.html]);
  return (
    <>
      {props.editable && editor ? (
        <div className={styles["document-toolbar"]}>
          <button onClick={() => editor.chain().focus().toggleBold().run()}>Bold</button>
          <button onClick={() => editor.chain().focus().toggleItalic().run()}>Italic</button>
          <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
            Heading
          </button>
          <button onClick={() => editor.chain().focus().setParagraph().run()}>Text</button>
          <button onClick={() => editor.chain().focus().toggleBulletList().run()}>List</button>
          <button onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            Numbered list
          </button>
          <button
            onClick={() =>
              editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            }
          >
            Table
          </button>
          <button onClick={() => editor.chain().focus().addRowAfter().run()}>Add row</button>
          <button onClick={() => editor.chain().focus().addColumnAfter().run()}>Add column</button>
          <input
            aria-label="Link URL"
            value={href}
            onChange={(event) => setHref(event.target.value)}
            placeholder="https://…"
          />
          <button
            disabled={!/^(https?:\/\/|mailto:)/i.test(href)}
            onClick={() => editor.chain().focus().setLink({ href }).run()}
          >
            Link
          </button>
          <button onClick={() => editor.chain().focus().undo().run()}>Undo</button>
          <button onClick={() => editor.chain().focus().redo().run()}>Redo</button>
        </div>
      ) : null}
      <EditorContent editor={editor} className={styles["document-prose"]} />
    </>
  );
}

function PdfEditor(props: {
  port: DocumentEditorPort;
  page: number;
  query: string;
  editable: boolean;
  note: string;
  notes: DocumentEdits["notes"];
  onNote: (x: number, y: number) => void;
  onNavigate: (page: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    let current = true;
    let task: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    void (async () => {
      try {
        const p = await import("pdfjs-dist");
        p.GlobalWorkerOptions.workerSrc = workerUrl;
        const url = await props.port.binaryUrl();
        if (!current) return;
        task = p.getDocument({ url });
        const document = await task.promise;
        if (current) setPdf(document);
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : "PDF preview failed.");
      }
    })();
    return () => {
      current = false;
      void task?.destroy();
    };
  }, [props.port]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let current = true;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void (async () => {
      try {
        const page = await pdf.getPage(props.page);
        if (!current || !canvas.current) return;
        const viewport = page.getViewport({ scale: zoom });
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        render = page.render({ canvas: canvas.current, viewport });
        await render.promise;
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : "PDF page failed.");
      }
    })();
    return () => {
      current = false;
      render?.cancel();
    };
  }, [pdf, props.page, zoom]);
  const findNext = async () => {
    if (!pdf || !props.query.trim()) return;
    setFinding(true);
    setError(null);
    try {
      for (let offset = 1; offset <= pdf.numPages; offset++) {
        const pageNumber = ((props.page - 1 + offset) % pdf.numPages) + 1;
        const page = await pdf.getPage(pageNumber);
        const text = (await page.getTextContent()).items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        if (text.toLocaleLowerCase().includes(props.query.toLocaleLowerCase())) {
          props.onNavigate(pageNumber);
          return;
        }
      }
      setError("No matching text found.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PDF search failed.");
    } finally {
      setFinding(false);
    }
  };
  return (
    <>
      <div className={styles["document-toolbar"]}>
        <label>
          Zoom{" "}
          <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
              <option key={value} value={value}>
                {Math.round(value * 100)}%
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={finding || !pdf || !props.query.trim()}
          onClick={() => {
            void findNext();
          }}
        >
          {finding ? "Searching…" : "Find next"}
        </button>
      </div>
      <div
        className={styles["document-pdf-page"]}
        role="button"
        tabIndex={0}
        aria-label="Place note on PDF page"
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && props.editable && props.note.trim()) {
            event.preventDefault();
            props.onNote(0.1, 0.1);
          }
        }}
        onClick={(event) => {
          if (!props.editable || !props.note.trim()) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          props.onNote(
            (event.clientX - bounds.left) / bounds.width,
            (event.clientY - bounds.top) / bounds.height,
          );
        }}
      >
        <canvas ref={canvas} aria-label={`PDF page ${props.page}`} />
        {props.notes
          ?.filter((note) => note.page === props.page)
          .map((note) => (
            <span
              key={`${note.x}:${note.y}:${note.text}`}
              className={styles["document-note"]}
              style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }}
            >
              {note.text}
            </span>
          ))}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

/** Bounded pages and sparse edits use the same port in web, desktop and the native WebView. */
export default function DocumentEditor(props: { port: DocumentEditorPort }) {
  const [page, setPage] = useState<DocumentPage | null>(null);
  const [start, setStart] = useState(0),
    [sheet, setSheet] = useState<string | undefined>();
  const [column, setColumn] = useState(1);
  const [editable, setEditable] = useState(false);
  const [edits, setEdits] = useState<DocumentEdits>({});
  const [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false),
    [saved, setSaved] = useState<{ copy: DocumentSavedCopy; url: string } | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void props.port.binaryUrl().then(
      (url) => {
        if (current) setDownloadUrl(url);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [props.port]);
  const [query, setQuery] = useState(""),
    [note, setNote] = useState("");
  const [selected, setSelected] = useState<{ row: number; column: number } | null>(null);
  const [rangeEnd, setRangeEnd] = useState<{ row: number; column: number } | null>(null);
  const cellEdits = useMemo(
    () => new Map((edits.cells ?? []).map((cell) => [cellKey(cell), cell])),
    [edits.cells],
  );
  const count = page?.format && page.format !== "pdf" ? 40 : 1;
  useEffect(() => {
    let current = true;
    // oxlint-disable-next-line react/set-state-in-effect -- Invalidate the previous formula results while the external file service recalculates this range.
    setLoading(true);
    const timer = setTimeout(
      () => {
        setLoading(true);
        setError(null);
        void props.port
          .read({
            start,
            count,
            ...(sheet ? { sheet } : {}),
            column,
            columns: 12,
            ...(edits.cells?.length ? { edits: { cells: edits.cells } } : {}),
          })
          .then(
            (result) => {
              if (current) setPage(result);
            },
            (cause) => {
              if (current)
                setError(cause instanceof Error ? cause.message : "Could not read document.");
            },
          )
          .finally(() => {
            if (current) setLoading(false);
          });
      },
      edits.cells?.length ? 250 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [props.port, start, sheet, column, edits.cells, count]);
  const updateCells = (updates: NonNullable<DocumentEdits["cells"]>) =>
    setEdits((previous) => {
      const next = new Map((previous.cells ?? []).map((cell) => [cellKey(cell), cell]));
      updates.forEach((cell) =>
        next.set(cellKey(cell), {
          ...next.get(cellKey(cell)),
          ...cell,
          ...(cell.style ? { style: { ...next.get(cellKey(cell))?.style, ...cell.style } } : {}),
        }),
      );
      return { ...previous, cells: [...next.values()] };
    });
  const dirty =
    (edits.cells?.length ?? 0) +
      (edits.html?.length ?? 0) +
      (edits.notes?.length ?? 0) +
      Object.keys(edits.fields ?? {}).length >
    0;
  const save = async () => {
    if (!page) return;
    setSaving(true);
    setError(null);
    try {
      setSaved(await props.port.saveCopy(page.revision, edits));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save a copy.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={styles["document-editor"]}>
      <div className={styles["document-toolbar"]}>
        <strong>{page?.name ?? "Document"}</strong>
        {downloadUrl ? (
          <a href={downloadUrl} download={page?.name} target="_blank" rel="noopener noreferrer">
            Download
          </a>
        ) : null}
        <button
          disabled={!page || !dirty || saving || loading}
          onClick={() => {
            void save();
          }}
        >
          {saving ? "Saving…" : "Save a copy"}
        </button>
        {saved ? (
          <a href={saved.url} download={saved.copy.name} target="_blank" rel="noopener noreferrer">
            Download {saved.copy.name}
          </a>
        ) : null}
        <span aria-live="polite">{loading ? "Loading…" : dirty ? "Unsaved changes" : ""}</span>
      </div>
      {page ? (
        <>
          <div className={styles["document-limitations"]}>
            {page.limitations.map((message) => (
              <p key={message}>{message}</p>
            ))}
            {!editable ? (
              <button onClick={() => setEditable(true)}>Enable basic editing</button>
            ) : null}
          </div>
          <div className={styles["document-toolbar"]}>
            <button
              disabled={start === 0 || loading}
              onClick={() => setStart(Math.max(0, start - (page.format === "pdf" ? 1 : 40)))}
            >
              Previous
            </button>
            <span>
              {start + 1}–{Math.min(start + page.count, page.total)} of {page.total}
            </span>
            <button
              disabled={start + page.count >= page.total || loading}
              onClick={() => setStart(start + page.count)}
            >
              Next
            </button>
            {page.format !== "pdf" && page.format !== "docx" ? (
              <>
                <select
                  aria-label="Worksheet"
                  value={page.sheet}
                  onChange={(event) => {
                    setSheet(event.target.value);
                    setStart(0);
                  }}
                >
                  {page.sheets.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
                <button disabled={column === 1} onClick={() => setColumn(Math.max(1, column - 12))}>
                  ← Columns
                </button>
                <button disabled={column + 12 > 1000} onClick={() => setColumn(column + 12)}>
                  Columns →
                </button>
              </>
            ) : null}
          </div>
          <div className={styles["document-content"]}>
            {page.format === "docx" ? (
              <DocxEditor
                key={`${start}:${page.revision}`}
                html={edits.html?.find((chunk) => chunk.start === start)?.contents ?? page.html}
                editable={editable}
                onChange={(contents) =>
                  setEdits((previous) => ({
                    ...previous,
                    html: [
                      ...(previous.html ?? []).filter((chunk) => chunk.start !== start),
                      { start, count: page.count, contents },
                    ],
                  }))
                }
              />
            ) : page.format === "pdf" ? (
              <>
                <div className={styles["document-toolbar"]}>
                  <input
                    aria-label="Search PDF"
                    placeholder="Search PDF text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {editable ? (
                    <>
                      <input
                        aria-label="PDF note"
                        placeholder="Note text; click its position on the page"
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                      />
                      <button
                        disabled={!edits.notes?.length}
                        onClick={() =>
                          setEdits((previous) => ({
                            ...previous,
                            notes: previous.notes?.slice(0, -1) ?? [],
                          }))
                        }
                      >
                        Undo note
                      </button>
                    </>
                  ) : null}
                </div>
                <PdfEditor
                  port={props.port}
                  page={start + 1}
                  query={query}
                  editable={editable}
                  note={note}
                  notes={edits.notes}
                  onNavigate={(page) => setStart(page - 1)}
                  onNote={(x, y) =>
                    setEdits((previous) => ({
                      ...previous,
                      notes: [
                        ...(previous.notes ?? []).filter(
                          (entry) =>
                            entry.page !== start + 1 ||
                            entry.x !== x ||
                            entry.y !== y ||
                            entry.text !== note,
                        ),
                        { page: start + 1, x, y, text: note },
                      ],
                    }))
                  }
                />
                {query &&
                page.pages[0]?.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? (
                  <p>Text found on this page: {page.pages[0].text}</p>
                ) : null}
                {page.fields.length ? (
                  <fieldset>
                    <legend>Form fields</legend>
                    {page.fields.map((field) => (
                      <label key={field.name}>
                        {field.name}
                        {field.type === "checkbox" ? (
                          <input
                            type="checkbox"
                            checked={Boolean(edits.fields?.[field.name] ?? field.value)}
                            disabled={!editable || field.readOnly}
                            onChange={(event) =>
                              setEdits((previous) => ({
                                ...previous,
                                fields: { ...previous.fields, [field.name]: event.target.checked },
                              }))
                            }
                          />
                        ) : field.type === "choice" ? (
                          <select
                            disabled={!editable || field.readOnly}
                            value={String(edits.fields?.[field.name] ?? field.value)}
                            onChange={(event) =>
                              setEdits((previous) => ({
                                ...previous,
                                fields: { ...previous.fields, [field.name]: event.target.value },
                              }))
                            }
                          >
                            {field.options.map((option) => (
                              <option key={option}>{option}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={String(edits.fields?.[field.name] ?? field.value)}
                            disabled={!editable || field.readOnly || field.type === "unsupported"}
                            onChange={(event) =>
                              setEdits((previous) => ({
                                ...previous,
                                fields: { ...previous.fields, [field.name]: event.target.value },
                              }))
                            }
                          />
                        )}
                      </label>
                    ))}
                  </fieldset>
                ) : null}
              </>
            ) : (
              <>
                {editable && selected ? (
                  <div className={styles["document-toolbar"]}>
                    Cell {columnName(selected.column)}
                    {selected.row}
                    <button
                      onClick={() => {
                        const cell = page.cells.find(
                          (entry) => entry.row === selected.row && entry.column === selected.column,
                        );
                        if (cell)
                          updateCells([
                            {
                              ...(cellEdits.get(cellKey(cell)) ?? cell),
                              style: { bold: !cell.style?.bold },
                            },
                          ]);
                      }}
                    >
                      Bold
                    </button>
                    <button
                      onClick={() => {
                        const cell = page.cells.find(
                          (entry) => entry.row === selected.row && entry.column === selected.column,
                        );
                        if (cell)
                          updateCells([
                            {
                              ...(cellEdits.get(cellKey(cell)) ?? cell),
                              style: { italic: !cell.style?.italic },
                            },
                          ]);
                      }}
                    >
                      Italic
                    </button>
                    <input
                      aria-label="Cell number format"
                      placeholder="Number format (e.g. 0.00)"
                      onChange={(event) => {
                        const cell = page.cells.find(
                          (entry) => entry.row === selected.row && entry.column === selected.column,
                        );
                        if (cell)
                          updateCells([
                            {
                              ...(cellEdits.get(cellKey(cell)) ?? cell),
                              style: { numberFormat: event.target.value },
                            },
                          ]);
                      }}
                    />
                  </div>
                ) : null}
                <table
                  className={styles["document-grid"]}
                  onCopy={(event) => {
                    if (!selected || !rangeEnd) return;
                    const rows = [];
                    for (
                      let row = Math.min(selected.row, rangeEnd.row);
                      row <= Math.max(selected.row, rangeEnd.row);
                      row++
                    ) {
                      const values = [];
                      for (
                        let col = Math.min(selected.column, rangeEnd.column);
                        col <= Math.max(selected.column, rangeEnd.column);
                        col++
                      ) {
                        const cell = page.cells.find(
                          (entry) => entry.row === row && entry.column === col,
                        );
                        values.push(
                          cell ? (cellEdits.get(cellKey(cell))?.value ?? cell.value) : "",
                        );
                      }
                      rows.push(values.join("\t"));
                    }
                    event.clipboardData.setData("text/plain", rows.join("\n"));
                    event.preventDefault();
                  }}
                >
                  <thead>
                    <tr>
                      <th>Row</th>
                      {Array.from({ length: 12 }, (_, index) => (
                        <th key={column + index}>{columnName(column + index)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 40 }, (_, rowIndex) => (
                      <tr key={start + rowIndex}>
                        <th>{start + rowIndex + 1}</th>
                        {page.cells
                          .filter((cell) => cell.row === start + rowIndex + 1)
                          .map((cell) => (
                            <td
                              key={cellKey(cell)}
                              data-selected={
                                selected &&
                                rangeEnd &&
                                cell.row >= Math.min(selected.row, rangeEnd.row) &&
                                cell.row <= Math.max(selected.row, rangeEnd.row) &&
                                cell.column >= Math.min(selected.column, rangeEnd.column) &&
                                cell.column <= Math.max(selected.column, rangeEnd.column)
                              }
                              onMouseDown={(event) => {
                                if (event.shiftKey && selected) {
                                  event.preventDefault();
                                  setRangeEnd(cell);
                                }
                              }}
                            >
                              <input
                                aria-label={`${page.sheet}!${columnName(cell.column)}${cell.row}`}
                                readOnly={!editable}
                                value={cellEdits.get(cellKey(cell))?.value ?? cell.value}
                                style={{
                                  fontWeight: cell.style?.bold ? "bold" : "normal",
                                  fontStyle: cell.style?.italic ? "italic" : "normal",
                                }}
                                onFocus={() => {
                                  setSelected(cell);
                                  setRangeEnd(cell);
                                }}
                                onChange={(event) =>
                                  updateCells([
                                    {
                                      sheet: cell.sheet,
                                      row: cell.row,
                                      column: cell.column,
                                      value: event.target.value,
                                    },
                                  ])
                                }
                                onPaste={(event) => {
                                  if (!editable) return;
                                  const parsed = parseDelimitedPreview(
                                    event.clipboardData.getData("text/plain"),
                                    "\t",
                                  );
                                  if (parsed.truncated) {
                                    setError("Paste at most 100 rows and 30 columns at a time.");
                                    event.preventDefault();
                                    return;
                                  }
                                  if (parsed.rows.length > 1 || (parsed.rows[0]?.length ?? 0) > 1) {
                                    event.preventDefault();
                                    updateCells(
                                      parsed.rows.flatMap((row, rowIndex) =>
                                        row.map((value, colIndex) => ({
                                          sheet: page.sheet,
                                          row: cell.row + rowIndex,
                                          column: cell.column + colIndex,
                                          value,
                                        })),
                                      ),
                                    );
                                  }
                                }}
                              />
                              {cell.value.startsWith("=") ? (
                                <small role={cell.error ? "alert" : undefined}>
                                  {loading ? "Recalculating…" : cell.display}
                                </small>
                              ) : null}
                            </td>
                          ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className={styles["document-error"]}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
