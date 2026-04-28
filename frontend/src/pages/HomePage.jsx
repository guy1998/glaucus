import { useCallback, useRef, useState } from 'react'
import { Upload, Zap, Search, GitBranch } from 'lucide-react'
import { uploadDocument, openStream } from '../api'
import { useNavigate } from 'react-router-dom'

const features = [
  { Icon: Zap,       title: 'Instant Extraction', desc: 'Structured nodes from any PDF in minutes.' },
  { Icon: Search,    title: 'Semantic Search',     desc: 'Query by meaning across the full document.' },
  { Icon: GitBranch, title: 'Reference Graph',     desc: 'Cross-references and figures resolved automatically.' },
]

export default function HomePage({ onUpload }) {
  const navigate = useNavigate()
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef(null)

  const handleDrop = useCallback(e => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f?.type === 'application/pdf') {
      onUpload()
    }
  }, [onUpload])

  return (
    <div className="h-full flex flex-col items-center justify-center px-8 py-16 bg-white">
      {/* Hero */}
      <div className="max-w-xl text-center mb-12">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gold-50 border border-gold-200 rounded-full text-gold-700 text-xs font-semibold mb-6 tracking-wide uppercase">
          <span className="w-1.5 h-1.5 bg-gold-500 rounded-full animate-pulse" />
          Document Intelligence
        </div>

        <h1 className="text-4xl font-bold text-zinc-900 tracking-tight leading-tight mb-4">
          Understand your<br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-gold-500 to-gold-700">
            documents deeply
          </span>
        </h1>

        <p className="text-zinc-500 text-lg leading-relaxed">
          Upload a PDF and instantly get a structured breakdown, rendered markdown, and semantic search — all in one place.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={onUpload}
        className={`w-full max-w-md cursor-pointer rounded-2xl border-2 border-dashed p-10 flex flex-col items-center gap-4 transition-all duration-200 mb-12 ${
          dragging
            ? 'border-gold-400 bg-gold-50 scale-[1.02]'
            : 'border-zinc-200 hover:border-gold-300 hover:bg-zinc-50'
        }`}
      >
        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-colors ${
          dragging ? 'bg-gold-100' : 'bg-zinc-100'
        }`}>
          <Upload className={`w-7 h-7 transition-colors ${dragging ? 'text-gold-600' : 'text-zinc-400'}`} />
        </div>
        <div className="text-center">
          <p className="font-semibold text-zinc-800">Drop a PDF here</p>
          <p className="text-zinc-400 text-sm mt-1">or click to browse your files</p>
        </div>
        <span className="text-xs text-zinc-300 uppercase tracking-widest">PDF up to 200 MB</span>
      </div>

      {/* Feature pills */}
      <div className="flex flex-col sm:flex-row gap-4 max-w-2xl w-full">
        {features.map(({ Icon, title, desc }) => (
          <div key={title} className="flex-1 flex items-start gap-3 px-4 py-4 rounded-xl bg-zinc-50 border border-zinc-100">
            <div className="w-8 h-8 rounded-lg bg-gold-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Icon className="w-4 h-4 text-gold-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-800">{title}</p>
              <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
