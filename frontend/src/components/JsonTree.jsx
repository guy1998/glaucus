import { useState, useMemo, useEffect, useCallback } from 'react'
import { ChevronRight, ChevronDown, Image, Table, List, Type, AlignLeft, Heading, Plus, X, Loader2 } from 'lucide-react'
import { getNodeConnections, addEdge, removeEdge } from '../api'

const TYPE_META = {
  title:          { label: 'Title',      color: 'bg-amber-100 text-amber-800',    Icon: Type },
  section_header: { label: 'Heading',    color: 'bg-gold-100 text-gold-800',      Icon: Heading },
  paragraph:      { label: 'Paragraph',  color: 'bg-zinc-100 text-zinc-600',      Icon: AlignLeft },
  text:           { label: 'Text',       color: 'bg-zinc-100 text-zinc-600',      Icon: AlignLeft },
  picture:        { label: 'Image',      color: 'bg-blue-100 text-blue-700',      Icon: Image },
  table:          { label: 'Table',      color: 'bg-purple-100 text-purple-700',  Icon: Table },
  list:           { label: 'List',       color: 'bg-emerald-100 text-emerald-700', Icon: List },
  caption:        { label: 'Caption',    color: 'bg-zinc-100 text-zinc-500',      Icon: AlignLeft },
}

function getTypeMeta(type) {
  return TYPE_META[type] ?? { label: type, color: 'bg-zinc-100 text-zinc-500', Icon: AlignLeft }
}

function preview(node) {
  if (node.type === 'picture') return node.picture?.description || '(image)'
  return (node.text || '').replace(/\s+/g, ' ').slice(0, 90)
}

