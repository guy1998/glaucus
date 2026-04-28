import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

function resolveImageSrc(src) {
  if (!src) return src
  if (src.startsWith('images/')) {
    const filename = src.slice('images/'.length)
    return `/api/documents/images/${filename}`
  }
  return src
}

export default function MarkdownPane({ markdown, activeNodeId }) {
  const containerRef = useRef(null)

  useEffect(() => {
    if (!activeNodeId || !containerRef.current) return
    const prev = containerRef.current.querySelector('.node-active')
    if (prev) prev.classList.remove('node-active')

    const el = containerRef.current.querySelector(`[id="${CSS.escape(activeNodeId)}"]`)
    if (el) {
      el.classList.add('node-active')
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeNodeId])

  const components = {
    img({ src, alt, ...props }) {
      return (
        <img
          src={resolveImageSrc(src)}
          alt={alt}
          loading="lazy"
          className="max-w-full rounded-xl my-6 border border-zinc-200 shadow-sm"
          {...props}
        />
      )
    },
    table({ children, ...props }) {
      return (
        <div className="overflow-x-auto mb-4">
          <table className="min-w-full text-sm" {...props}>{children}</table>
        </div>
      )
    },
  }

  if (!markdown) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-300 text-sm">
        No content to display.
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-10 py-10">
        <div className="markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={components}
          >
            {markdown}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
