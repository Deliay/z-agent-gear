import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from './stores/AuthProvider'
import { ThemeProvider } from './contexts/ThemeContext'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import MainLayout from './pages/MainLayout'
import SettingsPage from './pages/SettingsPage'
import SessionPage from './pages/SessionPage'
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
          <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:text-blue-600 focus:shadow-lg">
            跳到主要内容
          </a>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<MainLayout />}>
                <Route index element={
                  <div id="main-content" className="p-8 text-gray-600">
                    选择一个会话
                  </div>
                } />
                <Route path="sessions" element={<SessionPageRoute />} />
                <Route path="sessions/:id" element={<SessionPageRoute />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}

export default App
