import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './stores/AuthProvider'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import MainLayout from './pages/MainLayout'
import SettingsPage from './pages/SettingsPage'
import SessionPage from './pages/SessionPage'
import ProtectedRoute from './components/ProtectedRoute'

function App() {
  return (
    <BrowserRouter>
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
              <Route path="sessions" element={<SessionPage />} />
              <Route path="sessions/:id" element={<SessionPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
