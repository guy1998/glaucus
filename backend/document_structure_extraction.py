from docling.document_converter import DocumentConverter, InputFormat, PdfFormatOption
from docling.datamodel.pipeline_options import PdfPipelineOptions, PictureDescriptionApiOptions
from docling_core.types.doc import DocItem, TextItem, PictureItem, TableItem
from docling_core.types.doc import DescriptionAnnotation
from docling_core.types.doc.document import ListGroup, ListItem
from pathlib import Path
from dotenv import load_dotenv
from pypdf import PdfReader, PdfWriter
import os
import json
import shutil
import tempfile

load_dotenv(Path(__file__).parent / ".env")

INPUT_FILE = "./test_data/SPC-50S-SPC75-Close-Coupled-Pulper.pdf"
OUTPUT_DIR = Path(__file__).parent / "storage" / "documents"
IMAGES_DIR = OUTPUT_DIR / "images"
PAGES_PER_CHUNK = 10

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
IMAGES_DIR.mkdir(parents=True, exist_ok=True)


def parse_document(file_path: str):
    """
    Parse document using Docling.
    Picture description is delegated to an external OpenAI-compatible API
    (configured via .env) so no VLM model is loaded in-process, avoiding the
    Windows OOM/access-violation crash from inline PyTorch inference.
    """
    base_url = os.environ["VLM_BASE_URL"].rstrip("/")
    api_key  = os.environ["VLM_API_KEY"]
    model    = os.environ["VLM_MODEL"]

    picture_description_options = PictureDescriptionApiOptions(
        url=f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        params={"model": model},
        prompt=(
            "You are analyzing a figure from a technical engineering document.\n\n"
            "Return your response as a JSON object with exactly two keys:\n"
            "1. \"description\": A plain-text description of what is shown, including "
            "labels, flow directions, components, measurements, and any text visible "
            "in the image.\n"
            "2. \"references\": A list of strings for every explicit reference found "
            "in or around the image — including figure numbers (e.g. \"Figure 3\"), "
            "table numbers (e.g. \"Table 2\"), section references (e.g. \"Section 4.1\"), "
            "page references (e.g. \"page 12\"), and any cross-reference text visible "
            "in the image or its caption. Return an empty list if none are found.\n\n"
            "Example output:\n"
            "{\"description\": \"Piping diagram showing inlet and outlet valves with "
            "flow direction arrows. Pressure rating label reads 150 PSI.\", "
            "\"references\": [\"Figure 3\", \"Section 4.2\", \"Table 1\"]}\n\n"
            "Return only the JSON object with no additional text."
        ),
        timeout=60.0,
        concurrency=1,
    )
    pipeline_options = PdfPipelineOptions(
        generate_page_images=False,
        generate_picture_images=True,
        images_scale=1.0,
        do_picture_description=True,
        do_picture_classification=False,  # local ML model — disabled to avoid in-process crash
        enable_remote_services=True,
        picture_description_options=picture_description_options,
    )
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
    )
    result = converter.convert(file_path)
    return result.document


def generate_stable_id(doc_name: str, element_type: str, index: int):
    return f"{doc_name}_{element_type}_{index:05d}"


def _extract_picture_knowledge(element: PictureItem, doc, node_id: str, doc_name: str) -> dict:
    """Save image crop and pull VLM description + classification from annotations."""
    image_path = None
    img = element.get_image(doc)
    if img is not None:
        doc_images_dir = IMAGES_DIR / doc_name
        doc_images_dir.mkdir(parents=True, exist_ok=True)
        image_file = doc_images_dir / f"{node_id}.png"
        img.save(image_file, format="PNG")
        image_path = str(image_file)
        del img

    description = None
    references: list[str] = []
    for ann in element.annotations:
        if isinstance(ann, DescriptionAnnotation):
            raw = ann.text or ""
            # Strip markdown code fences that some VLMs wrap around JSON responses
            candidate = raw.strip()
            if candidate.startswith("```"):
                lines = candidate.splitlines()
                end = len(lines) - 1
                while end > 0 and not lines[end].strip():
                    end -= 1
                if lines[end].strip() == "```":
                    candidate = "\n".join(lines[1:end]).strip()
            try:
                parsed = json.loads(candidate)
                description = parsed.get("description")
                references = parsed.get("references", [])
                if not isinstance(references, list):
                    references = []
            except (json.JSONDecodeError, AttributeError):
                # VLM did not return valid JSON — treat entire response as description
                description = raw
            break

    return {
        "image_path": image_path,
        "description": description,
        "references": references,
    }


