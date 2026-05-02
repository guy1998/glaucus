"""
api.py — Flask REST API for the Glaucias document RAG pipeline.

Endpoints:
  POST /documents/upload                           Upload a PDF; returns {job_id, stream_url}
  GET  /documents/stream/<job_id>                  SSE stream of processing progress
  GET  /documents                                  List all indexed documents
  GET  /documents/<doc_id>                         Return markdown + JSON nodes for a document
  POST /documents/<doc_id>/query                   Semantic search over a document
  GET  /documents/<doc_id>/nodes/<node_id>/source        Return page-scoped markdown for a node's source page
  GET  /documents/<doc_id>/nodes/<node_id>/connections  Return outgoing/incoming edges for a node
  POST /documents/<doc_id>/edges                        Add an edge {source, target, type}
  DELETE /documents/<doc_id>/edges                      Remove an edge {source, target}
  DELETE /documents/<doc_id>                            Remove a collection from Qdrant
  GET  /health                                     Health check

Start:
  flask --app api run --debug --port 5000       (dev)
  flask --app api run --port 5000               (single worker — required, SSE needs threads not processes)

SSE event shape (all events share the same data channel):
  {"type": "progress",  "pct": 0-100, "step": "parse|graph|embed|…", "message": "…"}
  {"type": "heartbeat"}
  {"type": "complete",  "doc_id": "…", "collection": "…"}
  {"type": "error",     "message": "…"}
"""

import datetime
import json
import os
import queue
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Callable

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from flask_cors import CORS
from document_structure_extraction import (
    OUTPUT_DIR,
    IMAGES_DIR,
    PAGES_PER_CHUNK,
    assign_ids,
    generate_markdown,
    parse_document,
    save_document,
    save_markdown,
    split_pdf,
)

from embed_nodes import embed_document
from reference_graph_builder import build_reference_edges, save_graph
from retrieval import _qdrant, format_context_for_llm, retrieve_context
import chat_retrieval as _cr

load_dotenv(Path(__file__).parent / ".env")

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", 200))

app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

# ---------------------------------------------------------------------------
# Job registry  {job_id -> {status, queue, doc_id, collection, error, filename}}
# ---------------------------------------------------------------------------
_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {}

# Qdrant's local storage is not safe for concurrent writes; serialize them.
_write_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Data sources storage
# ---------------------------------------------------------------------------

DATA_SOURCES_FILE = Path(__file__).parent / "storage" / "data_sources.json"
_data_sources_lock = threading.Lock()


def _load_data_sources() -> dict:
    if not DATA_SOURCES_FILE.exists():
        return {"sources": [], "assignments": {}}
    with open(DATA_SOURCES_FILE, encoding="utf-8") as f:
        return json.load(f)


