import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Search, Loader2, AlertCircle, PanelRight, PanelRightClose, Download, Zap } from 'lucide-react'
import { getDocument, embedDocumentAsync, openStream } from '../api'
import MarkdownPane from '../components/MarkdownPane'
import JsonTree from '../components/JsonTree'
import QueryPanel from '../components/QueryPanel'

export default function DocumentPage() {
  const { docId } = useParams()
  const [doc, setDoc] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeNodeId, setActiveNodeId] = useState(null)
  const [scrollNodeId, setScrollNodeId] = useState(null)
  const [queryOpen, setQueryOpen] = useState(false)
  const [treeOpen, setTreeOpen] = useState(true)
  const [embedding, setEmbedding] = useState(false)
  const [embedded, setEmbedded] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setDoc(null)
    setActiveNodeId(null)
    setQueryOpen(false)
    setEmbedded(null)

    getDocument(docId)
      .then(d => { setDoc(d); setEmbedded(d.embedded) })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [docId])

  async function handleEmbed() {
    setEmbedding(true)
    try {
      const { job_id } = await embedDocumentAsync(docId)
      await new Promise((resolve, reject) => {
        const es = openStream(job_id)
        es.onmessage = ev => {
          const event = JSON.parse(ev.data)
          if (event.type === 'complete') { es.close(); resolve() }
          if (event.type === 'error') { es.close(); reject(new Error(event.message)) }
        }
        es.onerror = () => { es.close(); reject(new Error('Stream failed')) }
      })
      setEmbedded(true)
    } catch (err) {
      console.error('Embed failed:', err)
    } finally {
      setEmbedding(false)
    }
  }

  function handleNodeClick(nodeId) {
    setActiveNodeId(nodeId)
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-zinc-400">
        <Loader2 className="w-8 h-8 animate-spin text-gold-400" />
        <p className="text-sm">Loading document…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-red-500">
        <AlertCircle className="w-8 h-8" />
        <p className="text-sm font-medium">{error}</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header bar */}
      <header className="flex-shrink-0 flex items-center justify-between px-6 py-3 bg-white border-b border-zinc-200 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-2 h-2 rounded-full bg-gold-400 flex-shrink-0" />
          <h1 className="text-sm font-semibold text-zinc-800 truncate">{docId}</h1>
          {doc && (
            <span className="hidden sm:inline text-xs text-zinc-400 flex-shrink-0">
              {doc.nodes?.length ?? 0} nodes
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {embedded === false ? (
            <button
              onClick={handleEmbed}
              disabled={embedding}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {embedding
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Zap className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{embedding ? 'Embedding…' : 'Embed'}</span>
            </button>
          ) : (
            <button
              onClick={() => setQueryOpen(q => !q)}
              disabled={embedded === null}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                queryOpen
                  ? 'bg-gold-500 text-white shadow-sm'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-gold-50 hover:text-gold-700'
              }`}
            >
              <Search className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Query</span>
            </button>
          )}

          {doc && (
            <>
              <button
                onClick={() => downloadBlob(doc.markdown, `${docId}.md`, 'text/markdown')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-zinc-100 text-zinc-600 hover:bg-zinc-200 transition-colors"
                title="Export Markdown"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">MD</span>
              </button>
              <button
                onClick={() => downloadBlob(JSON.stringify(doc.nodes, null, 2), `${docId}.json`, 'application/json')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-zinc-100 text-zinc-600 hover:bg-zinc-200 transition-colors"
                title="Export JSON"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">JSON</span>
              </button>
            </>
          )}

          <button
            onClick={() => setTreeOpen(t => !t)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
            title={treeOpen ? 'Hide structure' : 'Show structure'}
          >
            {treeOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Content — split pane */}
      <div className="flex-1 flex overflow-hidden">
        {/* Markdown pane */}
        <div className="flex-1 overflow-hidden">
          <MarkdownPane
            markdown={doc?.markdown}
            activeNodeId={activeNodeId}
            scrollToNodeId={scrollNodeId}
            onNodeClick={handleNodeClick}
          />
        </div>

        {/* JSON / Structure pane */}
        {treeOpen && (
          <div className="w-80 xl:w-96 flex-shrink-0 overflow-hidden transition-all duration-200 animate-slide-down">
            <JsonTree
              docId={docId}
              nodes={doc?.nodes}
              activeNodeId={activeNodeId}
              onNodeClick={handleNodeClick}
              onConnectionNavigate={setScrollNodeId}
            />
          </div>
        )}
      </div>

      {/* Query panel (slide-up overlay) */}
      {queryOpen && (
        <QueryPanel
          docId={docId}
          onClose={() => setQueryOpen(false)}
          onNodeClick={handleNodeClick}
          activeNodeId={activeNodeId}
        />
      )}
    </div>
  )
}
