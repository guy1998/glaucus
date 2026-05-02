const BASE = '/api'

export async function listDocuments() {
  const res = await fetch(`${BASE}/documents`)
  if (!res.ok) throw new Error('Failed to list documents')
  return res.json()
}

export async function getDocument(docId) {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(docId)}`)
  if (!res.ok) throw new Error(`Document "${docId}" not found`)
  return res.json()
}

export async function uploadDocument(file, keywords = []) {
  const form = new FormData()
  form.append('file', file)
  if (keywords.length > 0) form.append('keywords', keywords.join(','))
  const res = await fetch(`${BASE}/documents/upload`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Upload failed')
  }
  return res.json()
}

export async function queryDocument(docId, query, topK = 6) {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(docId)}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: topK }),
  })
  if (!res.ok) throw new Error('Query failed')
  return res.json()
}

export async function deleteDocument(docId) {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(docId)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Delete failed')
  return res.json()
}

export async function getNodeConnections(docId, nodeId) {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(docId)}/nodes/${encodeURIComponent(nodeId)}/connections`)
  if (!res.ok) throw new Error('Failed to load connections')
  return res.json()
}

export async function addEdge(docId, source, target, type = 'explicit') {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(docId)}/edges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target, type }),
  })
  if (!res.ok) throw new Error('Failed to add edge')
  return res.json()
}

export async function removeEdge(docId, source, target) {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(docId)}/edges`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target }),
  })
  if (!res.ok) throw new Error('Failed to remove edge')
  return res.json()
}

export async function embedDocumentAsync(docId) {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(docId)}/embed`, { method: 'POST' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Embed failed')
  }
  return res.json()
}

export function openStream(jobId) {
  return new EventSource(`${BASE}/documents/stream/${jobId}`)
}

export function imageUrl(nodeId) {
  return `${BASE}/documents/images/${nodeId}.png`
}

export async function listDataSources() {
  const res = await fetch(`${BASE}/data-sources`)
  if (!res.ok) throw new Error('Failed to list data sources')
  return res.json()
}

export async function createDataSource(name) {
  const res = await fetch(`${BASE}/data-sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error('Failed to create data source')
  return res.json()
}

export async function renameDataSource(sourceId, name) {
  const res = await fetch(`${BASE}/data-sources/${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error('Failed to rename data source')
  return res.json()
}

export async function updateDataSourceDescription(sourceId, description) {
  const res = await fetch(`${BASE}/data-sources/${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  })
  if (!res.ok) throw new Error('Failed to update description')
  return res.json()
}

export async function* streamChat(query, dataSourceId, history = []) {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, data_source_id: dataSourceId, history }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Chat stream failed')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { yield JSON.parse(line.slice(6)) } catch {}
      }
    }
  }
}

export async function deleteDataSource(sourceId) {
  const res = await fetch(`${BASE}/data-sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete data source')
  return res.json()
}

export async function assignDocToDataSource(docId, sourceId) {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(docId)}/data-source`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId }),
  })
  if (!res.ok) throw new Error('Failed to assign data source')
  return res.json()
}