def _save_data_sources(data: dict) -> None:
    DATA_SOURCES_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(DATA_SOURCES_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _doc_id(filename: str) -> str:
    return Path(filename).stem


def _load_doc_nodes(doc_id: str) -> list[dict] | None:
    path = OUTPUT_DIR / f"{doc_id}.json"
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _load_doc_markdown(doc_id: str) -> str | None:
    path = OUTPUT_DIR / f"{doc_id}.md"
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _load_doc_graph(doc_id: str) -> dict | None:
    path = OUTPUT_DIR / f"{doc_id}_graph.json"
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _save_doc_graph(doc_id: str, graph: dict) -> None:
    path = OUTPUT_DIR / f"{doc_id}_graph.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(graph, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Pipeline worker (runs in a daemon thread per upload)
# ---------------------------------------------------------------------------

Emitter = Callable[[int, str, str], None]   # (pct, message, step)


def _run_pipeline(
    job_id: str,
    tmp_path: str,
    original_filename: str,
    q: "queue.Queue[dict]",
) -> None:

    def emit(pct: int, message: str, step: str = "") -> None:
        q.put({"type": "progress", "pct": pct, "message": message, "step": step})

    doc_name = _doc_id(original_filename)
    tmp_dir: str | None = None

    try:
        # ── 1. Split ────────────────────────────────────────────────────────
        emit(2, f"Splitting '{doc_name}.pdf' into page chunks…", "split")
        tmp_dir = tempfile.mkdtemp(prefix="docling_chunks_")
        chunks  = split_pdf(tmp_path, PAGES_PER_CHUNK, tmp_dir)
        emit(4, f"Split into {len(chunks)} chunk(s) of up to {PAGES_PER_CHUNK} pages", "split")

        # ── 2. Parse ────────────────────────────────────────────────────────
        all_nodes: list[dict] = []
        node_counter = 0

        for i, (chunk_path, page_offset) in enumerate(chunks):
            pct_start = 4  + int(38 * i       / len(chunks))
            pct_end   = 4  + int(38 * (i + 1) / len(chunks))
            end_page  = page_offset + PAGES_PER_CHUNK
            emit(
                pct_start,
                f"Parsing pages {page_offset + 1}–{end_page}  ({i + 1}/{len(chunks)})…",
                "parse",
            )
            doc = parse_document(chunk_path)
            nodes, node_counter = assign_ids(
                doc,
                doc_name=doc_name,
                node_counter_start=node_counter,
                page_offset=page_offset,
            )
            del doc
            all_nodes.extend(nodes)
            emit(pct_end, f"{len(nodes)} nodes extracted  (running total: {len(all_nodes)})", "parse")

        emit(44, f"Parsed {len(all_nodes)} nodes across {len(chunks)} chunk(s)", "parse")

        # ── 3. Save JSON + Markdown ─────────────────────────────────────────
        emit(46, "Saving structured nodes (JSON) and markdown…", "save")
        save_document(all_nodes, doc_name)
        save_markdown(generate_markdown(all_nodes), doc_name)
        nodes_json = str(OUTPUT_DIR / f"{doc_name}.json")
        emit(50, f"Saved → {nodes_json}", "save")

        # ── 4. Reference graph ──────────────────────────────────────────────
        emit(52, "Building reference graph (cross-refs, figures, tables)…", "graph")

        def _graph_progress(done: int, total: int, msg: str) -> None:
            pct = 52 + int(16 * done / total) if total else 52
            emit(pct, msg, "graph")

        edges = build_reference_edges(all_nodes, progress_fn=_graph_progress)
        save_graph(edges, nodes_json)
        emit(70, f"Reference graph complete — {len(edges)} edge(s) resolved", "graph")

        # ── 5. Embed + Qdrant ───────────────────────────────────────────────
        collection = f"doc_{doc_name}"
        emit(72, f"Embedding nodes → Qdrant collection '{collection}'…", "embed")

        def _embed_progress(done: int, total: int, msg: str) -> None:
            pct = 72 + int(26 * done / total) if total else 72
            emit(pct, msg, "embed")

        with _write_lock:
            embed_document(nodes_json, progress_fn=_embed_progress)

        emit(100, f"Ready — collection '{collection}' available for queries.", "complete")
        q.put({"type": "complete", "doc_id": doc_name, "collection": collection})

        with _jobs_lock:
            _jobs[job_id].update({"status": "done", "doc_id": doc_name, "collection": collection})

    except Exception as exc:
        err = str(exc)
        q.put({"type": "error", "message": err})
        with _jobs_lock:
            _jobs[job_id].update({"status": "error", "error": err})

    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/documents/images/<path:filename>")
def serve_image(filename: str):
    return send_from_directory(str(IMAGES_DIR), filename)


@app.post("/documents/upload")
def upload():
    if "file" not in request.files:
        return jsonify({"error": "missing 'file' field in multipart form-data"}), 400

    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "empty filename"}), 400
    if Path(f.filename).suffix.lower() != ".pdf":
        return jsonify({"error": "only PDF files are accepted"}), 400

    # Save to a temp file; the pipeline moves it to storage/documents/
    tmp = tempfile.NamedTemporaryFile(
        delete=False, suffix=".pdf",
        prefix=f"{_doc_id(f.filename)}_",
    )
    f.save(tmp.name)
    tmp.close()

    job_id: str              = str(uuid.uuid4())
    q: "queue.Queue[dict]"   = queue.Queue()

    with _jobs_lock:
        _jobs[job_id] = {
            "status":     "running",
            "queue":      q,
            "doc_id":     None,
            "collection": None,
            "error":      None,
            "filename":   f.filename,
        }

    threading.Thread(
        target=_run_pipeline,
        args=(job_id, tmp.name, f.filename, q),
        daemon=True,
    ).start()

    return jsonify({
        "job_id":     job_id,
        "stream_url": f"/documents/stream/{job_id}",
    }), 202