// ---------------------------------------------------------------------------
// ConnectionItem
// ---------------------------------------------------------------------------
function ConnectionItem({ node, edgeType, removing, onRemove }) {
  const meta = getTypeMeta(node.type)
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-50 last:border-0 group hover:bg-zinc-50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          <span className={`px-1 py-0.5 rounded text-[9px] font-medium flex-shrink-0 ${meta.color}`}>
            {meta.label}
          </span>
          {node.page != null && (
            <span className="text-[9px] text-zinc-400">p.{node.page}</span>
          )}
          <span className="text-[9px] text-zinc-300 italic">{edgeType}</span>
        </div>
        <p className="text-[11px] text-zinc-500 truncate">{node.preview || '(empty)'}</p>
      </div>
      <button
        onClick={onRemove}
        disabled={removing}
        title="Remove connection"
        className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 p-0.5 rounded text-zinc-300 hover:text-red-400 disabled:opacity-40"
      >
        {removing
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <X className="w-3.5 h-3.5" />
        }
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ConnectionsPanel
// ---------------------------------------------------------------------------
function ConnectionsPanel({ docId, nodeId, nodes }) {
  const [data, setData]       = useState(null)
  const [busy, setBusy]       = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [search, setSearch]   = useState('')
  const [removing, setRemoving] = useState(null)

  const refresh = useCallback(() => {
    if (!nodeId) return
    setBusy(true)
    getNodeConnections(docId, nodeId)
      .then(setData)
      .catch(() => setData({ outgoing: [], incoming: [] }))
      .finally(() => setBusy(false))
  }, [docId, nodeId])

  useEffect(() => {
    setData(null)
    setAddOpen(false)
    setSearch('')
    refresh()
  }, [refresh])

  async function doRemove(source, target) {
    const key = `${source}>${target}`
    setRemoving(key)
    try {
      await removeEdge(docId, source, target)
      refresh()
    } finally {
      setRemoving(null)
    }
  }

  async function doAdd(targetId) {
    await addEdge(docId, nodeId, targetId)
    setAddOpen(false)
    setSearch('')
    refresh()
  }

  const candidates = useMemo(() => {
    if (!search.trim() || !nodes) return []
    const q = search.toLowerCase()
    return nodes
      .filter(n =>
        n.id !== nodeId &&
        ((n.text || '').toLowerCase().includes(q) ||
         n.type.toLowerCase().includes(q) ||
         (n.picture?.description || '').toLowerCase().includes(q))
      )
      .slice(0, 6)
  }, [nodes, search, nodeId])

  const outgoing = data?.outgoing ?? []
  const incoming = data?.incoming ?? []

  return (
    <div className="border-t-2 border-zinc-200 bg-white flex flex-col" style={{ maxHeight: '260px' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-100 flex-shrink-0">
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest">
          Connections
        </span>
        <div className="flex items-center gap-2">
          {busy && <Loader2 className="w-3 h-3 animate-spin text-zinc-300" />}
          <button
            onClick={() => { setAddOpen(o => !o); setSearch('') }}
            className="flex items-center gap-1 text-[11px] font-medium text-gold-600 hover:text-gold-700 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        </div>
      </div>

      {/* Add connection search */}
      {addOpen && (
        <div className="px-4 py-2 border-b border-zinc-100 flex-shrink-0">
          <input
            autoFocus
            type="text"
            placeholder="Search nodes to connect…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full px-2 py-1 text-xs bg-zinc-50 border border-zinc-200 rounded focus:outline-none focus:ring-1 focus:ring-gold-300 focus:border-gold-300 placeholder-zinc-400"
          />
          {candidates.length > 0 && (
            <div className="mt-1 max-h-28 overflow-y-auto rounded border border-zinc-100 bg-white shadow-sm">
              {candidates.map(n => {
                const meta = getTypeMeta(n.type)
                return (
                  <button
                    key={n.id}
                    onClick={() => doAdd(n.id)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-zinc-50 transition-colors border-b border-zinc-50 last:border-0"
                  >
                    <span className={`px-1 py-0.5 rounded text-[9px] font-medium flex-shrink-0 ${meta.color}`}>
                      {meta.label}
                    </span>
                    <span className="text-[11px] text-zinc-600 truncate">{preview(n)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Edge list */}
      <div className="flex-1 overflow-y-auto">
        {!data && busy ? (
          <p className="text-zinc-400 text-[11px] text-center py-4">Loading…</p>
        ) : outgoing.length === 0 && incoming.length === 0 ? (
          <p className="text-zinc-300 text-[11px] text-center py-4 italic">No connections</p>
        ) : (
          <>
            {outgoing.length > 0 && (
              <div>
                <p className="px-4 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wide bg-zinc-50 border-b border-zinc-100">
                  Connected to ({outgoing.length})
                </p>
                {outgoing.map(({ edge_type, node }) => (
                  <ConnectionItem
                    key={node.id}
                    node={node}
                    edgeType={edge_type}
                    removing={removing === `${nodeId}>${node.id}`}
                    onRemove={() => doRemove(nodeId, node.id)}
                  />
                ))}
              </div>
            )}
            {incoming.length > 0 && (
              <div>
                <p className="px-4 py-1 text-[10px] font-semibold text-zinc-400 uppercase tracking-wide bg-zinc-50 border-b border-zinc-100">
                  Referenced by ({incoming.length})
                </p>
                {incoming.map(({ edge_type, node }) => (
                  <ConnectionItem
                    key={node.id}
                    node={node}
                    edgeType={edge_type}
                    removing={removing === `${node.id}>${nodeId}`}
                    onRemove={() => doRemove(node.id, nodeId)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PageGroup
// ---------------------------------------------------------------------------
function PageGroup({ page, nodes, activeNodeId, onNodeClick }) {
  const [open, setOpen] = useState(page <= 2)

  return (
    <div className="border-b border-zinc-100 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-zinc-50 transition-colors text-left"
      >
        {open
          ? <ChevronDown className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
        }
        <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
          Page {page}
        </span>
        <span className="ml-auto text-[11px] text-zinc-400">{nodes.length}</span>
      </button>

      {open && (
        <div className="pb-1">
          {nodes.map(node => {
            const meta = getTypeMeta(node.type)
            const Icon = meta.Icon
            const active = activeNodeId === node.id
            return (
              <button
                key={node.id}
                onClick={() => onNodeClick(node.id)}
                className={`w-full flex items-start gap-2.5 px-4 py-2.5 text-left transition-all duration-150 border-l-2 ${
                  active
                    ? 'bg-gold-50 border-gold-400'
                    : 'border-transparent hover:bg-zinc-50 hover:border-zinc-200'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${active ? 'text-gold-500' : 'text-zinc-400'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.color}`}>
                      {meta.label}
                    </span>
                  </div>
                  <p className="text-[12px] text-zinc-600 leading-snug line-clamp-2">
                    {preview(node) || <span className="text-zinc-300 italic">empty</span>}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// JsonTree
// ---------------------------------------------------------------------------
export default function JsonTree({ docId, nodes, activeNodeId, onNodeClick }) {
  const [search, setSearch] = useState('')

  const grouped = useMemo(() => {
    if (!nodes) return []
    const filtered = search.trim()
      ? nodes.filter(n =>
          (n.text ?? '').toLowerCase().includes(search.toLowerCase()) ||
          n.type.includes(search.toLowerCase()) ||
          (n.picture?.description ?? '').toLowerCase().includes(search.toLowerCase())
        )
      : nodes

    const map = new Map()
    for (const node of filtered) {
      const page = node.metadata?.page ?? 0
      if (!map.has(page)) map.set(page, [])
      map.get(page).push(node)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [nodes, search])

  if (!nodes) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-300 text-sm">
        No structure data.
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-zinc-50 border-l border-zinc-200">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-200 bg-white flex-shrink-0">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-widest mb-2">Structure</p>
        <input
          type="text"
          placeholder="Filter nodes…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full px-3 py-1.5 text-sm bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-300 placeholder-zinc-400 transition"
        />
      </div>

      {/* Stats */}
      <div className="px-4 py-2 border-b border-zinc-100 bg-white flex-shrink-0">
        <p className="text-[11px] text-zinc-400">
          {nodes.length} nodes · {grouped.length} pages
        </p>
      </div>

      {/* Node groups */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {grouped.length === 0 ? (
          <p className="text-zinc-400 text-xs text-center p-6">No matching nodes.</p>
        ) : (
          grouped.map(([page, pageNodes]) => (
            <PageGroup
              key={page}
              page={page}
              nodes={pageNodes}
              activeNodeId={activeNodeId}
              onNodeClick={onNodeClick}
            />
          ))
        )}
      </div>

      {/* Connections panel — shown when a node is active */}
      {activeNodeId && (
        <ConnectionsPanel
          docId={docId}
          nodeId={activeNodeId}
          nodes={nodes}
        />
      )}
    </div>
  )
}
