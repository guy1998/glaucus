<div align="center">
  <img src="media/glaucias_logo.png" alt="Glaucias" width="400" style="border-radius: 50%;" />
  <h1>Glaucias</h1>
  <p>A platform for turning PDFs into structured, searchable knowledge.</p>
</div>

---

## What is it

Glaucias is an open source RAG platform. The core idea is that most RAG pipelines treat documents as flat chunks of text, which loses a lot of the structure that is actually in the document. Glaucias parses PDFs and keeps that structure intact, sections, subsections, tables, figures, and the references between them.

It also finds the connections between parts of a document. Things like "as shown in Figure 3" or "refer to Section 2.1" are resolved into actual graph edges. This means when you query the document, the retrieval can follow those connections instead of just returning the closest text chunks.

---

## How it works

```mermaid
flowchart LR
    A[Upload PDF] --> B[Extract Structure]
    B --> C[Build Reference Graph]
    C --> D[Embed Nodes]
    D --> E[Search or Chat]
```

---

## The main flows

### 1. Document extraction

When you upload a PDF, Glaucias breaks it down into nodes. Each node is a piece of the document: a section, a paragraph, a table, a figure. The structure is preserved so you can see exactly how the document is organized.

```mermaid
flowchart TD
    A[PDF Upload] --> B[Docling Parser]
    B --> C{Node Types}
    C --> D[Sections & Paragraphs]
    C --> E[Tables]
    C --> F[Figures & Images]
    D & E & F --> G[Structured JSON]
    G --> H[Stored in Qdrant]
```

---

### 2. Reference graph

After extraction, Glaucias goes through the document and finds references between nodes. There are two kinds:

**Explicit** references are things like "Figure 3", "Table 1", "Section 4.2". These are found with pattern matching.

**Implicit** references are things like "as mentioned above" or "the following example". These are resolved by an LLM that reads the context and figures out what is being pointed to.

```mermaid
flowchart TD
    A[Document Nodes] --> B[Explicit Detection]
    A --> C[Implicit Detection]
    B --> D["Regex patterns\nFigure X, Table Y, Section Z"]
    C --> E["LLM resolution\nanaphoric + positional references"]
    D & E --> F[Reference Edges]
    F --> G[Knowledge Graph]
```

You can also add or remove edges manually in the UI.

---

### 3. Search within a document

When you query a document, Glaucias does a vector search over the nodes. It then expands the results by following the reference graph, so if the most relevant node references a figure or another section, those are pulled in too.

```mermaid
flowchart LR
    A[Query] --> B[Vector Search]
    B --> C[Top Nodes]
    C --> D[Graph Expansion]
    D --> E["Forward edges\nwhat this node references"]
    D --> F["Reverse edges\nwhat references this node"]
    E & F --> G[Final Context]
    G --> H[Answer]
```

---

### 4. Chat across multiple documents

The chat feature lets you talk to multiple documents at once. When you ask a question, the system first figures out which documents are relevant to the query, then retrieves from those and generates a streamed response with citations.

```mermaid
flowchart TD
    A[User Question] --> B[Query Expansion]
    B --> C[Source Router]
    C --> D{Which data sources?}
    D --> E[Source A]
    D --> F[Source B]
    D --> G[Source N]
    E & F & G --> H[Retrieve from each]
    H --> I[Merge context]
    I --> J[Stream response with citations]
```

---

## Screenshots

> TODO: Add a screenshot of the document view here

<!-- ![Document View](media/screenshot_document.png) -->

> TODO: Add a screenshot of the reference graph here

<!-- ![Reference Graph](media/screenshot_graph.png) -->

> TODO: Add a screenshot of the chat interface here

<!-- ![Chat](media/screenshot_chat.png) -->

---

## Demo

> TODO: Add a demo video here

<!-- [![Demo](media/demo_thumbnail.png)](media/demo.mp4) -->

---

## Setup

### Backend

```bash
cd backend
pip install -r requirements.txt
cp .example.env .env
# fill in your API keys in .env
python api.py
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

---

## Stack

**Backend** — Python, Flask, Docling, Qdrant, LangChain, OpenAI API

**Frontend** — React, Vite, TailwindCSS

**Storage** — Qdrant for vectors, JSON files for metadata and graphs