@app.get("/documents/stream/<job_id>")
def stream(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        return jsonify({"error": "job not found"}), 404

    q = job["queue"]

    def generate():
        while True:
            try:
                event = q.get(timeout=25)
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("type") in ("complete", "error"):
                    break
            except queue.Empty:
                # Heartbeat keeps the connection alive through proxies / browsers
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",   # tell nginx not to buffer
            "Connection":       "keep-alive",
        },
    )


@app.get("/documents")
def list_documents():
    try:
        cols = _qdrant().get_collections().collections
    except Exception:
        cols = []

    docs = [
        {"doc_id": c.name.removeprefix("doc_"), "collection": c.name}
        for c in cols
        if c.name.startswith("doc_")
    ]
    return jsonify({"documents": docs})


@app.get("/documents/<doc_id>")
def get_document(doc_id: str):
    markdown = _load_doc_markdown(doc_id)
    nodes    = _load_doc_nodes(doc_id)

    if markdown is None or nodes is None:
        return jsonify({"error": f"document '{doc_id}' not found — upload it first"}), 404

    return jsonify({"doc_id": doc_id, "markdown": markdown, "nodes": nodes})


@app.get("/documents/<doc_id>/nodes/<node_id>/source")
def node_source(doc_id: str, node_id: str):
    nodes = _load_doc_nodes(doc_id)
    if nodes is None:
        return jsonify({"error": f"document '{doc_id}' not found"}), 404

    node_map = {n["id"]: n for n in nodes}
    node = node_map.get(node_id)
    if node is None:
        return jsonify({"error": f"node '{node_id}' not found in document '{doc_id}'"}), 404

    page = (node.get("metadata") or {}).get("page")
    if page is None:
        return jsonify({"error": f"node '{node_id}' has no page metadata"}), 422

    page_nodes = [n for n in nodes if (n.get("metadata") or {}).get("page") == page]
    markdown   = generate_markdown(page_nodes)

    return jsonify({
        "node_id":  node_id,
        "doc_id":   doc_id,
        "page":     page,
        "markdown": markdown,
    })


@app.post("/documents/<doc_id>/query")
def query_document(doc_id: str):
    body    = request.get_json(force=True, silent=True) or {}
    q_text  = (body.get("query") or "").strip()
    if not q_text:
        return jsonify({"error": "'query' field is required"}), 400

    collection = f"doc_{doc_id}"
    if not _qdrant().collection_exists(collection):
        return jsonify({"error": f"collection '{collection}' not found — upload the document first"}), 404

    top_k       = int(body.get("top_k", 6))
    max_context = int(body.get("max_context", 20))

    nodes   = retrieve_context(q_text, collection, top_k=top_k, max_context=max_context)
    context = format_context_for_llm(nodes)

    return jsonify({"query": q_text, "nodes": nodes, "context": context})


@app.get("/documents/<doc_id>/nodes/<node_id>/connections")
def node_connections(doc_id: str, node_id: str):
    nodes = _load_doc_nodes(doc_id)
    if nodes is None:
        return jsonify({"error": f"document '{doc_id}' not found"}), 404

    graph = _load_doc_graph(doc_id)
    edges = graph.get("edges", []) if graph else []
    node_map = {n["id"]: n for n in nodes}

    def node_summary(nid: str) -> dict:
        n = node_map.get(nid)
        if not n:
            return {"id": nid, "type": None, "page": None, "preview": ""}
        text = n.get("text") or (n.get("picture") or {}).get("description") or ""
        return {
            "id": nid,
            "type": n.get("type"),
            "page": (n.get("metadata") or {}).get("page"),
            "preview": text.replace("\n", " ")[:90],
        }

    outgoing = [{"edge_type": e["type"], "node": node_summary(e["target"])} for e in edges if e["source"] == node_id]
    incoming = [{"edge_type": e["type"], "node": node_summary(e["source"])} for e in edges if e["target"] == node_id]

    return jsonify({"node_id": node_id, "outgoing": outgoing, "incoming": incoming})


