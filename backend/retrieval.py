"""
retrieval.py — Query the Glaucias RAG pipeline.

Usage (CLI):
    python retrieval.py doc_MyDoc "What is the maximum operating pressure?"

Or import retrieve_context() / format_context_for_llm() into your app.

Retrieval strategy (in order):
  1. Dense vector search  → top-k semantically similar nodes
  2. Forward graph expansion  → nodes that retrieved hits explicitly reference
  3. Reverse graph expansion  → nodes that explicitly reference retrieved hits
  4. Parent header injection  → section headers that own any retrieved node
     (these are added as structural anchors, not ranked results)

Only 'explicit' and 'explicit_page' edges are followed — implicit (LLM-resolved)
edges are noisier and excluded from expansion by default.

Env vars (all in .env):
    EMBEDDING_MODEL     model name for the embedding API (required)
    EMBEDDING_BASE_URL  base URL for embedding API (falls back to VLM_BASE_URL)
    EMBEDDING_API_KEY   API key for embedding API    (falls back to VLM_API_KEY)
    QDRANT_PATH         local storage path (default: ./qdrant_storage)
"""

import os
import sys
import uuid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI
from qdrant_client import QdrantClient

from qdrant_shared import get_qdrant

load_dotenv(Path(__file__).parent / ".env")

EMBEDDING_BASE  = (os.environ.get("EMBEDDING_BASE_URL") or os.environ.get("VLM_BASE_URL", "")).rstrip("/")
EMBEDDING_KEY   = os.environ.get("EMBEDDING_API_KEY")  or os.environ.get("VLM_API_KEY", "")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "")
QDRANT_PATH     = os.environ.get("QDRANT_PATH", "./qdrant_storage")

# Retrieval defaults — override per-call as needed
DEFAULT_TOP_K       = 6    # dense hits before graph expansion
DEFAULT_MAX_CONTEXT = 20   # hard cap on total nodes returned
EXPLICIT_EDGE_TYPES = {"explicit", "explicit_page"}


# ---------------------------------------------------------------------------
# Shared clients (lazy-initialised singletons)
# ---------------------------------------------------------------------------

_oai_client: OpenAI | None = None


def _oai() -> OpenAI:
    global _oai_client
    if _oai_client is None:
        if not EMBEDDING_BASE or not EMBEDDING_KEY or not EMBEDDING_MODEL:
            raise RuntimeError(
                "Missing embedding config. Set EMBEDDING_MODEL (and optionally "
                "EMBEDDING_BASE_URL / EMBEDDING_API_KEY) in .env"
            )
        _oai_client = OpenAI(base_url=EMBEDDING_BASE, api_key=EMBEDDING_KEY)
    return _oai_client


def _qdrant() -> QdrantClient:
    return get_qdrant()


def _stable_uuid(node_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, node_id))


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def embed_query(query: str) -> list[float]:
    response = _oai().embeddings.create(model=EMBEDDING_MODEL, input=[query])
    return response.data[0].embedding


# ---------------------------------------------------------------------------
# Graph expansion helpers
# ---------------------------------------------------------------------------

def _explicit_targets(edges_out: list[dict]) -> list[str]:
    """Forward: node IDs that this node explicitly references."""
    return [e["target"] for e in edges_out if e.get("type") in EXPLICIT_EDGE_TYPES]


def _explicit_sources(edges_in: list[dict]) -> list[str]:
    """Reverse: node IDs that explicitly reference this node."""
    return [e["source"] for e in edges_in if e.get("type") in EXPLICIT_EDGE_TYPES]


def _fetch_by_node_ids(collection: str, node_ids: list[str]) -> list[dict]:
    """Fetch Qdrant points by string node_id (converted to stable UUIDs)."""
    if not node_ids:
        return []
    uuids  = [_stable_uuid(nid) for nid in node_ids]
    points = _qdrant().retrieve(collection_name=collection, ids=uuids, with_payload=True)
    return [p.payload for p in points if p.payload]


# ---------------------------------------------------------------------------
# Core retrieval
# ---------------------------------------------------------------------------

