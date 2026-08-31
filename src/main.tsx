import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import CloudApp from './cloud/CloudApp'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CloudApp />
  </StrictMode>,
)
