import { useState, useEffect, useRef, useCallback } from 'react'
import { Send, Bot, User, ChevronDown, Loader2, FileText, Zap, RotateCcw } from 'lucide-react'
import { listDataSources, streamChat } from '../api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docIdFromCollection(collection) {
  return collection ? collection.replace(/^doc_/, '') : ''
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SourceSelector({ sources, value, onChange, disabled }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="appearance-none bg-zinc-800 border border-zinc-700 text-zinc-200 text-sm rounded-lg pl-3 pr-8 py-2 focus:outline-none focus:border-gold-500 disabled:opacity-50 cursor-pointer"
      >
        <option value="auto">Auto (route to best source)</option>
        {sources.map(s => (
          <option key={s.id} value={s.id}>
            {s.name}{s.description ? ` — ${s.description.slice(0, 40)}` : ''}
          </option>
        ))}
      </select>
      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
    </div>
  )
}

function KeywordChips({ keywords }) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {keywords.map((kw, i) => (
        <span
          key={kw}
          className="px-2 py-0.5 bg-gold-500/10 border border-gold-500/30 text-gold-400 text-[11px] rounded-full animate-fade-in"
          style={{ animationDelay: `${i * 80}ms` }}
        >
          {kw}
        </span>
      ))}
    </div>
  )
}