def split_pdf(input_path: str, pages_per_chunk: int, tmp_dir: str) -> list[tuple[str, int]]:
    """
    Split a PDF into page-range chunks written to tmp_dir.
    Returns a list of (chunk_path, page_offset) tuples in document order.
    page_offset is the number of pages that precede this chunk in the original,
    so that page numbers can be restored when merging.
    """
    reader = PdfReader(input_path)
    total = len(reader.pages)
    chunks = []
    for start in range(0, total, pages_per_chunk):
        end = min(start + pages_per_chunk, total)
        writer = PdfWriter()
        for page in reader.pages[start:end]:
            writer.add_page(page)
        chunk_path = os.path.join(tmp_dir, f"chunk_{start:05d}.pdf")
        with open(chunk_path, "wb") as f:
            writer.write(f)
        chunks.append((chunk_path, start))
    return chunks


def _flush_list(list_items: list[tuple], doc_name: str, node_counter: int, page_offset: int) -> dict:
    """Combine accumulated list items into a single node."""
    lines = []
    first_prov = None
    for item, prov in list_items:
        if first_prov is None:
            first_prov = prov
        lines.append(f"{item.marker} {item.text}")
    raw_page = first_prov.page_no if first_prov else None
    adjusted_page = (raw_page + page_offset) if raw_page is not None else None
    return {
        "id": generate_stable_id(doc_name=doc_name, element_type="list", index=node_counter),
        "type": "list",
        "text": "\n".join(lines),
        "metadata": {
            "page": adjusted_page,
            "bbox": first_prov.bbox.model_dump() if first_prov else None,
        },
        "picture": None,
    }


def assign_ids(doc, doc_name: str, node_counter_start: int = 0, page_offset: int = 0):
    """
    Assign stable IDs to all elements in doc.
    - doc_name: canonical document stem (original file, not chunk temp name).
    - node_counter_start: global counter value to start from, so IDs stay
      unique and ordered across chunks.
    - page_offset: pages preceding this chunk in the original PDF, added to
      each node's page number so the merged output has correct page numbers.
    Returns (nodes, next_counter_value).
    """
    node_counter = node_counter_start
    structured_nodes = []

    # (ListItem, prov) pairs accumulated while inside a ListGroup
    pending_list: list[tuple] = []
    list_group_level: int | None = None

    for element, level in doc.iterate_items(with_groups=True):
        # Detect end of list group: we've stepped back to or above the group's level
        if list_group_level is not None and level <= list_group_level:
            if pending_list:
                node = _flush_list(pending_list, doc_name, node_counter, page_offset)
                structured_nodes.append(node)
                node_counter += 1
            pending_list = []
            list_group_level = None

        if isinstance(element, ListGroup):
            list_group_level = level
            continue

        if list_group_level is not None and isinstance(element, ListItem):
            prov = element.prov[0] if element.prov else None
            pending_list.append((element, prov))
            continue

        if not isinstance(element, DocItem):
            continue

        element_type = element.label.value
        node_id = generate_stable_id(
            doc_name=doc_name,
            element_type=element_type,
            index=node_counter,
        )

        prov = element.prov[0] if element.prov else None

        picture_knowledge = (
            _extract_picture_knowledge(element, doc, node_id, doc_name)
            if isinstance(element, PictureItem)
            else None
        )

        raw_page = prov.page_no if prov else None
        adjusted_page = (raw_page + page_offset) if raw_page is not None else None

        if isinstance(element, TextItem):
            text = element.text
        elif isinstance(element, TableItem):
            text = element.export_to_markdown()
        else:
            text = None

        metadata = {
            "page": adjusted_page,
            "bbox": prov.bbox.model_dump() if prov else None,
        }
        if element_type == "section_header":
            metadata["heading_level"] = getattr(element, "level", 2)

        node_data = {
            "id": node_id,
            "type": element_type,
            "text": text,
            "metadata": metadata,
            "picture": picture_knowledge,
        }
        structured_nodes.append(node_data)
        node_counter += 1

    # Flush any list still open at end of document
    if pending_list:
        node = _flush_list(pending_list, doc_name, node_counter, page_offset)
        structured_nodes.append(node)
        node_counter += 1

    return structured_nodes, node_counter


