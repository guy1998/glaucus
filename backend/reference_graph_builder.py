"""
Reference Graph Builder v2

Pipeline
--------
1. Build title index   : {normalized_title -> node_id} from section_header,
                         document_index, title types, and ALL-CAPS text nodes.
2. Regex pre-filter    : scan every content node (text, table, list, picture
                         description) for reference keywords.  Skip nodes that
                         have no indicators.
3. Classify references : split detected indicators into
                           - implicit  (above / below / left / right / following …)
                           - explicit  (Section X, Table Y, Figure Z, named title)
4. Resolve references  :
     a. Explicit (deterministic):
          - Numbered section/table/figure  -> lookup in title index
          - Section reference              -> header node + all nodes until the
                                             next same-or-higher-level header
          - Named reference                -> fuzzy match in title index + section
          - Page reference                 -> LLM disambiguation among page nodes
     b. Implicit (LLM):
          - Build positional window (above/below/left/right by bbox on same page)
          - Build doc-order window (±N nodes in sequence)
          - Single focused LLM call returns node IDs that are actually referenced
5. Build graph edges from resolved target IDs.
"""

import json
import os
import re
import sys
import difflib
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

try:
    import openai as _openai
    _OPENAI_AVAILABLE = True
except ImportError:
    _OPENAI_AVAILABLE = False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TITLE_TYPES = {"section_header", "document_index", "title"}
EXCLUDED_FROM_SOURCES: set[str] = set()  # all types can be reference sources now
MIN_TEXT_LEN = 15
IMPLICIT_DOC_WINDOW = 5     # nodes before/after in document order for implicit refs
MAX_PER_DIRECTION = 8       # max nodes per bbox direction (above/below/left/right)

_ALL_CAPS_RE = re.compile(r'^[A-Z][A-Z0-9 \-/&()]{3,80}$')
_SECTION_NUM_RE = re.compile(r'^(\d+(?:\.\d+)*)')
_NORMALIZE_RE = re.compile(r'[^a-z0-9\s]')

# ---------------------------------------------------------------------------
# Regex: implicit reference indicators (positional / anaphoric keywords)
# ---------------------------------------------------------------------------

