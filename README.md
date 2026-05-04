<div align="center">
  <img src="media/glaucias_logo.png" alt="Glaucias" width="400" />
  <h1>Glaucias</h1>
  <p>A platform for turning PDFs into structured, searchable knowledge.</p>
</div>

---

## Table of Contents

- [What is it](#what-is-it)
- [How it works](#how-it-works)
- [The main flows](#the-main-flows)
  - [1. Document extraction](#1-document-extraction)
  - [2. Reference graph](#2-reference-graph)
  - [3. Search within a document](#3-search-within-a-document)
  - [4. Chat across multiple documents](#4-chat-across-multiple-documents)
- [Screenshots](#screenshots)
- [Demo](#demo)
- [Deploy](#deploy)
  - [Docker](#docker)
  - [Helm (Kubernetes)](#helm-kubernetes)
- [Setup](#setup)
- [Stack](#stack)

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
    G --> H[Content is embedded]
    H --> I[Stored in Qdrant]
```

---

### 2. Reference graph

After extraction, Glaucias goes through the document and finds references between nodes. There are two kinds:

**Explicit** references are things like "Figure 3", "Table 1", "Section 4.2". These are found with pattern matching.

**Implicit** references are things like "as mentioned above" or "the following example". These are resolved by an LLM that reads the context and figures out what is being pointed to.

**Custom keywords** can be provided at upload time to catch author-specific phrasing that the built-in patterns would miss — things like "per the methodology" or "as noted earlier". Any node containing a custom keyword is treated the same as an implicit reference and sent to the LLM for target resolution.

```mermaid
flowchart TD
    A[Document Nodes] --> B[Explicit Detection]
    A --> C[Implicit Detection]
    A --> K[Custom Keywords]
    B --> D["Regex patterns\nFigure X, Table Y, Section Z"]
    C --> E["LLM resolution\nanaphoric + positional references"]
    K --> E
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


<img src="media/upload-photo.png" alt="Upload" width="100%" />

<img src="media/document-view.png" alt="Upload" width="100%" />

<img src="media/chat-view.png" alt="Upload" width="100%" />

---

## Demo

<video src="https://github.com/user-attachments/assets/bc0a6b21-1dd7-4e05-b2b8-460adff7108d" controls width="100%"></video>
---

## Deploy

### Docker

**Run a pre-built image:**

```bash
docker run -d \
  --name glaucias \
  -p 5000:5000 \
  -e VLM_API_KEY=your_openai_key \
  -e VLM_MODEL=gpt-4o \
  -e EMBEDDING_MODEL=openai/text-embedding-3-large \
  -v glaucias-qdrant:/app/qdrant_storage \
  -v glaucias-storage:/app/storage \
  YOUR_REGISTRY/glaucias:latest
```

Open `http://localhost:5000`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `VLM_API_KEY` | yes | — | OpenAI API key |
| `VLM_BASE_URL` | no | — | OpenAI-compatible API base URL |
| `VLM_MODEL` | no | `gpt-4o` | LLM model for graph building and chat |
| `EMBEDDING_MODEL` | no | `openai/text-embedding-3-large` | Embedding model |
| `MAX_UPLOAD_MB` | no | `200` | Max upload size in MB |

**Build from source:**

```bash
docker build -t glaucias .

docker run -d \
  --name glaucias \
  -p 5000:5000 \
  -e VLM_API_KEY=your_openai_key \
  -v glaucias-qdrant:/app/qdrant_storage \
  -v glaucias-storage:/app/storage \
  glaucias
```

**docker-compose:**

```bash
cp backend/.example.env backend/.env
# fill in VLM_API_KEY and other values in backend/.env
docker compose up -d
```

> The first startup can take a minute while ML models are downloaded and initialised.


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
