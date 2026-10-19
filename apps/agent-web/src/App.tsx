import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from './stores/AuthProvider'
import { ThemeProvider } from './contexts/ThemeContext'
import { Toaster } from 'sonner'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import MainLayout from './pages/MainLayout'
import SettingsPage from './pages/SettingsPage'
import SessionPage from './pages/SessionPage'
import WorkflowInstancePage from './pages/WorkflowInstancePage'
import HomePage from './pages/HomePage'
import BillingPage from './pages/BillingPage'
import ProtectedRoute from './components/ProtectedRoute'

const basename = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')

function SessionPageRoute() {
  const location = useLocation();
  return <SessionPage key={location.pathname} />;
}

function App() {
  return (
    <BrowserRouter basename={basename}>
      <ThemeProvider>
        <AuthProvider>
          <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:text-primary focus:shadow-lg">
            跳到主要内容
          </a>
          <Toaster position="top-right" />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<MainLayout />}>
                <Route index element={<HomePage />} />
                <Route path="sessions" element={<SessionPageRoute />} />
                <Route path="sessions/:id" element={<SessionPageRoute />} />
                <Route path="workflows/:id" element={<WorkflowInstancePage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="billing" element={<BillingPage />} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}

export default App