_IMPLICIT_RE = re.compile(
    r'\b('
    r'above|below|left|right'
    r'|the following|the preceding|the previous|the next'
    r'|aforementioned|as shown|as indicated|as described|as listed'
    r'|shown above|shown below|illustrated above|illustrated below'
    r'|see (?:the )?(?:figure|table|diagram|image|picture) (?:above|below)'
    r'|refer to (?:the )?(?:figure|table|diagram) (?:above|below)'
    r')\b',
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Regex: explicit reference indicators
# ---------------------------------------------------------------------------

_SECTION_REF_RE = re.compile(
    r'\b(?:Section|Sec\.?|Chapter|Chap\.?)\s+(\d+(?:\.\d+)*)', re.IGNORECASE
)
_TABLE_REF_RE = re.compile(r'\bTable\s+(\d+)\b', re.IGNORECASE)
_FIGURE_REF_RE = re.compile(r'\b(?:Figure|Fig\.?)\s+(\d+)\b', re.IGNORECASE)
_PAGE_REF_RE = re.compile(r'\bpage\s+(\d+)\b', re.IGNORECASE)

# Named references: "see the Installation section", "refer to the Safety Instructions"
_NAMED_REF_RE = re.compile(
    r'\b(?:see|refer to|described in|detailed in|shown in|listed in|consult)'
    r'\s+(?:the\s+)?([A-Z][A-Za-z0-9 \-/]{2,50})'
    r'\s+(?:section|chapter|procedure|instructions?|manual|guide|appendix)\b',
    re.IGNORECASE,
)
# Broad reference-verb gate used by find_bare_title_refs
_REF_VERB_RE = re.compile(
    r'\b(?:'
    r'see|refer(?:ence)?(?:\s+to)?|described\s+in|detailed\s+in|shown\s+in'
    r'|listed\s+in|consult|found\s+in|covered\s+in|discussed\s+in'
    r'|outlined\s+in|specified\s+in|defined\s+in|explained\s+in'
    r'|presented\s+in|provided\s+in|given\s+in|contained\s+in'
    r'|documented\s+in|included\s+in|mentioned\s+in|noted\s+in'
    r'|per|according\s+to|as\s+per|as\s+stated\s+in|as\s+described\s+in'
    r'|as\s+shown\s+in|as\s+listed\s+in|as\s+defined\s+in|as\s+specified\s+in'
    r')\b',
    re.IGNORECASE,
)
# Quick gate: does the text contain ANY of the above?
_ANY_REF_RE = re.compile(
    r'\b(?:above|below|left|right|following|preceding|previous|next'
    r'|aforementioned|as shown|as described|as listed|illustrated'
    r'|Section|Sec\.|Chapter|Table|Figure|Fig\.'
    r'|see|refer to|consult)\b'
    r'|\bpage\s+\d',
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize(text: str) -> str:
    return _NORMALIZE_RE.sub('', text.lower()).strip()


def _clean_picture_description(raw: str) -> str:
    """
    VLM sometimes returns the description wrapped in markdown code fences
    or as a raw JSON object.  Extract the plain description text.
    """
    if not raw:
        return ''
    raw = raw.strip()
    # Strip markdown code fences
    raw = re.sub(r'^```[a-z]*\n?', '', raw)
    raw = re.sub(r'\n?```$', '', raw).strip()
    # If it's a JSON object, pull out the description field
    if raw.startswith('{'):
        try:
            parsed = json.loads(raw)
            return parsed.get('description') or raw
        except json.JSONDecodeError:
            pass
    return raw


def _get_node_text(node: dict) -> str:
    """Return the best searchable text for any node type."""
    text = node.get('text') or ''
    if not text:
        pic = node.get('picture') or {}
        text = _clean_picture_description(pic.get('description') or '')
    return text


def _is_title_node(node: dict) -> bool:
    ntype = node.get('type', '')
    if ntype in TITLE_TYPES:
        return True
    if ntype == 'text':
        t = (node.get('text') or '').strip()
        return bool(_ALL_CAPS_RE.match(t))
    return False


def _section_level(node: dict) -> int:
    """
    Return the structural depth of a title node (0 = top-level).
    Determined by dot-count in the leading section number.
    ALL-CAPS text nodes without a number are treated as level 0.
    """
    text = (node.get('text') or '').strip()
    m = _SECTION_NUM_RE.match(text)
    if m:
        return m.group(1).count('.')
    return 0


# ---------------------------------------------------------------------------
# Step 1 — Build title index
# ---------------------------------------------------------------------------

def build_title_index(nodes: list[dict]) -> dict[str, str]:
    """
    Returns {normalized_title: node_id} for all title-like nodes.
    Multiple lookup keys are registered per node:
      - full normalized text
      - text with leading section number stripped
      - raw section number string (e.g. "3.1")
    First registration wins (document order).
    """
    index: dict[str, str] = {}

    def _register(key: str, node_id: str) -> None:
        k = _normalize(key)
        if k and k not in index:
            index[k] = node_id

    for node in nodes:
        if not _is_title_node(node):
            continue
        nid = node['id']
        text = (node.get('text') or '').strip()
        if not text:
            continue

        _register(text, nid)

        # Strip leading section number and register the remainder
        stripped = _SECTION_NUM_RE.sub('', text).strip(' .-:')
        if stripped:
            _register(stripped, nid)

        # Register the raw section number itself ("3", "3.1", "3.1.2")
        m = _SECTION_NUM_RE.match(text)
        if m:
            _register(m.group(1), nid)

    return index


# ---------------------------------------------------------------------------
# Step 2 — Regex pre-filter
# ---------------------------------------------------------------------------

def has_potential_reference(node: dict, custom_re=None) -> bool:
    text = _get_node_text(node)
    if len(text) < MIN_TEXT_LEN:
        return False
    if _ANY_REF_RE.search(text):
        return True
    return bool(custom_re and custom_re.search(text))


def classify_references(text: str, custom_re=None) -> dict[str, list[str]]:
    """
    Returns detected reference categories in the text.
    Each value is a list of the matched targets (numbers or title fragments).
    """
    return {
        'implicit': [m.group(0) for m in _IMPLICIT_RE.finditer(text)],
        'section':  [m.group(1) for m in _SECTION_REF_RE.finditer(text)],
        'table':    [m.group(1) for m in _TABLE_REF_RE.finditer(text)],
        'figure':   [m.group(1) for m in _FIGURE_REF_RE.finditer(text)],
        'page':     [m.group(1) for m in _PAGE_REF_RE.finditer(text)],
        'named':    [m.group(1).strip() for m in _NAMED_REF_RE.finditer(text)],
        'custom':   [m.group(0) for m in custom_re.finditer(text)] if custom_re else [],
    }


def find_bare_title_refs(text: str, title_index: dict[str, str]) -> list[str]:
    """
    Return every normalized title-index key that appears verbatim in text
    (case-insensitive), but only when the text also contains a reference verb
    (see, refer to, described in, etc.) so we don't match incidental title
    repetitions.
    """
    if not _REF_VERB_RE.search(text):
        return []
    text_lower = text.lower()
    return [key for key in title_index if len(key) >= 4 and key in text_lower]


# ---------------------------------------------------------------------------
# Step 3a — Deterministic section traversal
# ---------------------------------------------------------------------------

def get_section_body_nodes(header_node_id: str, nodes: list[dict]) -> list[dict]:
    """
    Return all nodes belonging to the section that begins at header_node_id.
    The section ends when a title node at the same or higher level is encountered
    (higher level = smaller dot-count, i.e. parent or sibling section).
    Subsections (deeper dot-count) are included.
    """
    header_idx = next(
        (i for i, n in enumerate(nodes) if n['id'] == header_node_id), None
    )
    if header_idx is None:
        return []

    header_level = _section_level(nodes[header_idx])
    result: list[dict] = []

    for node in nodes[header_idx + 1:]:
        if _is_title_node(node) and _section_level(node) <= header_level:
            break
        result.append(node)

    return result


# ---------------------------------------------------------------------------
# Step 3b — Deterministic explicit reference resolution
# ---------------------------------------------------------------------------

def resolve_explicit_refs(
    detected: dict[str, list[str]],
    title_index: dict[str, str],
    nodes: list[dict],
    page_index: dict[int, list[str]],
    node_map: dict[str, dict],
    source_id: str = '',
) -> tuple[list[str], list[tuple[int, list[dict]]]]:
    """
    Resolve explicit references deterministically where possible.

    Returns:
        resolved_ids : node IDs that can be resolved without LLM
        page_disambig: [(page_num, candidate_nodes)] pairs needing LLM
                       disambiguation (from page references)
    """
    resolved: list[str] = []
    seen: set[str] = set()
    page_disambig: list[tuple[int, list[dict]]] = []

    def _add(nid: str) -> None:
        if nid and nid not in seen:
            seen.add(nid)
            resolved.append(nid)

    def _add_section(header_id: str) -> None:
        body = get_section_body_nodes(header_id, nodes)
        # Skip if the source node is the header itself or already lives inside
        # this section — it would be a self-referential edge.
        if source_id == header_id or any(n['id'] == source_id for n in body):
            return
        _add(header_id)
        for n in body:
            if len(_get_node_text(n).strip()) >= MIN_TEXT_LEN:
                _add(n['id'])

    def _lookup_title(name: str) -> str | None:
        norm = _normalize(name)
        nid = title_index.get(norm)
        if nid:
            return nid
        matches = difflib.get_close_matches(norm, title_index.keys(), n=1, cutoff=0.72)
        return title_index[matches[0]] if matches else None

    # Numbered section references: "Section 3.1"
    for sec_num in detected.get('section', []):
        nid = title_index.get(sec_num) or title_index.get(_normalize(sec_num))
        if nid:
            _add_section(nid)

    # Table references: "Table 2"
    for tnum in detected.get('table', []):
        pattern = re.compile(rf'\bTable\s+{re.escape(tnum)}\b', re.IGNORECASE)
        for n in nodes:
            if n.get('type') == 'table' and pattern.search(_get_node_text(n)):
                _add(n['id'])
                break
        else:
            # Fallback: table node whose ID contains the number
            for n in nodes:
                if n.get('type') == 'table' and f'_{tnum}' in n['id']:
                    _add(n['id'])
                    break

    # Figure references: "Figure 3" / "Fig. 3"
    for fnum in detected.get('figure', []):
        pattern = re.compile(rf'\b(?:Figure|Fig\.?)\s+{re.escape(fnum)}\b', re.IGNORECASE)
        for n in nodes:
            if n.get('type') in ('picture', 'figure') and pattern.search(_get_node_text(n)):
                _add(n['id'])
                break

    # Named references: "see the Safety Instructions section"
    for name in detected.get('named', []):
        nid = _lookup_title(name)
        if nid:
            _add_section(nid)

    # Page references: queue for LLM disambiguation
    for pg_str in detected.get('page', []):
        try:
            pg = int(pg_str)
            candidates = [node_map[nid] for nid in page_index.get(pg, []) if nid in node_map]
            if candidates:
                page_disambig.append((pg, candidates))
        except ValueError:
            pass

    return resolved, page_disambig


# ---------------------------------------------------------------------------
# Step 3c — LLM: implicit reference resolution
# ---------------------------------------------------------------------------

def _fmt_node(node: dict, max_chars: int = 160) -> str:
    text = _get_node_text(node)[:max_chars].replace('\n', ' ')
    pg = (node.get('metadata') or {}).get('page', '?')
    return f'[{node["id"]}] type={node.get("type", "?")} page={pg} | {text}'


def _llm_call(prompt: str, max_tokens: int = 256) -> list[str]:
    """
    Generic LLM call that expects a JSON array of node ID strings in reply.
    Returns an empty list on any error.
    Uses the OpenAI-compatible endpoint configured via VLM_BASE_URL / VLM_API_KEY / MODEL_NAME.
    """
    if not _OPENAI_AVAILABLE:
        print('[LLM] openai package not installed')
        return []
    base_url = os.environ.get('VLM_BASE_URL', '').rstrip('/')
    api_key = os.environ.get('VLM_API_KEY')
    model = os.environ.get('MODEL_NAME') or os.environ.get('VLM_MODEL')
    if not base_url or not api_key or not model:
        print(f'[LLM] missing config: base_url={bool(base_url)} api_key={bool(api_key)} model={model!r}')
        return []
    try:
        client = _openai.OpenAI(base_url=base_url, api_key=api_key)
        response = client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            messages=[{'role': 'user', 'content': prompt}],
        )
        reply = response.choices[0].message.content.strip()
        reply = re.sub(r'^```[a-z]*\n?', '', reply)
        reply = re.sub(r'\n?```$', '', reply).strip()
        result = json.loads(reply)
        if isinstance(result, list):
            return [str(x) for x in result if x]
    except Exception as e:
        print(f'[LLM] error: {e}')
    return []


def resolve_implicit_refs_with_llm(
    source_node: dict, 
    implicit_keywords: list[str],
    positional_windows: dict[str, list[dict]],
    doc_order_window: list[dict],
) -> list[str]:
    """
    Ask the LLM which candidate nodes the source node's positional/anaphoric
    keywords (above / below / following / etc.) actually point to.
    """
    def _section(label: str, nodes_list: list[dict]) -> str:
        if not nodes_list:
            return f'{label}:\n  (none)\n'
        return f'{label}:\n' + '\n'.join(f'  {_fmt_node(n)}' for n in nodes_list) + '\n'

    context = (
        _section('ABOVE (same page, higher position)', positional_windows.get('above', []))
        + _section('BELOW (same page, lower position)', positional_windows.get('below', []))
        + _section('LEFT (same page)', positional_windows.get('left', []))
        + _section('RIGHT (same page)', positional_windows.get('right', []))
        + _section('NEARBY (document order, same/adjacent section)', doc_order_window)
    )

    src_text = _get_node_text(source_node)[:600]
    kw_str = ', '.join(f'"{k}"' for k in implicit_keywords)

    prompt = (
        'You are resolving implicit references in a technical document.\n\n'
        f'Source node [ID: {source_node["id"]}]:\n"{src_text}"\n\n'
        f'Detected implicit reference keywords: {kw_str}\n\n'
        f'Candidate nodes:\n{context}\n'
        'Task: identify which candidate node IDs the source text is referring to '
        'via the implicit keywords (considering spatial position and context). '
        'Only include nodes that are clearly referenced.\n\n'
        'Important: if the source introduces a numbered or bulleted list with '
        '"the following" (or a similar phrase), include ALL list items that follow '
        'it — not just the ones you find most relevant.\n\n'
        'Return ONLY a JSON array of node ID strings, e.g. ["id1", "id2"].\n'
        'Return [] if no clear reference can be determined.'
    )
    return _llm_call(prompt, max_tokens=256)


def resolve_page_ref_with_llm(
    source_node: dict,
    page_num: int,
    page_candidates: list[dict],
) -> list[str]:
    """
    Given that the source node says "see page N", ask the LLM which of the
    nodes on page N it is most likely referring to.
    """
    src_text = _get_node_text(source_node)[:400]
    candidates_block = '\n'.join(f'  {_fmt_node(n)}' for n in page_candidates[:20])

    prompt = (
        'A technical document node references "page {pg}".\n\n'
        'Source node [ID: {sid}]:\n"{src}"\n\n'
        'Nodes on page {pg}:\n{cands}\n\n'
        'Which of these node IDs is the source most likely referring to? '
        'Return ONLY a JSON array of node ID strings (usually 1–3 IDs).\n'
        'Return [] if the reference is too vague to resolve.'
    ).format(pg=page_num, sid=source_node['id'], src=src_text, cands=candidates_block)

    return _llm_call(prompt, max_tokens=128)


# ---------------------------------------------------------------------------
# Step 4 — Positional window (bbox-based, same page)
# ---------------------------------------------------------------------------

def build_positional_window(
    node: dict,
    page_nodes: list[dict],
) -> dict[str, list[dict]]:
    """
    Classify same-page nodes as above / below / left / right relative to the
    source node using BOTTOMLEFT bbox coordinates.
    """
    bbox = (node.get('metadata') or {}).get('bbox')
    if not bbox:
        return {'above': [], 'below': [], 'left': [], 'right': []}

    nl, nt, nr, nb = bbox['l'], bbox['t'], bbox['r'], bbox['b']
    src_id = node['id']

    buckets: dict[str, list[tuple[float, dict]]] = {
        'above': [], 'below': [], 'left': [], 'right': []
    }

    for other in page_nodes:
        if other['id'] == src_id:
            continue
        ob = (other.get('metadata') or {}).get('bbox')
        if not ob:
            continue
        ol, ot, or_, ob_ = ob['l'], ob['t'], ob['r'], ob['b']

        if ob_ >= nt:
            buckets['above'].append((ob_ - nt, other))
        elif ot <= nb:
            buckets['below'].append((nb - ot, other))
        else:
            if or_ <= nl:
                buckets['left'].append((nl - or_, other))
            elif ol >= nr:
                buckets['right'].append((ol - nr, other))

    return {
        direction: [n for _, n in sorted(pairs, key=lambda x: x[0])[:MAX_PER_DIRECTION]]
        for direction, pairs in buckets.items()
    }


# ---------------------------------------------------------------------------
# Step 5 — Indices
# ---------------------------------------------------------------------------

def build_page_index(nodes: list[dict]) -> dict[int, list[str]]:
    idx: dict[int, list[str]] = {}
    for n in nodes:
        pg = (n.get('metadata') or {}).get('page')
        if pg is not None:
            idx.setdefault(pg, []).append(n['id'])
    return idx


# ---------------------------------------------------------------------------
# Step 6 — Main edge builder
# ---------------------------------------------------------------------------

def build_reference_edges(
    nodes: list[dict],
    progress_fn=None,
    custom_keywords: list[str] | None = None,
) -> list[dict]:
    custom_re = None
    if custom_keywords:
        parts = [re.escape(k.strip()) for k in custom_keywords if k.strip()]
        if parts:
            custom_re = re.compile('|'.join(parts), re.IGNORECASE)

    node_map: dict[str, dict] = {n['id']: n for n in nodes}
    title_index = build_title_index(nodes)
    page_index = build_page_index(nodes)

    edges: list[dict] = []
    seen_edges: set[tuple[str, str]] = set()

    def _add_edge(source_id: str, target_id: str, ref_type: str) -> None:
        key = (source_id, target_id)
        if (
            target_id
            and target_id != source_id
            and target_id in node_map
            and key not in seen_edges
        ):
            seen_edges.add(key)
            edges.append({'source': source_id, 'target': target_id, 'type': ref_type})

    for i, node in enumerate(nodes):
        if progress_fn is not None and i % 25 == 0:
            progress_fn(i, len(nodes), f"Scanning references {i}/{len(nodes)} nodes…")
        # --- Pre-filter ---
        if not has_potential_reference(node, custom_re):
            continue

        source_id = node['id']
        text = _get_node_text(node)
        detected = classify_references(text, custom_re)
        detected['named'].extend(find_bare_title_refs(text, title_index))

        implicit_keywords = detected['implicit'] + detected['custom']
        has_implicit = bool(implicit_keywords)
        has_explicit = any(
            detected[k] for k in ('section', 'table', 'figure', 'page', 'named')
        )

        if not has_implicit and not has_explicit:
            continue

        # --- Explicit references (deterministic + optional page LLM) ---
        if has_explicit:
            resolved_ids, page_disambig = resolve_explicit_refs(
                detected, title_index, nodes, page_index, node_map, source_id
            )
            for tid in resolved_ids:
                _add_edge(source_id, tid, 'explicit')

            for pg_num, pg_candidates in page_disambig:
                llm_ids = resolve_page_ref_with_llm(node, pg_num, pg_candidates)
                for tid in llm_ids:
                    _add_edge(source_id, tid, 'explicit_page')

        # --- Implicit references (LLM) ---
        if has_implicit:
            page = (node.get('metadata') or {}).get('page')
            page_node_ids = page_index.get(page, []) if page is not None else []
            page_nodes = [node_map[nid] for nid in page_node_ids if nid in node_map]
            positional_windows = build_positional_window(node, page_nodes)

            # Structural parents: title-like nodes in the N slots immediately
            # before the source.  They are the source's own section headers, not
            # reference targets, so we strip them from every window before the
            # LLM call.  We detect them by their typed role (section_header /
            # title / document_index) OR by being ALL-CAPS text (nodes that
            # should have been typed as headers but were misclassified).
            structural_parent_ids: set[str] = {
                nodes[j]['id']
                for j in range(max(0, i - IMPLICIT_DOC_WINDOW), i)
                if _is_title_node(nodes[j])
            }

            # Doc-order window: ±IMPLICIT_DOC_WINDOW nodes, excluding those
            # already in the positional windows (avoid duplication to LLM) and
            # structural parents.
            in_positional = {
                n['id']
                for bucket in positional_windows.values()
                for n in bucket
            }
            doc_order_window = [
                nodes[j]
                for j in range(
                    max(0, i - IMPLICIT_DOC_WINDOW),
                    min(len(nodes), i + IMPLICIT_DOC_WINDOW + 1),
                )
                if nodes[j]['id'] != source_id
                and nodes[j]['id'] not in in_positional
                and nodes[j]['id'] not in structural_parent_ids
            ]

            # Also strip structural parents from the positional windows.
            positional_windows = {
                direction: [n for n in bucket if n['id'] not in structural_parent_ids]
                for direction, bucket in positional_windows.items()
            }

            llm_ids = resolve_implicit_refs_with_llm(
                node, implicit_keywords, positional_windows, doc_order_window
            )
            for tid in llm_ids:
                _add_edge(source_id, tid, 'implicit')

    return edges


# ---------------------------------------------------------------------------
# Step 7 — Save graph
# ---------------------------------------------------------------------------

def save_graph(edges: list[dict], input_file: str) -> str:
    output_file = input_file.replace('.json', '_graph.json')
    doc_id = Path(input_file).stem
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump({'document_id': doc_id, 'edges': edges}, f, indent=2, ensure_ascii=False)
    return output_file


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def process_document(input_file: str) -> None:
    with open(input_file, encoding='utf-8') as f:
        nodes: list[dict] = json.load(f)

    print(f'Loaded {len(nodes)} nodes from {input_file}')

    title_index = build_title_index(nodes)
    print(f'Title index: {len(title_index)} keys')

    candidates = [n for n in nodes if has_potential_reference(n, None)]
    print(f'Nodes with potential references: {len(candidates)} / {len(nodes)}')
    for n in candidates[:10]:
        print(f'  [{n["id"]}] {_get_node_text(n)[:80]}')

    edges = build_reference_edges(nodes)
    print(f'Built {len(edges)} reference edges')

    output_path = save_graph(edges, input_file)
    print(f'Graph saved to: {output_path}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        default = (
            Path(__file__).parent
            / 'storage'
            / 'documents'
            / 'SPC-50S-SPC75-Close-Coupled-Pulper.json'
        )
        target = str(default)
    else:
        target = sys.argv[1]

    process_document(target)
