import { useState, useRef, useEffect } from 'react'
import { Search, X, Loader2, FileText, AlertCircle, ChevronRight } from 'lucide-react'
import { queryDocument } from '../api'

function ScoreBadge({ score }) {
  const pct = Math.round((score ?? 0) * 100)
  const color = pct >= 80 ? 'text-emerald-600 bg-emerald-50' : pct >= 60 ? 'text-gold-700 bg-gold-50' : 'text-zinc-500 bg-zinc-100'
  return (
    <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${color}`}>
      {pct}%
    </span>
  )
}

export default function QueryPanel({ docId, onClose, onNodeClick, activeNodeId }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  async function handleSearch(e) {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    setResults(null)
    try {
      const data = await queryDocument(docId, q)
      setResults(data.nodes)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function handleNodeClick(nodeId) {
    onNodeClick(nodeId)
  }

  return (
    <div className="animate-slide-up fixed bottom-0 left-64 right-0 z-40 flex flex-col bg-white border-t border-zinc-200 shadow-2xl shadow-zinc-900/10"
      style={{ maxHeight: '60vh' }}>
      {/* Handle bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-100">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-gold-500" />
          <span className="text-sm font-semibold text-zinc-700">Semantic Search</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Search input */}
      <form onSubmit={handleSearch} className="px-6 py-4 border-b border-zinc-100">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Ask anything about this document…"
              className="w-full pl-9 pr-4 py-2.5 text-sm border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-300 placeholder-zinc-400 transition"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="px-5 py-2.5 bg-gold-500 hover:bg-gold-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-all duration-150 flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
          </button>
        </div>
      </form>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="flex items-start gap-2.5 m-4 text-red-600 bg-red-50 rounded-xl px-4 py-3">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {results && results.length === 0 && (
          <div className="flex flex-col items-center py-10 text-zinc-400">
            <Search className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">No matching nodes found.</p>
          </div>
        )}

        {results && results.length > 0 && (
          <div className="divide-y divide-zinc-100">
            {results.map((node, i) => (
              <button
                key={node.node_id ?? i}
                onClick={() => handleNodeClick(node.node_id)}
                className={`w-full flex items-start gap-4 px-6 py-4 text-left transition-colors group ${
                  activeNodeId === node.node_id
                    ? 'bg-gold-50 border-l-2 border-gold-400'
                    : 'hover:bg-gold-50'
                }`}
              >
                <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-gold-100 flex items-center justify-center">
                  <FileText className="w-3.5 h-3.5 text-gold-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-medium text-zinc-400 uppercase tracking-wide">
                      {node.node_type?.replace('_', ' ')}
                    </span>
                    {node.page != null && (
                      <span className="text-[11px] text-zinc-300">· p.{node.page}</span>
                    )}
                    {node.score != null && <ScoreBadge score={node.score} />}
                  </div>
                  <p className="text-sm text-zinc-700 line-clamp-3 leading-relaxed">
                    {(node.text || node.picture_desc || '').replace(/\s+/g, ' ')}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-zinc-300 group-hover:text-gold-400 flex-shrink-0 mt-1 transition-colors" />
              </button>
            ))}
          </div>
        )}

        {!loading && !results && !error && (
          <div className="flex flex-col items-center py-10 text-zinc-300">
            <Search className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">Search by meaning, not just keywords.</p>
          </div>
        )}
      </div>
    </div>
  )
}
