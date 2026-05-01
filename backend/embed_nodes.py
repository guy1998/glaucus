"""
embed_nodes.py — Embed document nodes and upsert into a Qdrant local collection.

Usage:
    python embed_nodes.py storage/documents/MyDoc.json

The graph file is expected alongside the nodes JSON as <stem>_graph.json.
Re-running this script overwrites the collection for that document, so it's
safe to re-index after re-extraction.

Env vars (all in .env):
    EMBEDDING_MODEL     model name for the embedding API (required)
    EMBEDDING_BASE_URL  base URL for embedding API (falls back to VLM_BASE_URL)
    EMBEDDING_API_KEY   API key for embedding API    (falls back to VLM_API_KEY)
    QDRANT_PATH         local storage path (default: ./qdrant_storage)
"""

import json
import os
import sys
import uuid
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from qdrant_client.models import Distance, VectorParams, PointStruct
from tqdm import tqdm

from qdrant_shared import get_qdrant

load_dotenv(Path(__file__).parent / ".env")

EMBEDDING_BASE  = (os.environ.get("EMBEDDING_BASE_URL") or os.environ.get("VLM_BASE_URL", "")).rstrip("/")
EMBEDDING_KEY   = os.environ.get("EMBEDDING_API_KEY")  or os.environ.get("VLM_API_KEY", "")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "")
QDRANT_PATH     = os.environ.get("QDRANT_PATH", "./qdrant_storage")

BATCH_SIZE  = 64
MIN_TEXT    = 10   # skip nodes whose embeddable text is shorter than this


# ---------------------------------------------------------------------------
# OpenAI-compatible embedding client
# ---------------------------------------------------------------------------

def _client() -> OpenAI:
    if not EMBEDDING_BASE or not EMBEDDING_KEY or not EMBEDDING_MODEL:
        raise RuntimeError(
            "Missing embedding config. Set EMBEDDING_MODEL (and optionally "
            "EMBEDDING_BASE_URL / EMBEDDING_API_KEY) in .env"
        )
    return OpenAI(base_url=EMBEDDING_BASE, api_key=EMBEDDING_KEY)


def _embed(client: OpenAI, texts: list[str]) -> list[list[float]]:
    response = client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    return [item.embedding for item in sorted(response.data, key=lambda x: x.index)]


def _detect_dim(client: OpenAI) -> int:
    return len(_embed(client, ["probe"])[0])