@app.post("/documents/<doc_id>/edges")
def add_edge(doc_id: str):
    body   = request.get_json(force=True, silent=True) or {}
    source = (body.get("source") or "").strip()
    target = (body.get("target") or "").strip()
    etype  = (body.get("type") or "explicit").strip()

    if not source or not target:
        return jsonify({"error": "'source' and 'target' are required"}), 400
    if source == target:
        return jsonify({"error": "source and target must differ"}), 400

    graph = _load_doc_graph(doc_id)
    if graph is None:
        return jsonify({"error": f"graph for '{doc_id}' not found"}), 404

    edges = graph.get("edges", [])
    if any(e["source"] == source and e["target"] == target for e in edges):
        return jsonify({"message": "edge already exists"}), 200

    edges.append({"source": source, "target": target, "type": etype})
    graph["edges"] = edges
    _save_doc_graph(doc_id, graph)
    return jsonify({"added": {"source": source, "target": target, "type": etype}}), 201


@app.delete("/documents/<doc_id>/edges")
def remove_edge(doc_id: str):
    body   = request.get_json(force=True, silent=True) or {}
    source = (body.get("source") or "").strip()
    target = (body.get("target") or "").strip()

    if not source or not target:
        return jsonify({"error": "'source' and 'target' are required"}), 400

    graph = _load_doc_graph(doc_id)
    if graph is None:
        return jsonify({"error": f"graph for '{doc_id}' not found"}), 404

    before = len(graph.get("edges", []))
    graph["edges"] = [e for e in graph.get("edges", []) if not (e["source"] == source and e["target"] == target)]
    if len(graph["edges"]) == before:
        return jsonify({"error": "edge not found"}), 404

    _save_doc_graph(doc_id, graph)
    return jsonify({"removed": {"source": source, "target": target}})


@app.delete("/documents/<doc_id>")
def delete_document(doc_id: str):
    collection = f"doc_{doc_id}"
    client     = _qdrant()
    if not client.collection_exists(collection):
        return jsonify({"error": f"collection '{collection}' not found"}), 404

    with _write_lock:
        client.delete_collection(collection)
        for suffix in (".json", ".md", "_graph.json"):
            p = OUTPUT_DIR / f"{doc_id}{suffix}"
            if p.exists():
                p.unlink()

    return jsonify({"deleted": doc_id})


# ---------------------------------------------------------------------------
# Data source routes
# ---------------------------------------------------------------------------

@app.get("/data-sources")
def list_data_sources():
    with _data_sources_lock:
        return jsonify(_load_data_sources())


@app.post("/data-sources")
def create_data_source():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "'name' is required"}), 400

    source = {
        "id": f"ds_{uuid.uuid4().hex[:12]}",
        "name": name,
        "description": (body.get("description") or "").strip() or None,
        "created_at": datetime.datetime.utcnow().isoformat(),
    }

    with _data_sources_lock:
        data = _load_data_sources()
        data["sources"].append(source)
        _save_data_sources(data)

    return jsonify({"source": source}), 201


@app.patch("/data-sources/<source_id>")
def update_data_source(source_id: str):
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip() or None
    has_description = "description" in body
    description = (body.get("description") or "").strip() or None

    if name is None and not has_description:
        return jsonify({"error": "at least 'name' or 'description' is required"}), 400

    with _data_sources_lock:
        data = _load_data_sources()
        source = next((s for s in data["sources"] if s["id"] == source_id), None)
        if not source:
            return jsonify({"error": f"data source '{source_id}' not found"}), 404
        if name is not None:
            source["name"] = name
        if has_description:
            source["description"] = description
        _save_data_sources(data)

    return jsonify({"source": source})


@app.delete("/data-sources/<source_id>")
def delete_data_source(source_id: str):
    with _data_sources_lock:
        data = _load_data_sources()
        if not any(s["id"] == source_id for s in data["sources"]):
            return jsonify({"error": f"data source '{source_id}' not found"}), 404
        data["sources"] = [s for s in data["sources"] if s["id"] != source_id]
        data["assignments"] = {
            doc_id: sid
            for doc_id, sid in data["assignments"].items()
            if sid != source_id
        }
        _save_data_sources(data)

    return jsonify({"deleted": source_id})