def generate_markdown(nodes: list[dict], doc_name: str = "") -> str:
    """
    Build a Markdown document from structured nodes.
    Each node is wrapped in an HTML span with its JSON id so the frontend
    can scroll to or highlight any node by id.
    Images are included as <img> tags using paths relative to OUTPUT_DIR.
    """
    _heading_prefix = {1: "#", 2: "##", 3: "###", 4: "####", 5: "#####", 6: "######"}
    parts: list[str] = []

    for node in nodes:
        node_id = node["id"]
        node_type = node["type"]
        text = node.get("text") or ""
        picture = node.get("picture")

        anchor = f'<span id="{node_id}"></span>'

        if node_type == "title":
            parts.append(f"{anchor}\n# {text}")

        elif node_type == "section_header":
            level = node.get("metadata", {}).get("heading_level", 2)
            prefix = _heading_prefix.get(level, "##")
            parts.append(f"{anchor}\n{prefix} {text}")

        elif node_type == "picture":
            img_lines = [anchor]
            if picture and picture.get("image_path"):
                rel_path = f"images/{doc_name}/{node_id}.png" if doc_name else f"images/{node_id}.png"
                desc = picture.get("description") or ""
                # Collapse to single line so the alt attribute and italic caption stay valid markdown
                alt = " ".join(desc.splitlines()).replace('"', "'")
                img_lines.append(f'<img src="{rel_path}" alt="{alt}" />')
            if picture and picture.get("description"):
                desc = picture["description"]
                caption = " ".join(desc.splitlines())
                img_lines.append(f"\n*{caption}*")
            parts.append("\n".join(img_lines))

        elif node_type == "table":
            parts.append(f"{anchor}\n{text}")

        elif node_type == "list":
            parts.append(f"{anchor}\n{text}")

        elif node_type == "caption":
            parts.append(f"{anchor}\n*{text}*")

        elif node_type == "code":
            parts.append(f"{anchor}\n```\n{text}\n```")

        elif node_type == "formula":
            parts.append(f"{anchor}\n$$\n{text}\n$$")

        elif node_type in ("page_header", "page_footer", "footnote"):
            parts.append(f"{anchor}\n<!-- {node_type}: {text} -->")

        elif text:
            parts.append(f"{anchor}\n{text}")

    return "\n\n".join(parts)


def save_document(doc_nodes, doc_id: str):
    output_file = OUTPUT_DIR / f"{doc_id}.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(doc_nodes, f, indent=2)


def save_markdown(md_content: str, doc_id: str):
    output_file = OUTPUT_DIR / f"{doc_id}.md"
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(md_content)


if __name__ == "__main__":
    input_path = INPUT_FILE
    doc_name = Path(input_path).stem
    all_nodes = []
    node_counter = 0

    tmp_dir = tempfile.mkdtemp(prefix="docling_chunks_")
    try:
        chunks = split_pdf(input_path, PAGES_PER_CHUNK, tmp_dir)
        print(f"Split into {len(chunks)} chunk(s) of up to {PAGES_PER_CHUNK} pages each.")

        for chunk_path, page_offset in chunks:
            print(f"Processing pages {page_offset + 1}–{page_offset + PAGES_PER_CHUNK} ...")
            doc = parse_document(chunk_path)
            nodes, node_counter = assign_ids(
                doc,
                doc_name=doc_name,
                node_counter_start=node_counter,
                page_offset=page_offset,
            )
            del doc
            all_nodes.extend(nodes)
            print(f"  → {len(nodes)} nodes (running total: {len(all_nodes)})")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    save_document(all_nodes, doc_name)
    md_content = generate_markdown(all_nodes)
    save_markdown(md_content, doc_name)
    print(f"Done. {len(all_nodes)} total nodes saved. JSON + Markdown written to {OUTPUT_DIR}.")