def retrieve_context(
    query: str,
    collection: str,
    top_k: int = DEFAULT_TOP_K,
    max_context: int = DEFAULT_MAX_CONTEXT,
    include_implicit_expansion: bool = False,
) -> list[dict[str, Any]]:
    """
    Return a ranked list of node dicts relevant to `query`.

    Each item has keys:
        node_id, node_type, page, text, picture_desc, image_path,
        parent_header, score, source
    where `source` is one of:
        'dense'              — matched by vector similarity
        'graph_forward'      — explicitly referenced by a dense hit
        'graph_reverse'      — explicitly references a dense hit
        'parent_header'      — section header that owns a hit (structural anchor)
    """
    qclient = _qdrant()
    vector  = embed_query(query)

    # 1. Dense search
    hits = qclient.query_points(
        collection_name=collection,
        query=vector,
        limit=top_k,
        with_payload=True,
    ).points

    # scored: node_id -> (score, source)
    scored: dict[str, tuple[float, str]] = {}
    payloads: dict[str, dict] = {}

    for hit in hits:
        p   = hit.payload or {}
        nid = p.get("node_id", "")
        if nid:
            scored[nid]   = (hit.score, "dense")
            payloads[nid] = p

    hit_ids = set(scored)

    # 2. Forward expansion — nodes that dense hits explicitly reference
    forward_ids: set[str] = set()
    for nid in hit_ids:
        p = payloads[nid]
        for tid in _explicit_targets(p.get("edges_out", [])):
            if tid not in scored:
                forward_ids.add(tid)

    for p in _fetch_by_node_ids(collection, list(forward_ids)):
        nid = p.get("node_id", "")
        if nid and nid not in scored:
            scored[nid]   = (0.0, "graph_forward")
            payloads[nid] = p

    # 3. Reverse expansion — nodes that reference our dense hits
    reverse_ids: set[str] = set()
    for nid in hit_ids:
        p = payloads[nid]
        for sid in _explicit_sources(p.get("edges_in", [])):
            if sid not in scored:
                reverse_ids.add(sid)

    for p in _fetch_by_node_ids(collection, list(reverse_ids)):
        nid = p.get("node_id", "")
        if nid and nid not in scored:
            scored[nid]   = (0.0, "graph_reverse")
            payloads[nid] = p

    # 4. Parent section headers — inject as structural anchors for every hit
    #    A node's parent_header is a text breadcrumb, not a node reference,
    #    so we don't need to fetch a separate point for it — it's already
    #    in the payload.  Nothing to do here beyond keeping the field.

    # 5. Sort: dense first (desc score), then graph expansions
    order = {"dense": 0, "graph_forward": 1, "graph_reverse": 2, "parent_header": 3}
    ranked = sorted(
        scored.items(),
        key=lambda kv: (order.get(kv[1][1], 9), -kv[1][0]),
    )

    results: list[dict[str, Any]] = []
    for nid, (score, source) in ranked[:max_context]:
        p = payloads.get(nid, {})
        results.append({
            "node_id":       nid,
            "node_type":     p.get("node_type"),
            "page":          p.get("page"),
            "text":          p.get("text") or p.get("picture_desc") or "",
            "picture_desc":  p.get("picture_desc"),
            "image_path":    p.get("image_path"),
            "parent_header": p.get("parent_header"),
            "score":         round(score, 4),
            "source":        source,
        })

    return results


# ---------------------------------------------------------------------------
# Context formatter
# ---------------------------------------------------------------------------

def format_context_for_llm(nodes: list[dict[str, Any]]) -> str:
    """
    Render retrieved nodes as a prompt-ready context block.

    Each node is separated by a divider and prefixed with its section breadcrumb
    and page number so the LLM can cite sources.
    """
    parts: list[str] = []
    for node in nodes:
        lines: list[str] = []
        if node.get("parent_header"):
            lines.append(f"[Section: {node['parent_header']}]")
        if node.get("page") is not None:
            lines.append(f"(page {node['page']})")
        lines.append(f"[{node['node_type']}]")
        lines.append(node.get("text") or node.get("picture_desc") or "(no text)")
        parts.append("\n".join(lines))

    return "\n\n---\n\n".join(parts)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python retrieval.py <collection> \"<query>\"")
        print("  collection: e.g.  doc_SPC-50S-SPC75-Close-Coupled-Pulper")
        sys.exit(1)

    collection_arg = sys.argv[1]
    query_arg      = sys.argv[2]

    results = retrieve_context(query_arg, collection_arg)

    print(f"\nRetrieved {len(results)} nodes for: \"{query_arg}\"\n")
    for i, r in enumerate(results, 1):
        snippet = (r["text"] or "")[:100].replace("\n", " ")
        print(f"  {i:2}. [{r['source']:15}] score={r['score']:.4f}  type={r['node_type']:15}  page={r['page']}")
        print(f"       {snippet}")

    print("\n" + "=" * 60)
    print("Context block (paste into LLM prompt):")
    print("=" * 60)
    print(format_context_for_llm(results))
