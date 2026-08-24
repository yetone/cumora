import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ConditionalPostHogProvider } from './components/ConditionalPostHogProvider'
import { PostHogAppTracker } from './components/PostHogAppTracker'
import { initObservability } from './lib/observability'
import { isElectron } from './lib/runtime'
import { bootNative, isNativePlatform } from './lib/native'
import './styles/globals.css'
import '@/lib/theme'

if (isElectron) document.body.classList.add('electron')
if (isNativePlatform()) document.body.classList.add('native', `native-${typeof window !== 'undefined' && (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() || ''}`)

void initObservability()
void bootNative()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConditionalPostHogProvider>
      <PostHogAppTracker />
      <App />
    </ConditionalPostHogProvider>
  </StrictMode>,
)
