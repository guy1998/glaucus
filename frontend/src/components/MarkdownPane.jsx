import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

const API_IMAGES = '/api/documents/images'

// Rewrite relative `images/` srcs at the string level so both raw-HTML <img>
// tags (rendered by rehypeRaw) and markdown image syntax get the correct URL.
function rewriteImageSrcs(md) {
  return md.replace(/src="images\//g, `src="${API_IMAGES}/`)
}

export default function MarkdownPane({ markdown, activeNodeId, scrollToNodeId }) {
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

  useEffect(() => {
    if (!scrollToNodeId || !containerRef.current) return
    const el = containerRef.current.querySelector(`[id="${CSS.escape(scrollToNodeId)}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [scrollToNodeId])

  const components = {
    img({ src, alt, ...props }) {
      return (
        <img
          src={src}
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
            {rewriteImageSrcs(markdown)}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
