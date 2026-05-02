import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, X, FileText, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import { uploadDocument, openStream } from '../api'

const STEPS = ['split', 'parse', 'save', 'graph', 'embed', 'complete']
const STEP_LABELS = {
  split:    'Splitting pages',
  parse:    'Parsing content',
  save:     'Saving structure',
  graph:    'Building references',
  embed:    'Embedding for search',
  complete: 'Complete',
}

export default function UploadModal({ onClose, onComplete }) {
  const navigate = useNavigate()
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | uploading | streaming | done | error
  const [progress, setProgress] = useState({ pct: 0, step: '', message: '' })
  const [error, setError] = useState(null)
  const [keywords, setKeywords] = useState([])
  const [kwInput, setKwInput] = useState('')
  const fileInput = useRef(null)
  const esRef = useRef(null)

  function addKeyword(raw) {
    const kw = raw.trim().replace(/,+$/, '').trim()
    if (kw && !keywords.includes(kw)) setKeywords(prev => [...prev, kw])
    setKwInput('')
  }

  function onKwKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addKeyword(kwInput)
    } else if (e.key === 'Backspace' && !kwInput && keywords.length > 0) {
      setKeywords(prev => prev.slice(0, -1))
    }
  }

  useEffect(() => () => esRef.current?.close(), [])

  const acceptFile = useCallback(f => {
    if (f?.type === 'application/pdf') setFile(f)
    else setError('Only PDF files are accepted.')
  }, [])

  function onDrop(e) {
    e.preventDefault()
    setDragging(false)
    acceptFile(e.dataTransfer.files[0])
  }

  async function handleUpload() {
    if (!file) return
    const finalKeywords = kwInput.trim() ? [...keywords, kwInput.trim()] : keywords
    setPhase('uploading')
    setError(null)
    try {
      const { job_id } = await uploadDocument(file, finalKeywords)
      setPhase('streaming')
      const es = openStream(job_id)
      esRef.current = es
      es.onmessage = e => {
        const evt = JSON.parse(e.data)
        if (evt.type === 'heartbeat') return
        if (evt.type === 'progress') {
          setProgress({ pct: evt.pct, step: evt.step, message: evt.message })
        } else if (evt.type === 'complete') {
          es.close()
          setProgress({ pct: 100, step: 'complete', message: 'Ready!' })
          setPhase('done')
          setTimeout(() => {
            onComplete(evt.doc_id)
            navigate(`/documents/${evt.doc_id}`)
          }, 900)
        } else if (evt.type === 'error') {
          es.close()
          setError(evt.message)
          setPhase('error')
        }
      }
      es.onerror = () => {
        es.close()
        setError('Connection lost. Please try again.')
        setPhase('error')
      }
    } catch (err) {
      setError(err.message)
      setPhase('error')
    }
  }

  const isStreaming = phase === 'uploading' || phase === 'streaming'
  const currentStepIdx = STEPS.indexOf(progress.step)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in"
      onClick={e => { if (e.target === e.currentTarget && !isStreaming) onClose() }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-100">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gold-50 rounded-lg flex items-center justify-center">
              <Upload className="w-4 h-4 text-gold-600" />
            </div>
            <h2 className="font-semibold text-zinc-900">Upload Document</h2>
          </div>
          {!isStreaming && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="px-6 py-6">
          {/* Drop zone — shown when idle */}
          {(phase === 'idle' || phase === 'error') && (
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInput.current?.click()}
              className={`relative flex flex-col items-center justify-center gap-3 p-8 rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200 ${
                dragging
                  ? 'border-gold-400 bg-gold-50'
                  : file
                  ? 'border-gold-300 bg-gold-50/50'
                  : 'border-zinc-200 hover:border-gold-300 hover:bg-zinc-50'
              }`}
            >
              <input
                ref={fileInput}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={e => acceptFile(e.target.files?.[0])}
              />
              {file ? (
                <>
                  <div className="w-12 h-12 bg-gold-100 rounded-xl flex items-center justify-center">
                    <FileText className="w-6 h-6 text-gold-600" />
                  </div>
                  <div className="text-center">
                    <p className="font-medium text-zinc-900 text-sm">{file.name}</p>
                    <p className="text-zinc-400 text-xs mt-0.5">
                      {(file.size / 1024 / 1024).toFixed(1)} MB
                    </p>
                  </div>
                  <p className="text-xs text-zinc-400">Click to change file</p>
                </>
              ) : (
                <>
                  <div className="w-12 h-12 bg-zinc-100 rounded-xl flex items-center justify-center">
                    <Upload className="w-6 h-6 text-zinc-400" />
                  </div>
                  <div className="text-center">
                    <p className="font-medium text-zinc-700 text-sm">Drop your PDF here</p>
                    <p className="text-zinc-400 text-xs mt-1">or click to browse</p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Custom reference keywords */}
          {(phase === 'idle' || phase === 'error') && (
            <div className="mt-4">
              <label className="block text-xs font-medium text-zinc-500 mb-1.5">
                Custom reference keywords
                <span className="font-normal text-zinc-400 ml-1">(optional — press Enter or , to add)</span>
              </label>
              <div className="flex flex-wrap gap-1.5 p-2.5 rounded-xl border border-zinc-200 bg-zinc-50 min-h-[40px] focus-within:border-gold-300 focus-within:bg-white transition-colors">
                {keywords.map(kw => (
                  <span key={kw} className="flex items-center gap-1 px-2 py-0.5 bg-gold-100 text-gold-700 rounded-full text-xs font-medium">
                    {kw}
                    <button
                      type="button"
                      onClick={() => setKeywords(prev => prev.filter(k => k !== kw))}
                      className="text-gold-500 hover:text-gold-700 leading-none"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={kwInput}
                  onChange={e => setKwInput(e.target.value)}
                  onKeyDown={onKwKeyDown}
                  onBlur={() => kwInput.trim() && addKeyword(kwInput)}
                  placeholder={keywords.length === 0 ? 'e.g. per the methodology, as noted earlier' : ''}
                  className="flex-1 min-w-[120px] bg-transparent text-xs text-zinc-700 placeholder-zinc-300 outline-none"
                />
              </div>
            </div>
          )}

          {/* Progress — shown while processing */}
          {(phase === 'uploading' || phase === 'streaming' || phase === 'done') && (
            <div className="space-y-5">
              {/* File info */}
              <div className="flex items-center gap-3 p-3 bg-zinc-50 rounded-xl">
                <FileText className="w-5 h-5 text-gold-600 flex-shrink-0" />
                <p className="text-sm font-medium text-zinc-700 truncate">{file?.name}</p>
              </div>

              {/* Progress bar */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-zinc-700">
                    {STEP_LABELS[progress.step] ?? 'Initialising…'}
                  </span>
                  <span className="text-sm font-semibold text-gold-600">
                    {progress.pct}%
                  </span>
                </div>
                <div className="h-2 bg-zinc-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-gold-400 to-gold-600 rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${progress.pct}%` }}
                  />
                </div>
              </div>

              {/* Step pills */}
              <div className="flex gap-1.5 flex-wrap">
                {STEPS.filter(s => s !== 'complete').map((s, i) => {
                  const done = currentStepIdx > i
                  const active = STEPS[currentStepIdx] === s
                  return (
                    <span
                      key={s}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-all duration-300 ${
                        done
                          ? 'bg-gold-100 text-gold-700'
                          : active
                          ? 'bg-gold-500 text-white ring-2 ring-gold-300'
                          : 'bg-zinc-100 text-zinc-400'
                      }`}
                    >
                      {STEP_LABELS[s]}
                    </span>
                  )
                })}
              </div>

              {/* Message */}
              <p className="text-xs text-zinc-400 leading-relaxed line-clamp-2 min-h-[2rem]">
                {progress.message}
              </p>

              {/* Done state */}
              {phase === 'done' && (
                <div className="flex items-center gap-2 text-emerald-600 bg-emerald-50 rounded-xl px-4 py-3">
                  <CheckCircle className="w-4 h-4 flex-shrink-0" />
                  <span className="text-sm font-medium">Processing complete — opening document…</span>
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2.5 mt-4 text-red-600 bg-red-50 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p className="text-sm leading-snug">{error}</p>
            </div>
          )}
        </div>

        {/* Footer actions */}
        {(phase === 'idle' || phase === 'error') && (
          <div className="px-6 pb-6 flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl border border-zinc-200 text-zinc-600 text-sm font-medium hover:bg-zinc-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleUpload}
              disabled={!file}
              className="flex-1 px-4 py-2.5 rounded-xl bg-gold-500 hover:bg-gold-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-all duration-150 shadow-sm"
            >
              Upload & Process
            </button>
          </div>
        )}

        {isStreaming && (
          <div className="px-6 pb-6 flex items-center gap-2 text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">Processing — please keep this window open…</span>
          </div>
        )}
      </div>
    </div>
  )
}