function SourceCitations({ nodes }) {
  const [open, setOpen] = useState(false)
  if (!nodes || nodes.length === 0) return null

  const unique = []
  const seen = new Set()
  for (const n of nodes) {
    const key = `${n.collection}:${n.page}`
    if (!seen.has(key)) { seen.add(key); unique.push(n) }
  }

  return (
    <div className="mt-3 border-t border-zinc-700/50 pt-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-400 transition-colors"
      >
        <FileText className="w-3 h-3" />
        {unique.length} source{unique.length !== 1 ? 's' : ''} used
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {unique.map((n, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px] text-zinc-500">
              <span className="text-zinc-600 flex-shrink-0 w-4 text-right">{i + 1}.</span>
              <span>
                <span className="text-zinc-400 font-medium">{docIdFromCollection(n.collection)}</span>
                {n.page != null && <span className="text-zinc-600"> · p.{n.page}</span>}
                {n.parent_header && (
                  <span className="text-zinc-600"> · {n.parent_header.split(' > ').pop()}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AssistantMessage({ msg }) {
  const isStreaming = msg.streaming
  const showSearching = isStreaming && !msg.content && msg.keywords?.length === 0

  return (
    <div className="flex gap-3 group">
      <div className="w-7 h-7 rounded-lg bg-gold-500/20 border border-gold-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Bot className="w-3.5 h-3.5 text-gold-400" />
      </div>
      <div className="flex-1 min-w-0">
        {/* Routing indicator */}
        {msg.routedTo && (
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 mb-2">
            <Zap className="w-3 h-3 text-gold-500/60" />
            Searching in <span className="text-zinc-400 font-medium">{msg.routedTo.name}</span>
          </div>
        )}

        {/* Keywords while searching */}
        {msg.keywords?.length > 0 && (
          <div className="mb-3">
            <p className="text-[11px] text-zinc-600 mb-1">Searching for</p>
            <KeywordChips keywords={msg.keywords} />
          </div>
        )}

        {/* Searching pulse */}
        {showSearching && (
          <div className="flex items-center gap-2 text-zinc-500 text-sm">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-gold-500" />
            Thinking…
          </div>
        )}

        {/* Answer */}
        {msg.content && (
          <div className="markdown-chat">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
            {isStreaming && <span className="inline-block w-2 h-3.5 bg-gold-400 animate-pulse ml-0.5 align-middle rounded-sm" />}
          </div>
        )}

        {/* Error state */}
        {msg.error && (
          <p className="text-red-400 text-sm">{msg.content}</p>
        )}

        {/* Source citations */}
        {!isStreaming && <SourceCitations nodes={msg.sources} />}
      </div>
    </div>
  )
}

function UserMessage({ msg }) {
  return (
    <div className="flex gap-3 justify-end group">
      <div className="max-w-[75%] bg-zinc-800 border border-zinc-700 rounded-2xl rounded-tr-sm px-4 py-2.5">
        <p className="text-zinc-200 text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
      </div>
      <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center flex-shrink-0 mt-0.5">
        <User className="w-3.5 h-3.5 text-zinc-400" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main ChatPage
// ---------------------------------------------------------------------------

export default function ChatPage() {
  const [sources, setSources] = useState([])
  const [selectedSource, setSelectedSource] = useState('auto')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const abortRef = useRef(false)

  useEffect(() => {
    listDataSources()
      .then(d => setSources(d.sources ?? []))
      .catch(console.error)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const updateLastMsg = useCallback((updater) => {
    setMessages(prev => {
      const msgs = [...prev]
      msgs[msgs.length - 1] = updater(msgs[msgs.length - 1])
      return msgs
    })
  }, [])

  async function send() {
    const q = input.trim()
    if (!q || streaming) return

    const userMsg = { role: 'user', content: q }
    const assistantMsg = {
      role: 'assistant',
      content: '',
      streaming: true,
      keywords: [],
      sources: [],
      routedTo: null,
      error: false,
    }

    const historyForApi = messages.map(m => ({ role: m.role, content: m.content }))
    setMessages(prev => [...prev, userMsg, assistantMsg])
    setInput('')
    setStreaming(true)
    abortRef.current = false

    try {
      for await (const evt of streamChat(q, selectedSource, historyForApi)) {
        if (abortRef.current) break

        if (evt.type === 'routing') {
          updateLastMsg(m => ({ ...m, routedTo: evt.source }))
        } else if (evt.type === 'keywords') {
          updateLastMsg(m => ({ ...m, keywords: evt.keywords }))
        } else if (evt.type === 'sources') {
          updateLastMsg(m => ({ ...m, sources: evt.nodes }))
        } else if (evt.type === 'token') {
          updateLastMsg(m => ({ ...m, content: m.content + evt.text }))
        } else if (evt.type === 'complete') {
          updateLastMsg(m => ({ ...m, streaming: false }))
          setStreaming(false)
        } else if (evt.type === 'error') {
          updateLastMsg(m => ({ ...m, content: evt.message, streaming: false, error: true }))
          setStreaming(false)
        }
      }
    } catch (err) {
      updateLastMsg(m => ({ ...m, content: err.message, streaming: false, error: true }))
      setStreaming(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function clearChat() {
    if (streaming) { abortRef.current = true; setStreaming(false) }
    setMessages([])
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
        <div>
          <h1 className="text-white font-semibold text-base">Chat</h1>
          <p className="text-zinc-500 text-[11px] mt-0.5">Ask questions across your documents</p>
        </div>
        <div className="flex items-center gap-3">
          <SourceSelector
            sources={sources}
            value={selectedSource}
            onChange={setSelectedSource}
            disabled={streaming}
          />
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="p-2 rounded-lg text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors"
              title="Clear chat"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {isEmpty && (
          <div className="flex flex-col items-center justify-center h-full text-center select-none">
            <div className="w-12 h-12 bg-gold-500/10 border border-gold-500/20 rounded-2xl flex items-center justify-center mb-4">
              <Bot className="w-6 h-6 text-gold-400/60" />
            </div>
            <p className="text-zinc-400 font-medium text-sm">Ask anything about your documents</p>
            <p className="text-zinc-600 text-xs mt-1 max-w-xs">
              {sources.length > 0
                ? `Choose a data source or let the AI route to the most relevant one.`
                : 'Upload documents and group them into data sources to get started.'}
            </p>
          </div>
        )}

        {messages.map((msg, i) =>
          msg.role === 'user'
            ? <UserMessage key={i} msg={msg} />
            : <AssistantMessage key={i} msg={msg} />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-zinc-800 flex-shrink-0">
        <div className="flex items-end gap-3 bg-zinc-900 border border-zinc-700 rounded-2xl px-4 py-3 focus-within:border-zinc-500 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask something about your documents…"
            rows={1}
            disabled={streaming}
            className="flex-1 bg-transparent text-zinc-200 text-sm placeholder-zinc-600 resize-none outline-none leading-relaxed disabled:opacity-50"
            style={{ maxHeight: 120, overflowY: 'auto' }}
            onInput={e => {
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
            }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || streaming}
            className="flex-shrink-0 w-8 h-8 bg-gold-500 hover:bg-gold-400 disabled:bg-zinc-700 disabled:text-zinc-600 text-white rounded-xl flex items-center justify-center transition-colors"
          >
            {streaming
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Send className="w-3.5 h-3.5" />}
          </button>
        </div>
        <p className="text-zinc-700 text-[10px] text-center mt-2">
          Press Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
