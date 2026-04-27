"""
Print the source and target node content for each edge in a reference graph.
Usage: python print_graph_edges.py <graph_file>
       python print_graph_edges.py  (defaults to sample document graph)
"""

import json
import re
import sys
from pathlib import Path


def _get_node_text(node: dict, max_chars: int = 200) -> str:
    """Return usable display text for any node type, including pictures."""
    text = node.get("text") or ""
    if not text:
        pic = node.get("picture") or {}
        raw = pic.get("description") or ""
        raw = re.sub(r"^```[a-z]*\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw).strip()
        if raw.startswith("{"):
            try:
                text = json.loads(raw).get("description") or raw
            except json.JSONDecodeError:
                text = raw
        else:
            text = raw
    return text[:max_chars].replace("\n", " ") if text else "(no text)"


def print_graph_edges(graph_file: str) -> None:
    doc_file = graph_file.replace("_graph.json", ".json")

    with open(graph_file, encoding="utf-8") as f:
        graph = json.load(f)

    with open(doc_file, encoding="utf-8") as f:
        nodes = json.load(f)

    node_by_id = {n["id"]: n for n in nodes}
    edges = graph["edges"]

    # Summary by type
    type_counts: dict[str, int] = {}
    for e in edges:
        type_counts[e["type"]] = type_counts.get(e["type"], 0) + 1

    print(f"Document : {graph['document_id']}")
    print(f"Edges    : {len(edges)}")
    for etype, count in sorted(type_counts.items()):
        print(f"  {etype:<20} {count}")
    print("=" * 80)

    for i, edge in enumerate(edges, 1):
        etype = edge["type"]
        source_node = node_by_id.get(edge["source"])
        target_node = node_by_id.get(edge["target"])

        def node_line(node: dict | None, node_id: str) -> tuple[str, str]:
            if node is None:
                return node_id, "(node not found)"
            pg = (node.get("metadata") or {}).get("page", "?")
            label = f"{node_id}  [type={node.get('type', '?')}  page={pg}]"
            return label, _get_node_text(node)

        src_label, src_text = node_line(source_node, edge["source"])
        tgt_label, tgt_text = node_line(target_node, edge["target"])

        print(f"Edge {i}  [{etype}]")
        print(f"  SOURCE  {src_label}")
        print(f"          {src_text!r}")
        print(f"  TARGET  {tgt_label}")
        print(f"          {tgt_text!r}")
        print("-" * 80)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        default = (
            Path(__file__).parent
            / "storage"
            / "documents"
            / "SPC-50S-SPC75-Close-Coupled-Pulper_graph.json"
        )
        target = str(default)
    else:
        target = sys.argv[1]

    print_graph_edges(target)
