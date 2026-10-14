import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './stores/AuthProvider'
import { Toaster } from 'sonner'
import LoginPage from './pages/LoginPage'
import ChangePasswordPage from './pages/ChangePasswordPage'
import ModelConfigPage from './pages/ModelConfigPage'
import BaseImagePage from './pages/BaseImagePage'
import CloudContainersPage from './pages/CloudContainersPage'
import AdminLayout from './components/AdminLayout'
import ProtectedRoute from './components/ProtectedRoute'

const basename = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')

function App() {
  return (
    <BrowserRouter basename={basename}>
      <AuthProvider>
        <Toaster position="top-right" />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<AdminLayout />}>
              <Route index element={<Navigate to="/models" replace />} />
              <Route path="models" element={<ModelConfigPage />} />
              <Route path="base-images" element={<BaseImagePage />} />
              <Route path="cloud-containers" element={<CloudContainersPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/models" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
