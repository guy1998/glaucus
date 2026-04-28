import { useState } from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import UploadModal from './components/UploadModal'
import HomePage from './pages/HomePage'
import DocumentPage from './pages/DocumentPage'

export default function App() {
  const [showUpload, setShowUpload] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  function handleUploadComplete() {
    setShowUpload(false)
    setRefreshKey(k => k + 1)
  }

  return (
    <Router>
      <div className="flex h-screen bg-white overflow-hidden">
        <Sidebar
          onUpload={() => setShowUpload(true)}
          refreshKey={refreshKey}
        />

        <main className="flex-1 overflow-hidden flex flex-col">
          <Routes>
            <Route path="/" element={<HomePage onUpload={() => setShowUpload(true)} />} />
            <Route path="/documents/:docId" element={<DocumentPage />} />
          </Routes>
        </main>

        {showUpload && (
          <UploadModal
            onClose={() => setShowUpload(false)}
            onComplete={handleUploadComplete}
          />
        )}
      </div>
    </Router>
  )
}
