import { useState, useEffect } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { FileText, Plus, Trash2, Loader2 } from 'lucide-react'
import { listDocuments, deleteDocument } from '../api'

export default function Sidebar({ onUpload, refreshKey }) {
  const { docId } = useParams()
  const navigate = useNavigate()
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState(null)

  useEffect(() => {
    setLoading(true)
    listDocuments()
      .then(d => setDocs(d.documents ?? []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [refreshKey])

  async function handleDelete(id, e) {
    e.preventDefault()
    e.stopPropagation()
    if (!window.confirm(`Delete "${id}"? This cannot be undone.`)) return
    setDeletingId(id)
    try {
      await deleteDocument(id)
      setDocs(prev => prev.filter(d => d.doc_id !== id))
      if (docId === id) navigate('/')
    } catch (err) {
      console.error(err)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <aside className="w-64 flex-shrink-0 bg-zinc-950 flex flex-col h-screen border-r border-zinc-800">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-zinc-800/80">
        <Link to="/" className="flex items-center gap-3 group">
          <div className="w-8 h-8 bg-gradient-to-br from-gold-400 to-gold-600 rounded-lg flex items-center justify-center shadow-lg shadow-gold-900/30 flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 12 L8 2 L14 12 Z" fill="white" fillOpacity="0.9" />
              <path d="M4 12 L8 6 L12 12 Z" fill="white" fillOpacity="0.4" />
            </svg>
          </div>
          <div>
            <p className="text-white font-semibold text-[15px] leading-none tracking-tight">Glaucus</p>
            <p className="text-zinc-500 text-[11px] mt-0.5">Document Intelligence</p>
          </div>
        </Link>
      </div>

      {/* New Document */}
      <div className="px-3 py-3">
        <button
          onClick={onUpload}
          className="w-full flex items-center gap-2 px-3 py-2.5 bg-gold-500 hover:bg-gold-400 active:bg-gold-600 text-white rounded-lg font-medium text-sm transition-all duration-150 shadow-sm shadow-gold-900/20"
        >
          <Plus className="w-4 h-4" />
          New Document
        </button>
      </div>

      {/* Document list */}
      <nav className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
        {!loading && docs.length === 0 && (
          <p className="text-zinc-600 text-xs text-center px-4 pt-6 leading-relaxed">
            No documents yet.<br />Upload a PDF to get started.
          </p>
        )}
        {loading && (
          <div className="flex justify-center pt-6">
            <Loader2 className="w-4 h-4 text-zinc-600 animate-spin" />
          </div>
        )}
        {!loading && docs.length > 0 && (
          <>
            <p className="text-zinc-600 text-[10px] font-semibold uppercase tracking-widest px-2 py-2">
              Documents
            </p>
            {docs.map(doc => {
              const active = docId === doc.doc_id
              return (
                <Link
                  key={doc.doc_id}
                  to={`/documents/${doc.doc_id}`}
                  className={`group flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all duration-150 ${
                    active
                      ? 'bg-zinc-800 text-white'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                  }`}
                >
                  <FileText
                    className={`w-3.5 h-3.5 flex-shrink-0 transition-colors ${
                      active ? 'text-gold-400' : 'text-zinc-600 group-hover:text-zinc-500'
                    }`}
                  />
                  <span className="flex-1 text-[13px] truncate font-medium">
                    {doc.doc_id}
                  </span>
                  {deletingId === doc.doc_id ? (
                    <Loader2 className="w-3 h-3 text-zinc-600 animate-spin flex-shrink-0" />
                  ) : (
                    <button
                      onClick={e => handleDelete(doc.doc_id, e)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-600 hover:text-red-400 transition-all duration-100 flex-shrink-0"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </Link>
              )
            })}
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-zinc-800/80">
        <p className="text-zinc-600 text-[11px]">Claude · Qdrant · Docling</p>
      </div>
    </aside>
  )
}
