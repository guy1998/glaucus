"""
chat_retrieval.py — Multi-document chat with query expansion, auto-routing, and streaming.

Pipeline:
  1. route_to_data_source  — LLM picks best data source from descriptions
  2. expand_query          — LLM generates query variants + keywords for display
  3. retrieve_from_collections — multi-collection Qdrant search, deduped & ranked
  4. stream_response       — streaming LLM answer grounded in retrieved context
"""

import json
import os
from pathlib import Path
from typing import Iterator

from dotenv import load_dotenv
from openai import OpenAI

from retrieval import retrieve_context, format_context_for_llm, _qdrant

load_dotenv(Path(__file__).parent / ".env")

VLM_BASE = (os.environ.get("VLM_BASE_URL") or "").rstrip("/")
VLM_KEY  = os.environ.get("VLM_API_KEY", "")
MODEL    = os.environ.get("MODEL_NAME") or os.environ.get("VLM_MODEL", "")

_llm_client: OpenAI | None = None


def _llm() -> OpenAI:
    global _llm_client
    if _llm_client is None:
        _llm_client = OpenAI(base_url=VLM_BASE, api_key=VLM_KEY)
    return _llm_client


def _call(messages: list[dict], max_tokens: int = 512, stream: bool = False):
    return _llm().chat.completions.create(
        model=MODEL,
        messages=messages,
        max_tokens=max_tokens,
        stream=stream,
    )


# ---------------------------------------------------------------------------
# 1. Source routing
# ---------------------------------------------------------------------------

def route_to_data_source(query: str, sources: list[dict]) -> str | None:
    """
    Return the ID of the most relevant data source for the query.
    sources: list of {id, name, description?}
    """
    if not sources:
        return None
    if len(sources) == 1:
        return sources[0]["id"]

    lines = []
    for s in sources:
        line = f'- id="{s["id"]}" name="{s["name"]}"'
        if s.get("description"):
            line += f' description="{s["description"]}"'
        lines.append(line)

    prompt = (
        "You are a routing assistant. Return ONLY the id of the most relevant data source for the query.\n\n"
        "Data sources:\n" + "\n".join(lines) + f"\n\nQuery: {query}"
    )
    resp = _call([{"role": "user", "content": prompt}], max_tokens=64)
    chosen = resp.choices[0].message.content.strip().strip('"\'')
    known = {s["id"] for s in sources}
    return chosen if chosen in known else sources[0]["id"]


# ---------------------------------------------------------------------------
# 2. Query expansion + keyword extraction
# ---------------------------------------------------------------------------

def expand_query(query: str) -> tuple[list[str], list[str]]:
    """
    Returns (query_variants, keywords).
    query_variants includes the original query followed by LLM-generated variants.
    """
    prompt = (
        'Generate 4 alternative phrasings of the question and the top 6 most important search keywords.\n'
        'Respond ONLY with valid JSON (no markdown fences): {"queries": [...], "keywords": [...]}\n\n'
        f"Question: {query}"
    )
    resp = _call([{"role": "user", "content": prompt}], max_tokens=400)
    text = resp.choices[0].message.content.strip()
    if "```" in text:
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    try:
        data = json.loads(text)
        variants = [query] + [q for q in (data.get("queries") or []) if q != query]
        keywords = [k for k in (data.get("keywords") or []) if k]
        return variants[:5], keywords[:8]
    except Exception:
        return [query], []


# ---------------------------------------------------------------------------
# 3. Multi-collection retrieval
# ---------------------------------------------------------------------------

def retrieve_from_collections(
    queries: list[str],
    collections: list[str],
    top_k: int = 5,
    max_per_query: int = 8,
    max_total: int = 25,
) -> list[dict]:
    """
    Retrieve from multiple Qdrant collections, merge, deduplicate by node_id,
    keep highest score per node, and rank.
    """
    qclient = _qdrant()
    merged: dict[str, dict] = {}

    for collection in collections:
        if not qclient.collection_exists(collection):
            continue
        for query in queries:
            try:
                for r in retrieve_context(query, collection, top_k=top_k, max_context=max_per_query):
                    nid = r["node_id"]
                    if nid not in merged or r["score"] > merged[nid]["score"]:
                        merged[nid] = {**r, "collection": collection}
            except Exception:
                pass

    order = {"dense": 0, "graph_forward": 1, "graph_reverse": 2, "parent_header": 3}
    return sorted(
        merged.values(),
        key=lambda r: (order.get(r.get("source", "dense"), 9), -r.get("score", 0)),
    )[:max_total]


# ---------------------------------------------------------------------------
# 4. Streaming response
# ---------------------------------------------------------------------------

def stream_response(
    query: str,
    nodes: list[dict],
    history: list[dict] | None = None,
) -> Iterator[str]:
    """Yield LLM response tokens grounded in the retrieved document context."""
    context = format_context_for_llm(nodes)
    messages: list[dict] = [
        {
            "role": "system",
            "content": (
                "You are a knowledgeable assistant answering questions based on the provided document context. "
                "Give accurate, well-structured answers. Cite page numbers and sections when relevant. "
                "If the context is insufficient, say so clearly."
            ),
        }
    ]
    if history:
        messages.extend(history[-6:])
    messages.append({
        "role": "user",
        "content": f"Document context:\n\n{context}\n\n---\n\nQuestion: {query}",
    })
    stream = _call(messages, max_tokens=1024, stream=True)
    for chunk in stream:
        delta = chunk.choices[0].delta
        if delta.content:
            yield delta.content