@app.put("/documents/<doc_id>/data-source")
def assign_document_data_source(doc_id: str):
    body = request.get_json(force=True, silent=True) or {}
    source_id = body.get("source_id")  # None to unassign

    with _data_sources_lock:
        data = _load_data_sources()
        if source_id is not None and not any(s["id"] == source_id for s in data["sources"]):
            return jsonify({"error": f"data source '{source_id}' not found"}), 404
        if source_id is None:
            data["assignments"].pop(doc_id, None)
        else:
            data["assignments"][doc_id] = source_id
        _save_data_sources(data)

    return jsonify({"doc_id": doc_id, "source_id": source_id})


# ---------------------------------------------------------------------------
# Chat stream route
# ---------------------------------------------------------------------------

@app.post("/chat/stream")
def chat_stream():
    body      = request.get_json(force=True, silent=True) or {}
    query     = (body.get("query") or "").strip()
    source_id = body.get("data_source_id")   # None / "auto" → auto-route
    history   = body.get("history") or []    # [{role, content}, …]

    if not query:
        return jsonify({"error": "'query' is required"}), 400

    def generate():
        try:
            with _data_sources_lock:
                ds_data = _load_data_sources()
            all_sources  = ds_data["sources"]
            assignments  = ds_data["assignments"]

            # ── 1. Route ────────────────────────────────────────────────────
            chosen_source = None
            if not source_id or source_id == "auto":
                # Only consider sources that have at least one indexed document
                candidates = []
                for s in all_sources:
                    doc_ids = [did for did, sid in assignments.items() if sid == s["id"]]
                    if any(_qdrant().collection_exists(f"doc_{did}") for did in doc_ids):
                        candidates.append(s)
                if candidates:
                    cid = _cr.route_to_data_source(query, candidates)
                    chosen_source = next((s for s in all_sources if s["id"] == cid), None)
            else:
                chosen_source = next((s for s in all_sources if s["id"] == source_id), None)

            if chosen_source:
                yield f"data: {json.dumps({'type': 'routing', 'source': {'id': chosen_source['id'], 'name': chosen_source['name']}})}\n\n"

            # ── 2. Expand query ──────────────────────────────────────────────
            queries, keywords = _cr.expand_query(query)
            yield f"data: {json.dumps({'type': 'queries', 'queries': queries})}\n\n"
            if keywords:
                yield f"data: {json.dumps({'type': 'keywords', 'keywords': keywords})}\n\n"

            # ── 3. Determine collections to search ──────────────────────────
            if chosen_source:
                doc_ids = [did for did, sid in assignments.items() if sid == chosen_source["id"]]
            else:
                # No routable source → search everything indexed
                try:
                    cols = _qdrant().get_collections().collections
                    doc_ids = [c.name.removeprefix("doc_") for c in cols if c.name.startswith("doc_")]
                except Exception:
                    doc_ids = list(assignments.keys())

            collections = [f"doc_{did}" for did in doc_ids]

            if not collections:
                yield f"data: {json.dumps({'type': 'error', 'message': 'No indexed documents found in this data source.'})}\n\n"
                return

            # ── 4. Retrieve ──────────────────────────────────────────────────
            nodes = _cr.retrieve_from_collections(queries, collections)

            node_summary = [
                {
                    "node_id":      n.get("node_id"),
                    "node_type":    n.get("node_type"),
                    "page":         n.get("page"),
                    "text":         (n.get("text") or "")[:300],
                    "parent_header": n.get("parent_header"),
                    "score":        n.get("score"),
                    "source":       n.get("source"),
                    "collection":   n.get("collection", ""),
                }
                for n in nodes
            ]
            yield f"data: {json.dumps({'type': 'sources', 'nodes': node_summary})}\n\n"

            # ── 5. Stream LLM answer ─────────────────────────────────────────
            llm_history = [
                {"role": m["role"], "content": m["content"]}
                for m in history
                if m.get("role") in ("user", "assistant") and m.get("content")
            ]
            for token in _cr.stream_response(query, nodes, llm_history):
                yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"

            yield f"data: {json.dumps({'type': 'complete'})}\n\n"

        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# Dev entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
