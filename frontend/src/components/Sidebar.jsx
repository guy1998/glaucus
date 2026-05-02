import { useState, useEffect, useRef } from 'react'
import glaucusLogo from '../images/glaucias_logo-cropped.png'
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom'
import {
  FileText, Plus, Trash2, Loader2, Pencil, Check, X,
  FolderOpen, Folder, ChevronRight, ChevronDown, FolderInput,
  MessageSquare, AlignLeft, Zap,
} from 'lucide-react'
import {
  listDocuments, deleteDocument,
  listDataSources, createDataSource, renameDataSource,
  deleteDataSource, assignDocToDataSource, updateDataSourceDescription,
  embedDocumentAsync, openStream,
} from '../api'

export default function Sidebar({ onUpload, refreshKey }) {
  const { docId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const onChatPage = location.pathname === '/chat'

  const [docs, setDocs] = useState([])
  const [sources, setSources] = useState([])
  const [assignments, setAssignments] = useState({})
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState(null)
  const [embeddingIds, setEmbeddingIds] = useState(new Set())

  // New source creation
  const [creatingSource, setCreatingSource] = useState(false)
  const [newSourceName, setNewSourceName] = useState('')
  const newSourceInputRef = useRef(null)

  // Source rename
  const [editingSourceId, setEditingSourceId] = useState(null)
  const [editingSourceName, setEditingSourceName] = useState('')
  const editSourceInputRef = useRef(null)

  // Assign dropdown (fixed-position to avoid scroll-container clipping)
  const [assignDropdownDocId, setAssignDropdownDocId] = useState(null)
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 })
  const dropdownRef = useRef(null)

  // Collapsed data source sections
  const [collapsedSources, setCollapsedSources] = useState({})

  // Description editing (inline, per source)
  const [editingDescId, setEditingDescId] = useState(null)
  const [editingDescText, setEditingDescText] = useState('')
  const descInputRef = useRef(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([listDocuments(), listDataSources()])
      .then(([docsData, sourcesData]) => {
        setDocs(docsData.documents ?? [])
        setSources(sourcesData.sources ?? [])
        setAssignments(sourcesData.assignments ?? {})
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [refreshKey])

  useEffect(() => {
    if (creatingSource && newSourceInputRef.current) newSourceInputRef.current.focus()
  }, [creatingSource])

  useEffect(() => {
    if (editingSourceId && editSourceInputRef.current) editSourceInputRef.current.focus()
  }, [editingSourceId])

  useEffect(() => {
    if (editingDescId && descInputRef.current) descInputRef.current.focus()
  }, [editingDescId])

  // Close assign dropdown on outside click
  useEffect(() => {
    if (!assignDropdownDocId) return
    function onOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setAssignDropdownDocId(null)
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [assignDropdownDocId])

  // Group docs by source
  const docsBySource = {}
  sources.forEach(s => { docsBySource[s.id] = [] })
  const unassigned = []
  docs.forEach(doc => {
    const sid = assignments[doc.doc_id]
    if (sid && docsBySource[sid] !== undefined) docsBySource[sid].push(doc)
    else unassigned.push(doc)
  })

  async function handleDeleteDoc(id, e) {
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

  async function handleEmbedDoc(docId, e) {
    e.preventDefault()
    e.stopPropagation()
    setEmbeddingIds(prev => new Set([...prev, docId]))
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
      const [docsData, sourcesData] = await Promise.all([listDocuments(), listDataSources()])
      setDocs(docsData.documents ?? [])
      setSources(sourcesData.sources ?? [])
      setAssignments(sourcesData.assignments ?? {})
    } catch (err) {
      console.error('Embed failed:', err)
    } finally {
      setEmbeddingIds(prev => { const next = new Set(prev); next.delete(docId); return next })
    }
  }

  async function handleCreateSource() {
    const name = newSourceName.trim()
    setCreatingSource(false)
    setNewSourceName('')
    if (!name) return
    try {
      const { source } = await createDataSource(name)
      setSources(prev => [...prev, source])
    } catch (err) {
      console.error(err)
    }
  }

  function startRenameSource(source) {
    setEditingSourceId(source.id)
    setEditingSourceName(source.name)
  }

  async function handleRenameSource(sourceId) {
    const name = editingSourceName.trim()
    setEditingSourceId(null)
    if (!name) return
    try {
      const { source } = await renameDataSource(sourceId, name)
      setSources(prev => prev.map(s => s.id === sourceId ? source : s))
    } catch (err) {
      console.error(err)
    }
  }

  async function handleDeleteSource(sourceId, e) {
    e.stopPropagation()
    if (!window.confirm('Delete this data source? Documents will become unassigned.')) return
    try {
      await deleteDataSource(sourceId)
      setSources(prev => prev.filter(s => s.id !== sourceId))
      setAssignments(prev => {
        const next = { ...prev }
        Object.keys(next).forEach(k => { if (next[k] === sourceId) delete next[k] })
        return next
      })
    } catch (err) {
      console.error(err)
    }
  }

  function openAssignDropdown(docId, e) {
    e.preventDefault()
    e.stopPropagation()
    if (assignDropdownDocId === docId) { setAssignDropdownDocId(null); return }
    const rect = e.currentTarget.getBoundingClientRect()
    const dropW = 200
    const left = Math.min(rect.left, window.innerWidth - dropW - 8)
    setDropdownPos({ top: rect.bottom + 4, left: Math.max(8, left) })
    setAssignDropdownDocId(docId)
  }

  async function handleAssignDoc(targetDocId, sourceId) {
    try {
      await assignDocToDataSource(targetDocId, sourceId)
      setAssignments(prev => {
        const next = { ...prev }
        if (sourceId === null) delete next[targetDocId]
        else next[targetDocId] = sourceId
        return next
      })
    } catch (err) {
      console.error(err)
    } finally {
      setAssignDropdownDocId(null)
    }
  }

  function toggleCollapse(sourceId) {
    setCollapsedSources(prev => ({ ...prev, [sourceId]: !prev[sourceId] }))
  }

  function startEditDesc(source) {
    setEditingDescId(source.id)
    setEditingDescText(source.description || '')
  }

  async function handleSaveDescription(sourceId) {
    const description = editingDescText.trim() || null
    setEditingDescId(null)
    try {
      const { source } = await updateDataSourceDescription(sourceId, description)
      setSources(prev => prev.map(s => s.id === sourceId ? source : s))
    } catch (err) {
      console.error(err)
    }
  }

  function DocItem({ doc }) {
    const active = docId === doc.doc_id
    const isEmbedding = embeddingIds.has(doc.doc_id)
    return (
      <Link
        to={`/documents/${doc.doc_id}`}
        className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all duration-150 ${
          active ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
        }`}
      >
        {isEmbedding
          ? <Loader2 className="w-3.5 h-3.5 flex-shrink-0 text-amber-400 animate-spin" />
          : <FileText className={`w-3.5 h-3.5 flex-shrink-0 ${
              active ? 'text-gold-400' : doc.embedded ? 'text-zinc-600 group-hover:text-zinc-500' : 'text-amber-500/70'
            }`} />
        }
        <span className="flex-1 text-[12px] truncate">{doc.doc_id}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          {!doc.embedded && !isEmbedding && (
            <button
              onClick={e => handleEmbedDoc(doc.doc_id, e)}
              className="p-0.5 rounded text-amber-500/70 hover:text-amber-400 transition-colors"
              title="Embed for search"
            >
              <Zap className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={e => openAssignDropdown(doc.doc_id, e)}
            className="p-0.5 rounded text-zinc-600 hover:text-blue-400 transition-colors"
            title="Assign to data source"
          >
            <FolderInput className="w-3 h-3" />
          </button>
          {deletingId === doc.doc_id ? (
            <Loader2 className="w-3 h-3 text-zinc-600 animate-spin" />
          ) : (
            <button
              onClick={e => handleDeleteDoc(doc.doc_id, e)}
              className="p-0.5 rounded text-zinc-600 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </Link>
    )
  }

  return (
    <aside className="w-64 flex-shrink-0 bg-zinc-950 flex flex-col h-screen border-r border-zinc-800">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-zinc-800/80">
        <Link to="/" className="flex items-center gap-3 group">
          <img src={glaucusLogo} alt="Glaucias" className="w-8 h-8 object-contain flex-shrink-0" />
          <div>
            <p className="text-white font-semibold text-[15px] leading-none tracking-tight">Glaucias</p>
            <p className="text-zinc-500 text-[11px] mt-0.5">Document Intelligence</p>
          </div>
        </Link>
      </div>

      {/* New Document + Chat */}
      <div className="px-3 py-3 space-y-1.5">
        <button
          onClick={onUpload}
          className="w-full flex items-center gap-2 px-3 py-2.5 bg-gold-500 hover:bg-gold-400 active:bg-gold-600 text-white rounded-lg font-medium text-sm transition-all duration-150 shadow-sm shadow-gold-900/20"
        >
          <Plus className="w-4 h-4" />
          New Document
        </button>
        <Link
          to="/chat"
          className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg font-medium text-sm transition-all duration-150 ${
            onChatPage
              ? 'bg-zinc-800 text-white'
              : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          Chat
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
        {loading && (
          <div className="flex justify-center pt-6">
            <Loader2 className="w-4 h-4 text-zinc-600 animate-spin" />
          </div>
        )}

        {!loading && docs.length === 0 && sources.length === 0 && (
          <p className="text-zinc-600 text-xs text-center px-4 pt-6 leading-relaxed">
            No documents yet.<br />Upload a PDF to get started.
          </p>
        )}

        {!loading && (
          <>
            {/* Data Sources header */}
            <div className="flex items-center justify-between px-2 pt-2 pb-1">
              <p className="text-zinc-600 text-[10px] font-semibold uppercase tracking-widest">Data Sources</p>
              <button
                onClick={() => { setCreatingSource(true); setNewSourceName('') }}
                className="p-0.5 rounded text-zinc-600 hover:text-zinc-400 transition-colors"
                title="New data source"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            {sources.length === 0 && !creatingSource && (
              <p className="text-zinc-700 text-[11px] px-3 pb-1">No data sources yet.</p>
            )}

            {/* Source groups */}
            {sources.map(source => {
              const sourceDocs = docsBySource[source.id] || []
              const isCollapsed = !!collapsedSources[source.id]
              const isEditing = editingSourceId === source.id

              return (
                <div key={source.id}>
                  <div className="group flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-zinc-900/50">
                    <button
                      onClick={() => toggleCollapse(source.id)}
                      className="text-zinc-600 flex-shrink-0"
                    >
                      {isCollapsed
                        ? <ChevronRight className="w-3 h-3" />
                        : <ChevronDown className="w-3 h-3" />
                      }
                    </button>
                    <FolderOpen className="w-3.5 h-3.5 text-gold-500/70 flex-shrink-0" />
                    {isEditing ? (
                      <input
                        ref={editSourceInputRef}
                        value={editingSourceName}
                        onChange={e => setEditingSourceName(e.target.value)}
                        onBlur={() => handleRenameSource(source.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleRenameSource(source.id)
                          if (e.key === 'Escape') setEditingSourceId(null)
                        }}
                        className="flex-1 bg-zinc-800 text-white text-[12px] px-1.5 py-0.5 rounded outline-none border border-zinc-600 min-w-0"
                      />
                    ) : (
                      <span
                        className="flex-1 text-zinc-300 text-[12px] font-medium truncate cursor-default"
                        onDoubleClick={() => startRenameSource(source)}
                      >
                        {source.name}
                      </span>
                    )}
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0">
                      <button
                        onClick={() => startEditDesc(source)}
                        className="p-0.5 rounded text-zinc-600 hover:text-blue-400 transition-colors"
                        title="Edit description"
                      >
                        <AlignLeft className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => startRenameSource(source)}
                        className="p-0.5 rounded text-zinc-600 hover:text-zinc-400 transition-colors"
                        title="Rename"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={e => handleDeleteSource(source.id, e)}
                        className="p-0.5 rounded text-zinc-600 hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {/* Description row */}
                  {editingDescId === source.id ? (
                    <div className="ml-5 px-2 pb-1">
                      <input
                        ref={descInputRef}
                        value={editingDescText}
                        onChange={e => setEditingDescText(e.target.value)}
                        onBlur={() => handleSaveDescription(source.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveDescription(source.id)
                          if (e.key === 'Escape') setEditingDescId(null)
                        }}
                        placeholder="Add a description for routing…"
                        className="w-full bg-zinc-800 text-zinc-300 text-[11px] px-1.5 py-1 rounded outline-none border border-zinc-600 placeholder-zinc-600"
                      />
                    </div>
                  ) : source.description ? (
                    <p
                      className="ml-5 px-2 pb-1 text-[11px] text-zinc-600 truncate cursor-pointer hover:text-zinc-500"
                      onClick={() => startEditDesc(source)}
                      title={source.description}
                    >
                      {source.description}
                    </p>
                  ) : null}

                  {!isCollapsed && (
                    <div className="ml-4 space-y-0.5">
                      {sourceDocs.length === 0 && (
                        <p className="text-zinc-700 text-[11px] px-2 py-1 italic">Empty</p>
                      )}
                      {sourceDocs.map(doc => <DocItem key={doc.doc_id} doc={doc} />)}
                    </div>
                  )}
                </div>
              )
            })}

            {/* New source input */}
            {creatingSource && (
              <div className="flex items-center gap-1.5 px-2 py-1">
                <FolderOpen className="w-3.5 h-3.5 text-gold-500/70 flex-shrink-0" />
                <input
                  ref={newSourceInputRef}
                  value={newSourceName}
                  onChange={e => setNewSourceName(e.target.value)}
                  onBlur={handleCreateSource}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreateSource()
                    if (e.key === 'Escape') { setCreatingSource(false); setNewSourceName('') }
                  }}
                  placeholder="Data source name…"
                  className="flex-1 bg-zinc-800 text-white text-[12px] px-1.5 py-1 rounded outline-none border border-zinc-600 placeholder-zinc-600"
                />
              </div>
            )}

            {/* Unassigned */}
            {unassigned.length > 0 && (
              <div>
                <p className="text-zinc-600 text-[10px] font-semibold uppercase tracking-widest px-2 pt-3 pb-1">
                  Unassigned
                </p>
                <div className="space-y-0.5">
                  {unassigned.map(doc => <DocItem key={doc.doc_id} doc={doc} />)}
                </div>
              </div>
            )}
          </>
        )}
      </nav>

      {/* Assign dropdown — fixed so it escapes the scrolling nav */}
      {assignDropdownDocId && (
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, width: 200, zIndex: 9999 }}
          className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden"
        >
          <p className="text-zinc-500 text-[10px] uppercase tracking-wider px-2.5 py-1.5 border-b border-zinc-800">
            Move to data source
          </p>
          {sources.length === 0 && (
            <p className="px-2.5 py-2 text-zinc-600 text-[11px]">No data sources yet</p>
          )}
          {sources.map(s => {
            const current = assignments[assignDropdownDocId] === s.id
            return (
              <button
                key={s.id}
                onClick={() => handleAssignDoc(assignDropdownDocId, s.id)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-zinc-800 transition-colors ${current ? 'text-gold-400' : 'text-zinc-300'}`}
              >
                <Folder className="w-3 h-3 flex-shrink-0" />
                <span className="truncate flex-1">{s.name}</span>
                {current && <Check className="w-3 h-3 flex-shrink-0" />}
              </button>
            )
          })}
          {assignments[assignDropdownDocId] && (
            <button
              onClick={() => handleAssignDoc(assignDropdownDocId, null)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors border-t border-zinc-800"
            >
              <X className="w-3 h-3 flex-shrink-0" />
              Remove from source
            </button>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="px-5 py-4 border-t border-zinc-800/80">
        <p className="text-zinc-600 text-[11px]">Glaucias &copy; 2026</p>
      </div>
    </aside>
  )
}