def _stable_uuid(node_id: str) -> str:
    """Deterministic UUID from a string node ID — survives re-indexing."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, node_id))


# ---------------------------------------------------------------------------
# Contextual text construction
# ---------------------------------------------------------------------------

def build_parent_header_map(nodes: list[dict]) -> dict[str, str | None]:
    """
    Walk nodes in document order and map each node_id to the breadcrumb of
    section headers above it.  Headers themselves get None (they ARE context).

    e.g. a paragraph under '3 Safety > 3.1 Warnings' gets:
         "3 Safety > 3.1 Warnings"
    """
    stack: list[tuple[int, str]] = []   # (level, text)
    result: dict[str, str | None] = {}

    for node in nodes:
        ntype = node.get("type", "")
        if ntype in ("section_header", "title"):
            level = node.get("metadata", {}).get("heading_level", 1)
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, (node.get("text") or "").strip()))
            result[node["id"]] = None
        else:
            result[node["id"]] = " > ".join(t for _, t in stack) if stack else None

    return result


def _node_text(node: dict) -> str:
    text = (node.get("text") or "").strip()
    if not text:
        pic  = node.get("picture") or {}
        text = (pic.get("description") or "").strip()
    return text


def build_embedding_text(node: dict, parent_header: str | None) -> str:
    """Prepend section breadcrumb so embeddings carry structural context."""
    parts: list[str] = []
    if parent_header:
        parts.append(f"[Section: {parent_header}]")
    text = _node_text(node)
    if text:
        parts.append(text)
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Edge index helpers
# ---------------------------------------------------------------------------

def build_edge_indexes(
    edges: list[dict],
) -> tuple[dict[str, list[dict]], dict[str, list[dict]]]:
    """
    Build forward (source→targets) and reverse (target→sources) indexes.
    Both include the edge type so retrieval can filter by confidence tier.
    """
    forward: dict[str, list[dict]] = {}   # source_id -> [{target, type}]
    reverse: dict[str, list[dict]] = {}   # target_id -> [{source, type}]

    for e in edges:
        src, tgt, etype = e.get("source", ""), e.get("target", ""), e.get("type", "")
        if src and tgt:
            forward.setdefault(src, []).append({"target": tgt, "type": etype})
            reverse.setdefault(tgt, []).append({"source": src, "type": etype})

    return forward, reverse


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def embed_document(nodes_path: str, progress_fn=None) -> None:
    nodes_file  = Path(nodes_path)
    graph_file  = nodes_file.with_name(nodes_file.stem + "_graph.json")
    doc_id      = nodes_file.stem
    collection  = f"doc_{doc_id}"

    with open(nodes_file, encoding="utf-8") as f:
        nodes: list[dict] = json.load(f)

    edges: list[dict] = []
    if graph_file.exists():
        with open(graph_file, encoding="utf-8") as f:
            edges = json.load(f).get("edges", [])
    else:
        print(f"[warn] no graph file found at {graph_file} — edges will be empty")

    print(f"Loaded {len(nodes)} nodes, {len(edges)} edges for '{doc_id}'")

    parent_map             = build_parent_header_map(nodes)
    forward_idx, reverse_idx = build_edge_indexes(edges)

    # Build the list of (node, embedding_text, point_uuid) to index
    records: list[tuple[dict, str, str]] = []
    skipped = 0
    for node in nodes:
        emb_text = build_embedding_text(node, parent_map.get(node["id"]))
        if len(emb_text.strip()) < MIN_TEXT:
            skipped += 1
            continue
        records.append((node, emb_text, _stable_uuid(node["id"])))

    print(f"Embedding {len(records)} nodes  ({skipped} skipped — below {MIN_TEXT} chars)")

    oai = _client()
    dim = _detect_dim(oai)
    print(f"Embedding dim detected: {dim}")

    # ---------- Qdrant collection setup ----------
    qclient = get_qdrant()

    if qclient.collection_exists(collection):
        qclient.delete_collection(collection)
        print(f"Dropped existing collection '{collection}'")

    qclient.create_collection(
        collection_name=collection,
        vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
    )
    print(f"Created collection '{collection}' at {QDRANT_PATH}")

    # ---------- Embed + upsert in batches ----------
    batch_ranges = range(0, len(records), BATCH_SIZE)
    iterator = tqdm(batch_ranges, desc="Embedding batches") if progress_fn is None else batch_ranges

    for batch_start in iterator:
        batch   = records[batch_start : batch_start + BATCH_SIZE]
        vectors = _embed(oai, [r[1] for r in batch])

        points = []
        for (node, emb_text, point_uuid), vector in zip(batch, vectors):
            nid  = node["id"]
            pic  = node.get("picture") or {}
            meta = node.get("metadata") or {}

            payload = {
                "node_id":       nid,
                "doc_id":        doc_id,
                "node_type":     node.get("type", ""),
                "page":          meta.get("page"),
                "text":          (node.get("text") or "").strip(),
                "picture_desc":  (pic.get("description") or "").strip(),
                "image_path":    pic.get("image_path"),
                "parent_header": parent_map.get(nid),
                "embedding_text": emb_text,
                # graph edges stored in payload so retrieval is self-contained
                "edges_out": forward_idx.get(nid, []),
                "edges_in":  reverse_idx.get(nid, []),
            }
            points.append(PointStruct(id=point_uuid, vector=vector, payload=payload))

        qclient.upsert(collection_name=collection, points=points)

        if progress_fn is not None:
            done = min(batch_start + BATCH_SIZE, len(records))
            progress_fn(done, len(records), f"Embedded {done}/{len(records)} nodes")

    print(f"\nDone. '{collection}' is ready — {len(records)} points in {QDRANT_PATH}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        default = (
            Path(__file__).parent
            / "storage" / "documents"
            / "SPC-50S-SPC75-Close-Coupled-Pulper.json"
        )
        target = str(default)
    else:
        target = sys.argv[1]

    embed_document(target)
